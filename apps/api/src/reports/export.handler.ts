import { Inject, Injectable } from '@nestjs/common';
import {
  apAgingFilterSchema,
  arAgingFilterSchema,
  balanceSheetQuerySchema,
  type ExportFormat,
  isStockValueSort,
  profitAndLossQuerySchema,
  purchaseReportFilterSchema,
  salesReportFilterSchema,
  stockMovementFilterSchema,
  trialBalanceQuerySchema,
  vatReportFilterSchema,
} from '@omnivo/contracts';
import {
  branches,
  customerGroups,
  productCategories,
  reportExports,
  supplierGroups,
  tenants,
  tenantSettings,
  users,
  warehouses,
} from '@omnivo/db';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';

import {
  emit,
  type EventHandler,
  type OutboxEvent,
  PermanentJobError,
} from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';
import { holdsPermission } from '../rbac/holds-permission.js';
import { StorageService } from '../storage/storage.service.js';
import { payablesAging, receivablesAging } from './aging-queries.js';
import {
  buildDocument,
  type DocumentContext,
  fileStem,
  type ReportData,
} from './export/document.js';
import { writePdf } from './export/pdf.js';
import { writeXlsx } from './export/xlsx.js';
import { balanceSheet, profitAndLoss, trialBalance } from './report-queries.js';
import { notifyScheduleCreator } from './report-schedule-bells.js';
import { stockMovementReport } from './stock-movement-queries.js';
import { purchaseReport, salesReport } from './trade-report-queries.js';
import { vatReport } from './vat-queries.js';

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
    // Step 21b: every row (no page), in the page's order (decision 20)
    case 'sales_report': {
      const query = queryOf(salesReportFilterSchema, row);
      // The cost columns as the person may see them when the file is made, not when it was asked
      // for. The API refused a cost sort without the permission; if it was lost since, the file is
      // sorted by the net instead, since the order of the rows would tell the cost (decision 17).
      const withCost = await holdsPermission(tx, row.requestedBy, 'inventory.stock.value');
      const data = await salesReport(tx, withCost ? query : { ...query, sort: '-net' }, {
        withCost,
        page: null,
      });
      return { report: row.report, query, data };
    }
    case 'purchase_report': {
      const query = queryOf(purchaseReportFilterSchema, row);
      return { report: row.report, query, data: await purchaseReport(tx, query, { page: null }) };
    }
    case 'ar_aging': {
      const query = queryOf(arAgingFilterSchema, row);
      return { report: row.report, query, data: await receivablesAging(tx, query, null) };
    }
    case 'ap_aging': {
      const query = queryOf(apAgingFilterSchema, row);
      return { report: row.report, query, data: await payablesAging(tx, query, null) };
    }
    // Step 21c: the VAT summary by rate, and every row of the stock movement report
    case 'vat_report': {
      const query = queryOf(vatReportFilterSchema, row);
      return { report: row.report, query, data: await vatReport(tx, query) };
    }
    case 'stock_movement': {
      const query = queryOf(stockMovementFilterSchema, row);
      // As for the sales report's cost: the values as the person may see them now, and a value
      // sort they lost falls back to the name (decision 24)
      const withValue = await holdsPermission(tx, row.requestedBy, 'inventory.stock.value');
      const sorted =
        withValue || !isStockValueSort(query.sort) ? query : { ...query, sort: 'name' as const };
      const data = await stockMovementReport(tx, sorted, { withValue, page: null });
      return { report: row.report, query, data };
    }
  }
}

// The names the file's heading prints for the query's filters. Read by the export's own tenant:
// an id of another workspace finds nothing (row-level security), and the line is left out.
async function filterNames(tx: Transaction, report: ReportData) {
  const tenantId = getTenantId();
  const ids = {
    branchId:
      report.report === 'profit_and_loss' ||
      report.report === 'sales_report' ||
      report.report === 'purchase_report' ||
      report.report === 'vat_report'
        ? report.query.branchId
        : undefined,
    warehouseId: report.report === 'stock_movement' ? report.query.warehouseId : undefined,
    customerGroupId:
      report.report === 'sales_report' || report.report === 'ar_aging'
        ? report.query.customerGroupId
        : undefined,
    supplierGroupId:
      report.report === 'purchase_report' || report.report === 'ap_aging'
        ? report.query.supplierGroupId
        : undefined,
    categoryId:
      report.report === 'sales_report' ||
      report.report === 'purchase_report' ||
      report.report === 'stock_movement'
        ? report.query.categoryId
        : undefined,
  };
  const [[branch], [customerGroup], [supplierGroup], [category], [warehouse]] = await Promise.all([
    ids.branchId === undefined
      ? []
      : tx
          .select({ name: branches.name })
          .from(branches)
          .where(and(eq(branches.tenantId, tenantId), eq(branches.id, ids.branchId))),
    ids.customerGroupId === undefined
      ? []
      : tx
          .select({ name: customerGroups.name })
          .from(customerGroups)
          .where(
            and(eq(customerGroups.tenantId, tenantId), eq(customerGroups.id, ids.customerGroupId)),
          ),
    ids.supplierGroupId === undefined
      ? []
      : tx
          .select({ name: supplierGroups.name })
          .from(supplierGroups)
          .where(
            and(eq(supplierGroups.tenantId, tenantId), eq(supplierGroups.id, ids.supplierGroupId)),
          ),
    ids.categoryId === undefined
      ? []
      : tx
          .select({ name: productCategories.name })
          .from(productCategories)
          .where(
            and(eq(productCategories.tenantId, tenantId), eq(productCategories.id, ids.categoryId)),
          ),
    ids.warehouseId === undefined
      ? []
      : tx
          .select({ name: warehouses.name })
          .from(warehouses)
          .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, ids.warehouseId))),
  ]);
  return {
    branchName: branch?.name ?? null,
    groupName: customerGroup?.name ?? supplierGroup?.name ?? null,
    categoryName: category?.name ?? null,
    warehouseName: warehouse?.name ?? null,
  };
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
      const documentContext: DocumentContext = {
        language: user?.language ?? 'en',
        company: context.company,
        currency: context.currency,
        timeZone: context.timeZone,
        ...(await filterNames(tx, report)),
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
    //    this far, only one row update (and one notification) happens. A scheduled report's file
    //    goes by email instead (step 21c): the email job, in the same transaction as the mark, so
    //    a file that is ready is always emailed, and only once.
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
      const { scheduleId } = event.payload;
      if (scheduleId !== undefined) {
        await emit(tx, 'report.schedule_email', { exportId: row.id, scheduleId });
        return;
      }
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
      const params = { report: failed.report, format: failed.format };
      // Nobody asked for a scheduled file: the person who made the schedule hears it (decision 32)
      const { scheduleId } = event.payload;
      if (scheduleId !== undefined) {
        await notifyScheduleCreator(tx, {
          scheduleId,
          type: 'report.schedule_failed',
          params,
          eventId: event.id,
        });
        return;
      }
      await notify(tx, {
        userId: failed.requestedBy,
        type: 'report.failed',
        params,
        eventId: event.id,
      });
    });
  }
}
