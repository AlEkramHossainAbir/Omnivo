import type { NotificationParams, NotificationType } from '@omnivo/contracts';
import { memberships, reportSchedules } from '@omnivo/db';
import { and, eq, isNull } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { notify } from '../notifications/notify.js';

// A scheduled report's bells go to the person who made the schedule, and only while they are still
// a member (decision 12): someone who left cannot open the bell, and nobody else is told instead.
// A schedule deleted meanwhile has nobody to tell either.
export async function notifyScheduleCreator(
  tx: Transaction,
  input: {
    scheduleId: string;
    type: Extract<NotificationType, `report.schedule_${string}`>;
    params: NotificationParams;
    eventId: string;
  },
): Promise<void> {
  const tenantId = getTenantId();
  const [creator] = await tx
    .select({ userId: memberships.userId })
    .from(reportSchedules)
    .innerJoin(
      memberships,
      and(
        eq(memberships.tenantId, reportSchedules.tenantId),
        eq(memberships.userId, reportSchedules.createdBy),
        isNull(memberships.deletedAt),
      ),
    )
    .where(and(eq(reportSchedules.tenantId, tenantId), eq(reportSchedules.id, input.scheduleId)));
  if (!creator) return;
  await notify(tx, {
    userId: creator.userId,
    type: input.type,
    params: input.params,
    eventId: input.eventId,
  });
}
