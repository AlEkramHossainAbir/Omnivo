import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';

// Better Auth-এর `verification` model — ইমেইল যাচাই আর পাসওয়ার্ড রিসেটের এককালীন টোকেন
export const verifications = pgTable(
  'verifications',
  {
    id: baseColumns().id,
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);
