import {
  DOCUMENT_EMAIL_STATUSES,
  DOCUMENT_FILE_STATUSES,
  LANGUAGE_CODES,
  OUTPUT_DOCUMENTS,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// The columns that say which document a row belongs to (step 16): a quotation, an invoice, a
// money receipt or a credit note. No FK to the document: it is in one of four tables, and a
// foreign key points at one. The API checks the document exists before it writes a row.
function documentColumns() {
  return {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind', { enum: OUTPUT_DOCUMENTS }).notNull(),
    documentId: uuid('document_id').notNull(),
    language: text('language', { enum: LANGUAGE_CODES }).notNull(),
  };
}

// A document's PDF, drawn by the worker and kept in S3/MinIO. One row per look of the document:
// the model is everything the PDF shows (the document, the company's header, every word in the
// row's language), and the fingerprint is its hash, so the same look is drawn once and reused,
// and a changed invoice (now paid) gets a new row. No baseColumns: the API writes a row, the
// worker finishes it.
export const documentFiles = pgTable(
  'document_files',
  {
    id: baseColumns().id,
    ...documentColumns(),
    // sha256 of the model (and the layout's version), in hex
    fingerprint: text('fingerprint').notNull(),
    // The page as the API worked it out (apps/api/src/documents/model.ts). The worker draws
    // exactly this, so the file always matches its fingerprint. Read back through a Zod schema.
    model: jsonb('model').notNull(),
    status: text('status', { enum: DOCUMENT_FILE_STATUSES }).notNull().default('pending'),
    // Who asked first. NULL when a customer opened a share link: they are not a user.
    requestedBy: uuid('requested_by').references(() => users.id),
    // Set by the worker when the file is in storage, as on report_exports
    fileName: text('file_name'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    storageKey: text('storage_key'),
    createdAt: baseColumns().createdAt,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // One row per look, so two clicks at once share one row and one job: the API inserts with
    // ON CONFLICT DO NOTHING and then reads the row. It is also the lookup "is this look drawn?"
    // and, by its first three columns, "every file of this document".
    uniqueIndex('document_files_look_idx').on(
      table.tenantId,
      table.kind,
      table.documentId,
      table.language,
      table.fingerprint,
    ),
    check(
      'document_files_ready_check',
      sql`${table.status} <> 'ready' OR (${table.fileName} IS NOT NULL AND ${table.contentType} IS NOT NULL AND ${table.sizeBytes} IS NOT NULL AND ${table.storageKey} IS NOT NULL AND ${table.finishedAt} IS NOT NULL)`,
    ),
  ],
);

// An email with a document's PDF attached, as the person wrote it in the dialog. The worker sends
// it; the document page lists them. The message is kept as typed, so the history can show what
// the customer was told.
export const documentEmails = pgTable(
  'document_emails',
  {
    id: baseColumns().id,
    ...documentColumns(),
    // Lowercase addresses, from the contract's list parsing
    to: text('to').array().notNull(),
    cc: text('cc')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text('subject').notNull(),
    message: text('message').notNull(),
    status: text('status', { enum: DOCUMENT_EMAIL_STATUSES }).notNull().default('pending'),
    sentBy: uuid('sent_by')
      .notNull()
      .references(() => users.id),
    createdAt: baseColumns().createdAt,
    // When the mail server took it
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    // The document's history, newest first (id is UUIDv7)
    index('document_emails_document_idx').on(
      table.tenantId,
      table.kind,
      table.documentId,
      table.id,
    ),
    // 5 = the contract's MAX_EMAIL_RECIPIENTS; 200 and 5000 = its subject and message limits.
    // cardinality(), not array_length(): an empty array has length NULL, and NULL passes a check.
    check(
      'document_emails_recipients_check',
      sql`cardinality(${table.to}) BETWEEN 1 AND 5 AND cardinality(${table.cc}) <= 5`,
    ),
    check(
      'document_emails_text_check',
      sql`char_length(${table.subject}) BETWEEN 1 AND 200 AND char_length(${table.message}) <= 5000`,
    ),
    check(
      'document_emails_sent_check',
      sql`(${table.status} = 'sent') = (${table.sentAt} IS NOT NULL)`,
    ),
  ],
);

// A link a customer opens without a login (/d/<token>). Like an invitation, only the token's
// SHA-256 is kept: the link is shown once, and a leaked database dump cannot be turned back into
// working links. A link is turned off (revoked_at), never deleted, so the list still shows it.
export const documentShares = pgTable(
  'document_shares',
  {
    id: baseColumns().id,
    ...documentColumns(),
    tokenHash: text('token_hash').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: baseColumns().createdAt,
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Set by the public page, so the list shows whether the customer opened it
    firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
  },
  (table) => [
    // The public page finds a link by its hash before it knows the workspace
    uniqueIndex('document_shares_token_hash_idx').on(table.tokenHash),
    // The document's links, newest first
    index('document_shares_document_idx').on(
      table.tenantId,
      table.kind,
      table.documentId,
      table.id,
    ),
    check('document_shares_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'document_shares_opened_check',
      sql`(${table.firstOpenedAt} IS NULL) = (${table.lastOpenedAt} IS NULL) AND (${table.firstOpenedAt} IS NULL OR ${table.firstOpenedAt} <= ${table.lastOpenedAt})`,
    ),
  ],
);
