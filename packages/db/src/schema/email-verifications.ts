import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sessions } from './sessions.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// The link that confirms a new owner's email address. One row per person, made at sign-up (or at a
// sign-in of an account that has none, see AuthService.login), and kept after it is used:
// verified_at says when. A global table like users (no tenant_id of its own, so no RLS).
//
// The link's token is never stored, only its SHA-256, like an invitation's and a refresh token's:
// a leaked database dump cannot open anyone's account.
export const emailVerifications = pgTable(
  'email_verifications',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The workspace the link opens: the one the person just created
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // The sign-in the link finishes. Sign-up (and a refused sign-in) makes a Better Auth session
    // but gives out no token for it; opening the link does. NULL once that session is gone
    // (signed out everywhere, or expired): the link then confirms the address, and the person
    // signs in with the password.
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    // NULL until the worker makes the link, like invitations.token_hash: the token is created
    // right before the email goes out, so it never sits in the outbox or in a queue. A new link
    // sets it back to NULL first, which kills the old one at once. NULL again once used.
    tokenHash: text('token_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Set by the worker once the mail server has taken the email
    sentAt: timestamp('sent_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // The link's lookup: by the token's hash, before anyone is known. Unique, and many NULLs are allowed
  (table) => [uniqueIndex('email_verifications_token_hash_idx').on(table.tokenHash)],
);
