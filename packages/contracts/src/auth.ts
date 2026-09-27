import { z } from 'zod';

// workspace-এর ঠিকানা হবে `{slug}.omnivo.app` — তাই DNS label-এর নিয়ম মানতে হবে
const workspaceSlugFormat = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Use at least 3 letters or numbers.')
  .max(32, 'Use 32 characters or fewer.')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase letters, numbers and single hyphens, like rahman-garments.',
  );

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
  'This address is reserved. Try adding your city, like rahman-gazipur.',
);

// trim/lowercase আগে, তারপর email যাচাই — ক্রম উল্টালে " A@b.com" ভুল হিসেবে ধরা পড়ত
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter an email like name@company.com.'));

// Better Auth-এর maxPasswordLength ডিফল্ট 128 — দুই জায়গায় একই সীমা
const newPasswordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(128, 'Use 128 characters or fewer.');

export const signUpInputSchema = z.object({
  companyName: z.string().trim().min(2, 'Enter your company name.').max(120),
  workspaceSlug: newWorkspaceSlugSchema,
  fullName: z.string().trim().min(2, 'Enter your full name.').max(120),
  email: emailSchema,
  password: newPasswordSchema,
});
export type SignUpInput = z.infer<typeof signUpInputSchema>;

export const loginInputSchema = z.object({
  workspace: workspaceSlugFormat,
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(128),
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
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const memberListResponseSchema = z.object({
  members: z.array(
    z.object({
      membershipId: z.uuid(),
      userId: z.uuid(),
      fullName: z.string(),
      email: z.string(),
      roles: z.array(z.string()),
    }),
  ),
});
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;

// Nest-এর built-in exception ({ statusCode, message, error }) আর আমাদের validation error
// ({ ..., fieldErrors }) — দুটোই এই আকারে মেলে
export const apiErrorSchema = z.object({
  statusCode: z.number(),
  message: z.string(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;