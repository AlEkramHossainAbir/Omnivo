import { z } from 'zod';

import { authSessionSchema, emailSchema, fullNameSchema, newPasswordSchema } from './auth.js';
import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { roleRefSchema } from './members.js';

// ইমেইলের লিংক: {APP_ORIGIN}/invite#<token>। token path বা query-তে না, # (fragment)-এর পরে — ব্রাউজার
// fragment কখনো সার্ভারে পাঠায় না, তাই app-এর hosting/CDN-এর access log-এ বা Referer header-এ token
// লেখা হয় না। API (ইমেইল লেখে) আর app (পেজ পড়ে) দুজনেই এই ফাংশন থেকে, তাই path কখনো আলাদা হয় না
export const INVITE_PATH = '/invite';

export function invitationLink(appOrigin: string, token: string): string {
  return `${appOrigin}${INVITE_PATH}#${token}`;
}

// এক সপ্তাহ: সাপ্তাহিক ছুটি পেরিয়েও কাজ করে, আবার পুরনো ইমেইলে পড়ে থাকা লিংক চিরকাল খোলা থাকে না
export const INVITATION_TTL_DAYS = 7;

// Where the email is. The worker sends it after the request has finished (outbox, step 8):
// sending = queued or being retried, sent = the mail server took it, failed = the worker gave up
// after its retries. Resend starts again from sending.
export const INVITATION_DELIVERIES = ['sending', 'sent', 'failed'] as const;
export type InvitationDelivery = (typeof INVITATION_DELIVERIES)[number];

export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  roles: z.array(roleRefSchema),
  // null = যিনি পাঠিয়েছিলেন তাঁর অ্যাকাউন্ট আর নেই
  invitedBy: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
  delivery: z.enum(INVITATION_DELIVERIES),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  version: z.number().int(),
});
export type Invitation = z.infer<typeof invitationSchema>;

// শুধু খোলা invitation (গৃহীত বা বাতিল না) — মেয়াদ পেরোনোগুলোও, যাতে "Expired · Resend" দেখা যায়
export const invitationListSchema = z.object({ items: z.array(invitationSchema) });

export const createInvitationInputSchema = z.object({
  email: emailSchema,
  // রোল ছাড়া invite মানে লোকটা ঢুকে কিছুই দেখবে না — সেটা প্রায় সবসময় ভুল, তাই অন্তত একটা
  roleIds: z.array(z.uuid()).min(1, errorCode('role_required')).max(10),
});
export type CreateInvitationInput = z.infer<typeof createInvitationInputSchema>;

export const invitationVersionInputSchema = z.object({ version: versionSchema });

export const revokeInvitationQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// 32 random byte-এর base64url = ৪৩ অক্ষর। সীমা ঢিলা রাখা, কিন্তু ১ MB-র "token" parse করতে দেওয়া না
const invitationTokenSchema = z.string().min(32).max(128);

export const invitationLookupInputSchema = z.object({ token: invitationTokenSchema });

// লিংক খুললে দেখানোর মতো যা লাগে, তার বেশি না
export const invitationPreviewSchema = z.object({
  workspace: z.object({ name: z.string(), slug: z.string() }),
  email: z.string(),
  invitedBy: z.string().nullable(),
  // এই ইমেইলে আগে থেকেই Omnivo অ্যাকাউন্ট আছে কি না — থাকলে শুধু পাসওয়ার্ড, না থাকলে নাম + নতুন
  // পাসওয়ার্ড। token-এর মালিক শুধু নিজের ইমেইলের কথাই জানে, অন্য কারো না
  accountExists: z.boolean(),
  expiresAt: z.iso.datetime(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

// দুই রকম গ্রহণ, 'account' দিয়ে আলাদা। ইমেইল কোনোটাতেই নেই ইচ্ছা করে: সেটা invitation থেকে আসে —
// ক্লায়েন্ট অন্য ইমেইল পাঠিয়ে অন্য কারো অ্যাকাউন্টে invitation বসাতে পারে না
export const acceptInvitationInputSchema = z.discriminatedUnion('account', [
  z.object({
    account: z.literal('new'),
    token: invitationTokenSchema,
    fullName: fullNameSchema,
    password: newPasswordSchema,
  }),
  z.object({
    account: z.literal('existing'),
    token: invitationTokenSchema,
    password: z.string().min(1, errorCode('password_required')).max(128),
  }),
]);
export type AcceptInvitationInput = z.infer<typeof acceptInvitationInputSchema>;

const invitationParamsSchema = z.object({ id: z.uuid() });

export const invitationRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/invitations',
    summary: 'Open invitations of the active workspace, newest first',
    auth: 'bearer',
    permission: 'core.user.invite',
    status: 200,
    response: invitationListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/invitations',
    summary: 'Invite someone by email, with the roles they get on joining',
    auth: 'bearer',
    permission: 'core.user.invite',
    status: 201,
    body: createInvitationInputSchema,
    response: invitationSchema,
  }),
  resend: defineRoute({
    method: 'POST',
    path: '/invitations/:id/resend',
    summary: 'Send a fresh link; the old one stops working',
    auth: 'bearer',
    permission: 'core.user.invite',
    status: 200,
    params: invitationParamsSchema,
    body: invitationVersionInputSchema,
    response: invitationSchema,
  }),
  revoke: defineRoute({
    method: 'DELETE',
    path: '/invitations/:id',
    summary: 'Cancel an invitation before it is accepted',
    auth: 'bearer',
    permission: 'core.user.invite',
    status: 204,
    params: invitationParamsSchema,
    query: revokeInvitationQuerySchema,
    response: z.void(),
  }),
  // public, আর GET না: token URL-এ গেলে API-র access log-এ লেখা হতো। POST body log হয় না
  lookup: defineRoute({
    method: 'POST',
    path: '/invitations/lookup',
    summary: 'Show which workspace an invitation link is for',
    auth: 'public',
    status: 200,
    body: invitationLookupInputSchema,
    response: invitationPreviewSchema,
  }),
  // সফল হলে লগইনের মতোই session শুরু — refresh cookie + access token
  accept: defineRoute({
    method: 'POST',
    path: '/invitations/accept',
    summary: 'Join the workspace, creating an account if needed, and start a session',
    auth: 'public',
    status: 200,
    body: acceptInvitationInputSchema,
    response: authSessionSchema,
  }),
};
