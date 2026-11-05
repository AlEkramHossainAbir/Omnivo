import { Inject, Injectable } from '@nestjs/common';
import { memberships, users } from '@omnivo/db';
import { and, eq, isNull } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';

// "Nasrin Akter joined the workspace" in the bell of whoever invited her. Idempotent through
// notify(): a second run of this job adds nothing.
@Injectable()
export class MemberJoinedHandler implements EventHandler<'member.joined'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: OutboxEvent<'member.joined'>): Promise<void> {
    const { inviterId, membershipId } = event.payload;
    if (inviterId === null) return;
    const tenantId = getTenantId();

    await this.withTenant(async (tx) => {
      const [joined] = await tx
        .select({ fullName: users.fullName, userId: users.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));
      // The inviter must still be in the workspace: a removed person gets no news about it
      const [inviter] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, inviterId),
            isNull(memberships.deletedAt),
          ),
        );
      // Inviting yourself is impossible (already_member), but a joined person never hears about
      // their own joining, whatever the data says
      if (!joined || !inviter || joined.userId === inviterId) return;

      await notify(tx, {
        userId: inviterId,
        type: 'member.joined',
        params: { name: joined.fullName },
        eventId: event.id,
      });
    });
  }
}
