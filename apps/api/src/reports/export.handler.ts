import { Inject, Injectable } from '@nestjs/common';
import {
  balanceSheetQuerySchema,
  type ExportFormat,
  profitAndLossQuerySchema,
  trialBalanceQuerySchema,
} from '@omnivo/contracts';
import { branches, reportExports, tenants, tenantSettings, users } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';

import { type EventHandler, type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';
import { StorageService } from '../storage/storage.service.js';
import {
  buildDocument,
  type DocumentContext,
  fileStem,
  type ReportData,
} from './export/document.js';
import { writePdf } from './export/pdf.js';
import { writeXlsx } from './export/xlsx.js';
import { balanceSheet, profitAndLoss, trialBalance } from './report-queries.js';

const CONTENT_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} satisfies Record<ExportFormat, string>;

type ExportRow = typeof reportExports.$inferSelect;

// The stored query is parsed again with the report's own schema. A row changed by hand (or by a
// bug) can then not feed a report anything it would not take from the page; running the job
// again cannot fix that, so it fails for good.
function queryOf<S extends z.ZodType>(schema: S, row: ExportRow): z.output<S> {
  const parsed = schema.safeParse(row.query);
  if (!parsed.success) throw new PermanentJobError(`Export ${row.id} has a broken query`);
  return parsed.data;
}

async function reportData(tx: Transaction, row: ExportRow): Promise<ReportData> {
  switch (row.report) {
    case 'trial_balance': {
      const query = queryOf(trialBalanceQuerySchema, row);
      return { report: row.report, query, data: await trialBalance(tx, query) };
    }
    case 'profit_and_loss': {
      const query = queryOf(profitAndLossQuerySchema, row);
      return { report: row.report, query, data: await profitAndLoss(tx, query) };
    }
    case 'balance_sheet': {
      const query = queryOf(balanceSheetQuerySchema, row);
      return { report: row.report, query, data: await balanceSheet(tx, query) };
    }
  }
}

// Writes the file of one report_exports row (step 11). Idempotent like every handler: a finished
// row is left alone, the file's key is fixed by the row's id (a second run overwrites the same
// object), and the notification is keyed by the event.
@Injectable()
export class ReportExportHandler implements EventHandler<'report.export_requested'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  async handle(event: OutboxEvent<'report.export_requested'>): Promise<void> {
    const tenantId = getTenantId();
    // 1) Read everything in one short transaction: the export, the report itself and the words
    //    around it. The file is written and uploaded outside it, so no transaction stays open
    //    while the PDF is drawn or the upload waits on the network.
    const job = await this.withTenant(async (tx) => {
      const [row] = await tx
        .select()
        .from(reportExports)
        .where(
          and(eq(reportExports.tenantId, tenantId), eq(reportExports.id, event.payload.exportId)),
        );
      if (!row) throw new PermanentJobError('The export no longer exists');
      // Done already: this is a second run of the same job
      if (row.status !== 'pending') return null;

      const [context] = await tx
        .select({
          company: tenants.name,
          currency: tenantSettings.baseCurrency,
          timeZone: tenantSettings.timezone,
        })
        .from(tenantSettings)
        .innerJoin(tenants, eq(tenants.id, tenantSettings.tenantId))
        .where(eq(tenantSettings.tenantId, tenantId));
      if (!context) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
      // The file is in the language of the person who asked for it; English until they pick one
      const [user] = await tx
        .select({ language: users.language })
        .from(users)
        .where(eq(users.id, row.requestedBy));
      const report = await reportData(tx, row);
      const branchId = report.report === 'profit_and_loss' ? report.query.branchId : undefined;
      const [branch] =
        branchId === undefined
          ? []
          : await tx
              .select({ name: branches.name })
              .from(branches)
              .where(and(eq(branches.tenantId, tenantId), eq(branches.id, branchId)));
      const documentContext: DocumentContext = {
        language: user?.language ?? 'en',
        company: context.company,
        currency: context.currency,
        timeZone: context.timeZone,
        branchName: branch?.name ?? null,
        madeAt: new Date(),
      };
      return { row, report, documentContext };
    });
    if (!job) return;

    // 2) The file, and into storage under a key that only this export uses
    const { row } = job;
    const doc = buildDocument(job.report, job.documentContext);
    const bytes = row.format === 'xlsx' ? await writeXlsx(doc) : await writePdf(doc);
    const contentType = CONTENT_TYPES[row.format];
    const key = ['tenants', tenantId, 'report-exports', `${row.id}.${row.format}`].join('/');
    await this.storage.put(key, bytes, contentType);

    // 3) Mark it ready and tell the person. `status = 'pending'` in the WHERE: if two runs raced
    //    this far, only one row update (and one notification) happens.
    await this.withTenant(async (tx) => {
      const [done] = await tx
        .update(reportExports)
        .set({
          status: 'ready',
          fileName: `${fileStem(job.report)}.${row.format}`,
          contentType,
          sizeBytes: bytes.byteLength,
          storageKey: key,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(reportExports.tenantId, tenantId),
            eq(reportExports.id, row.id),
            eq(reportExports.status, 'pending'),
          ),
        )
        .returning({ id: reportExports.id });
      if (!done) return;
      await notify(tx, {
        userId: row.requestedBy,
        type: 'report.ready',
        params: { report: row.report, format: row.format },
        eventId: event.id,
      });
    });
  }

  // After the last attempt: the row says "failed" and the person hears it, instead of waiting
  async onGiveUp(event: OutboxEvent<'report.export_requested'>): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [failed] = await tx
        .update(reportExports)
        .set({ status: 'failed', finishedAt: new Date() })
        .where(
          and(
            eq(reportExports.tenantId, tenantId),
            eq(reportExports.id, event.payload.exportId),
            eq(reportExports.status, 'pending'),
          ),
        )
        .returning({
          requestedBy: reportExports.requestedBy,
          report: reportExports.report,
          format: reportExports.format,
        });
      if (!failed) return;
      await notify(tx, {
        userId: failed.requestedBy,
        type: 'report.failed',
        params: { report: failed.report, format: failed.format },
        eventId: event.id,
      });
    });
  }
}
