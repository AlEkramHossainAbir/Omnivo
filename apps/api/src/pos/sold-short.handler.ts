import { Inject, Injectable } from '@nestjs/common';
import {
  membershipRoles,
  memberships,
  permissions,
  posSaleLines,
  posSales,
  rolePermissions,
  roles,
  warehouses,
} from '@omnivo/db';
import { and, countDistinct, eq, isNull, or, sql } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';

// "POS1-000123 sold 2 items Main store did not have" in the bell of everyone who adjusts stock
// (decision 30: they put it right with an adjustment or a transfer) and of the owners. The bell
// opens the sale. Like LowStockHandler: it reads the rows when it runs, and the event id is each
// notification's key, so a second run of the job adds nothing.
@Injectable()
export class SoldShortHandler implements EventHandler<'pos.sold_short'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: OutboxEvent<'pos.sold_short'>): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // A sale never changes (0052), so what was short then is short in these rows for good
      const [sale] = await tx
        .select({
          id: posSales.id,
          number: posSales.number,
          warehouse: warehouses.name,
          count: countDistinct(posSaleLines.variantId),
        })
        .from(posSales)
        .innerJoin(
          warehouses,
          and(eq(warehouses.tenantId, posSales.tenantId), eq(warehouses.id, posSales.warehouseId)),
        )
        .innerJoin(
          posSaleLines,
          and(
            eq(posSaleLines.tenantId, posSales.tenantId),
            eq(posSaleLines.saleId, posSales.id),
            or(
              sql`${posSaleLines.shortQuantity} > 0`,
              sql`cardinality(${posSaleLines.shortSerials}) > 0`,
            ),
          ),
        )
        .where(and(eq(posSales.tenantId, tenantId), eq(posSales.id, event.payload.saleId)))
        .groupBy(posSales.id, posSales.number, warehouses.name);
      if (!sale) return;

      // Owners, and members with a role that has inventory.stock.adjust
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
            or(eq(roles.kind, 'owner'), eq(permissions.key, 'inventory.stock.adjust')),
          ),
        );
      for (const recipient of recipients) {
        await notify(tx, {
          userId: recipient.userId,
          type: 'pos.sold_short',
          params: {
            id: sale.id,
            number: sale.number,
            warehouse: sale.warehouse,
            count: sale.count,
          },
          eventId: event.id,
        });
      }
    });
  }
}
