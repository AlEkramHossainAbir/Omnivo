import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { users } from './users.js';

// Better Auth-এর `account` model — email/password লগইনে providerId = 'credential',
// আর password কলামে hash থাকে। পরে Google/SSO এলে একই ইউজারের আরেকটা রো হবে
export const accounts = pgTable(
  'accounts',
  {
    id: baseColumns().id,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
  },
  (table) => [
    uniqueIndex('accounts_provider_account_idx').on(table.providerId, table.accountId),
    index('accounts_user_idx').on(table.userId),
  ],
);
