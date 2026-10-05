import { Inject, Injectable } from '@nestjs/common';
import { compareQuantity } from '@omnivo/contracts';
import {
  membershipRoles,
  memberships,
  permissions,
  reorderLevels,
  rolePermissions,
  roles,
  warehouses,
} from '@omnivo/db';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';

// "3 items at Main store fell to their reorder level" in the bell of everyone who manages
// products (they set the levels and order the stock) and of the owners. Runs after the posting
// committed; it counts again, so a variant refilled in between is not reported. Idempotent: the
// event id is each notification's key.
@Injectable()
export class LowStockHandler implements EventHandler<'stock.below_reorder'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: OutboxEvent<'stock.below_reorder'>): Promise<void> {
    const tenantId = getTenantId();
    const { warehouseId, variantIds } = event.payload;
    await this.withTenant(async (tx) => {
      const [warehouse] = await tx
        .select({ name: warehouses.name })
        .from(warehouses)
        .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, warehouseId)));
      if (!warehouse) return;

      const levels = await tx
        .select({
          minQuantity: reorderLevels.minQuantity,
          // The outer table by its name (see stock-adjustments.service.ts's lineCount)
          onHand: sql<string>`coalesce((SELECT sum(sb.quantity) FROM stock_balances sb
            WHERE sb.tenant_id = reorder_levels.tenant_id AND sb.warehouse_id = reorder_levels.warehouse_id
              AND sb.variant_id = reorder_levels.variant_id), 0)::text`,
        })
        .from(reorderLevels)
        .where(
          and(
            eq(reorderLevels.tenantId, tenantId),
            eq(reorderLevels.warehouseId, warehouseId),
            inArray(reorderLevels.variantId, variantIds),
          ),
        );
      const count = levels.filter(
        (level) => compareQuantity(level.onHand, level.minQuantity) <= 0,
      ).length;
      if (count === 0) return;

      // Owners, and members with a role that has inventory.product.manage
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
            or(eq(roles.kind, 'owner'), eq(permissions.key, 'inventory.product.manage')),
          ),
        );
      for (const recipient of recipients) {
        await notify(tx, {
          userId: recipient.userId,
          type: 'stock.low',
          params: { warehouse: warehouse.name, count },
          eventId: event.id,
        });
      }
    });
  }
}
