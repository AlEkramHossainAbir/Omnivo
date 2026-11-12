import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  REPORT_KIND_PERMISSIONS,
  reportExportInputSchema,
  reportSchedulePeriod,
  reportScheduleQuery,
  todayIn,
} from '@omnivo/contracts';
import {
  reportExports,
  reportScheduleRecipients,
  reportSchedules,
  tenantSettings,
} from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { audit } from '../common/audit/audit.js';
import {
  emit,
  type EventHandler,
  type OutboxEvent,
  PermanentJobError,
} from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { permissionHolders } from '../rbac/holds-permission.js';
import { storedQuery } from './report-exports.service.js';
import { notifyScheduleCreator } from './report-schedule-bells.js';

type Event = OutboxEvent<'report.schedule_due'>;

// The id of one person's file of one run. The same every time the job runs, so a second run (a
// retry after a crash) finds the rows of the first and makes nothing twice. Still a UUIDv7 that
// sorts by time like every other export, because the Exports page lists the newest id first: the
// time is the event's own (the first 48 bits of its UUIDv7 id, written by the sweep), the rest
// comes from a hash of the two ids.
export function exportIdFor(eventId: string, userId: string): string {
  const hash = createHash('sha256').update(`${eventId}/${userId}`).digest('hex');
  const time = eventId.replaceAll('-', '').slice(0, 12);
  // The version (7) is the 13th digit; the variant (8, 9, a or b) the 17th
  const variant = ((Number.parseInt(hash.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  const hex = `${time}7${hash.slice(0, 3)}${variant}${hash.slice(4, 19)}`;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

// One run of a scheduled report (decisions 7–9): who still may read it, then one report_exports
// row per person, made by the export handler you already have, in each person's own language and
// with what each person's own permissions show. Everything in one transaction, so a run either
// hands every file over or none.
@Injectable()
export class ReportScheduleRunHandler implements EventHandler<'report.schedule_due'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: Event): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // Locked: a person who saves or pauses it now waits until this run is handed over
      const [row] = await tx
        .select()
        .from(reportSchedules)
        .where(
          and(
            eq(reportSchedules.tenantId, tenantId),
            eq(reportSchedules.id, event.payload.scheduleId),
          ),
        )
        .for('update');
      // Deleted or paused since the sweep: nothing to send
      if (row?.status !== 'active') return;
      const [settings] = await tx
        .select({ timeZone: tenantSettings.timezone })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));
      if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);

      // The period from the run's day in the workspace's zone (decisions 8 and 28), parsed with
      // the report's own schema, as every export's query is. Broken filters (a row changed by
      // hand) cannot be fixed by running again.
      const period = reportSchedulePeriod(
        row.frequency,
        todayIn(settings.timeZone, new Date(event.payload.runAt)),
      );
      const input = reportExportInputSchema.safeParse({
        report: row.report,
        format: row.format,
        query: reportScheduleQuery(row.report, row.filters, period),
      });
      if (!input.success)
        throw new PermanentJobError(`Report schedule ${row.id} has broken filters`);

      // Who may read it now (decision 9): a member with the report's permission
      const recipients = await tx
        .select({ userId: reportScheduleRecipients.userId })
        .from(reportScheduleRecipients)
        .where(
          and(
            eq(reportScheduleRecipients.tenantId, tenantId),
            eq(reportScheduleRecipients.scheduleId, row.id),
          ),
        )
        .orderBy(asc(reportScheduleRecipients.position));
      const holders = await permissionHolders(tx, REPORT_KIND_PERMISSIONS[row.report]);
      const receiving = recipients.filter((recipient) => holders.has(recipient.userId));

      if (receiving.length === 0) {
        // Nobody left: Paused (decision 31). The check constraint wants no next run.
        await tx
          .update(reportSchedules)
          .set({
            status: 'paused',
            pausedReason: 'no_recipients',
            nextRunAt: null,
            version: sql`${reportSchedules.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(reportSchedules.tenantId, tenantId), eq(reportSchedules.id, row.id)));
        // No actor: the worker did it, and the audit log says so
        await audit(tx, {
          action: 'report_schedule.paused',
          entityType: 'report_schedule',
          entityId: row.id,
          changes: {
            status: { from: 'active', to: 'paused' },
            pausedReason: { from: null, to: 'no_recipients' },
          },
        });
        await notifyScheduleCreator(tx, {
          scheduleId: row.id,
          type: 'report.schedule_paused',
          params: { report: row.report },
          eventId: event.id,
        });
        return;
      }
      const skipped = recipients.length - receiving.length;
      if (skipped > 0) {
        await notifyScheduleCreator(tx, {
          scheduleId: row.id,
          type: 'report.schedule_skipped',
          params: { report: row.report, count: skipped },
          eventId: event.id,
        });
      }

      // One file per person. RETURNING gives only the rows this run inserted: on a second run of
      // the job it gives none, and no file is asked for twice.
      const query = storedQuery(input.data.query);
      const made = await tx
        .insert(reportExports)
        .values(
          receiving.map((recipient) => ({
            id: exportIdFor(event.id, recipient.userId),
            tenantId,
            requestedBy: recipient.userId,
            report: row.report,
            format: row.format,
            query,
          })),
        )
        .onConflictDoNothing({ target: reportExports.id })
        .returning({ id: reportExports.id });
      for (const file of made) {
        await emit(tx, 'report.export_requested', { exportId: file.id, scheduleId: row.id });
      }
    });
  }

  // After the last attempt (broken filters, or the database kept failing): the person who made it
  // hears that this run went to nobody
  async onGiveUp(event: Event): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [row] = await tx
        .select({ report: reportSchedules.report, format: reportSchedules.format })
        .from(reportSchedules)
        .where(
          and(
            eq(reportSchedules.tenantId, tenantId),
            eq(reportSchedules.id, event.payload.scheduleId),
          ),
        );
      if (!row) return;
      await notifyScheduleCreator(tx, {
        scheduleId: event.payload.scheduleId,
        type: 'report.schedule_failed',
        params: { report: row.report, format: row.format },
        eventId: event.id,
      });
    });
  }
}
