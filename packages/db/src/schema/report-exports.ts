import { EXPORT_FORMATS, EXPORT_STATUSES, REPORT_KINDS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// A report written to a file by the worker (step 11): one row per click on "Export". The file
// itself is in S3/MinIO; this row says what was asked for, whose it is and where the file is.
// No baseColumns: a row is written by the API, finished by the worker, and never edited after.
export const reportExports = pgTable(
  'report_exports',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Only this person sees and downloads it: an export is a copy of the books made for them
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    report: text('report', { enum: REPORT_KINDS }).notNull(),
    format: text('format', { enum: EXPORT_FORMATS }).notNull(),
    // The report's query as the page sent it (dates, branch). The worker parses it again with the
    // report's schema, so a row changed by hand cannot feed the report anything else.
    query: jsonb('query').$type<Record<string, string>>().notNull(),
    status: text('status', { enum: EXPORT_STATUSES }).notNull().default('pending'),
    // Set by the worker when the file is in storage
    fileName: text('file_name'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    storageKey: text('storage_key'),
    createdAt: baseColumns().createdAt,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // "My exports", newest first: id is UUIDv7, so its order is the order they were asked for
    index('report_exports_tenant_user_idx').on(table.tenantId, table.requestedBy, table.id),
    // A ready export always says where its file is, so a download never meets a half-made row
    check(
      'report_exports_ready_check',
      sql`${table.status} <> 'ready' OR (${table.fileName} IS NOT NULL AND ${table.contentType} IS NOT NULL AND ${table.sizeBytes} IS NOT NULL AND ${table.storageKey} IS NOT NULL AND ${table.finishedAt} IS NOT NULL)`,
    ),
  ],
);
