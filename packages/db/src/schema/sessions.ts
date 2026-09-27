import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { users } from './users.js';

// Better Auth-এর `session` model — প্রতিটা লগইন (একটা ডিভাইস) একটা রো।
// global টেবিল (tenant_id নেই), তাই RLS নেই
export const sessions = pgTable(
  'sessions',
  {
    id: baseColumns().id,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
  },
  (table) => [
    uniqueIndex('sessions_token_idx').on(table.token),
    index('sessions_user_idx').on(table.userId),
  ],
);