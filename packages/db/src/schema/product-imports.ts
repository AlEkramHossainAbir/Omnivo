import { PRODUCT_IMPORT_STATUSES, type ProductImportError } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// One CSV file of products (step 12): the API makes the row and the upload address, the worker
// checks the file and creates the products — all of them, or none. Like report_exports: written by
// the API, finished by the worker, never edited after.
export const productImports = pgTable(
  'product_imports',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    fileName: text('file_name').notNull(),
    // As declared by the browser; the start route checks the stored file against it
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status', { enum: PRODUCT_IMPORT_STATUSES }).notNull().default('uploading'),
    rowCount: integer('row_count'),
    productCount: integer('product_count'),
    errorCount: integer('error_count').notNull().default(0),
    // The first 100 problems, in file order
    errors: jsonb('errors')
      .$type<ProductImportError[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: baseColumns().createdAt,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // The list, newest first: id is UUIDv7, so its order is the order of the uploads
    index('product_imports_tenant_id_idx').on(table.tenantId, table.id),
    // A finished import says when; a done one says how many products it made
    check(
      'product_imports_finished_check',
      sql`(${table.status} IN ('done', 'failed')) = (${table.finishedAt} IS NOT NULL)`,
    ),
    check(
      'product_imports_done_check',
      sql`${table.status} <> 'done' OR ${table.productCount} IS NOT NULL`,
    ),
  ],
);
