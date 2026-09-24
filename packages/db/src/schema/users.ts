import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';

export const users = pgTable(
  'users',
  {
    ...baseColumns(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    fullName: text('full_name').notNull(), // TODO: Replace with firstName and lastName
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);
