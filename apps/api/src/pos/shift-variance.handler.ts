import { Inject, Injectable } from '@nestjs/common';
import { cashDifferenceOf } from '@omnivo/contracts';
import {
  membershipRoles,
  memberships,
  permissions,
  posRegisters,
  posShifts,
  rolePermissions,
  roles,
} from '@omnivo/db';
import { and, eq, isNull, or } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';

// "POS1-S0042 at Front counter was ৳520 short" in the bell of the owners and of everyone with
// pos.shift.manage (step 20b, decision 29). The bell opens the shift. Like SoldShortHandler: it
// reads the shift when it runs, and the event id is each notification's key, so a second run of
// the job adds nothing. The close decided that the difference is over the limit; a closed shift
// never changes, so the numbers here are the ones it decided on.
@Injectable()
export class ShiftVarianceHandler implements EventHandler<'pos.shift_variance'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: OutboxEvent<'pos.shift_variance'>): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [shift] = await tx
        .select({
          id: posShifts.id,
          number: posShifts.number,
          register: posRegisters.name,
          countedCash: posShifts.countedCash,
          expectedCash: posShifts.expectedCash,
        })
        .from(posShifts)
        .innerJoin(
          posRegisters,
          and(
            eq(posRegisters.tenantId, posShifts.tenantId),
            eq(posRegisters.id, posShifts.registerId),
          ),
        )
        .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, event.payload.shiftId)));
      if (shift?.countedCash == null || shift.expectedCash === null) return;

      // Owners, and members with a role that has pos.shift.manage
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
          ),
        );
      for (const recipient of recipients) {
        await notify(tx, {
          userId: recipient.userId,
          type: 'pos.shift_variance',
          params: {
            id: shift.id,
            number: shift.number,
            register: shift.register,
            // Counted less expected: below zero = short (the text says which)
            difference: cashDifferenceOf(shift.countedCash, shift.expectedCash),
          },
          eventId: event.id,
        });
      }
    });
  }
}
