import { Inject, Injectable } from '@nestjs/common';
import { reportExports, reportSchedules, tenants, users } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { type EventHandler, type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG, WITH_TENANT } from '../infra/tokens.js';
import { MailService } from '../mail/mail.service.js';
import { scheduledReportEmail } from '../mail/scheduled-report-email.js';
import { StorageService } from '../storage/storage.service.js';
import { COPY } from './export/copy.js';
import { formatIsoDate } from './export/format.js';
import { notifyScheduleCreator } from './report-schedule-bells.js';

type Event = OutboxEvent<'report.schedule_email'>;

// Decision 7: a file up to 5 MB goes with the email. Most mail servers take 10 to 25 MB, and a
// file grows by a third when it is encoded for email, so 5 MB stays well inside every limit.
export const MAX_REPORT_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// The app's pages the email links to (step 21c.6 makes the schedules page)
const SCHEDULES_PATH = '/reports/schedules';
const EXPORTS_PATH = '/reports/exports';

// Sends one person's scheduled report (step 21c), on the email queue: a slow mail server never
// holds up the files of other people. Like the document email (step 16), sending is the last
// step: a crash after the mail server took it sends it again on the retry, which is better than
// never.
@Injectable()
export class ReportScheduleEmailHandler implements EventHandler<'report.schedule_email'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: WorkerConfig,
    private readonly mail: MailService,
    private readonly storage: StorageService,
  ) {}

  async handle(event: Event): Promise<void> {
    const tenantId = getTenantId();
    // 1) What to send and to whom, in one short transaction
    const job = await this.withTenant(async (tx) => {
      const [row] = await tx
        .select({ file: reportExports, email: users.email, language: users.language })
        .from(reportExports)
        .innerJoin(users, eq(users.id, reportExports.requestedBy))
        .where(
          and(eq(reportExports.tenantId, tenantId), eq(reportExports.id, event.payload.exportId)),
        );
      if (!row) throw new PermanentJobError('The export no longer exists');
      const { file } = row;
      // The export handler asks for this email only once the row is ready
      if (
        file.status !== 'ready' ||
        file.storageKey === null ||
        file.contentType === null ||
        file.fileName === null ||
        file.sizeBytes === null
      ) {
        throw new PermanentJobError(`Export ${file.id} is not ready`);
      }
      const [schedule] = await tx
        .select({ frequency: reportSchedules.frequency })
        .from(reportSchedules)
        .where(
          and(
            eq(reportSchedules.tenantId, tenantId),
            eq(reportSchedules.id, event.payload.scheduleId),
          ),
        );
      // Deleted since the run: whoever deleted it wanted the emails to stop. The file stays on
      // the person's Exports page.
      if (!schedule) return null;
      const [company] = await tx
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      // The narrowed fields one by one: TypeScript keeps the null checks above only this way
      return {
        id: file.id,
        report: file.report,
        query: file.query,
        storageKey: file.storageKey,
        contentType: file.contentType,
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
        to: row.email,
        language: row.language ?? 'en',
        frequency: schedule.frequency,
        company: company?.name ?? '',
      };
    });
    if (!job) return;

    // 2) The file from storage when it is small enough, then the email, outside any transaction
    let attachment: { bytes: Uint8Array; contentType: string } | null = null;
    if (job.sizeBytes <= MAX_REPORT_ATTACHMENT_BYTES) {
      const bytes = await this.storage.get(job.storageKey);
      // The export handler wrote it a moment ago: gone means someone deleted it, and running
      // again cannot bring it back
      if (bytes === null) throw new PermanentJobError(`Export ${job.id} has no file`);
      attachment = { bytes, contentType: job.contentType };
    }
    const copy = COPY[job.language];
    const date = (iso: string) => formatIsoDate(iso, job.language);
    // An aging and the balance sheet show one day; the others a period (reportScheduleQuery)
    const { from, to, asOf } = job.query;
    let period: string;
    if (asOf !== undefined) period = copy.asOf(date(asOf));
    else if (from !== undefined && to !== undefined) period = copy.range(date(from), date(to));
    else throw new PermanentJobError(`Export ${job.id} has no dates`);
    await this.mail.send(
      scheduledReportEmail({
        to: job.to,
        language: job.language,
        company: job.company,
        title: copy.titles[job.report],
        period,
        frequency: job.frequency,
        fileName: job.fileName,
        file: attachment,
        schedulesUrl: `${this.config.appOrigin}${SCHEDULES_PATH}`,
        exportsUrl: `${this.config.appOrigin}${EXPORTS_PATH}`,
      }),
    );
  }

  // The mail server kept refusing it: the person who made the schedule hears (decision 32). The
  // file is still on the recipient's Exports page.
  async onGiveUp(event: Event): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [file] = await tx
        .select({ report: reportExports.report, format: reportExports.format })
        .from(reportExports)
        .where(
          and(eq(reportExports.tenantId, tenantId), eq(reportExports.id, event.payload.exportId)),
        );
      if (!file) return;
      await notifyScheduleCreator(tx, {
        scheduleId: event.payload.scheduleId,
        type: 'report.schedule_failed',
        params: { report: file.report, format: file.format },
        eventId: event.id,
      });
    });
  }
}
