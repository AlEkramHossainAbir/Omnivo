import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';

// Better Auth-এর `user` model এই টেবিলে map হয় (packages/auth দেখুন) —
// পাসওয়ার্ড এখানে না, accounts.password-এ থাকে
export const users = pgTable(
  'users',
  {
    ...baseColumns(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    fullName: text('full_name').notNull(), // TODO: Replace with firstName and lastName
    image: text('image'),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);
