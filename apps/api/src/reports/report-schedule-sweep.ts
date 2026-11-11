import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Db, reportSchedules, tenantSettings } from '@omnivo/db';
import { and, asc, eq, lte } from 'drizzle-orm';

import { emit } from '../common/outbox/outbox.js';
import { getTenantId, runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { RELAY_DB, WITH_TENANT } from '../infra/tokens.js';
import { catchUp, whenOf } from './report-schedule-row.js';

// How many due schedules one sweep takes. A workspace has at most 20; the next sweep, 5 minutes
// later, takes the rest.
const BATCH = 200;

// The 5-minute job (decision 9). Two halves, on two roles:
// 1. as omnivo_worker (RELAY_DB): which schedules are due, in every workspace. Migration 0062 lets
//    this role read only id, tenant_id and next_run_at (decision 37).
// 2. as omnivo_app, inside each schedule's own workspace: lock it, write the outbox event and move
//    next_run_at on, in one transaction. So a run is either handed over and moved on, or neither.
// The run itself (who gets it, the files) is the report.schedule_due job: a broken schedule fails
// there, with its own retries, and never holds up another workspace's.
// Provided by WorkerModule only; the HTTP process never has it.
@Injectable()
export class ReportScheduleSweep {
  private readonly logger = new Logger(ReportScheduleSweep.name);

  constructor(
    @Inject(RELAY_DB) private readonly relayDb: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
  ) {}

  // The number of runs handed over. One clock for the whole sweep: the JavaScript one, used both
  // to find the due rows and to work out the next run, so a server whose clock differs from the
  // database's by a second cannot find a schedule due and then move it to a time already past.
  async run(now: Date = new Date()): Promise<number> {
    const due = await this.relayDb
      .select({ id: reportSchedules.id, tenantId: reportSchedules.tenantId })
      .from(reportSchedules)
      .where(lte(reportSchedules.nextRunAt, now))
      .orderBy(asc(reportSchedules.nextRunAt))
      .limit(BATCH);
    let handed = 0;
    for (const schedule of due) {
      try {
        if (await runWithTenant(schedule.tenantId, () => this.handOver(schedule.id, now))) {
          handed += 1;
        }
      } catch (error) {
        // One broken row must not stop the others; it is still due, so the next sweep tries again
        this.logger.warn(
          `report schedule ${schedule.id} (tenant ${schedule.tenantId}): ${String(error)}`,
        );
      }
    }
    return handed;
  }

  private handOver(scheduleId: string, now: Date): Promise<boolean> {
    return this.withTenant(async (tx) => {
      // SKIP LOCKED: a second worker's sweep, or a person saving this schedule right now, has it;
      // leave it to them. next_run_at again: it may have moved since the first read.
      const [row] = await tx
        .select()
        .from(reportSchedules)
        .where(
          and(
            eq(reportSchedules.tenantId, getTenantId()),
            eq(reportSchedules.id, scheduleId),
            lte(reportSchedules.nextRunAt, now),
          ),
        )
        .for('update', { skipLocked: true });
      if (row?.nextRunAt == null) return false;
      const [settings] = await tx
        .select({ timeZone: tenantSettings.timezone })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, getTenantId()));
      if (!settings) throw new Error(`tenant_settings row missing for tenant ${row.tenantId}`);
      const { runAt, nextRunAt } = catchUp(whenOf(row), settings.timeZone, row.nextRunAt, now);
      await emit(tx, 'report.schedule_due', {
        scheduleId: row.id,
        runAt: runAt.toISOString(),
      });
      // Not the version: that is for people editing the schedule, and a sweep between opening
      // the form and saving it must not make their save fail
      await tx
        .update(reportSchedules)
        .set({ lastRunAt: now, nextRunAt })
        .where(and(eq(reportSchedules.tenantId, getTenantId()), eq(reportSchedules.id, row.id)));
      return true;
    });
  }
}
