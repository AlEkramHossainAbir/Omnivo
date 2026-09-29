import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { preferencesSchema } from './preferences.js';

// workspace-এর ঠিকানা হবে `{slug}.omnivo.app` — তাই DNS label-এর নিয়ম মানতে হবে
const workspaceSlugFormat = z
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

// trim/lowercase আগে, তারপর email যাচাই — ক্রম উল্টালে " A@b.com" ভুল হিসেবে ধরা পড়ত
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email(errorCode('email_invalid')));

// Better Auth-এর maxPasswordLength ডিফল্ট 128 — দুই জায়গায় একই সীমা
const newPasswordSchema = z
  .string()
  .min(8, errorCode('password_too_short'))
  .max(128, errorCode('password_too_long'));

// সাইনআপ আর সেটিংস দুই জায়গায় একই নিয়ম — কোম্পানির নাম tenants.name-এ বসে
export const companyNameSchema = z
  .string()
  .trim()
  .min(2, errorCode('company_name_required'))
  .max(120);

export const signUpInputSchema = z.object({
  companyName: companyNameSchema,
  workspaceSlug: newWorkspaceSlugSchema,
  fullName: z.string().trim().min(2, errorCode('full_name_required')).max(120),
  email: emailSchema,
  password: newPasswordSchema,
});
export type SignUpInput = z.infer<typeof signUpInputSchema>;

export const loginInputSchema = z.object({
  workspace: workspaceSlugFormat,
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
  tenant: z.object({ id: z.uuid(), name: z.string(), slug: z.string() }),
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
    summary: 'Create a workspace and its owner, and start a session',
    auth: 'public',
    status: 201,
    body: signUpInputSchema,
    response: authSessionSchema,
  }),
  login: defineRoute({
    method: 'POST',
    path: '/auth/login',
    summary: 'Sign in to a workspace',
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
