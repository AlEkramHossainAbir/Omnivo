import { LANGUAGE_CODES, THEMES } from '@omnivo/contracts';
import { boolean, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

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
    // ইউজারের পছন্দ — টেন্যান্টের না, তাই এখানে (users-এ RLS নেই, প্রতিটা workspace-এ একই)।
    // language NULL = এখনো বাছেনি; তখন ডিভাইসে যা চলছে তাই থাকে
    language: text('language', { enum: LANGUAGE_CODES }),
    theme: text('theme', { enum: THEMES }).notNull().default('system'),
    // Step 3b: the workspace this person signed in to, or switched to, last. Sign-in opens it
    // when the browser sends no usable hint. A pointer, not a grant: sign-in checks the
    // membership again every time, so a stale value can never let anyone in.
    lastTenantId: uuid('last_tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);
