import type { NotificationParams, NotificationType } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// In-app notifications: one row per person. Stored as a type plus plain values, never as a
// sentence, so the app shows each one in the reader's own language.
export const notifications = pgTable(
  'notifications',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Who sees it. The same person in another workspace does not: tenant RLS hides the row.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type').$type<NotificationType>().notNull(),
    params: jsonb('params').$type<NotificationParams>().notNull().default({}),
    // The outbox event that created it. The worker may run a job twice (a retry after a crash), so
    // the unique index below turns the second insert into a no-op instead of a duplicate.
    eventId: uuid('event_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The bell's list: one person's rows, newest first, keyset on (created_at, id)
    index('notifications_tenant_user_created_idx').on(
      table.tenantId,
      table.userId,
      table.createdAt,
      table.id,
    ),
    // The unread count, polled every 30 seconds by every open tab. Partial: read rows (most of
    // them after a while) are not in it, so the count reads a few index entries.
    index('notifications_tenant_user_unread_idx')
      .on(table.tenantId, table.userId)
      .where(sql`${table.readAt} IS NULL`),
    // Idempotency. NULL event ids never clash, so a notification made without an event is fine.
    uniqueIndex('notifications_tenant_event_user_idx').on(
      table.tenantId,
      table.eventId,
      table.userId,
    ),
  ],
);
