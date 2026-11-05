import type { NotificationParams, NotificationType } from '@omnivo/contracts';
import { notifications } from '@omnivo/db';
import { sql } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';

interface NotifyInput {
  userId: string;
  type: NotificationType;
  params?: NotificationParams;
  // The event that caused it — the key that makes a second run of the same job harmless
  eventId: string;
}

// Adds a notification in the transaction's tenant, as part of the job's other work: if the job
// rolls back, no notification; if the job runs twice, still one notification.
export async function notify(tx: Transaction, input: NotifyInput): Promise<void> {
  await tx
    .insert(notifications)
    .values({
      tenantId: sql`NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      userId: input.userId,
      type: input.type,
      params: input.params ?? {},
      eventId: input.eventId,
    })
    .onConflictDoNothing({
      target: [notifications.tenantId, notifications.eventId, notifications.userId],
    });
}
