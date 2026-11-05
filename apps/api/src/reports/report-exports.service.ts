import { Inject, Injectable } from '@nestjs/common';
import type { ReportExport, ReportExportInput } from '@omnivo/contracts';
import { reportExports } from '@omnivo/db';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { type SignedUrl, StorageService } from '../storage/storage.service.js';

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
// (export.handler.ts) and tells the person through the bell.
@Injectable()
export class ReportExportsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  create(input: ReportExportInput): Promise<ReportExport> {
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

  list(query: { limit: number; cursor?: string | undefined }) {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(reportExports)
        .where(
          and(
            eq(reportExports.tenantId, getTenantId()),
            eq(reportExports.requestedBy, currentPrincipal().userId),
            after === undefined ? undefined : lt(reportExports.id, after[0]),
          ),
        )
        .orderBy(desc(reportExports.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.id]);
      return { items: page.items.map(toReportExport), nextCursor: page.nextCursor };
    });
  }

  download(id: string): Promise<SignedUrl> {
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
