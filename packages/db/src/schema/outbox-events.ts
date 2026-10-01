import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// Every event the API can hand to the worker. Named as facts ("this happened"), not as orders:
// the worker decides what to do about each one. Server-only, so the list lives here and not in
// contracts — the browser never sees an outbox event.
export const OUTBOX_EVENT_TYPES = [
  'workspace.created',
  'workspace.setup_requested',
  'invitation.issued',
  'member.joined',
  'workspace.chart_requested',
] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

// The transactional outbox (system-design §5.5). The API inserts a row in the SAME transaction as
// the change itself, so both commit or neither does. The worker's relay later reads new rows and
// puts them on the queue. No baseColumns: a row is written once and never edited by the app.
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // $type: plain text in the DB (an old row survives a renamed type), but code can only write
    // a type from the list above
    type: text('type').$type<OutboxEventType>().notNull(),
    // Ids only (which invitation, which user), never copies of data or secrets. The worker reads
    // the current rows when it runs, and the API layer checks the shape with a Zod schema.
    payload: jsonb('payload').notNull(),
    // The HTTP request that caused the event. The worker writes it into its audit rows, so one
    // click can be followed from the request to everything that happened in the background.
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // NULL = not on the queue yet. The relay sets it in the same transaction that claimed the row.
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    // The relay's only query: the oldest unpublished rows across ALL tenants. That is why this
    // index does not start with tenant_id, unlike every other index. Partial: published rows (all
    // but a handful) are not in it, so it stays tiny however big the table grows.
    index('outbox_events_unpublished_idx')
      .on(table.createdAt, table.id)
      .where(sql`${table.publishedAt} IS NULL`),
  ],
);
