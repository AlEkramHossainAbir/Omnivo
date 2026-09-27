import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { sessions } from './sessions.js';
import { tenants } from './tenants.js';

// আমাদের নিজের টেবিল (Better Auth-এর না): প্রতিবার refresh-এ নতুন রো, পুরনোটায় used_at বসে।
// একই session-এর সব রো মিলে একটা "family" — পুরনো টোকেন আবার এলে পুরো session মুছে যায়
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: baseColumns().id,
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    // tenant_id নাম ইচ্ছাকৃতভাবে না: এটা RLS-এর tenant কলাম না, শুধু "এই ডিভাইস এখন কোন টেন্যান্টে"
    activeTenantId: uuid('active_tenant_id')
      .notNull()
      .references(() => tenants.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: baseColumns().createdAt,
  },
  (table) => [
    uniqueIndex('refresh_tokens_token_hash_idx').on(table.tokenHash),
    index('refresh_tokens_session_idx').on(table.sessionId),
  ],
);