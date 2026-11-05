import { sql } from 'drizzle-orm';
import { foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { roles } from './roles.js';
import { tenants } from './tenants.js';

// কাউকে workspace-এ ডাকা। কে ডেকেছে = created_by (baseColumns)। লিংকের token নিজে কোথাও রাখা হয় না,
// শুধু তার SHA-256 — refresh token-এর মতোই (ধাপ ৩): DB dump লিক হলেও কেউ সেখান থেকে লিংক বানাতে পারে না
export const invitations = pgTable(
  'invitations',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // contracts-এর emailSchema-র পরে — ছোট হাতে, তাই users.email-এর সাথে সরাসরি মেলে
    email: text('email').notNull(),
    // NULL until the worker makes the link (step 8): the token is created right before the email
    // goes out, so it never sits in the outbox or in a queue. Resend sets it back to NULL, which
    // kills the old link at once. A unique index allows many NULLs.
    tokenHash: text('token_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Set by the worker once the mail server has taken the email
    sentAt: timestamp('sent_at', { withTimezone: true }),
    // Set by the worker when it gives up after its retries — the app shows "Email not sent"
    sendFailedAt: timestamp('send_failed_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // public lookup/accept token দিয়ে খোঁজে (টেন্যান্ট জানার আগে) — অনন্য, আর index ছাড়া পুরো টেবিল পড়ত
    uniqueIndex('invitations_token_hash_idx').on(table.tokenHash),
    // invitation_roles-এর composite FK-এর target
    uniqueIndex('invitations_tenant_id_idx').on(table.tenantId, table.id),
    // একটা ইমেইলে একসাথে একটাই খোলা invitation: দুজন admin একসাথে একই লোককে ডাকলে দুটো লিংক আর
    // দুই রকম রোল তৈরি হতো। গৃহীত বা বাতিল হলে আবার ডাকা যায়
    uniqueIndex('invitations_tenant_email_open_idx')
      .on(table.tenantId, table.email)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  ],
);

// invitation গ্রহণ করলে যে রোলগুলো পাবে। uuid[] কলামের বদলে আলাদা টেবিল: FK দিয়ে DB নিজেই নিশ্চিত
// করে যে রোলগুলো একই টেন্যান্টের আর সত্যিই আছে (array-র ভেতরের মানে FK হয় না)
export const invitationRoles = pgTable(
  'invitation_roles',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    invitationId: uuid('invitation_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (table) => [
    uniqueIndex('invitation_roles_tenant_invitation_role_idx').on(
      table.tenantId,
      table.invitationId,
      table.roleId,
    ),
    // cascade দুই দিকেই: রোল মোছার আগে service দেখে নেয় কোনো খোলা invitation সেটা চায় কি না;
    // পুরনো (গৃহীত/বাতিল) invitation-এর রো রোলটাকে চিরকাল আটকে রাখবে না
    foreignKey({
      name: 'invitation_roles_invitation_fk',
      columns: [table.tenantId, table.invitationId],
      foreignColumns: [invitations.tenantId, invitations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'invitation_roles_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }).onDelete('cascade'),
  ],
);
