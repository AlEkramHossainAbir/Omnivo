import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { preferencesSchema } from './preferences.js';
import { SETUP_STATUSES } from './setup.js';

// workspace-এর ঠিকানা হবে `{slug}.omnivo.app` — তাই DNS label-এর নিয়ম মানতে হবে।
// Exported (step 3b): the sign-in page checks the remembered workspace with it before sending it
// as a hint.
export const workspaceSlugFormat = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, errorCode('slug_too_short'))
  .max(32, errorCode('slug_too_long'))
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, errorCode('slug_format'));

// আমাদের নিজের সাবডোমেইনের জন্য রাখা নাম — কোনো টেন্যান্ট এগুলো নিতে পারবে না
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'blog',
  'docs',
  'help',
  'mail',
  'omnivo',
  'shop',
  'status',
  'www',
]);

export const newWorkspaceSlugSchema = workspaceSlugFormat.refine(
  (slug) => !RESERVED_SLUGS.has(slug),
  errorCode('slug_reserved'),
);

// trim/lowercase আগে, তারপর email যাচাই — ক্রম উল্টালে " A@b.com" ভুল হিসেবে ধরা পড়ত।
// export: invite-এর ইমেইলও ঠিক এই নিয়মে — নাহলে "Nasrin@…" invite হয়ে "nasrin@…" অ্যাকাউন্টে মিলত না
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email(errorCode('email_invalid')));

// Better Auth-এর maxPasswordLength ডিফল্ট 128 — দুই জায়গায় একই সীমা। invite নিয়ে নতুন অ্যাকাউন্টেও একই
export const newPasswordSchema = z
  .string()
  .min(8, errorCode('password_too_short'))
  .max(128, errorCode('password_too_long'));

// সাইনআপ আর সেটিংস দুই জায়গায় একই নিয়ম — কোম্পানির নাম tenants.name-এ বসে
export const companyNameSchema = z
  .string()
  .trim()
  .min(2, errorCode('company_name_required'))
  .max(120);

export const fullNameSchema = z.string().trim().min(2, errorCode('full_name_required')).max(120);

export const signUpInputSchema = z.object({
  companyName: companyNameSchema,
  workspaceSlug: newWorkspaceSlugSchema,
  fullName: fullNameSchema,
  email: emailSchema,
  password: newPasswordSchema,
});
export type SignUpInput = z.infer<typeof signUpInputSchema>;

// Sign-up makes the workspace but no session: the person must open the link in the email first.
// status is a literal, so a later answer of another kind can join it as a discriminated union.
// email: the address the link went to, as the API stored it (trimmed, lower case)
export const signUpResultSchema = z.object({
  status: z.literal('verify_email'),
  email: z.string(),
});
export type SignUpResult = z.infer<typeof signUpResultSchema>;

// The email's link: /verify-email#<token>. The token sits after the #, like an invitation's, so
// the browser never sends it to a server, and it is not in a log or a Referer header
export const VERIFY_EMAIL_PATH = '/verify-email';

export function verifyEmailLink(appOrigin: string, token: string): string {
  return `${appOrigin}${VERIFY_EMAIL_PATH}#${token}`;
}

// How long a link works. A day covers "I'll do it after lunch"; after it, signing in with the
// password sends a new link, so a late person is never stuck
export const EMAIL_VERIFICATION_TTL_HOURS = 24;

// The token is 32 random bytes in base64url (43 characters). The max only keeps a huge body out
export const verifyEmailInputSchema = z.object({
  token: z.string().min(1).max(200),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailInputSchema>;

export const resendVerificationInputSchema = z.object({
  email: emailSchema,
});
export type ResendVerificationInput = z.infer<typeof resendVerificationInputSchema>;

export const loginInputSchema = z.object({
  // Step 3b: a hint, not a demand. The server opens this workspace when the person belongs to
  // it, and ignores it otherwise. The sign-in page sends the workspace this browser used last.
  workspace: workspaceSlugFormat.optional(),
  email: emailSchema,
  password: z.string().min(1, errorCode('password_required')).max(128),
  keepSignedIn: z.boolean(),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const switchTenantInputSchema = z.object({
  tenantId: z.uuid(),
});
export type SwitchTenantInput = z.infer<typeof switchTenantInputSchema>;

// sign-up/login/refresh/switch-tenant সবগুলোর response — refresh token এখানে নেই, সেটা শুধু cookie-তে
export const authSessionSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export const meResponseSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), fullName: z.string() }),
  // setupStatus: the app sends an owner to the onboarding wizard while it is 'pending'
  tenant: z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    setupStatus: z.enum(SETUP_STATUSES),
  }),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  memberships: z.array(z.object({ tenantId: z.uuid(), name: z.string(), slug: z.string() })),
  preferences: preferencesSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const authRoutes = {
  signUp: defineRoute({
    method: 'POST',
    path: '/auth/sign-up',
    summary: 'Create a workspace and its owner, and email the link that confirms the address',
    auth: 'public',
    status: 201,
    body: signUpInputSchema,
    response: signUpResultSchema,
  }),
  // The email's link. Public: the person has no session yet; the token is the proof
  verifyEmail: defineRoute({
    method: 'POST',
    path: '/auth/verify-email',
    summary: 'Confirm the email address with the link’s token, and start a session',
    auth: 'public',
    status: 200,
    body: verifyEmailInputSchema,
    response: authSessionSchema,
  }),
  // Always 204, whether the address has an account or not: the answer must not tell a stranger
  // which addresses are signed up
  resendVerification: defineRoute({
    method: 'POST',
    path: '/auth/resend-verification',
    summary: 'Email a new confirmation link, when the address waits for one',
    auth: 'public',
    status: 204,
    body: resendVerificationInputSchema,
    response: z.void(),
  }),
  login: defineRoute({
    method: 'POST',
    path: '/auth/login',
    summary: 'Sign in with an email and a password, into the hinted or the last-used workspace',
    auth: 'public',
    status: 200,
    body: loginInputSchema,
    response: authSessionSchema,
  }),
  // access token-এর মেয়াদ শেষ হতে পারে, তাই public — প্রমাণ শুধু httpOnly refresh cookie
  refresh: defineRoute({
    method: 'POST',
    path: '/auth/refresh',
    summary: 'Rotate the refresh cookie and issue a new access token',
    auth: 'public',
    status: 200,
    response: authSessionSchema,
  }),
  switchTenant: defineRoute({
    method: 'POST',
    path: '/auth/switch-tenant',
    summary: 'Move the session into another workspace the user belongs to',
    auth: 'bearer',
    status: 200,
    body: switchTenantInputSchema,
    response: authSessionSchema,
  }),
  logout: defineRoute({
    method: 'POST',
    path: '/auth/logout',
    summary: 'End the session behind the refresh cookie',
    auth: 'public',
    status: 204,
    response: z.void(),
  }),
  me: defineRoute({
    method: 'GET',
    path: '/auth/me',
    summary: 'The signed-in user, the active workspace and its permissions',
    auth: 'bearer',
    status: 200,
    response: meResponseSchema,
  }),
};
