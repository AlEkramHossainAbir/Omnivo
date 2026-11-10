import { Inject, Injectable } from '@nestjs/common';
import {
  REPORT_KIND_PERMISSIONS,
  type ReportExport,
  type ReportExportInput,
  reportKindsFor,
} from '@omnivo/contracts';
import { reportExports } from '@omnivo/db';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';

import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import { type SignedUrl, StorageService } from '../storage/storage.service.js';
import { checkCostSort, missingPermission } from './report-access.js';

type ExportRow = typeof reportExports.$inferSelect;

function toReportExport(row: ExportRow): ReportExport {
  return {
    id: row.id,
    report: row.report,
    format: row.format,
    query: row.query,
    status: row.status,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

// The query's set values only: an optional field the page left out is not stored as null
function storedQuery(query: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
}

const cursorSchema = z.tuple([z.uuid()]);

// The API's half of an export: the row and the outbox event. The worker writes the file
// (export.handler.ts) and tells the person through the bell. Since step 21b each kind has its own
// permission (decision 14): the routes only ask for a signed-in person, and every method here
// checks the kind's permission, now, not when the export was made.
@Injectable()
export class ReportExportsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
    private readonly permissions: PermissionService,
  ) {}

  async create(input: ReportExportInput): Promise<ReportExport> {
    const access = await this.permissions.ofCurrentUser();
    const permission = REPORT_KIND_PERMISSIONS[input.report];
    if (!access.permissions.includes(permission)) throw missingPermission(permission);
    // The same rule as the page: a file sorted by the cost would tell it (decision 17)
    if (input.report === 'sales_report') {
      checkCostSort(input.query.sort, access.permissions.includes('inventory.stock.value'));
    }
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .insert(reportExports)
        .values({
          tenantId: getTenantId(),
          requestedBy: currentPrincipal().userId,
          report: input.report,
          format: input.format,
          query: storedQuery(input.query),
        })
        .returning();
      if (!row) throw new Error('Report export insert returned no row');
      // Same transaction: if the row commits, the job is safely queued (step 8's outbox)
      await emit(tx, 'report.export_requested', { exportId: row.id });
      return toReportExport(row);
    });
  }

  // The person's own exports of the kinds they may read today: a file of a report they lost is not
  // listed (and not downloaded, below)
  async list(query: { limit: number; cursor?: string | undefined }) {
    const after = decodeCursor(query.cursor, cursorSchema);
    const kinds = reportKindsFor((await this.permissions.ofCurrentUser()).permissions);
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(reportExports)
        .where(
          and(
            eq(reportExports.tenantId, getTenantId()),
            eq(reportExports.requestedBy, currentPrincipal().userId),
            // Drizzle writes an empty list as false: no kind, no row
            inArray(reportExports.report, kinds),
            after === undefined ? undefined : lt(reportExports.id, after[0]),
          ),
        )
        .orderBy(desc(reportExports.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.id]);
      return { items: page.items.map(toReportExport), nextCursor: page.nextCursor };
    });
  }

  async download(id: string): Promise<SignedUrl> {
    const access = await this.permissions.ofCurrentUser();
    return this.withTenant(async (tx) => {
      // Someone else's export is "not found", like another tenant's row
      const [row] = await tx
        .select()
        .from(reportExports)
        .where(
          and(
            eq(reportExports.tenantId, getTenantId()),
            eq(reportExports.id, id),
            eq(reportExports.requestedBy, currentPrincipal().userId),
          ),
        );
      if (!row) throw notFound('Report export');
      const permission = REPORT_KIND_PERMISSIONS[row.report];
      if (!access.permissions.includes(permission)) throw missingPermission(permission);
      // The check constraint makes these four present whenever the status is 'ready'
      if (
        row.status !== 'ready' ||
        row.storageKey === null ||
        row.contentType === null ||
        row.fileName === null
      ) {
        throw new AppError(409, 'export_not_ready', 'The file is not ready yet.');
      }
      return this.storage.downloadUrl(row.storageKey, row.contentType, row.fileName);
    });
  }
}
