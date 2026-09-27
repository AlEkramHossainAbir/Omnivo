# ধাপ ৩: Auth + RBAC + প্রথম দৃশ্যমান স্ক্রিন

> [build-plan.bn.md](build-plan.bn.md)-এর "ধাপ ৩" অংশের ইমপ্লিমেন্টেশন গাইড — ঠিক কোন ফাইলে কী
> লিখতে হবে, কোন কমান্ড কোথায় চালাতে হবে।
>
> এই গাইডের প্রতিটা ফাইল রিপোর একটা আলাদা কপিতে বসিয়ে যাচাই করা (২০২৬-০৯-২৭), `dist` মুছে একদম
> শুরু থেকে: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`
> (১৬টা টেস্ট), `pnpm test:integration` (Testcontainers-এ ১৯টা), `pnpm test:tenant-leak` (৯টা),
> `pnpm build`, `pnpm boundaries`, `pnpm dev` — সব পাস। তারপর headless Chrome-এ আসল ব্রাউজার flow:
> sign-up → ড্যাশবোর্ড → reload-এ session ফেরত → sign-out → ভুল পাসওয়ার্ড → লগইন → মেয়াদোত্তীর্ণ
> access token-এ নিজে থেকে refresh → tenant switch → API বন্ধ থাকলে লগইন পেজ; ডেস্কটপ আর মোবাইল
> (dark mode) দুটোতেই। নিরাপত্তার মূল টেস্টগুলো mutation দিয়েও যাচাই করা — কোড ইচ্ছা করে ভাঙলে টেস্ট
> fail করে (বিস্তারিত ৩.৮-এ)।

## লক্ষ্য

🎉 **সাইনআপ → লগইন → নিজের টেন্যান্টের খালি ড্যাশবোর্ড।** পেছনে যা তৈরি হবে:

- Better Auth দিয়ে ইউজার, পাসওয়ার্ড hash আর লগইন session — `packages/auth` facade-এর আড়ালে।
- নিজেদের JWT access token (`tenant_id`, `membership_id`, `roles[]` সহ) আর প্রতিবার বদলানো
  (rotating) refresh token, httpOnly cookie-তে।
- `@RequirePermission('core.user.read')` decorator, permission cache Valkey (Redis)-এ।
- ধাপ ২-এর `x-tenant-id` header বাদ — টেন্যান্ট আসবে শুধু যাচাই করা টোকেন থেকে।
- ফ্রন্টএন্ডে লগইন/সাইনআপ পেজ, TanStack Router-এ protected route, Zustand auth store, টোকেন
  refresh interceptor আর tenant switcher।

## পুরো ছবিটা এক নজরে

```
ব্রাউজার (apps/app)                        API (apps/api)                           Postgres / Valkey
──────────────────                         ──────────────                           ─────────────────
POST /auth/login ─────────────────────▶    AuthService.login
{ workspace, email, password }             ├─ slug → tenants                 ───▶   tenants (RLS নেই)
                                           ├─ auth.signIn() (Better Auth)     ───▶   users + accounts (hash)
                                           │                                        sessions ← নতুন রো
                                           ├─ findMembership() (withTenant)  ───▶   memberships, roles (RLS)
                                           └─ auth.issueTokens()             ───▶   refresh_tokens ← শুধু hash
◀── 200 { accessToken } + Set-Cookie: omnivo_rt (HttpOnly; SameSite=Strict; Path=/auth)

GET /members ─────────────────────────▶    AuthMiddleware: JWT যাচাই → AsyncLocalStorage-এ principal
Authorization: Bearer <accessToken>        AuthGuard: principal নেই → 401
                                           PermissionGuard: core.user.read আছে? ─▶  Valkey t:{tenant}:perm:{user}
                                                                                    (না থাকলে DB → cache)
                                           handler → withTenant → RLS

১৫ মিনিট পর 401 ──▶ POST /auth/refresh (শুধু cookie) → পুরনো টোকেনে used_at, নতুন টোকেন + নতুন cookie
                    পুরনো টোকেন আবার এলে → পুরো session মুছে যায় (reuse মানে চুরি)
```

## এই ধাপের ভিত্তি-সিদ্ধান্ত

1. **Better Auth শুধু "এই মানুষটা কে" বলে।** ইউজার তৈরি, পাসওয়ার্ড hash (scrypt), পাসওয়ার্ড যাচাই,
   আর প্রতিটা লগইনের জন্য `sessions` টেবিলে একটা রো — এটুকুই। Better Auth-এর নিজস্ব HTTP handler
   (`/api/auth/*`) mount করা হয়নি; `packages/auth` সার্ভারের ভেতর থেকে `signUpEmail()` /
   `signInEmail()` ডাকে। তাই Better Auth-এর কোনো endpoint বা cookie বাইরে যায় না, আর ADR 0002-এর
   facade নিয়ম শুধু কাগজে না, কোডেই বাধ্যতামূলক হয়ে যায়।
2. **দুই রকম টোকেন।**
   - **access token:** ১৫ মিনিটের JWT (HS256, `jose` লাইব্রেরি), থাকে শুধু ব্রাউজারের memory-তে।
   - **refresh token:** 256-bit random string, থাকে শুধু `HttpOnly; SameSite=Strict; Path=/auth`
     cookie-তে, আর DB-তে শুধু তার SHA-256 hash।

   প্রতিটা refresh-এ নতুন টোকেন দেওয়া হয় (rotation); পুরনোটা আবার এলে পুরো session বাতিল হয়
   (reuse detection)। Better Auth নিজে এটা দেয় না — ওর session token কখনো বদলায় না (যাচাই করা: 1.7.6-এর
   কোডে "rotation" আছে শুধু JWT plugin-এর signing key আর `secrets`-এর জন্য, session/refresh token-এর
   জন্য না)। ADR 0002-এর "Consequences" অংশেও লেখা
   আছে যে rotation আর reuse detection আমাদের দায়িত্ব। Better Auth-এর `sessions` রো এখানে "family"-র
   কাজ করে: একই লগইনের সব refresh token সেই রো-র সাথে বাঁধা, রো মুছলে cascade-এ সব টোকেনও মুছে যায়।
3. **লগইন workspace-নির্দিষ্ট।** অনুমোদিত Sign In mockup-এ "Workspace" ফিল্ড আছে
   (`rahman-garments` + `.omnivo.app`)। তাই `POST /auth/login` slug থেকে টেন্যান্ট বের করে, সেখানে
   membership যাচাই করে, আর টোকেনে সেই টেন্যান্টের `tenant_id` বসায়। একাধিক workspace-এর ইউজার
   পরে switcher দিয়ে অন্যটায় যায়।
4. **টেন্যান্ট শুধু যাচাই করা টোকেন থেকে।** ধাপ ২-এর `x-tenant-id` header পুরোপুরি বাদ
   (system-design §৪.৩: "টেন্যান্ট আসবে শুধু যাচাই করা টোকেন থেকে")। header পাঠালেও কিছু হয় না —
   টেস্টে সেটাও প্রমাণ করা হয়েছে।
5. **ডিফল্টে সব বন্ধ (deny by default)।** `AuthGuard` global — প্রতিটা নতুন রুট নিজে থেকেই লগইন চায়,
   খোলা রাখতে হলে `@Public()` লিখতে হয়। কেউ কিছু লিখতে ভুলে গেলে ফল হয় 401, অর্থাৎ নিরাপদ দিকে
   ভুল হয়, ডেটা leak হয় না।
6. **Permission-এর আসল উৎস DB, Redis শুধু cache।** টোকেনের `roles[]` claim শুধু তথ্যের জন্য
   (UI, আর ভবিষ্যতে IdP-সঙ্গতি)। অধিকার যাচাই হয় membership → role → permission থেকে। ফলাফল Valkey-তে
   `t:{tenant_id}:perm:{user_id}` key-তে ১০ মিনিট থাকে (key ফরম্যাট system-design §৪.৫ থেকে)।
7. **`packages/contracts` এখনই শুরু।** build-plan-এ এটা ধাপ ৫-এর কাজ, কিন্তু auth-এর request আর
   response-এর Zod schema API (validation) আর app (ফর্ম validation + response parse) দুজনেরই লাগছে।
   দুই জায়গায় আলাদা টাইপ না লিখে একটাই উৎস (rule ২)। ধাপ ৫-এ এই প্যাকেজেই OpenAPI/codegen যোগ হবে।
8. **ফ্রন্টএন্ডের design token আপাতত `apps/app`-এ।** CLAUDE.md-এর token, font আর Tailwind wiring
   এই ধাপেই লাগছে, কারণ auth স্ক্রিনকেও design system মানতে হবে। ধাপ ৪-এ `packages/ui` তৈরি হলে
   `styles.css` আর `components/` সেখানে সরে যাবে।

## এই ধাপে যা ইচ্ছাকৃতভাবে নেই

| জিনিস | কেন এখন না / কখন আসবে |
|---|---|
| Sign-up wizard-এর Industry, Modules, Fiscal year ধাপ | onboarding wizard — ধাপ ৮-এ, provisioning job-এর সাথে। এখন শুধু "Your account" অংশের ফিল্ড + কোম্পানির নাম আর ঠিকানা |
| Email verification, "Forgot password?" | ইমেইল পাঠানো (Mailpit) আসে ধাপ ৮-এ; `verifications` টেবিল এখনই তৈরি হচ্ছে যাতে তখন migration না লাগে |
| লগইন/সাইনআপ-এ rate limit | ADR 0002 অনুযায়ী beta-র আগে বাধ্যতামূলক — শেষের "নোট" অংশ দেখুন |
| "Sign in with company SSO" বাটন | SAML আসবে IdP-তে সরানোর পর (ADR 0002 "When to revisit") |
| Audit log-এ লগইন লেখা | audit interceptor — ধাপ ৬ |
| ইউজার invite, রোল বদলানো | ধাপ ৭ (তখন `PermissionService.invalidate()` ডাকতে হবে) |
| পুরনো refresh token রো মুছে ফেলার job | background worker আসে ধাপ ৮-এ |
| সাবডোমেইন থেকে টেন্যান্ট চেনা (`acme.omnivo.app`) | deploy/DNS সেটআপের সাথে; এখন workspace ফর্মে লেখা হয় |

## আগের কোড থেকে যা বাদ বা বদল হচ্ছে

- `apps/api/src/common/tenant/tenant.middleware.ts`, `tenant.guard.ts`, `tenant.middleware.spec.ts`
  — **মুছে ফেলুন।** header-ভিত্তিক tenant-এর জায়গায় আসছে `auth/auth.middleware.ts`, global
  `auth/auth.guard.ts` আর `auth/auth.middleware.spec.ts`। ধাপ ২-এর middleware-এর TODO ঠিক এটাই
  বলেছিল।
- `users.password_hash` কলাম — **বাদ** (migration 0006)। পাসওয়ার্ড এখন Better Auth-এর
  `accounts.password`-এ। দুই জায়গায় থাকলে কোনটা আসল সেই প্রশ্ন উঠত (ADR 0002 "Consequences")।
- `packages/db/src/seed.ts`-এর নিজস্ব `PERMISSIONS` তালিকা — **বাদ**, এখন আসবে
  `permission-catalog.ts` থেকে।
- `apps/app/src/App.tsx` — **মুছে ফেলুন**, router তার জায়গা নেয়।
- `apps/api/src/main.ts`-এর হার্ডকোড করা `3000` → config-এর `PORT` (ডিফল্ট 3000)।
- ADR 0002-এ facade-এর উদাহরণ হিসেবে `getSession()`, `getPrincipal()`, `issueTokens()` নাম আছে।
  এখানে `getPrincipal()` আর `issueTokens()` হুবহু আছে; `getSession()`-এর কাজটা করে
  `rotateRefreshToken()`, কারণ আমাদের refresh token-ই session-এর হাতল। ADR-এর কথাটা উদাহরণ ছিল,
  কড়া তালিকা না — চাইলে ADR-এ এক লাইনে এটা লিখে রাখতে পারেন।

---

## ৩.১ — ডাটাবেস: Better Auth-এর টেবিল, refresh token আর permission catalog

Better Auth-এর চারটা "model" আছে: `user`, `session`, `account`, `verification`। `user`-কে আমাদের
বিদ্যমান `users` টেবিলে map করা হবে; বাকি তিনটা নতুন টেবিল। সাথে আমাদের নিজেদের `refresh_tokens`।

এই পাঁচটা টেবিলই **global** — কোনোটায় `tenant_id` নেই, তাই RLS-ও নেই। কারণ লগইন হয় টেন্যান্ট জানার
আগে, আর একটা লগইন session কোনো এক টেন্যান্টের সম্পত্তি না (switcher দিয়ে একই session একাধিক
টেন্যান্টে যায়)।

> **migration দুই ধাপে তৈরি হবে, একবারে না।** একই রানে drizzle-kit যদি দেখে একটা কলাম মুছছে
> (`password_hash`) আর অন্য কলাম যোগ হচ্ছে (`email_verified`, `image`), তাহলে জিজ্ঞেস করে "এটা কি
> rename?"। এটা interactive প্রশ্ন — TTY ছাড়া চালালে crash করে (যাচাই করা: `Interactive prompts
> require a TTY terminal`), আর terminal-এ ভুল উত্তর দিলে rename-এর SQL তৈরি হয়ে যেত। তাই আগে শুধু
> যোগ (ধাপ A), তারপর শুধু মোছা (ধাপ B) — কোনোটাতেই প্রশ্ন আসে না, SQL সবসময় একই।

### ধাপ A — যোগ

**ফাইল: `packages/db/src/schema/users.ts`** (আপডেট — ধাপ A-তে `passwordHash` লাইনটা **রেখে দিন**)

```ts
import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';

// Better Auth-এর `user` model এই টেবিলে map হয় (packages/auth দেখুন) —
// পাসওয়ার্ড এখানে না, accounts.password-এ থাকে
export const users = pgTable(
  'users',
  {
    ...baseColumns(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'), // ধাপ B-তে এই লাইন মুছবেন
    emailVerified: boolean('email_verified').notNull().default(false),
    fullName: text('full_name').notNull(), // TODO: Replace with firstName and lastName
    image: text('image'),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);
```

**কোন লাইন কেন:**

- `boolean` import — নতুন `emailVerified` কলামের জন্য।
- `emailVerified: boolean('email_verified').notNull().default(false)` — Better Auth-এর user model-এ
  `emailVerified` আবশ্যিক ফিল্ড। না থাকলে drizzle adapter `The field "emailVerified" does not exist in
  the "user" Drizzle schema` error দেয়। `default(false)` দেওয়ায় `NOT NULL` কলাম যোগ করার সময় পুরনো
  রো-তে (যেমন seed-এর Acme admin) নিজে থেকে `false` বসে, migration ভাঙে না।
- `image: text('image')` — Better Auth-এর user model-এর ঐচ্ছিক ফিল্ড (প্রোফাইল ছবি), তাই nullable।
- `fullName`-এর নাম বদলানো হয়নি — Better Auth-এর `name` ফিল্ডকে `fullName`-এ map করা হবে
  `identity.ts`-এ (`user.fields.name`)। আপনার TODO রাখা হয়েছে; তবে কখনো first/last-এ ভাগ করলে
  Better Auth-এর একক `name` কোথায় যাবে সেটা আগে ঠিক করতে হবে। বাংলাদেশি নাম প্রায়ই first/last
  ছাঁচে মেলে না, তাই একক full name রাখাটাও একটা যৌক্তিক সিদ্ধান্ত হতে পারে।

**ফাইল: `packages/db/src/schema/sessions.ts`** (নতুন ফাইল)

```ts
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { users } from './users.js';

// Better Auth-এর `session` model — প্রতিটা লগইন (একটা ডিভাইস) একটা রো।
// global টেবিল (tenant_id নেই), তাই RLS নেই
export const sessions = pgTable(
  'sessions',
  {
    id: baseColumns().id,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
  },
  (table) => [
    uniqueIndex('sessions_token_idx').on(table.token),
    index('sessions_user_idx').on(table.userId),
  ],
);
```

**কোন লাইন কেন:**

- `id: baseColumns().id` — বাকি সব টেবিলের মতো uuid + UUIDv7। Better Auth নিজেও id পাঠায়
  (`identity.ts`-এর `generateId`), কিন্তু অন্য কোথাও থেকে insert হলেও একই ধরনের id থাকে।
- `...baseColumns()` পুরোটা না, শুধু `id`/`createdAt`/`updatedAt` — `created_by`, `version`,
  `deleted_at` Better Auth-এর রো-র জন্য অর্থহীন (Better Auth এগুলো চেনে না, কখনো লিখবে না)।
  `tenants.ts`-ও একই কৌশল ব্যবহার করে।
- `references(() => users.id, { onDelete: 'cascade' })` — ইউজার মুছলে তার session-ও মুছবে। সাইনআপের
  মাঝপথে ব্যর্থ হলে আমরা ইউজার মুছে দিই (৩.৫-এ "compensating action"), তখন এটা দরকার।
- `token` + `sessions_token_idx` (unique) — Better Auth লগইনের পর session token ফেরত দেয়, id না;
  আমরা token দিয়ে রো খুঁজে id নিই। unique index সেই খোঁজা দ্রুত রাখে আর দুটো session-এর একই token
  হওয়া আটকায়।
- `sessions_user_idx` — "এই ইউজারের সব ডিভাইস থেকে লগআউট"-এর মতো ভবিষ্যতের কাজের জন্য।
- একটা নিরাপত্তা নোট: Better Auth session token plaintext-এ রাখে। আমরা এই token কখনো ব্রাউজারে
  পাঠাই না, credential হিসেবেও ব্যবহার করি না — তাই DB leak হলেও এটা দিয়ে কিছু করা যায় না। পরে কখনো
  Better Auth-এর HTTP handler mount করলে এটা আবার ভাবতে হবে।

**ফাইল: `packages/db/src/schema/accounts.ts`** (নতুন ফাইল)

```ts
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
```

**কোন লাইন কেন:**

- email/password লগইনে Better Auth একটা রো বানায়: `provider_id = 'credential'`,
  `account_id = user id`, আর `password` কলামে scrypt hash। পাসওয়ার্ড এখন শুধু এখানে থাকে।
- `access_token`, `refresh_token`, `id_token`, `scope` ইত্যাদি — Google/SSO-এর মতো OAuth provider-এর
  জন্য। এখন খালি থাকবে, কিন্তু এগুলো Better Auth-এর account model-এর অংশ (1.7.6-এর
  `accountSchema`)। টেবিল model-এর সাথে পুরো মিলিয়ে রাখা নিরাপদ — অর্ধেক কলাম থাকলে কোন ফিচার কবে
  "field does not exist" দিয়ে ভাঙবে আগে থেকে বলা কঠিন।
- `accounts_provider_account_idx` (unique) — একই provider-এর একই পরিচয় দুবার যোগ হওয়া আটকায়।
- `onDelete: 'cascade'` — sessions-এর মতো একই কারণে।

**ফাইল: `packages/db/src/schema/verifications.ts`** (নতুন ফাইল)

```ts
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';

// Better Auth-এর `verification` model — ইমেইল যাচাই আর পাসওয়ার্ড রিসেটের এককালীন টোকেন
export const verifications = pgTable(
  'verifications',
  {
    id: baseColumns().id,
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);
```

**কেন এখনই:** এই ধাপে কেউ এটা ব্যবহার করবে না, কিন্তু Better Auth-এর চতুর্থ model এটাই, আর ইমেইল
যাচাই/পাসওয়ার্ড রিসেট (ধাপ ৮) এলে এখানেই এককালীন টোকেন বসবে। এখন বানিয়ে রাখলে তখন শুধু config বদলাতে
হবে। `identifier` দিয়ে খোঁজা হয় (যেমন ইমেইল), তাই তার index।

**ফাইল: `packages/db/src/schema/refresh-tokens.ts`** (নতুন ফাইল — এটা আমাদের নিজের, Better Auth-এর না)

```ts
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { sessions } from './sessions.js';
import { tenants } from './tenants.js';

// আমাদের নিজের টেবিল (Better Auth-এর না): প্রতিবার refresh-এ নতুন রো, পুরনোটায় used_at বসে।
// একই session-এর সব রো মিলে একটা "family" — পুরনো টোকেন আবার এলে পুরো session মুছে যায়
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: baseColumns().id,
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    // tenant_id নাম ইচ্ছাকৃতভাবে না: এটা RLS-এর tenant কলাম না, শুধু "এই ডিভাইস এখন কোন টেন্যান্টে"
    activeTenantId: uuid('active_tenant_id')
      .notNull()
      .references(() => tenants.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: baseColumns().createdAt,
  },
  (table) => [
    uniqueIndex('refresh_tokens_token_hash_idx').on(table.tokenHash),
    index('refresh_tokens_session_idx').on(table.sessionId),
  ],
);
```

**কোন লাইন কেন:**

- `tokenHash` + unique index — ব্রাউজারের cookie-তে আসল টোকেন থাকে, DB-তে শুধু তার hash। refresh-এর
  সময় আসা টোকেনকে hash করে এই index দিয়ে খোঁজা হয়।
- `sessionId` → `sessions.id`, `onDelete: 'cascade'` — এটাই "family"। লগআউট বা reuse ধরা পড়লে শুধু
  session রো মুছলেই তার সব refresh token নিজে থেকে মুছে যায় — আলাদা করে প্রতিটা খুঁজতে হয় না।
- `activeTenantId`, `tenant_id` না — build-plan-এর ঝুঁকি-তালিকায় আছে: "`tenant_id`-ওয়ালা টেবিলে RLS না
  থাকলে CI fail" (ভবিষ্যতের migration lint)। এই কলাম টেন্যান্টের ডেটা না, শুধু "এই ডিভাইস এখন কোন
  workspace-এ আছে"। আর এখানে RLS দেওয়া সম্ভবও না, কারণ refresh request-এ কোনো tenant context থাকে না।
  refresh-এর পর নতুন access token এই টেন্যান্টের জন্যই বানানো হয়।
- `usedAt` — `null` মানে টোকেনটা চালু; সময় বসানো মানে একবার ব্যবহার (rotate) হয়ে গেছে। ব্যবহৃত রো
  **মোছা হয় না** — এগুলো আছে বলেই পরে পুরনো টোকেন এলে বোঝা যায় যে এটা reuse, অচেনা কোনো টোকেন না।
- `expiresAt` — session-এর মেয়াদের সমান (৩০ দিন, অথবা "Keep me signed in" বন্ধ থাকলে ১ দিন)।

**ফাইল: `packages/db/src/schema/index.ts`** (আপডেট — শেষে চার লাইন যোগ)

```ts
export * from './tenants.js';
export * from './users.js';
export * from './memberships.js';
export * from './roles.js';
export * from './permissions.js';
export * from './role-permissions.js';
export * from './membership-roles.js';
export * from './audit-logs.js';
export * from './sessions.js';
export * from './accounts.js';
export * from './verifications.js';
export * from './refresh-tokens.js';
```

এবার migration তৈরি করুন:

```bash
pnpm db:generate --name auth-tables
```

**ফলাফল: `packages/db/migrations/0005_auth-tables.sql`** (drizzle-kit বানাবে — হাতে লিখবেন না,
শুধু মিলিয়ে দেখুন)

```sql
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"active_tenant_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_active_tenant_id_tenants_id_fk" FOREIGN KEY ("active_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_idx" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_idx" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_token_hash_idx" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_idx" ON "refresh_tokens" USING btree ("session_id");
```

- আগে চারটা `CREATE TABLE`, তারপর FK আর index — drizzle-kit নিজেই এই ক্রম রাখে, তাই কোনো টেবিল
  এমন টেবিলকে রেফার করে না যেটা তখনো তৈরি হয়নি।
- `omnivo_app`-এর জন্য কোনো `GRANT` নেই, আর লাগবেও না: `infra/docker/postgres/init/01-roles.sql`-এর
  `ALTER DEFAULT PRIVILEGES FOR ROLE omnivo_migrator` বলে রেখেছে যে migrator যে টেবিল বানাবে,
  `omnivo_app` সেখানে নিজে থেকেই `SELECT/INSERT/UPDATE/DELETE` পাবে। এই কারণেই migration **সবসময়
  `pnpm db:migrate` দিয়ে** (অর্থাৎ `omnivo_migrator` হিসেবে) চালাতে হবে। `postgres` superuser দিয়ে
  চালালে default privilege খাটত না, আর অ্যাপ নতুন টেবিল পড়তে পারত না।

### ধাপ B — মোছা

**ফাইল: `packages/db/src/schema/users.ts`** (চূড়ান্ত — `passwordHash` লাইনটা মুছুন)

```ts
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
```

```bash
pnpm db:generate --name drop-users-password-hash
```

**ফলাফল: `packages/db/migrations/0006_drop-users-password-hash.sql`**

```sql
ALTER TABLE "users" DROP COLUMN "password_hash";
```

(`meta/0005_snapshot.json`, `meta/0006_snapshot.json` আর `meta/_journal.json`-এর বদলও drizzle-kit
নিজে করবে — এগুলো commit করতে হবে, হাতে ছোঁবেন না।)

### Permission catalog

**ফাইল: `packages/db/src/permission-catalog.ts`** (নতুন ফাইল)

```ts
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { permissions } from './schema/index.js';

// সিস্টেম-জোড়া permission-এর একমাত্র উৎস। নতুন permission এলে শুধু এখানে যোগ হবে —
// DB-তে তোলে syncPermissions(), আর @RequirePermission() এই তালিকা থেকেই টাইপ পায়
export const PERMISSIONS = [
  { key: 'core.user.read', description: 'View users in the workspace' },
  { key: 'core.user.invite', description: 'Invite users to the workspace' },
  { key: 'core.role.manage', description: 'Create roles and assign permissions' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

// signup-এ যে রোল তৈরি হয় আর সব permission পায়
export const OWNER_ROLE_NAME = 'Owner';

// Pick<..., 'insert'>: migrate-এর plain db, createDb()-এর Db, বা transaction-এর tx — সবই চলে
// idempotent: নতুন key যোগ হয়, পুরনো key-এর description আপডেট হয়; কিছু মোছে না
export async function syncPermissions(db: Pick<PostgresJsDatabase, 'insert'>): Promise<void> {
  await db
    .insert(permissions)
    .values([...PERMISSIONS])
    .onConflictDoUpdate({
      target: permissions.key,
      set: { description: sql`excluded.description` },
    });
}
```

**কোন লাইন কেন:**

- `PERMISSIONS = [...] as const` — `as const` না দিলে TypeScript `key`-এর টাইপ ধরত সাধারণ `string`।
  এটা দেওয়ায় প্রতিটা key একটা literal টাইপ হয়।
- `type PermissionKey = (typeof PERMISSIONS)[number]['key']` — ফলাফল
  `'core.user.read' | 'core.user.invite' | 'core.role.manage'`। `@RequirePermission()` এই টাইপ নেয়,
  তাই `'core.user.raed'` লিখলে সেটা compile error, রানটাইমে চুপচাপ 403 না। তালিকায় নতুন permission
  যোগ করলে টাইপ নিজে থেকে বাড়ে (rule ২: টাইপ আসে source of truth থেকে)।
- কেন SQL migration না, কোড থেকে sync — (১) তালিকা আর টাইপ একই জায়গায় থাকে, drift হওয়ার সুযোগ নেই;
  (২) Postgres 17-এ `uuidv7()` নেই (১৮-তে এসেছে), SQL-এ id বানালে বাকি টেবিলের মতো UUIDv7 হতো না;
  (৩) নতুন permission মানে শুধু এই ফাইলে এক লাইন।
- `OWNER_ROLE_NAME` — সাইনআপ (API) আর seed দুজনেই এই নাম ব্যবহার করে; দুই জায়গায় `'Owner'` স্ট্রিং
  থাকলে একটা বদলালে অন্যটা পিছিয়ে পড়ত।
- `db: Pick<PostgresJsDatabase, 'insert'>` — এই ফাংশন তিন রকম জায়গা থেকে ডাকা হয়: migrate.ts-এর
  schema-ছাড়া `drizzle(client)`, `createDb()`-এর schema-সহ `Db`, আর seed-এর transaction `tx`। তিনটার
  generic টাইপ আলাদা, কিন্তু `insert` method-এর signature একই। শুধু যা দরকার (`insert`) সেটুকু চাওয়ায়
  তিনটাই cast ছাড়া পাস হয়।
- `onConflictDoUpdate(... excluded.description)` — key আগে থেকে থাকলে শুধু description আপডেট হয়,
  তাই বারবার চালানো নিরাপদ (idempotent)। **মোছা হয় না** ইচ্ছা করে: কোনো permission সরাতে হলে আগে
  `role_permissions`-এর রেফারেন্স সরাতে হবে — সেটা আলাদা, সচেতন migration-এর কাজ।

**ফাইল: `packages/db/src/index.ts`** (আপডেট)

```ts
export * from './schema/index.js';
export * from './client.js';
export * from './permission-catalog.js';
```

**ফাইল: `packages/db/src/migrate.ts`** (আপডেট — import আর `migrate()`-এর পরের দুই লাইন)

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadRootEnv, requireEnv } from './env.js';
import { syncPermissions } from './permission-catalog.js';

loadRootEnv();

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

async function main() {
  const migrationClient = postgres(requireEnv('MIGRATOR_DATABASE_URL'), { max: 1 });
  const db = drizzle(migrationClient);
  await migrate(db, { migrationsFolder });
  // permissions সিস্টেম ডেটা — schema-র মতোই প্রতিটা deploy-এ কোডের তালিকার সাথে মেলানো
  await syncPermissions(db);
  await migrationClient.end();
  console.log('migrations done');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

**কেন migrate-এর ভেতরে:** production-এ deploy মানেই `pnpm db:migrate`। এখানে sync থাকলে কোডে নতুন
permission এলে deploy-এর সাথেই সেটা DB-তে ওঠে — আলাদা কোনো কমান্ড মনে রাখতে হয় না। `migrate()`-এর
**পরে**, কারণ প্রথমবার চালানোর সময় `permissions` টেবিল তখনই তৈরি হয়।

**ফাইল: `packages/db/src/seed.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadRootEnv, requireEnv } from './env.js';
import { OWNER_ROLE_NAME, PERMISSIONS, syncPermissions } from './permission-catalog.js';
import {
  tenants,
  users,
  memberships,
  roles,
  permissions,
  rolePermissions,
  membershipRoles,
} from './schema/index.js';

loadRootEnv();

// noUncheckedIndexedAccess-এর কারণে rows[0] হলো T | undefined — এখানে একবার narrow করা
function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`seed: ${what} not found`);
  }
  return row;
}

async function main() {
  const client = postgres(requireEnv('MIGRATOR_DATABASE_URL'), { max: 1 });
  const db = drizzle(client);

  // সব insert idempotent — বারবার চালালেও একই অবস্থা থাকবে
  await db.transaction(async (tx) => {
    await syncPermissions(tx);
    const permissionRows = await tx
      .select({ id: permissions.id })
      .from(permissions)
      .where(
        inArray(
          permissions.key,
          PERMISSIONS.map((p) => p.key),
        ),
      );

    const tenant = one(
      await tx
        .insert(tenants)
        .values({ name: 'Acme Textiles', slug: 'acme' })
        .onConflictDoUpdate({ target: tenants.slug, set: { name: 'Acme Textiles' } })
        .returning({ id: tenants.id }),
      'tenant',
    );

    const user = one(
      await tx
        .insert(users)
        .values({ email: 'admin@acme.omnivo.app', fullName: 'Acme Admin' })
        .onConflictDoUpdate({ target: users.email, set: { fullName: 'Acme Admin' } })
        .returning({ id: users.id }),
      'user',
    );

    // বাকি টেবিলে FORCE ROW LEVEL SECURITY আছে, তাই insert-এর আগে
    // এই ট্রানজ্যাকশনে tenant context সেট করতে হবে — নাহলে policy insert ব্লক করবে।
    // true = transaction-local, tx কমিট/রোলব্যাক হলে এই সেটিংও সাথে যায়
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant.id}, true)`);

    await tx
      .insert(memberships)
      .values({ tenantId: tenant.id, userId: user.id })
      .onConflictDoNothing({ target: [memberships.tenantId, memberships.userId] });
    const membership = one(
      await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, user.id))),
      'membership',
    );

    await tx
      .insert(roles)
      .values({ tenantId: tenant.id, name: OWNER_ROLE_NAME })
      .onConflictDoNothing({ target: [roles.tenantId, roles.name] });
    const owner = one(
      await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.tenantId, tenant.id), eq(roles.name, OWNER_ROLE_NAME))),
      'Owner role',
    );

    await tx
      .insert(rolePermissions)
      .values(
        permissionRows.map((p) => ({ tenantId: tenant.id, roleId: owner.id, permissionId: p.id })),
      )
      .onConflictDoNothing();

    await tx
      .insert(membershipRoles)
      .values({ tenantId: tenant.id, membershipId: membership.id, roleId: owner.id })
      .onConflictDoNothing();
  });

  await client.end();
  console.log('seed done');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

**কী বদলাল:**

- ফাইলের নিজস্ব `PERMISSIONS` তালিকা মুছে catalog থেকে import। `PERMISSIONS` এখনো লাগে
  `inArray(...)`-এ, Owner রোলকে সব permission দেওয়ার জন্য।
- `insert(permissions)...onConflictDoNothing` → `syncPermissions(tx)` — একই কাজ, এক জায়গায়। `tx`
  পাস করা যায় সেই `Pick<..., 'insert'>`-এর কারণে।
- `'Owner'` → `OWNER_ROLE_NAME`।
- seed-এর ইউজারের (`admin@acme.omnivo.app`) কোনো পাসওয়ার্ড নেই, তাই এই ইউজার দিয়ে লগইন করা যাবে না।
  Acme টেন্যান্ট থাকছে `pnpm db:psql:app`-এ RLS দেখার জন্য; লগইন দেখতে sign-up পেজ দিয়ে নতুন workspace
  বানান।

---

## ৩.২ — `packages/contracts`: API আর app-এর শেয়ার করা Zod schema

`@omnivo/db`-এর মতোই `dist/`-এ build হওয়া প্যাকেজ (ধাপ ২-এর ভিত্তি-সিদ্ধান্ত ২: Node `.ts` ফাইল
সরাসরি চালাতে পারে না, আর `types` `src`-এ দিলে API-র `tsc` `TS6059` দেয়)।

**ফাইল: `packages/contracts/package.json`** (নতুন ফাইল — `dependencies`/`devDependencies` ছাড়া
লিখুন, নিচের কমান্ড সেগুলো যোগ করবে)

```json
{
  "name": "@omnivo/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch --preserveWatchOutput",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@omnivo/config": "workspace:*",
    "typescript": "^6.0.3",
    "vitest": "^5.0.1"
  }
}
```

**ফাইল: `packages/contracts/tsconfig.json`** (নতুন ফাইল)

```json
{
  "extends": "../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "nodenext",
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

**ফাইল: `packages/contracts/tsconfig.build.json`** (নতুন ফাইল)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "./src",
    "outDir": "./dist",
    "declarationMap": true
  },
  "exclude": ["src/**/*.spec.ts"]
}
```

- `tsconfig.json`-এ `types: ["node"]` নেই — এই প্যাকেজ ব্রাউজারেও চলে, Node-এর কিছু ব্যবহার করা উচিত
  না। ভুল করে `node:crypto` import করলে টাইপ-চেকেই ধরা পড়বে।
- `exclude: ["src/**/*.spec.ts"]` — টেস্ট `dist`-এ যায় না, ফলে app-এর bundle-এ vitest ঢোকে না।

```bash
pnpm --filter @omnivo/contracts add 'zod@^4.6.5'
pnpm --filter @omnivo/contracts add -D '@omnivo/config@workspace:*' 'typescript@^6.0.3' 'vitest@^5.0.1'
```

(zsh-এ `workspace:*`-এর `*` glob হিসেবে পড়ে "no matches found" দেয় — তাই quote।)

**ফাইল: `packages/contracts/src/auth.ts`** (নতুন ফাইল)

```ts
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
```

**কোন লাইন কেন:**

- `workspaceSlugFormat` — slug-টাই পরে সাবডোমেইন হবে (`rahman-garments.omnivo.app`), তাই DNS
  label-এর নিয়ম: শুধু `a-z0-9`, হাইফেন শুরু/শেষে না, পাশাপাশি দুটো না
  (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`)। `trim().toLowerCase()` আগে, যাতে `" Rahman-Garments "`-ও চলে।
  `max(32)` — DNS-এর সীমা 63, কিন্তু Workspace Setup mockup-এর slugify-ও ৩২-এ কাটে আর UI-তে পড়তে সহজ।
- `RESERVED_SLUGS` — আমাদের নিজেদের সাবডোমেইন (`api`, `app`, `www`, `admin`…) কোনো গ্রাহকের নামে
  গেলে `api.omnivo.app` একজন গ্রাহকের দখলে চলে যেত — phishing বা traffic ভুল জায়গায় যাওয়ার ঝুঁকি।
  `ReadonlySet` — কেউ রানটাইমে এতে কিছু যোগ করতে পারবে না।
- `newWorkspaceSlugSchema` (reserved চেক সহ) শুধু সাইনআপে; লগইনে শুধু `workspaceSlugFormat` —
  লগইনে কেউ `admin` লিখলে "এটা reserved" বলাটা বিভ্রান্তিকর, সে শুধু "খুঁজে পাইনি" দেখবে।
- `emailSchema` — `z.string().trim().toLowerCase().pipe(z.email(...))`। ক্রমটা গুরুত্বপূর্ণ: Zod 4-এ
  `z.email().trim()` লিখলে email-এর যাচাই আগে চলে আর `.trim()` পরে, তাই `" a@b.com"` ভুল ধরা পড়ত।
  `pipe` দিয়ে আগে পরিষ্কার, তারপর যাচাই। lowercase — Better Auth-ও ইমেইল lowercase করে রাখে, তাই
  দুই জায়গায় একই রূপ।
- `newPasswordSchema` `min(8)` / `max(128)` — `identity.ts`-এ Better Auth-কে একই সীমা দেওয়া আছে।
  দুটো আলাদা হলে এক স্তর পাস করত আর অন্যটা আটকাত, ইউজার দুই রকম মেসেজ দেখত।
- মেসেজগুলো schema-র ভেতরেই — একই schema সার্ভারে (validation pipe) আর ব্রাউজারে (ফর্ম) চলে, তাই
  দুই জায়গায় হুবহু একই লেখা। লেখার ধরন CLAUDE.md-এর copy নিয়ম মানে: কী ঠিক করতে হবে সেটা বলা,
  ক্ষমা চাওয়া না।
- লগইনের `password`-এ শুধু `min(1)` — পুরনো নিয়মে তৈরি পাসওয়ার্ড (ধরুন ভবিষ্যতে নিয়ম কড়া হলো) যেন
  লগইনে আটকে না যায়; দৈর্ঘ্যের নিয়ম শুধু নতুন পাসওয়ার্ডে।
- `keepSignedIn: z.boolean()` — mockup-এর "Keep me signed in on this device" checkbox।
- `authSessionSchema`-এ refresh token নেই — সেটা শুধু cookie-তে যায়, JSON-এ কখনো না।
  `z.iso.datetime()` — JSON-এ `Date` ISO স্ট্রিং হয়ে আসে, তাই স্ট্রিং হিসেবেই যাচাই।
- `meResponseSchema`, `memberListResponseSchema` — response-এর schema কেন: ব্রাউজারে `res.json()`
  ফেরত দেয় `Promise<any>`। সেটা সরাসরি ব্যবহার করলে `any` ছড়িয়ে পড়ত (rule ৩)। schema দিয়ে parse
  করলে রানটাইম চেক আর টাইপ দুটোই একসাথে মেলে।
- `apiErrorSchema` — Nest-এর নিজের exception (`{ statusCode, message, error }`) আর আমাদের validation
  error (`{ statusCode, message, fieldErrors }`) দুটোই এই আকারে মেলে। `z.object` অচেনা key (যেমন
  `error`) ডিফল্টে বাদ দেয়, তাই দুটোই সমস্যা ছাড়া parse হয়।
- প্রতিটা `export type X = z.infer<typeof xSchema>` — টাইপ হাতে লেখা হয়নি, schema থেকে আসে।

**ফাইল: `packages/contracts/src/index.ts`** (নতুন ফাইল)

```ts
export * from './auth.js';
```

**ফাইল: `packages/contracts/src/auth.spec.ts`** (নতুন ফাইল)

```ts
import { describe, expect, it } from 'vitest';

import { loginInputSchema, newWorkspaceSlugSchema, signUpInputSchema } from './auth.js';

describe('auth contracts', () => {
  it('normalizes email and slug before validating', () => {
    const parsed = signUpInputSchema.parse({
      companyName: ' Rahman Garments Ltd. ',
      workspaceSlug: ' Rahman-Garments ',
      fullName: 'Farhana Rahman',
      email: ' Farhana@RahmanGarments.com ',
      password: 'Gazipur-knit-2026',
    });
    expect(parsed.email).toBe('farhana@rahmangarments.com');
    expect(parsed.workspaceSlug).toBe('rahman-garments');
    expect(parsed.companyName).toBe('Rahman Garments Ltd.');
  });

  it('rejects reserved and malformed workspace addresses', () => {
    expect(newWorkspaceSlugSchema.safeParse('admin').success).toBe(false);
    expect(newWorkspaceSlugSchema.safeParse('rahman--garments').success).toBe(false);
    expect(newWorkspaceSlugSchema.safeParse('-rahman').success).toBe(false);
    expect(newWorkspaceSlugSchema.safeParse('ra').success).toBe(false);
  });

  it('lets login use any well-formed slug, reserved or not', () => {
    const result = loginInputSchema.safeParse({
      workspace: 'admin',
      email: 'a@b.co',
      password: 'x',
      keepSignedIn: true,
    });
    expect(result.success).toBe(true);
  });
});
```

তিনটা টেস্ট তিনটা নিয়ম পাহারা দেয়: parse-এর আগে normalize হয় কিনা, reserved আর ভাঙা slug আটকায় কিনা,
আর লগইন reserved চেক করে না কিনা। কেউ `pipe`-এর ক্রম উল্টালে প্রথম টেস্ট fail করবে।

---

## ৩.৩ — `packages/auth`: Better Auth-এর চারপাশে facade

এই প্যাকেজের বাইরে কেউ Better Auth চেনে না। API শুধু `createAuth()` থেকে পাওয়া ফাংশনগুলো ডাকে।

**ফাইল: `packages/auth/package.json`** (নতুন ফাইল — আগের মতোই dependency ছাড়া লিখুন)

```json
{
  "name": "@omnivo/auth",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch --preserveWatchOutput",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@omnivo/db": "workspace:*",
    "better-auth": "^1.7.6",
    "drizzle-orm": "^0.45.3",
    "jose": "^6.2.12",
    "uuidv7": "^1.2.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@omnivo/config": "workspace:*",
    "@types/node": "^26.6.2",
    "typescript": "^6.0.3",
    "vitest": "^5.0.1"
  }
}
```

**ফাইল: `packages/auth/tsconfig.json`** (নতুন ফাইল)

```json
{
  "extends": "../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "nodenext",
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

**ফাইল: `packages/auth/tsconfig.build.json`** (নতুন ফাইল — contracts-এরটার হুবহু কপি)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "./src",
    "outDir": "./dist",
    "declarationMap": true
  },
  "exclude": ["src/**/*.spec.ts"]
}
```

```bash
pnpm --filter @omnivo/auth add 'better-auth@^1.7.6' 'jose@^6.2.12' 'zod@^4.6.5' 'uuidv7@^1.2.1' 'drizzle-orm@^0.45.3' '@omnivo/db@workspace:*'
pnpm --filter @omnivo/auth add -D '@omnivo/config@workspace:*' '@types/node@^26.6.2' 'typescript@^6.0.3' 'vitest@^5.0.1'
pnpm dedupe
```

> ⚠️ **`pnpm dedupe` বাদ দেবেন না।** `drizzle-orm`-এর একটা ঐচ্ছিক peer dependency আছে `kysely`, আর
> Better Auth `kysely` নিয়ে আসে। ফলে install-এর পর pnpm `drizzle-orm`-এর **দুটো কপি** রাখে — একটা
> kysely-সহ (`packages/auth`, `apps/api`), একটা kysely-ছাড়া (`packages/db`)। দুই কপির `SQL` class
> TypeScript-এর চোখে আলাদা, তাই `eq(refreshTokens.tokenHash, …)`-এর মতো লাইনে এই error আসে (যাচাই
> করা):
>
> ```
> TS2345: Argument of type '…drizzle-orm@0.45.3_kysely@0.29.6…SQL<unknown>' is not assignable to
> parameter of type '…drizzle-orm@0.45.3_postgres@3.4.9…SQL<unknown>'.
>   Types have separate declarations of a private property 'shouldInlineParams'.
> ```
>
> `pnpm dedupe` সবাইকে একটা কপিতে নিয়ে আসে। ৩.৯-এ CI-তে `pnpm dedupe --check` যোগ করা হবে, যাতে এই
> ভাঙন আর চুপচাপ ফিরে আসতে না পারে।

**ফাইল: `packages/auth/src/errors.ts`** (নতুন ফাইল)

```ts
// facade-এর বাইরে Better Auth-এর নিজস্ব error কোড যায় না — API শুধু এই কয়টা কোড চেনে
export type AuthErrorCode =
  'INVALID_CREDENTIALS' | 'EMAIL_TAKEN' | 'INVALID_REFRESH_TOKEN' | 'REFRESH_TOKEN_REUSED';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
  }
}
```

**কেন:** Better Auth-এর `APIError` এই প্যাকেজের বাইরে গেলে API-কে Better Auth-এর error কোড চিনতে
হতো — facade-এর উদ্দেশ্যই ভেঙে যেত। বাইরে যায় শুধু এই চারটা কোড। `AuthErrorCode` একটা union, তাই
`error.code === 'EMAIL_TAKN'`-এর মতো বানান ভুল compile error। `this.name` — লগে "AuthError" দেখাবে,
সাধারণ "Error" না।

**ফাইল: `packages/auth/src/access-token.ts`** (নতুন ফাইল)

```ts
import { randomUUID } from 'node:crypto';
import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

export interface AccessTokenConfig {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

// টোকেনে যা ঢোকে — ADR 0002-এর কাস্টম claim
export interface AccessClaims {
  userId: string;
  tenantId: string;
  membershipId: string;
  roles: readonly string[];
}

// যাচাই করা টোকেন থেকে যা বেরোয়
export interface Principal extends AccessClaims {
  tokenId: string;
  expiresAt: Date;
}

// jose শুধু স্ট্যান্ডার্ড claim (exp, iss, aud) যাচাই করে; আমাদের কাস্টম claim-এর আকার এখানে
const payloadSchema = z.object({
  sub: z.uuid(),
  jti: z.string().min(1),
  exp: z.number(),
  tenant_id: z.uuid(),
  membership_id: z.uuid(),
  roles: z.array(z.string()),
});

export function createAccessTokens(config: AccessTokenConfig) {
  const key = new TextEncoder().encode(config.secret);
  // HS256-এর key অন্তত 256 bit হওয়া উচিত (RFC 7518 §3.2); jose নিজে এটা চেক করে না
  if (key.byteLength < 32) {
    throw new Error(
      'JWT secret must be at least 32 bytes — generate one with `openssl rand -base64 32`',
    );
  }

  async function sign(claims: AccessClaims): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + config.ttlSeconds;
    const token = await new SignJWT({
      tenant_id: claims.tenantId,
      membership_id: claims.membershipId,
      roles: [...claims.roles],
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(randomUUID())
      .sign(key);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  // ভুল/মেয়াদোত্তীর্ণ/জাল টোকেন → null (caller 401 দেবে); অন্য যেকোনো error → throw (সেটা bug)
  async function verify(token: string): Promise<Principal | null> {
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['HS256'],
      });
      const claims = payloadSchema.safeParse(payload);
      if (!claims.success) return null;
      return {
        userId: claims.data.sub,
        tenantId: claims.data.tenant_id,
        membershipId: claims.data.membership_id,
        roles: claims.data.roles,
        tokenId: claims.data.jti,
        expiresAt: new Date(claims.data.exp * 1000),
      };
    } catch (error) {
      if (error instanceof errors.JOSEError) return null;
      throw error;
    }
  }

  return { sign, verify };
}

export type AccessTokens = ReturnType<typeof createAccessTokens>;
```

**কোন লাইন কেন:**

- `AccessClaims` আর `Principal` আলাদা — টোকেন বানাতে যা লাগে (claims) আর যাচাইয়ের পর যা পাওয়া যায়
  (claims + `tokenId` + `expiresAt`)। `Principal extends AccessClaims`, তাই কোনো ফিল্ড দুবার লেখা নেই।
- `roles: readonly string[]` — principal পড়ার জিনিস; handler-এর ভেতরে কেউ ভুল করে `push` করলে
  compile error।
- `payloadSchema` — `jose`-এর `jwtVerify` শুধু স্বাক্ষর আর স্ট্যান্ডার্ড claim (`exp`, `iss`, `aud`)
  যাচাই করে। `payload`-এর টাইপ `JWTPayload`, যেখানে বাকি সব `unknown`। Zod দিয়ে parse করায়
  `tenant_id` ইত্যাদি cast ছাড়াই টাইপ পায় (rule ৩), আর সঠিক secret দিয়ে স্বাক্ষর করা কিন্তু ভুল
  আকারের টোকেনও বাদ পড়ে (স্পেক-এর শেষ টেস্ট)।
- `key.byteLength < 32` হলে throw — HS256-এ key অন্তত 256 bit হওয়া উচিত (RFC 7518 §3.2), কিন্তু
  `jose` ছোট key-ও চুপচাপ মেনে নেয়। অ্যাপ চালুর সময়েই থেমে যাওয়া ভালো, production-এ দুর্বল secret
  নিয়ে চলার চেয়ে। config-এর Zod-ও `min(32)` দেয়, এটা দ্বিতীয় দেয়াল।
- `issuedAt` একবারই হিসাব — `exp = iat + ttl` নিশ্চিতভাবে মেলে, আর যে `expiresAt` ফেরত যায় সেটা
  টোকেনের ভেতরের `exp`-এর হুবহু সমান (টেস্টে যাচাই)।
- claim-এর নাম `tenant_id`, `membership_id` (snake_case) — OIDC/JWT-এর রীতি, ADR 0002-এর তালিকার সাথে
  মিলিয়ে। পরে Zitadel একই আকারের টোকেন দিলে verifier বদলাতে হবে না।
- `alg: 'HS256'` (symmetric) — একই সার্ভিস টোকেন বানায় আর যাচাই করে, তাই public/private key জোড়ার
  দরকার নেই। বাইরের IdP-তে গেলে যাচাই হবে তাদের JWKS দিয়ে — তখন শুধু এই ফাইল বদলাবে।
- `setJti(randomUUID())` — প্রতিটা টোকেনের আলাদা id। এখন ব্যবহার হয় না, কিন্তু system-design-এর Redis
  "token blocklist"-এর জন্য এটাই লাগবে (একটা নির্দিষ্ট টোকেন সঙ্গে সঙ্গে বাতিল করা)।
- `algorithms: ['HS256']` — "algorithm confusion" আক্রমণ আটকায়: আক্রমণকারী header-এ `alg: none`
  লিখে স্বাক্ষর ছাড়া টোকেন পাঠালে সেটা বাদ (টেস্টে যাচাই)।
- `issuer`/`audience` চেক — অন্য কোনো সিস্টেম একই secret-এ (ভুলবশত) টোকেন বানালেও আমাদের API সেটা
  মানবে না।
- `catch`-এ শুধু `JOSEError` → `null`; বাকি সব throw — ভুল/মেয়াদোত্তীর্ণ/জাল টোকেন ইউজারের সমস্যা
  (401), কিন্তু অন্য error কোডের bug, সেটা লুকালে কখনো ধরা পড়ত না।

**ফাইল: `packages/auth/src/refresh-token.ts`** (নতুন ফাইল)

```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { refreshTokens, sessions, type Db } from '@omnivo/db';

import { AuthError } from './errors.js';

export interface RefreshGrant {
  userId: string;
  sessionId: string;
  sessionExpiresAt: Date;
  activeTenantId: string;
}

// টোকেন নিজে 256-bit random, তাই brute-force অসম্ভব — bcrypt/scrypt লাগে না, SHA-256 যথেষ্ট।
// DB-তে শুধু hash থাকে: DB dump লিক হলেও কেউ সেখান থেকে cookie বানাতে পারবে না
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createRefreshToken(
  db: Db,
  input: { sessionId: string; activeTenantId: string; expiresAt: Date },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(refreshTokens).values({
    sessionId: input.sessionId,
    tokenHash: hashRefreshToken(token),
    activeTenantId: input.activeTenantId,
    expiresAt: input.expiresAt,
  });
  return token;
}

export async function consumeRefreshToken(db: Db, token: string): Promise<RefreshGrant> {
  const tokenHash = hashRefreshToken(token);

  // একটাই atomic UPDATE: দুটো request একই টোকেন একসাথে পাঠালে row lock-এর কারণে
  // শুধু একটা `used_at IS NULL` দেখবে — অন্যটা 0 রো পাবে আর reuse হিসেবে ধরা পড়বে
  const [consumed] = await db
    .update(refreshTokens)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.usedAt),
        gt(refreshTokens.expiresAt, sql`now()`),
      ),
    )
    .returning({
      sessionId: refreshTokens.sessionId,
      activeTenantId: refreshTokens.activeTenantId,
    });

  if (consumed) {
    const [session] = await db
      .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(and(eq(sessions.id, consumed.sessionId), gt(sessions.expiresAt, sql`now()`)));
    if (!session) throw new AuthError('INVALID_REFRESH_TOKEN');
    return {
      userId: session.userId,
      sessionId: consumed.sessionId,
      sessionExpiresAt: session.expiresAt,
      activeTenantId: consumed.activeTenantId,
    };
  }

  // UPDATE কিছু পায়নি: টোকেনটা কি আগে ব্যবহার হয়েছে, নাকি একেবারে অচেনা/মেয়াদোত্তীর্ণ?
  const [existing] = await db
    .select({ sessionId: refreshTokens.sessionId, usedAt: refreshTokens.usedAt })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash));

  if (existing?.usedAt) {
    // পুরনো টোকেন আবার এসেছে = কেউ কপি করে রেখেছিল। কে আসল আর কে চোর বোঝার উপায় নেই,
    // তাই পুরো session (আর cascade-এ তার সব refresh token) মুছে দুজনকেই লগআউট
    await db.delete(sessions).where(eq(sessions.id, existing.sessionId));
    throw new AuthError('REFRESH_TOKEN_REUSED');
  }
  throw new AuthError('INVALID_REFRESH_TOKEN');
}

export async function revokeSessionByRefreshToken(db: Db, token: string): Promise<void> {
  const [row] = await db
    .select({ sessionId: refreshTokens.sessionId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashRefreshToken(token)));
  if (row) {
    await db.delete(sessions).where(eq(sessions.id, row.sessionId));
  }
}
```

**কোন লাইন কেন:**

- `randomBytes(32).toString('base64url')` — 256 bit এলোমেলো, অনুমান করা অসম্ভব। `base64url`-এ শুধু
  `A-Z a-z 0-9 - _`, তাই cookie-তে escape লাগে না।
- `createHash('sha256')`, bcrypt/scrypt না — পাসওয়ার্ড ধীর hash চায় কারণ মানুষের পাসওয়ার্ড ছোট আর
  অনুমানযোগ্য। এই টোকেন 256-bit random, brute-force এমনিতেই অসম্ভব; ধীর hash শুধু প্রতিটা refresh
  ধীর করত। DB-তে hash থাকায় DB dump leak হলেও কেউ সেখান থেকে cookie বানাতে পারবে না।
- **একটা atomic `UPDATE … WHERE used_at IS NULL … RETURNING`** — এটাই পুরো ফাইলের মূল লাইন। "আগে
  SELECT, তারপর UPDATE" লিখলে দুটো request একসাথে একই টোকেন পড়ে দুজনেই "চালু" দেখত, আর দুটো নতুন
  টোকেন বেরিয়ে যেত। এক statement-এ Postgres row lock নেয়: প্রথমজন `used_at` বসায়, দ্বিতীয়জন শর্ত
  মেলাতে না পেরে 0 রো পায়। "দুটো একসাথে refresh → ঠিক একটা 200" টেস্ট এটাই প্রমাণ করে, আর mutation
  test-এ `isNull(refreshTokens.usedAt)` মুছলে সেটা fail করে।
- ``sql`now()` ``, `new Date()` না — সময়ের তুলনা হয় DB-র ঘড়িতে। একাধিক API instance-এর ঘড়ি কয়েক
  সেকেন্ড এদিক-ওদিক হলেও ফলাফল একই থাকে।
- টোকেন পাওয়ার পর session আলাদা করে চেক — Better Auth-এর session-এর মেয়াদ শেষ হয়ে থাকলে (বা কেউ মুছে
  থাকলে) refresh token-ও অচল।
- UPDATE কিছু না পেলে দ্বিতীয় query — "অচেনা/মেয়াদোত্তীর্ণ" আর "আগে ব্যবহৃত"-এর মধ্যে পার্থক্য করতে।
  দুটোরই ফল 401, কিন্তু দ্বিতীয়টা মানে কেউ টোকেন কপি করে রেখেছিল।
- reuse হলে পুরো session মুছে ফেলা — আক্রমণকারী আর আসল ইউজার দুজনের কাছেই একই family-র টোকেন আছে;
  কে কে সেটা সার্ভার জানে না। তাই দুজনকেই বের করে দেওয়া হয়; আসল ইউজার আবার পাসওয়ার্ড দিয়ে ঢুকতে
  পারবে, আক্রমণকারী পারবে না।
- `revokeSessionByRefreshToken` — লগআউট; অচেনা টোকেন হলে চুপচাপ কিছু না করা (idempotent), যাতে
  দুবার logout চাপলে error না আসে।

**ফাইল: `packages/auth/src/identity.ts`** (নতুন ফাইল — Better Auth শুধু এখানে)

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { accounts, sessions, users, verifications, type Db } from '@omnivo/db';
import { uuidv7 } from 'uuidv7';

export interface IdentityOptions {
  db: Db;
  secret: string;
  baseURL: string;
  sessionTtlSeconds: number;
}

// Better Auth শুধু এই ফাইলে — packages/auth-এর বাইরে কেউ একে সরাসরি দেখে না (ADR 0002)
export function createIdentityProvider(options: IdentityOptions) {
  return betterAuth({
    appName: 'Omnivo',
    baseURL: options.baseURL,
    secret: options.secret,
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      // Better Auth-এর model নাম (key) → আমাদের Drizzle টেবিল (value)
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
      // user + credential account একসাথে তৈরি হবে, নাহলে পাসওয়ার্ড ছাড়া ইউজার থেকে যেতে পারত
      transaction: true,
    }),
    user: {
      // Better Auth-এর `name` ফিল্ড → আমাদের Drizzle key `fullName` (কলাম full_name)
      fields: { name: 'fullName' },
    },
    session: {
      expiresIn: options.sessionTtlSeconds,
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    advanced: {
      // ডিফল্ট random string id আমাদের uuid কলামে ঢুকবে না; বাকি টেবিলের মতো UUIDv7
      database: { generateId: () => uuidv7() },
    },
    telemetry: { enabled: false },
  });
}

export type IdentityProvider = ReturnType<typeof createIdentityProvider>;
```

**কোন লাইন কেন:**

- `secret` — Better Auth-এর নিজের ডকুমেন্টেশন অনুযায়ী production-এ এটা না দিলে throw করে, আর dev-এ
  একটা সবার-জানা ডিফল্ট স্ট্রিং নেয়। তাই সবসময় env থেকে দেওয়া। `baseURL` — আমরা HTTP handler
  ব্যবহার না করলেও ধাপ ৮-এর ইমেইল যাচাইয়ের লিঙ্ক Better Auth এখান থেকেই বানাবে।
- `drizzleAdapter(options.db, { provider: 'pg', schema: {...} })` — `schema`-র key হলো Better
  Auth-এর model নাম (`user`, `session`…), value আমাদের Drizzle টেবিল। adapter `schema[model]` দিয়ে
  টেবিল খোঁজে (1.7.6-এর adapter কোড দেখে যাচাই করা), তাই আলাদা করে `modelName` দিতে হয় না।
- `transaction: true` — সাইনআপে Better Auth দুটো insert করে: `users` আর `accounts` (পাসওয়ার্ড)।
  দুটোর মাঝে crash হলে পাসওয়ার্ড ছাড়া ইউজার থেকে যেত, যে কখনো লগইন করতে পারবে না কিন্তু ইমেইলটা আটকে
  রাখবে। transaction-এ দুটো একসাথে হয় অথবা কোনোটাই না।
- `user.fields.name: 'fullName'` — Better Auth বলে `name`, আমাদের Drizzle key `fullName` (কলাম
  `full_name`)। এই mapping-এর জন্যই ৩.১-এ `fullName`-এর নাম বদলাতে হয়নি।
- `session.expiresIn` — ৩০ দিন (config থেকে)। "Keep me signed in" বন্ধ থাকলে Better Auth নিজে ১ দিন
  দেয় (1.7.6-এর `createSession`-এ `dontRememberMe ? 1 day : expiresIn`)।
- `autoSignIn: true` — সাইনআপের সাথেই session তৈরি হয়, আলাদা লগইন লাগে না। এটা বন্ধ করলে
  `signUpEmail` token ফেরত দেয় না, আর `auth.ts`-এর চেক সেটা স্পষ্ট error দিয়ে ধরবে।
- `generateId: () => uuidv7()` — Better Auth-এর ডিফল্ট id ৩২ অক্ষরের random স্ট্রিং; আমাদের `uuid`
  কলামে সেটা ঢুকলে Postgres `invalid input syntax for type uuid` দিত।
- `telemetry: { enabled: false }` — 1.7-এ ডিফল্টেও বন্ধ, কিন্তু স্পষ্ট করে লেখা, যাতে ভবিষ্যতের কোনো
  ভার্সনে ডিফল্ট বদলালেও গ্রাহকের ডেটা নিয়ে কিছু বাইরে না যায়।
- এই ফাইল `index.ts` থেকে export হয় না — প্যাকেজের বাইরে Better Auth-এর instance কেউ পায় না।

**ফাইল: `packages/auth/src/auth.ts`** (নতুন ফাইল — facade)

```ts
import { eq } from 'drizzle-orm';
import { isAPIError } from 'better-auth/api';
import { sessions, users, type Db } from '@omnivo/db';

import { createAccessTokens, type AccessClaims, type AccessTokenConfig } from './access-token.js';
import { AuthError } from './errors.js';
import { createIdentityProvider } from './identity.js';
import {
  consumeRefreshToken,
  createRefreshToken,
  revokeSessionByRefreshToken,
  type RefreshGrant,
} from './refresh-token.js';

export interface AuthOptions {
  db: Db;
  betterAuthSecret: string;
  baseURL: string;
  sessionTtlSeconds: number;
  accessToken: AccessTokenConfig;
}

// Better Auth-এর session (= একটা ডিভাইসের লগইন); refresh token এর সাথে বাঁধা থাকে
export interface Identity {
  userId: string;
  sessionId: string;
  sessionExpiresAt: Date;
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

// Better Auth-এর error কোড → আমাদের AuthError; অচেনা হলে undefined (caller আসল error ছুড়বে)
function toAuthError(error: unknown): AuthError | undefined {
  if (!isAPIError(error)) return undefined;
  const code: unknown = error.body?.code;
  if (code === 'INVALID_EMAIL_OR_PASSWORD') return new AuthError('INVALID_CREDENTIALS');
  if (code === 'USER_ALREADY_EXISTS' || code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
    return new AuthError('EMAIL_TAKEN');
  }
  return undefined;
}

export function createAuth(options: AuthOptions) {
  const { db } = options;
  const identity = createIdentityProvider({
    db,
    secret: options.betterAuthSecret,
    baseURL: options.baseURL,
    sessionTtlSeconds: options.sessionTtlSeconds,
  });
  const accessTokens = createAccessTokens(options.accessToken);

  // Better Auth session token ফেরত দেয়, id না — refresh_tokens.session_id-এর জন্য id লাগবে
  async function identityFromSessionToken(userId: string, token: string): Promise<Identity> {
    const [session] = await db
      .select({ id: sessions.id, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.token, token));
    if (!session) throw new Error('Better Auth created a session that cannot be found');
    return { userId, sessionId: session.id, sessionExpiresAt: session.expiresAt };
  }

  return {
    async signUp(input: { email: string; password: string; fullName: string }): Promise<Identity> {
      try {
        const result = await identity.api.signUpEmail({
          body: { email: input.email, password: input.password, name: input.fullName },
        });
        // autoSignIn: true, তাই token সবসময় থাকে; null মানে config বদলে গেছে
        if (!result.token) throw new Error('Better Auth did not create a session on sign-up');
        return await identityFromSessionToken(result.user.id, result.token);
      } catch (error) {
        throw toAuthError(error) ?? error;
      }
    },

    async signIn(input: {
      email: string;
      password: string;
      keepSignedIn: boolean;
    }): Promise<Identity> {
      try {
        const result = await identity.api.signInEmail({
          // rememberMe: false হলে Better Auth session ১ দিনে শেষ হয়
          body: { email: input.email, password: input.password, rememberMe: input.keepSignedIn },
        });
        return await identityFromSessionToken(result.user.id, result.token);
      } catch (error) {
        throw toAuthError(error) ?? error;
      }
    },

    // sign-up-এর পরের ধাপ ব্যর্থ হলে "compensating action" — cascade-এ account/session-ও মোছে
    async deleteUser(userId: string): Promise<void> {
      await db.delete(users).where(eq(users.id, userId));
    },

    async revokeSession(sessionId: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    },

    async issueTokens(input: {
      sessionId: string;
      sessionExpiresAt: Date;
      claims: AccessClaims;
    }): Promise<IssuedTokens> {
      const refreshToken = await createRefreshToken(db, {
        sessionId: input.sessionId,
        activeTenantId: input.claims.tenantId,
        expiresAt: input.sessionExpiresAt,
      });
      const access = await accessTokens.sign(input.claims);
      return {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken,
        refreshTokenExpiresAt: input.sessionExpiresAt,
      };
    },

    rotateRefreshToken(refreshToken: string): Promise<RefreshGrant> {
      return consumeRefreshToken(db, refreshToken);
    },

    revokeRefreshToken(refreshToken: string): Promise<void> {
      return revokeSessionByRefreshToken(db, refreshToken);
    },

    getPrincipal: accessTokens.verify,
  };
}

export type Auth = ReturnType<typeof createAuth>;
```

**কোন লাইন কেন:**

- `toAuthError()` — `isAPIError` একটা type guard। `error.body`-র টাইপ Better Auth-এর ভেতরের
  (`better-call`) — আমাদের নিয়ন্ত্রণে নেই, ভার্সনে বদলাতে পারে। তাই `code` আগে একটা `unknown`
  ভেরিয়েবলে রেখে তারপর স্ট্রিংয়ের সাথে তুলনা: টাইপ যাই হোক, আমাদের কোডে `any` ঢোকে না। অচেনা error-এ
  `undefined`, যাতে caller আসল error-টাই ছুড়ে দেয় (`throw toAuthError(error) ?? error`)।
- `identityFromSessionToken` — `signInEmail`/`signUpEmail` session-এর **token** ফেরত দেয়, id না। কিন্তু
  `refresh_tokens.session_id` রাখে id। token-এ unique index আছে, তাই এক query-তেই পাওয়া যায়।
- `if (!result.token)` — সাইনআপে `autoSignIn` বন্ধ থাকলে token `null` হয়। সেটা config-এর ভুল, তাই
  চুপচাপ এগোনোর বদলে স্পষ্ট error।
- `signIn`-এ `rememberMe: input.keepSignedIn` — Better Auth-এর নাম আর আমাদের নাম আলাদা; mapping এখানেই,
  API জানেই না যে Better Auth-এ এটাকে `rememberMe` বলে।
- `deleteUser` — "compensating action": সাইনআপে ইউজার তৈরি (Better Auth) আর workspace তৈরি (আমাদের
  transaction) দুটো আলাদা transaction, তাই দ্বিতীয়টা ব্যর্থ হলে প্রথমটা হাতে উল্টাতে হয়। `users` মুছলে
  FK cascade-এ `accounts` আর `sessions`-ও যায়।
- `issueTokens` — প্রথমে refresh token-এর রো, তারপর JWT। refresh token-এর মেয়াদ = session-এর মেয়াদ,
  তাই "Keep me signed in" বন্ধ থাকলে cookie-ও ১ দিনে শেষ হয়। `activeTenantId`-তে যায় claims-এর
  `tenantId` — refresh-এর সময় এই টেন্যান্টের জন্যই নতুন টোকেন হবে।
- `getPrincipal: accessTokens.verify` — ADR 0002-এর নাম। middleware শুধু এটাই ব্যবহার করে।
- `export type Auth = ReturnType<typeof createAuth>` — টাইপ হাতে লেখা নেই; facade-এ ফাংশন যোগ করলে টাইপ
  নিজে বাড়ে।

**ফাইল: `packages/auth/src/index.ts`** (নতুন ফাইল)

```ts
export { createAuth, type Auth, type Identity, type IssuedTokens } from './auth.js';
export {
  createAccessTokens,
  type AccessClaims,
  type AccessTokenConfig,
  type AccessTokens,
  type Principal,
} from './access-token.js';
export { AuthError, type AuthErrorCode } from './errors.js';
export type { RefreshGrant } from './refresh-token.js';
```

`identity.ts` আর `refresh-token.ts`-এর ফাংশন export হয় না (শুধু `RefreshGrant` টাইপ) — বাইরে থেকে কেউ
সরাসরি টোকেন consume বা Better Auth ডাকতে পারবে না, সব facade দিয়ে।

**ফাইল: `packages/auth/src/access-token.spec.ts`** (নতুন ফাইল)

```ts
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { createAccessTokens } from './access-token.js';

const config = {
  secret: 'test-secret-that-is-at-least-32-bytes-long',
  issuer: 'http://localhost:3000',
  audience: 'omnivo-api',
  ttlSeconds: 900,
};

const claims = {
  userId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8e',
  tenantId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8f',
  membershipId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d90',
  roles: ['Owner'],
};

describe('access tokens', () => {
  it('round-trips the claims', async () => {
    const tokens = createAccessTokens(config);
    const { token, expiresAt } = await tokens.sign(claims);
    const principal = await tokens.verify(token);
    expect(principal).toMatchObject(claims);
    expect(principal?.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it('rejects a token signed with another secret', async () => {
    const other = createAccessTokens({
      ...config,
      secret: 'another-secret-that-is-32-bytes-long!!',
    });
    const { token } = await other.sign(claims);
    expect(await createAccessTokens(config).verify(token)).toBeNull();
  });

  it('rejects a token for another audience', async () => {
    const other = createAccessTokens({ ...config, audience: 'someone-else' });
    const { token } = await other.sign(claims);
    expect(await createAccessTokens(config).verify(token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const tokens = createAccessTokens({ ...config, ttlSeconds: -10 });
    const { token } = await tokens.sign(claims);
    expect(await tokens.verify(token)).toBeNull();
  });

  it('rejects an unsigned (alg: none) token', async () => {
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({ sub: claims.userId, iss: config.issuer, aud: config.audience }),
      ).toString('base64url'),
      '',
    ].join('.');
    expect(await createAccessTokens(config).verify(unsigned)).toBeNull();
  });

  it('rejects a correctly signed token without our custom claims', async () => {
    const key = new TextEncoder().encode(config.secret);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setExpirationTime('5m')
      .setJti('x')
      .sign(key);
    expect(await createAccessTokens(config).verify(token)).toBeNull();
  });

  it('refuses a short secret at startup', () => {
    expect(() => createAccessTokens({ ...config, secret: 'short' })).toThrow(/at least 32 bytes/);
  });
});
```

সাতটা টেস্ট, প্রতিটা একটা আলাদা আক্রমণ বা ভুল ধরে: ঠিক টোকেন ফেরত আসে; অন্য secret-এ বানানো জাল টোকেন;
অন্য `aud`-এর টোকেন; মেয়াদোত্তীর্ণ (`ttlSeconds: -10` দিয়ে বানানো); `alg: none`; ঠিক secret কিন্তু
আমাদের claim নেই; আর ছোট secret-এ চালুর সময়েই থেমে যাওয়া। DB লাগে না, তাই সাধারণ `pnpm test`-এ চলে।

---

## ৩.৪ — API-র ভিত্তি: config, DB/Redis provider, tenant context

```bash
pnpm --filter @omnivo/api add 'ioredis@^6.0.0' 'zod@^4.6.5' '@fastify/cookie@^11.1.2' 'fastify@5.12.5' '@omnivo/auth@workspace:*' '@omnivo/contracts@workspace:*'
pnpm dedupe
```

- `fastify@5.12.5` — হুবহু এই ভার্সন, `^` ছাড়া। `@nestjs/platform-fastify` 12.0.4 নিজে `fastify`
  5.12.5 pin করে রাখে। আমাদের দিকে অন্য ভার্সন থাকলে দুটো কপি হতো: controller-এ `FastifyReply` টাইপ
  আসত এক কপি থেকে, আর `@fastify/cookie`-এর `reply.setCookie` টাইপ যোগ হতো অন্য কপিতে। `fastify`
  লাগছে শুধু `FastifyReply`/`FastifyRequest` টাইপের জন্য। **Nest আপগ্রেড করলে এই pin-ও মিলিয়ে বদলাতে
  হবে।**
- `@fastify/cors` আলাদা করে লাগে না — `@nestjs/platform-fastify` এটা নিজেই সাথে আনে, `app.enableCors()`
  সেটাই ব্যবহার করে।
- `ioredis` — BullMQ (ধাপ ৮) এটাই ব্যবহার করে, তাই একটাই Redis client থাকবে। Valkey Redis-এর protocol
  মানে, তাই client একই।

**ফাইল: `.env.example`** (আপডেট — শেষে যোগ)

```bash
# App runtime — NOBYPASSRLS role, সব tenant query এই দিয়ে যাবে
DATABASE_URL=postgres://omnivo_app:app_dev_password@localhost:5432/omnivo

# Migration/seed শুধু — DDL চালায়; FORCE RLS-এর কারণে ডেটা লিখতে tenant context লাগে
MIGRATOR_DATABASE_URL=postgres://omnivo_migrator:migrator_dev_password@localhost:5432/omnivo

# Valkey (Redis-compatible) — permission cache
REDIS_URL=redis://localhost:6379

# JWT-এর `iss` আর Better Auth-এর baseURL — API নিজের ঠিকানা
API_BASE_URL=http://localhost:3000
# CORS: শুধু এই origin থেকে cookie সহ request চলবে
APP_ORIGIN=http://localhost:5173

# শুধু dev-এর জন্য। production-এ প্রতিটা আলাদা করে বানান: openssl rand -base64 32
BETTER_AUTH_SECRET=dev-only-better-auth-secret-change-me-0123456789
JWT_SECRET=dev-only-jwt-secret-change-me-0123456789abcdef
```

তারপর **নিজের `.env`-এ এই নতুন লাইনগুলো কপি করুন।** একটা জিনিস মনে রাখবেন: `pnpm dev` চলে turbo
দিয়ে, আর turbo 2 ডিফল্টে "strict env mode"-এ task চালায় — shell-এ `export` করা যে ভেরিয়েবল
`turbo.json`-এ ঘোষণা করা নেই, সেটা task পর্যন্ত পৌঁছায় না (যাচাই করা: shell-এ দিলে API বলে
`Invalid environment`)। আমাদের API `.env` ফাইল নিজে পড়ে (`src/env.ts`-এর dotenv), তাই মান `.env`-এ
রাখলেই কাজ করে।

- `BETTER_AUTH_SECRET` আর `JWT_SECRET` আলাদা — একই key দুই কাজে (Better Auth-এর ভেতরের HMAC/encryption
  আর আমাদের JWT স্বাক্ষর) ব্যবহার করা cryptography-র খারাপ অভ্যাস; একটা ফাঁস হলে দুটোই যেত।
- `.env.example`-এর মানগুলো শুধু dev-এর জন্য (DB পাসওয়ার্ডের মতোই), দুটোই ৩২ অক্ষরের বেশি — config-এর
  `min(32)` পাস করতে।

**ফাইল: `apps/api/src/config.ts`** (নতুন ফাইল)

```ts
import { z } from 'zod';

// process.env-এর সব মান string | undefined — এখানে একবার যাচাই করে টাইপ-নিরাপদ Config বানানো
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  API_BASE_URL: z.url(),
  APP_ORIGIN: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  JWT_SECRET: z.string().min(32),
});

const DAY = 24 * 60 * 60;

export function loadConfig(env: Record<string, string | undefined>) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment — compare your .env with .env.example:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appOrigin: e.APP_ORIGIN,
    // localhost-এ http, তাই dev-এ Secure cookie বন্ধ; production-এ বাধ্যতামূলক
    secureCookies: e.NODE_ENV === 'production',
    auth: {
      betterAuthSecret: e.BETTER_AUTH_SECRET,
      baseURL: e.API_BASE_URL,
      sessionTtlSeconds: 30 * DAY,
      accessToken: {
        secret: e.JWT_SECRET,
        issuer: e.API_BASE_URL,
        audience: 'omnivo-api',
        ttlSeconds: 15 * 60,
      },
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
```

**কোন লাইন কেন:**

- `envSchema` — `process.env`-এর সব মান `string | undefined`। Zod দিয়ে একবার যাচাই করলে বাকি কোড
  টাইপ-নিরাপদ মান পায়; কোনো মান না থাকলে অ্যাপ চালুর সময়েই থামে, প্রথম request-এ গিয়ে না।
- `z.coerce.number()` — env-এ সবই স্ট্রিং; `PORT=3000`-কে সংখ্যা বানায়।
- `z.url()` — `postgres://…`, `redis://…` দুটোই URL হিসেবে পাস হয় (Zod 4 যেকোনো scheme মানে)।
  ভুল বানানের URL চালুতেই ধরা পড়ে।
- `z.prettifyError` — কোন ভেরিয়েবল নেই বা ভুল, সেটা লাইন ধরে দেখায়। মেসেজে বলা আছে কী করতে হবে
  (`.env.example`-এর সাথে মেলান)।
- ফেরত আসা object-এর আকার `createAuth()`-এর `AuthOptions`-এর সাথে মেলানো (`config.auth`), তাই
  `createAuth({ db, ...config.auth })` এক লাইনে হয়।
- `secureCookies: NODE_ENV === 'production'` — `Secure` cookie শুধু HTTPS-এ যায়। dev-এ
  `http://localhost`-এ Chrome ব্যতিক্রম হিসেবে মানে, কিন্তু Safari সবসময় মানে না। তাই dev-এ বন্ধ,
  production-এ বাধ্যতামূলক।
- `sessionTtlSeconds: 30 * DAY` আর access token `15 * 60` — system-design §৩.১০: "short-lived access
  JWT (১০–১৫ মিনিট)"। ছোট মানে চুরি হওয়া access token বেশিক্ষণ কাজে লাগে না; রোল বদলালে সর্বোচ্চ ১৫
  মিনিটে নতুন টোকেনে পৌঁছায়।
- `audience: 'omnivo-api'` — OIDC-তে access token-এর `aud` হলো যে সার্ভিস টোকেন গ্রহণ করে (আমাদের API),
  অ্যাপ না।
- `export type Config = ReturnType<typeof loadConfig>` — হাতে লেখা interface নেই।

**ফাইল: `apps/api/src/infra/tokens.ts`** (নতুন ফাইল)

```ts
// Nest DI token — এগুলোর পেছনের টাইপ (Db, Auth, WithTenant…) interface/type, class না,
// তাই emitDecoratorMetadata টাইপ দেখে inject করতে পারে না; @Inject(TOKEN) লাগে
export const CONFIG = Symbol('CONFIG');
export const DB = Symbol('DB');
export const WITH_TENANT = Symbol('WITH_TENANT');
export const WITH_USER = Symbol('WITH_USER');
export const REDIS = Symbol('REDIS');
export const AUTH = Symbol('AUTH');
```

**কেন Symbol:** Nest-এ `constructor(private readonly x: SomeClass)` কাজ করে কারণ `emitDecoratorMetadata`
class-টাকেই DI token হিসেবে রেখে দেয়। `Db`, `Auth`, `WithTenant` class না, শুধু টাইপ — compile-এর পর
মুছে যায়, metadata-তে থাকে শুধু `Object`। তাই `@Inject(DB)` দিয়ে স্পষ্ট token দিতে হয় (ধাপ ২-এর শেষ
নোটে এটাই বলা ছিল)। স্ট্রিং না, `Symbol` — দুটো মডিউল ভুল করে একই নাম দিলেও সংঘর্ষ হয় না।

**ফাইল: `apps/api/src/infra/infra.module.ts`** (নতুন ফাইল)

```ts
import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createAuth } from '@omnivo/auth';
import { createDb, type Db } from '@omnivo/db';
import { Redis } from 'ioredis';

import { createWithTenant } from '../common/tenant/with-tenant.js';
import { createWithUser } from '../common/tenant/with-user.js';
import type { Config } from '../config.js';
import { AUTH, CONFIG, DB, REDIS, WITH_TENANT, WITH_USER } from './tokens.js';

function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    // Redis বন্ধ থাকলে command queue-তে জমে থাকবে না, সাথে সাথে fail করবে —
    // permission cache তখন DB-তে fallback করে, request ঝুলে থাকে না
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  const logger = new Logger('Redis');
  redis.on('error', (error: Error) => {
    logger.warn(error.message);
  });
  return redis;
}

@Module({})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  static register(config: Config): DynamicModule {
    return {
      module: InfraModule,
      global: true,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DB, useFactory: () => createDb(config.databaseUrl) },
        { provide: WITH_TENANT, inject: [DB], useFactory: (db: Db) => createWithTenant(db) },
        { provide: WITH_USER, inject: [DB], useFactory: (db: Db) => createWithUser(db) },
        { provide: REDIS, useFactory: () => createRedis(config.redisUrl) },
        { provide: AUTH, inject: [DB], useFactory: (db: Db) => createAuth({ db, ...config.auth }) },
      ],
      exports: [CONFIG, DB, WITH_TENANT, WITH_USER, REDIS, AUTH],
    };
  }

  // app.close() বা SIGTERM-এ pool আর Redis connection বন্ধ — নাহলে process ঝুলে থাকে
  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.db.$client.end();
  }
}
```

**কোন লাইন কেন:**

- `static register(config)` → `DynamicModule` — config বাইরে থেকে আসে: `main.ts`-এ `process.env`
  থেকে, টেস্টে Testcontainers-এর URL থেকে। এতে টেস্টে `process.env` বদলাতে হয় না, আর
  `@nestjs/testing`-এর override-ও লাগে না।
- `global: true` — DB, Redis, Auth সব মডিউলেরই লাগে; প্রতিটা মডিউলে আলাদা করে import লিখতে হয় না।
- `useFactory` — ধাপ ২-এ `db` singleton import-time-এ তৈরি হতো বলে বাদ দেওয়া হয়েছিল (`postgres('')`
  চুপচাপ ভুল DB-তে যেত)। এখন Nest চালুর সময় একবার তৈরি হয়, config যাচাইয়ের পরে।
- `inject: [DB]` দিয়ে `WITH_TENANT`, `WITH_USER`, `AUTH` — তিনজনই একই connection pool শেয়ার করে।
- `enableOfflineQueue: false` — ioredis-এর ডিফল্ট: Redis বন্ধ থাকলে command queue-তে জমিয়ে রাখে আর
  reconnect-এর অপেক্ষা করে — ফলে প্রতিটা request ঝুলে থাকত। বন্ধ করায় সঙ্গে সঙ্গে error আসে, আর
  `PermissionService` DB-তে চলে যায়। cache না থাকলে অ্যাপ একটু ধীর হয়, কিন্তু বন্ধ হয় না।
- `redis.on('error', …)` — listener না থাকলে ioredis প্রতিটা reconnect ব্যর্থতায় "Unhandled error
  event" ছাপে। Nest-এর Logger দিয়ে warning হিসেবে লেখা।
- `onApplicationShutdown` — module class নিজেই provider inject করে বন্ধ করে। `useFactory`-তে তৈরি
  object-এ lifecycle hook বসানো যায় না, তাই এই জায়গাটা। pool খোলা থাকলে টেস্টে `app.close()`-এর পর
  Vitest ঝুলে থাকত, আর production-এ SIGTERM-এর পর process শেষ হতো না।

**ফাইল: `apps/api/src/common/tenant/tenant-context.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '@omnivo/auth';

export interface TenantStore {
  tenantId: string;
  // HTTP request-এ AuthMiddleware বসায়; background job-এ (ধাপ ৮) শুধু tenantId থাকবে
  principal?: Principal;
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>();

export function getTenantId(): string {
  const store = tenantStorage.getStore();
  if (!store) {
    throw new Error('No tenant context — did AuthMiddleware run for this request?');
  }
  return store.tenantId;
}

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run({ tenantId }, fn);
}

export function runWithPrincipal<T>(principal: Principal, fn: () => T): T {
  return tenantStorage.run({ tenantId: principal.tenantId, principal }, fn);
}

export function currentPrincipal(): Principal {
  const principal = tenantStorage.getStore()?.principal;
  if (!principal) {
    throw new Error('No principal — is this route marked @Public()?');
  }
  return principal;
}
```

**কী বদলাল আর কেন:**

- `TenantStore`-এ নতুন `principal?: Principal` — একটাই `AsyncLocalStorage`-এ টেন্যান্ট আর "কে"
  দুটোই থাকে। দুটো আলাদা storage রাখলে দুটো একসাথে ঠিক থাকা নিশ্চিত করা কঠিন হতো। ঐচ্ছিক (`?`)
  কারণ background job-এ (ধাপ ৮) কোনো ইউজার থাকে না, শুধু টেন্যান্ট।
- `runWithTenant` আগের মতোই — ধাপ ২-এর leak test অপরিবর্তিত চলে।
- `runWithPrincipal` — middleware এটা ডাকে। `tenantId` নেওয়া হয় `principal.tenantId` থেকে, আলাদা
  প্যারামিটার হিসেবে না — তাই টেন্যান্ট আর টোকেন কখনো আলাদা হতে পারে না।
- `currentPrincipal()` — নাম `getPrincipal` না, কারণ facade-এ `getPrincipal(token)` আছে; একই নামের
  দুটো ভিন্ন ফাংশন বিভ্রান্তিকর। না থাকলে throw — `@Public()` রুটে কেউ ভুল করে ডাকলে সঙ্গে সঙ্গে ধরা
  পড়ে।
- error মেসেজে `TenantMiddleware` → `AuthMiddleware`।

**ফাইল: `apps/api/src/common/tenant/with-tenant.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import { sql } from 'drizzle-orm';
import type { Db } from '@omnivo/db';

import { getTenantId } from './tenant-context.js';

export type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

// tenant context বসানোর একমাত্র জায়গা — কখনো `SET app.tenant_id` না
export async function setTenantContext(tx: Transaction, tenantId: string): Promise<void> {
  // true = transaction-local — commit/rollback-এর সাথে এই সেটিংও যায়, PgBouncer-নিরাপদ
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
}

export function createWithTenant(database: Db) {
  return async function withTenant<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const tenantId = getTenantId();
    return database.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      return fn(tx);
    });
  };
}

export type WithTenant = ReturnType<typeof createWithTenant>;
```

**কী বদলাল:** `set_config` লাইনটা নিজস্ব ফাংশন `setTenantContext()`-এ সরানো হয়েছে। সাইনআপে নতুন
টেন্যান্ট তৈরির transaction-এ context হাতে বসাতে হয় (তখনো ALS-এ কোনো টেন্যান্ট নেই), আর "কখনো `SET`
না, সবসময় `set_config(..., true)`" নিয়মটা এক জায়গাতেই থাকা উচিত। `withTenant`-এর আচরণ হুবহু আগের
মতো — leak test প্রমাণ করে।

**ফাইল: `apps/api/src/common/tenant/with-user.ts`** (নতুন ফাইল)

```ts
import { sql } from 'drizzle-orm';
import type { Db } from '@omnivo/db';

import type { Transaction } from './with-tenant.js';

// tenant context ছাড়া "এই ইউজারের নিজের membership" পড়ার জন্য — migration 0004-এর
// own_memberships policy শুধু app.user_id দেখে, আর সেটা শুধু SELECT-এ কাজ করে
export function createWithUser(database: Db) {
  return async function withUser<T>(
    userId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return database.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
      return fn(tx);
    });
  };
}

export type WithUser = ReturnType<typeof createWithUser>;
```

**কেন:** tenant switcher-এর জন্য লাগে "এই ইউজার কোন কোন টেন্যান্টে আছে" — এটা ইচ্ছাকৃতভাবে সব
টেন্যান্ট জুড়ে একটা query। `withTenant` দিয়ে সম্ভব না (RLS শুধু এক টেন্যান্ট দেখায়)। ধাপ ১-এর
migration 0004-এ ঠিক এর জন্যই `own_memberships` policy আছে, যেটা `app.user_id` দেখে। policy-টা
`FOR SELECT`, তাই এই helper দিয়ে কেউ অন্যের membership বদলাতে পারবে না। `tenant_id` সেট না থাকায়
`tenant_isolation` policy এখানে কিছুই দেখায় না — দুটো policy OR হয়, তাই শুধু নিজের রো আসে।

**ফাইল: `apps/api/src/common/zod-validation.pipe.ts`** (নতুন ফাইল)

```ts
import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

// @Body(new ZodValidationPipe(schema)) — body unknown হিসেবে আসে, schema দিয়ে parse হয়ে টাইপ পায়
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<TSchema>
> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Check the highlighted fields and try again.',
        fieldErrors: z.flattenError(result.error).fieldErrors,
      });
    }
    return result.data;
  }
}
```

**কোন লাইন কেন:**

- `PipeTransform<unknown, z.output<TSchema>>` — ঢোকে `unknown` (ক্লায়েন্ট যা খুশি পাঠাতে পারে), বের হয়
  schema-র output টাইপ।
- `safeParse` + `z.flattenError(...).fieldErrors` — `{ email: ['Enter an email…'] }` আকারে ফিল্ড ধরে
  error। ফ্রন্টএন্ড এটা সরাসরি ইনপুটের নিচে দেখায়, আর আকারটা `apiErrorSchema`-র সাথে মেলে।
- `class-validator`/`class-transformer` নেওয়া হয়নি — schema তো আগে থেকেই Zod-এ আছে
  (`@omnivo/contracts`); DTO class লিখলে একই নিয়ম দুবার লিখতে হতো।
- একটা সীমাবদ্ধতা: `@Body(new ZodValidationPipe(schema)) body: SignUpInput`-এ প্যারামিটারের টাইপ
  (`SignUpInput`) আর pipe-এর output টাইপ Nest নিজে মিলিয়ে দেখে না। তাই সবসময় একই schema-র `z.infer`
  টাইপ লিখবেন (যেমন `signUpInputSchema` ↔ `SignUpInput`)।

---

## ৩.৫ — API-তে auth: middleware, guard, endpoint

**ফাইল: `apps/api/src/auth/public.decorator.ts`** (নতুন ফাইল)

```ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'omnivo:isPublic';

// AuthGuard global — ডিফল্টে প্রতিটা রুট লগইন চায়; শুধু এই decorator দিলে খোলা
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
```

**কেন উল্টো পথ (`@Public` দিয়ে খোলা, `@Authenticated` দিয়ে বন্ধ না):** নতুন রুট লেখার সময় কিছু লিখতে
ভুলে গেলে ডিফল্টে সেটা বন্ধ থাকে। ভুলের ফল 401 — বিরক্তিকর, কিন্তু নিরাপদ। উল্টোটা হলে ভুলের ফল হতো
ডেটা leak। key-তে `omnivo:` prefix — অন্য লাইব্রেরির metadata-র সাথে নাম মিলে যাওয়া এড়াতে। ফেরত টাইপ
`MethodDecorator & ClassDecorator` — method বা পুরো controller দুটোতেই বসানো যায় (`HealthController`
পুরোটাই public)।

**ফাইল: `apps/api/src/auth/auth.guard.ts`** (নতুন ফাইল — ধাপ ২-এর `TenantGuard`-এর জায়গায়)

```ts
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { tenantStorage } from '../common/tenant/tenant-context.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // method-এর decorator আগে, না থাকলে class-এর
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    if (!tenantStorage.getStore()?.principal) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    return true;
  }
}
```

**কোন লাইন কেন:**

- `getAllAndOverride<boolean | undefined>(…, [handler, class])` — আগে method-এর decorator দেখে, না
  থাকলে class-এর। generic স্পষ্ট করে দেওয়া আছে, নাহলে Nest-এর ডিফল্ট ফেরত টাইপ `any` হয়।
- `isPublic === true` — শুধু `true` হলেই খোলা; ভুল কোনো মান (যেমন স্ট্রিং) হলে বন্ধই থাকে।
- `UnauthorizedException` (401), ধাপ ২-এর মতো `403` না — টোকেন নেই মানে "তুমি কে জানি না" (401); 403
  মানে "জানি তুমি কে, কিন্তু অনুমতি নেই"। ফ্রন্টএন্ড 401 দেখেই refresh চেষ্টা করে, তাই পার্থক্যটা
  জরুরি।

**ফাইল: `apps/api/src/auth/auth.middleware.ts`** (নতুন ফাইল — ধাপ ২-এর `TenantMiddleware`-এর জায়গায়)

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { Auth } from '@omnivo/auth';

import { runWithPrincipal } from '../common/tenant/tenant-context.js';
import { AUTH } from '../infra/tokens.js';

// RFC 6750: `Authorization: Bearer <token>`; scheme case-insensitive
const BEARER = /^Bearer\s+(\S+)$/i;

@Injectable()
export class AuthMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  // পুরো Auth না, শুধু getPrincipal — টেস্টে DB ছাড়াই একটা verifier দিয়ে চালানো যায়
  constructor(@Inject(AUTH) private readonly auth: Pick<Auth, 'getPrincipal'>) {}

  async use(req: IncomingMessage, _res: ServerResponse, next: () => void): Promise<void> {
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const principal = token ? await this.auth.getPrincipal(token) : null;

    if (principal) {
      // tenant আসে শুধু যাচাই করা টোকেন থেকে — header/body/query থেকে কখনো না
      runWithPrincipal(principal, next);
      return;
    }

    // টোকেন নেই বা ভুল: context ছাড়াই এগোনো; পাবলিক রুট চলবে, বাকিগুলো AuthGuard 401 দেবে
    next();
  }
}
```

**কোন লাইন কেন:**

- `Pick<Auth, 'getPrincipal'>` — middleware-এর শুধু টোকেন যাচাই লাগে। পুরো `Auth` চাইলে টেস্টে DB আর
  Better Auth সহ সব বানাতে হতো; এখন `auth.middleware.spec.ts` শুধু একটা verifier দিয়ে চলে।
- `BEARER` regex-এ `/i` — RFC 7235 অনুযায়ী scheme (`Bearer`) case-insensitive। `(\S+)` — টোকেনে কোনো
  space থাকে না।
- `?.[1]` আর `token ? … : null` — header না থাকলে বা আকার না মিললে DB/crypto-র কোনো কাজ না করেই এগোনো।
- `async use(...)` — JWT যাচাই async। Nest middleware-এর async error নিজেই ধরে (500 দেয়), unhandled
  rejection হয় না।
- `runWithPrincipal(principal, next)` — ধাপ ২-এর মতোই, `next`-কে `run()`-এর ভেতর থেকে ডাকা হয়, যাতে
  guard, handler আর তার ভেতরের সব `await` context পায়। এখানে একটা পার্থক্য: `run()`-এর আগে একটা
  `await` আছে। ALS তবুও কাজ করে, কারণ context তৈরি হয় `run()`-এর মুহূর্তে, তার আগের await-এ কিছু যায়
  আসে না — `auth.middleware.spec.ts`-এর "keeps the context across an await" টেস্ট এটা প্রমাণ করে।
- টোকেন ভুল হলে 401 এখানে না দিয়ে প্লেইন `next()` — `/health`, `/auth/login`-এর মতো পাবলিক রুটে পুরনো
  টোকেন পাঠালেও যেন আটকে না যায়। বাধ্য করে `AuthGuard`, middleware না (ধাপ ২-এর একই নীতি)।

**ফাইল: `apps/api/src/auth/refresh-cookie.ts`** (নতুন ফাইল)

```ts
import type { FastifyReply } from 'fastify';

export const REFRESH_COOKIE = 'omnivo_rt';

// cookie শুধু /auth/*-এ যায় (refresh, logout, switch-tenant) — বাকি API request-এ না
const COOKIE_PATH = '/auth';

export function setRefreshCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  secure: boolean,
): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: COOKIE_PATH,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: COOKIE_PATH,
  });
}
```

**প্রতিটা cookie অপশন কেন:**

- `httpOnly: true` — ব্রাউজারের JavaScript (তাই XSS স্ক্রিপ্টও) এই cookie পড়তে পারে না।
- `sameSite: 'strict'` — অন্য কোনো সাইট থেকে আসা request-এ ব্রাউজার cookie পাঠায় না। এটাই CSRF-এর
  দেয়াল: `evil.com` ইউজারের ব্রাউজার দিয়ে `/auth/refresh` বা `/auth/logout` ডাকালে cookie যাবেই না।
  (dev-এ `localhost:5173` থেকে `localhost:3000` — port আলাদা, কিন্তু "site" একই (`localhost`), তাই
  cookie যায়। production-এ `app.omnivo.app` আর `api.omnivo.app` একই site।)
- `path: '/auth'` — cookie শুধু `/auth/*`-এ যায়। `/members`-এর মতো সাধারণ request-এ যায় না, তাই কোনো লগ
  বা ভুল endpoint-এ ফাঁস হওয়ার সুযোগ কম।
- `expires: expiresAt` — session-এর মেয়াদের সাথে মিলিয়ে; মেয়াদ শেষে ব্রাউজার নিজেই ফেলে দেয়।
- `clearRefreshCookie`-এ একই `path`/`sameSite` — cookie মুছতে হলে একই path দিতে হয়, নাহলে ব্রাউজার
  এটাকে আলাদা cookie ধরে আর আসলটা থেকে যায়।
- আলাদা CSRF টোকেন নেই — `SameSite=Strict`, CORS-এ শুধু নিজেদের origin, আর body JSON (যা cross-site
  ফর্ম দিয়ে পাঠানো যায় না) মিলে যথেষ্ট।

**ফাইল: `apps/api/src/auth/auth.service.ts`** (নতুন ফাইল)

```ts
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  type Auth,
  AuthError,
  type Identity,
  type IssuedTokens,
  type Principal,
  type RefreshGrant,
} from '@omnivo/auth';
import type { LoginInput, MeResponse, SignUpInput } from '@omnivo/contracts';
import {
  type Db,
  OWNER_ROLE_NAME,
  membershipRoles,
  memberships,
  permissions,
  rolePermissions,
  roles,
  tenants,
  users,
} from '@omnivo/db';

import { runWithTenant } from '../common/tenant/tenant-context.js';
import { setTenantContext, type WithTenant } from '../common/tenant/with-tenant.js';
import type { WithUser } from '../common/tenant/with-user.js';
import { AUTH, DB, WITH_TENANT, WITH_USER } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';

interface MembershipGrant {
  membershipId: string;
  roles: string[];
}

function workspaceTaken(slug: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: `${slug}.omnivo.app is taken.`,
    fieldErrors: { workspaceSlug: [`${slug}.omnivo.app is taken. Try adding your city.`] },
  });
}

// drizzle Postgres error-কে DrizzleQueryError-এ মুড়ে দেয়; আসল কোড থাকে .cause-এ
function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint_name' in current &&
      current.constraint_name === constraint
    ) {
      return true;
    }
  }
  return false;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(WITH_USER) private readonly withUser: WithUser,
    private readonly permissionService: PermissionService,
  ) {}

  async signUp(input: SignUpInput): Promise<IssuedTokens> {
    // ইউজার তৈরির আগে slug চেক — নাহলে প্রায় প্রতিটা "taken" ক্ষেত্রে ইউজার বানিয়ে আবার মুছতে হতো
    if (await this.findTenantBySlug(input.workspaceSlug)) {
      throw workspaceTaken(input.workspaceSlug);
    }

    let identity: Identity;
    try {
      identity = await this.auth.signUp({
        email: input.email,
        password: input.password,
        fullName: input.fullName,
      });
    } catch (error) {
      if (error instanceof AuthError && error.code === 'EMAIL_TAKEN') {
        throw new ConflictException({
          statusCode: 409,
          message: 'An account with this email already exists.',
          fieldErrors: { email: ['An account with this email already exists. Sign in instead.'] },
        });
      }
      throw error;
    }

    let workspace: { tenantId: string } & MembershipGrant;
    try {
      workspace = await this.provisionWorkspace(identity.userId, input);
    } catch (error) {
      // Better Auth-এর ইউজার আর আমাদের workspace আলাদা transaction-এ — তাই হাতে rollback।
      // provision-এর transaction rollback হয়েছে, তাই এই ইউজারের কোনো membership নেই, মোছা যায়
      await this.auth.deleteUser(identity.userId);
      // pre-check-এর পরে কেউ একই slug নিয়ে ফেললে (race) unique index ধরবে
      if (isUniqueViolation(error, 'tenants_slug_idx')) throw workspaceTaken(input.workspaceSlug);
      throw error;
    }

    return this.auth.issueTokens({
      sessionId: identity.sessionId,
      sessionExpiresAt: identity.sessionExpiresAt,
      claims: { userId: identity.userId, ...workspace },
    });
  }

  async login(input: LoginInput): Promise<IssuedTokens> {
    const tenant = await this.findTenantBySlug(input.workspace);
    if (!tenant) {
      throw new NotFoundException({
        statusCode: 404,
        message: `We couldn't find ${input.workspace}.omnivo.app.`,
        fieldErrors: {
          workspace: [`We couldn't find ${input.workspace}.omnivo.app. Check the address.`],
        },
      });
    }

    let identity: Identity;
    try {
      identity = await this.auth.signIn({
        email: input.email,
        password: input.password,
        keepSignedIn: input.keepSignedIn,
      });
    } catch (error) {
      if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') {
        throw new UnauthorizedException(
          'Email or password is incorrect. Check them and try again.',
        );
      }
      throw error;
    }

    const membership = await this.findMembership(tenant.id, identity.userId);
    if (!membership) {
      // পাসওয়ার্ড ঠিক, কিন্তু এই workspace-এ নেই — Better Auth যে session বানিয়েছে সেটা ফেলে দেওয়া
      await this.auth.revokeSession(identity.sessionId);
      throw new ForbiddenException(
        `This account isn't a member of ${tenant.slug}.omnivo.app. Ask a workspace owner to invite you.`,
      );
    }

    return this.auth.issueTokens({
      sessionId: identity.sessionId,
      sessionExpiresAt: identity.sessionExpiresAt,
      claims: { userId: identity.userId, tenantId: tenant.id, ...membership },
    });
  }

  async refresh(refreshToken: string | undefined): Promise<IssuedTokens> {
    const grant = await this.rotate(refreshToken);
    // টোকেনের রোল ১৫ মিনিট পর্যন্ত পুরনো থাকতে পারে; প্রতিটা refresh-এ DB থেকে নতুন করে
    const membership = await this.findMembership(grant.activeTenantId, grant.userId);
    if (!membership) {
      await this.auth.revokeSession(grant.sessionId);
      throw new UnauthorizedException(
        'You no longer have access to this workspace. Sign in again.',
      );
    }
    return this.auth.issueTokens({
      sessionId: grant.sessionId,
      sessionExpiresAt: grant.sessionExpiresAt,
      claims: { userId: grant.userId, tenantId: grant.activeTenantId, ...membership },
    });
  }

  async switchTenant(
    principal: Principal,
    refreshToken: string | undefined,
    tenantId: string,
  ): Promise<IssuedTokens> {
    // refresh token খরচ করার আগে membership যাচাই — নাহলে ভুল tenantId দিলেই লগআউট হয়ে যেত
    const membership = await this.findMembership(tenantId, principal.userId);
    if (!membership) {
      throw new ForbiddenException("You aren't a member of that workspace.");
    }

    const grant = await this.rotate(refreshToken);
    if (grant.userId !== principal.userId) {
      // access token এক ইউজারের, cookie আরেকজনের — এমন অবস্থা স্বাভাবিকভাবে হয় না
      await this.auth.revokeSession(grant.sessionId);
      throw new UnauthorizedException('Your session has ended. Sign in again.');
    }

    return this.auth.issueTokens({
      sessionId: grant.sessionId,
      sessionExpiresAt: grant.sessionExpiresAt,
      claims: { userId: principal.userId, tenantId, ...membership },
    });
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) await this.auth.revokeRefreshToken(refreshToken);
  }

  async me(principal: Principal): Promise<MeResponse> {
    const [user] = await this.db
      .select({ id: users.id, email: users.email, fullName: users.fullName })
      .from(users)
      .where(eq(users.id, principal.userId));
    const [tenant] = await this.db
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, principal.tenantId));
    if (!user || !tenant) throw new UnauthorizedException('Your session has ended. Sign in again.');

    // tenant switcher-এর তালিকা: সব টেন্যান্ট জুড়ে নিজের membership — তাই withTenant না, withUser
    const workspaces = await this.withUser(principal.userId, (tx) =>
      tx
        .select({ tenantId: tenants.id, name: tenants.name, slug: tenants.slug })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(
          and(
            eq(memberships.userId, principal.userId),
            isNull(memberships.deletedAt),
            isNull(tenants.deletedAt),
          ),
        )
        .orderBy(asc(tenants.name)),
    );

    const granted = await this.permissionService.forPrincipal(principal);

    return {
      user,
      tenant,
      roles: [...principal.roles],
      permissions: [...granted].sort(),
      memberships: workspaces,
    };
  }

  private async rotate(refreshToken: string | undefined): Promise<RefreshGrant> {
    if (!refreshToken) throw new UnauthorizedException('Your session has ended. Sign in again.');
    try {
      return await this.auth.rotateRefreshToken(refreshToken);
    } catch (error) {
      if (error instanceof AuthError) {
        throw new UnauthorizedException('Your session has ended. Sign in again.');
      }
      throw error;
    }
  }

  private async findTenantBySlug(slug: string) {
    const [tenant] = await this.db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(and(eq(tenants.slug, slug), isNull(tenants.deletedAt)));
    return tenant;
  }

  private async findMembership(tenantId: string, userId: string): Promise<MembershipGrant | null> {
    return runWithTenant(tenantId, () =>
      this.withTenant(async (tx) => {
        const [membership] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenantId, tenantId),
              eq(memberships.userId, userId),
              isNull(memberships.deletedAt),
            ),
          );
        if (!membership) return null;

        const roleRows = await tx
          .select({ name: roles.name })
          .from(membershipRoles)
          .innerJoin(
            roles,
            and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
          )
          .where(
            and(
              eq(membershipRoles.membershipId, membership.id),
              isNull(membershipRoles.deletedAt),
              isNull(roles.deletedAt),
            ),
          )
          .orderBy(asc(roles.name));

        return { membershipId: membership.id, roles: roleRows.map((row) => row.name) };
      }),
    );
  }

  // একটা transaction: tenant → (context বসিয়ে) membership → Owner রোল → সব permission → রোল বরাদ্দ
  private async provisionWorkspace(
    userId: string,
    input: SignUpInput,
  ): Promise<{ tenantId: string } & MembershipGrant> {
    return this.db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({ name: input.companyName, slug: input.workspaceSlug })
        .returning({ id: tenants.id });
      if (!tenant) throw new Error('Tenant insert returned no row');

      // tenants-এ RLS নেই, কিন্তু বাকি সব টেবিলে FORCE RLS — এখান থেকে context লাগবে
      await setTenantContext(tx, tenant.id);

      const [membership] = await tx
        .insert(memberships)
        .values({ tenantId: tenant.id, userId, createdBy: userId })
        .returning({ id: memberships.id });
      const [owner] = await tx
        .insert(roles)
        .values({ tenantId: tenant.id, name: OWNER_ROLE_NAME, createdBy: userId })
        .returning({ id: roles.id });
      if (!membership || !owner) throw new Error('Membership or role insert returned no row');

      const allPermissions = await tx.select({ id: permissions.id }).from(permissions);
      if (allPermissions.length === 0) {
        throw new Error('The permissions table is empty — run `pnpm db:migrate`');
      }
      await tx.insert(rolePermissions).values(
        allPermissions.map((permission) => ({
          tenantId: tenant.id,
          roleId: owner.id,
          permissionId: permission.id,
          createdBy: userId,
        })),
      );
      await tx.insert(membershipRoles).values({
        tenantId: tenant.id,
        membershipId: membership.id,
        roleId: owner.id,
        createdBy: userId,
      });

      return { tenantId: tenant.id, membershipId: membership.id, roles: [OWNER_ROLE_NAME] };
    });
  }
}
```

**কোন অংশ কেন:**

- **`signUp` — তিন ধাপ, আর ক্রমটাই মূল কথা।**
  1. আগে slug চেক। ইউজার বানানোর পরে টেন্যান্টে ব্যর্থ হলে ইউজার মুছতে হতো; সাধারণ "নাম আগেই নেওয়া"
     ক্ষেত্রে সেই ঝামেলা আসেই না।
  2. `auth.signUp()` — Better Auth ইউজার + পাসওয়ার্ড বানায়। ইমেইল আগে থেকে থাকলে 409, সাথে
     `fieldErrors.email`, যাতে ফর্ম ঠিক ইনপুটের নিচে দেখায়। (এতে বোঝা যায় ইমেইলটা নিবন্ধিত — সাইনআপে
     প্রায় সব SaaS এই trade-off মেনে নেয়; লগইনে এমন কিছু ফাঁস হয় না।)
  3. `provisionWorkspace()` ব্যর্থ হলে `deleteUser()` — Better Auth-এর transaction আর আমাদেরটা আলাদা,
     তাই এক transaction-এ মোড়ানো যায় না; ব্যর্থ হলে হাতে উল্টানো ("compensating action")। এটা শুধু
     provision-এর `catch`-এ, `issueTokens`-এর চারপাশে না — provision সফল হওয়ার পর membership তৈরি হয়ে
     গেছে, আর `memberships.user_id`-এর FK-তে `cascade` নেই, তাই তখন ইউজার মোছা যেতই না। টোকেন বানানো
     ব্যর্থ হলে (যেমন DB সাময়িক বন্ধ) ইউজার আর workspace দুটোই ঠিক থাকে, সে পরে লগইন করতে পারবে।
- `isUniqueViolation` — দুজন একই মুহূর্তে একই slug চাইলে দুজনেই pre-check পাস করে; দ্বিতীয়জনকে ধরে
  `tenants_slug_idx` unique index। drizzle Postgres-এর error-কে `DrizzleQueryError`-এ মুড়ে দেয়, আসলটা
  থাকে `.cause`-এ — তাই loop দিয়ে cause-এর শিকল ধরে খোঁজা। `'code' in current` দিয়ে narrowing, কোনো
  cast নেই। constraint-এর নামও মেলানো হয়, যাতে অন্য কোনো unique violation ভুল করে "slug taken" না হয়।
- **`login`:**
  - আগে workspace খোঁজা, না পেলে 404 আর `fieldErrors.workspace`। workspace-এর নাম গোপন কিছু না (এটা
    একটা সাবডোমেইন), তাই পাসওয়ার্ড যাচাইয়ের আগে বললে কোনো তথ্য ফাঁস হয় না।
  - ভুল ইমেইল আর ভুল পাসওয়ার্ড দুটোরই একই মেসেজ — কোন ইমেইল নিবন্ধিত সেটা বোঝা যায় না। Better Auth
    অচেনা ইমেইলেও পাসওয়ার্ড hash করে সময় সমান রাখে (1.7.6-এর `signInEmail`-এর কোডে দেখা), তাই সময় মেপেও
    বোঝা যায় না।
  - পাসওয়ার্ড ঠিক কিন্তু workspace-এ সদস্য না → Better Auth যে session বানিয়ে ফেলেছে সেটা মুছে 403।
    এখানে বলা নিরাপদ যে সে সদস্য না, কারণ পাসওয়ার্ড দিয়ে সে পরিচয় প্রমাণ করেছে।
- **`refresh`:** টোকেন rotate করার পর membership **আবার DB থেকে** পড়া হয়। কারণ access token-এর রোল
  ১৫ মিনিট পর্যন্ত পুরনো থাকতে পারে; refresh-ই সেই মুহূর্ত যখন রোল আবার মেলানো হয়। membership মুছে গেলে
  session-ও মুছে 401।
- **`switchTenant`:** প্রথমে membership যাচাই, **তারপর** refresh token খরচ। উল্টো ক্রমে ভুল `tenantId`
  পাঠালে টোকেন খরচ হয়ে যেত কিন্তু নতুন টোকেন আসত না — ইউজার লগআউট হয়ে যেত ("keeps the session" টেস্ট)।
  `grant.userId !== principal.userId` — access token একজনের আর cookie আরেকজনের, এমন অবস্থা স্বাভাবিক
  ব্যবহারে হয় না; তাই সন্দেহজনক ধরে session বাতিল।
- **`me`:** `users` আর `tenants` global, তাই সাধারণ `db`। membership-এর তালিকা সব টেন্যান্ট জুড়ে, তাই
  `withUser` (আগের অংশ দেখুন)। `roles` নেওয়া হয় টোকেন থেকে (দেখানোর জন্য যথেষ্ট); `permissions` নেওয়া
  হয় `PermissionService` থেকে — cache/DB, অর্থাৎ যা guard আসলে চেক করে ঠিক সেটাই। UI সেই তালিকা দেখে
  কোন অংশ দেখাবে ঠিক করে।
- **`findMembership`:** `runWithTenant(tenantId, () => this.withTenant(...))` — লগইন/refresh-এর সময়
  request-এ কোনো principal থাকে না, তাই ALS-এ টেন্যান্ট হাতে বসিয়ে তারপর RLS-সহ query। `where`-এ
  `eq(memberships.tenantId, tenantId)` স্পষ্ট করে লেখা, যদিও RLS একই কাজ করে — দুই স্তর: কোডে filter
  ভুলে গেলে RLS আটকাবে, RLS policy-তে ভুল থাকলে filter আটকাবে। `isNull(deletedAt)` — soft-delete করা
  membership বা role কখনো অধিকার দেবে না। roles `orderBy(asc(...))` — টোকেনে রোলের ক্রম সবসময় একই।
- **`provisionWorkspace`:** সব একটা transaction-এ — tenant, membership, Owner রোল, রোলে সব permission,
  আর membership-এ রোল বরাদ্দ। মাঝে কিছু ব্যর্থ হলে কিছুই থাকে না। `tenants`-এ RLS নেই, তাই insert
  context ছাড়া চলে; তার পরের সব টেবিলে `FORCE RLS` আর `WITH CHECK`, তাই `setTenantContext(tx,
  tenant.id)` না দিলে policy insert আটকাত। `createdBy: userId` — audit-এর জন্য (ধাপ ৬)। permissions
  খালি হলে স্পষ্ট error: drizzle-এ খালি array দিয়ে `.values([])` ডাকলে বোঝা-কঠিন একটা error আসত; এখানে
  মেসেজ বলে দেয় কী করতে হবে (`pnpm db:migrate`)।

**ফাইল: `apps/api/src/auth/auth.controller.ts`** (নতুন ফাইল)

```ts
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { IssuedTokens } from '@omnivo/auth';
import {
  type AuthSession,
  type LoginInput,
  loginInputSchema,
  type MeResponse,
  type SignUpInput,
  signUpInputSchema,
  type SwitchTenantInput,
  switchTenantInputSchema,
} from '@omnivo/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { currentPrincipal } from '../common/tenant/tenant-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { AuthService } from './auth.service.js';
import { Public } from './public.decorator.js';
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from './refresh-cookie.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Public()
  @Post('sign-up')
  @Header('Cache-Control', 'no-store')
  async signUp(
    @Body(new ZodValidationPipe(signUpInputSchema)) body: SignUpInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    return this.startSession(reply, await this.authService.signUp(body));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body(new ZodValidationPipe(loginInputSchema)) body: LoginInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    return this.startSession(reply, await this.authService.login(body));
  }

  // access token-এর মেয়াদ শেষ হতে পারে, তাই Public — প্রমাণ হিসেবে শুধু refresh cookie
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    try {
      return this.startSession(
        reply,
        await this.authService.refresh(request.cookies[REFRESH_COOKIE]),
      );
    } catch (error) {
      // অচল cookie ব্রাউজারে রেখে লাভ নেই; কিন্তু DB down-এর মতো 5xx-এ cookie রেখে দেওয়া
      if (error instanceof UnauthorizedException) {
        clearRefreshCookie(reply, this.config.secureCookies);
      }
      throw error;
    }
  }

  // Public না: কে switch করছে সেটা access token বলে, আর cookie দিয়ে session rotate হয়
  @Post('switch-tenant')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async switchTenant(
    @Body(new ZodValidationPipe(switchTenantInputSchema)) body: SwitchTenantInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    const tokens = await this.authService.switchTenant(
      currentPrincipal(),
      request.cookies[REFRESH_COOKIE],
      body.tenantId,
    );
    return this.startSession(reply, tokens);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.authService.logout(request.cookies[REFRESH_COOKIE]);
    clearRefreshCookie(reply, this.config.secureCookies);
  }

  @Get('me')
  me(): Promise<MeResponse> {
    return this.authService.me(currentPrincipal());
  }

  // refresh token শুধু httpOnly cookie-তে; JSON-এ শুধু access token — JS কখনো refresh token দেখে না
  private startSession(reply: FastifyReply, tokens: IssuedTokens): AuthSession {
    setRefreshCookie(
      reply,
      tokens.refreshToken,
      tokens.refreshTokenExpiresAt,
      this.config.secureCookies,
    );
    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    };
  }
}
```

**কোন লাইন কেন:**

- `@Res({ passthrough: true })` — cookie বসাতে Fastify-র `reply` লাগে, কিন্তু `passthrough` ছাড়া
  `@Res()` দিলে Nest ধরে নেয় response আমরা নিজেরা পাঠাব, আর `return` করা মান হারিয়ে যায়।
  `passthrough`-এ দুটোই চলে: cookie বসানো আর সাধারণভাবে JSON ফেরত।
- `@Header('Cache-Control', 'no-store')` — টোকেন থাকা response কোনো proxy বা ব্রাউজার cache-এ রাখা উচিত
  না (OAuth 2.0 RFC 6749 §5.1 একই কথা বলে)।
- `@HttpCode(HttpStatus.OK)` — Nest-এ `@Post` ডিফল্টে 201 দেয়। sign-up আসলেই কিছু তৈরি করে (201), কিন্তু
  login/refresh/switch কিছু তৈরি করে না — তাই 200। logout 204 (body নেই)।
- `request.cookies[REFRESH_COOKIE]` — `@fastify/cookie` (৩.৭-এ register করা) `FastifyRequest`-এ
  `cookies` যোগ করে; টাইপ `string | undefined`, আর service সেই `undefined` নিজে সামলায়।
- `refresh`-এর `catch`: শুধু `UnauthorizedException`-এ cookie মোছা — অচল টোকেন ব্রাউজারে রেখে লাভ নেই।
  কিন্তু DB সাময়িক বন্ধ থাকার মতো 5xx-এ cookie রেখে দেওয়া হয়, নাহলে সার্ভারের সমস্যায় ইউজার লগআউট
  হয়ে যেত। `throw` করার আগে বসানো header error response-এও যায় (টেস্টে যাচাই: reuse-এর 401-এ
  `omnivo_rt` খালি হয়ে আসে)।
- `switchTenant`-এ `@Public()` নেই — কে switch করছে সেটা access token বলে (`currentPrincipal()`), আর
  cookie দিয়ে session rotate হয়। দুটোই লাগে।
- `logout` Public — access token-এর মেয়াদ শেষ হয়ে গেলেও লগআউট কাজ করা উচিত।
- `startSession` — refresh token শুধু cookie-তে, JSON-এ শুধু access token আর তার মেয়াদ। টেস্ট প্রমাণ করে
  যে response body-তে refresh token-এর মান কোথাও নেই।

**ফাইল: `apps/api/src/auth/auth.module.ts`** (নতুন ফাইল)

```ts
import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

@Module({
  imports: [RbacModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
```

`RbacModule` import — `AuthService.me()`-এর `PermissionService` লাগে।

---

## ৩.৬ — RBAC: `@RequirePermission()` আর Redis cache

**ফাইল: `apps/api/src/rbac/require-permission.decorator.ts`** (নতুন ফাইল)

```ts
import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@omnivo/db';

export const REQUIRED_PERMISSIONS_KEY = 'omnivo:requiredPermissions';

// PermissionKey = PERMISSIONS তালিকার key-গুলোর union — বানান ভুল হলে compile error
export const RequirePermission = (
  ...keys: [PermissionKey, ...PermissionKey[]]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_PERMISSIONS_KEY, keys);
```

**কোন লাইন কেন:**

- `...keys: [PermissionKey, ...PermissionKey[]]` — অন্তত একটা key বাধ্যতামূলক। খালি
  `@RequirePermission()` লিখলে compile error, কারণ সেটা দেখতে নিরাপদ লাগে কিন্তু আসলে কিছুই চেক করে না।
- `PermissionKey` — catalog-এর union টাইপ (৩.১); বানান ভুল = compile error।
- একাধিক key দিলে **সবগুলো** লাগবে (AND) — guard-এ `missing`-এর হিসাব দেখুন।

**ফাইল: `apps/api/src/rbac/permission.service.ts`** (নতুন ফাইল)

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Principal } from '@omnivo/auth';
import { membershipRoles, permissions, rolePermissions, roles } from '@omnivo/db';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { REDIS, WITH_TENANT } from '../infra/tokens.js';

// invalidation ভুলে গেলেও ১০ মিনিটের বেশি পুরনো permission থাকবে না
const CACHE_TTL_SECONDS = 600;

const cachedPermissionsSchema = z.array(z.string());

// system-design §৪.৫-এর key ফরম্যাট: প্রতিটা Redis key টেন্যান্ট দিয়ে শুরু
export function permissionCacheKey(tenantId: string, userId: string): string {
  return `t:${tenantId}:perm:${userId}`;
}

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
  ) {}

  async forPrincipal(principal: Principal): Promise<ReadonlySet<string>> {
    const key = permissionCacheKey(principal.tenantId, principal.userId);

    const cached = await this.readCache(key);
    if (cached) return new Set(cached);

    const keys = await this.loadFromDb(principal.tenantId, principal.membershipId);
    await this.writeCache(key, keys);
    return new Set(keys);
  }

  // রোল/permission বদলানোর কোড (ধাপ ৭) এটা ডাকবে
  async invalidate(tenantId: string, userId: string): Promise<void> {
    await this.redis.del(permissionCacheKey(tenantId, userId));
  }

  private async loadFromDb(tenantId: string, membershipId: string): Promise<string[]> {
    const rows = await runWithTenant(tenantId, () =>
      this.withTenant((tx) =>
        tx
          .selectDistinct({ key: permissions.key })
          .from(membershipRoles)
          .innerJoin(
            roles,
            and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
          )
          .innerJoin(
            rolePermissions,
            and(eq(rolePermissions.tenantId, roles.tenantId), eq(rolePermissions.roleId, roles.id)),
          )
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(
            and(
              eq(membershipRoles.tenantId, tenantId),
              eq(membershipRoles.membershipId, membershipId),
              isNull(membershipRoles.deletedAt),
              isNull(roles.deletedAt),
              isNull(rolePermissions.deletedAt),
            ),
          ),
      ),
    );
    return rows.map((row) => row.key).sort();
  }

  // Redis নষ্ট হলে request ব্যর্থ করার বদলে DB থেকে পড়া — cache শুধু গতি, সত্যের উৎস না
  private async readCache(key: string): Promise<string[] | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      const parsed = cachedPermissionsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      this.logger.warn(`permission cache read failed: ${String(error)}`);
      return null;
    }
  }

  private async writeCache(key: string, keys: string[]): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(keys), 'EX', CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`permission cache write failed: ${String(error)}`);
    }
  }
}
```

**কোন লাইন কেন:**

- `permissionCacheKey` → `t:{tenantId}:perm:{userId}` — system-design §৪.৫-এর ফরম্যাট: প্রতিটা Redis
  key টেন্যান্ট দিয়ে শুরু, যাতে এক টেন্যান্টের সব key একসাথে মোছা বা গোনা যায়। `export` — টেস্ট বা
  ভবিষ্যতের invalidation কোডে একই ফাংশন, হাতে লেখা স্ট্রিং না।
- `CACHE_TTL_SECONDS = 600` — রোল বদলানোর কোড (ধাপ ৭) `invalidate()` ডাকতে ভুলে গেলেও ১০ মিনিটের
  বেশি পুরনো permission থাকবে না। নিরাপত্তার জাল, আসল ব্যবস্থা না।
- `loadFromDb`-এর join: `membership_roles → roles → role_permissions → permissions`। প্রতিটা join-এ
  `tenantId`-ও মেলানো (composite FK-এর মতো) আর `isNull(deletedAt)` — soft-delete করা রোল অধিকার দেয়
  না। `selectDistinct` — একই permission দুটো রোল থেকে এলে একবারই। `permissions` টেবিল global, বাকি
  তিনটা RLS-এর আওতায় — তাই `withTenant`-এর ভেতরে।
- `runWithTenant(principal.tenantId, …)` — request-এর ALS-এ একই টেন্যান্ট আগেই আছে, কিন্তু স্পষ্ট করে
  বসানোয় এই service যেকোনো জায়গা থেকে (যেমন background job) নিরাপদে ডাকা যায়।
- `.sort()` — cache-এ আর `/auth/me`-তে তালিকার ক্রম সবসময় একই, টেস্টে তুলনা সহজ।
- `readCache`-এর `try/catch` আর `null` ফেরত — Redis বন্ধ বা ভাঙা মান থাকলে DB থেকে পড়ে। cache শুধু গতির
  জন্য, সত্যের উৎস না; cache-এর সমস্যায় লগইন করা ইউজার আটকে যাওয়া উচিত না।
- `JSON.parse` + `cachedPermissionsSchema.safeParse` — `JSON.parse` ফেরত দেয় `any`; সরাসরি ব্যবহার করলে
  `any` ঢুকত (rule ৩)। Zod দিয়ে যাচাই: অন্য কোনো কোড ভুল আকারের মান লিখে রাখলেও সেটা cache miss হিসেবে
  ধরা হয়।
- Redis SET টাইপ (`SADD`) না, JSON স্ট্রিং — Redis-এ খালি set রাখা যায় না (শেষ সদস্য গেলে key মুছে যায়)।
  ফলে "কোনো permission নেই" cache করা যেত না, আর এমন ইউজারের প্রতিটা request-এ DB query হতো।

**ফাইল: `apps/api/src/rbac/permission.guard.ts`** (নতুন ফাইল)

```ts
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@omnivo/db';

import { currentPrincipal } from '../common/tenant/tenant-context.js';
import { PermissionService } from './permission.service.js';
import { REQUIRED_PERMISSIONS_KEY } from './require-permission.decorator.js';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    // AuthGuard আগে চলে, তাই এখানে principal থাকবেই; না থাকলে @Public + @RequirePermission একসাথে — bug
    const granted = await this.permissions.forPrincipal(currentPrincipal());
    const missing = required.filter((key) => !granted.has(key));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `You need the ${missing.join(', ')} permission. Ask a workspace owner to grant it.`,
      );
    }
    return true;
  }
}
```

**কোন লাইন কেন:**

- `if (!required) return true` — `@RequirePermission` নেই মানে শুধু লগইনই যথেষ্ট (সেটা `AuthGuard`
  আগেই দেখেছে)।
- `currentPrincipal()` — `AuthGuard` আগে চলে (৩.৭-এর ক্রম), তাই এখানে principal থাকবেই। না থাকলে কেউ
  একই রুটে `@Public()` আর `@RequirePermission()` দুটোই দিয়েছে — এটা স্ববিরোধী, তাই throw হয়ে 500
  (bug), চুপচাপ খুলে দেওয়া না।
- 403 মেসেজে কোন permission নেই আর কী করতে হবে দুটোই বলা (CLAUDE.md-এর copy নিয়ম)।

**ফাইল: `apps/api/src/rbac/rbac.module.ts`** (নতুন ফাইল)

```ts
import { Module } from '@nestjs/common';

import { PermissionService } from './permission.service.js';

@Module({
  providers: [PermissionService],
  exports: [PermissionService],
})
export class RbacModule {}
```

**ফাইল: `apps/api/src/members/members.controller.ts`** (নতুন ফাইল — `@RequirePermission`-এর প্রথম আসল
ব্যবহার)

```ts
import { Controller, Get, Inject } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { MemberListResponse } from '@omnivo/contracts';
import { membershipRoles, memberships, roles, users } from '@omnivo/db';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';

@Controller('members')
export class MembersController {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  @Get()
  @RequirePermission('core.user.read')
  list(): Promise<MemberListResponse> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // explicit tenant filter + RLS: কোডে filter ভুলে গেলেও RLS আটকাবে, আর উল্টোটাও
      const rows = await tx
        .select({
          membershipId: memberships.id,
          userId: users.id,
          fullName: users.fullName,
          email: users.email,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, tenantId), isNull(memberships.deletedAt)))
        .orderBy(asc(users.fullName));

      const roleRows = await tx
        .select({ membershipId: membershipRoles.membershipId, name: roles.name })
        .from(membershipRoles)
        .innerJoin(
          roles,
          and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
        )
        .where(
          and(
            eq(membershipRoles.tenantId, tenantId),
            isNull(membershipRoles.deletedAt),
            isNull(roles.deletedAt),
          ),
        );

      const rolesByMembership = new Map<string, string[]>();
      for (const row of roleRows) {
        rolesByMembership.set(row.membershipId, [
          ...(rolesByMembership.get(row.membershipId) ?? []),
          row.name,
        ]);
      }

      return {
        members: rows.map((row) => ({
          ...row,
          roles: rolesByMembership.get(row.membershipId) ?? [],
        })),
      };
    });
  }
}
```

**কেন এই endpoint এখনই:** build-plan-এর ধাপ ৩ চায় `@RequirePermission` decorator; একটা আসল রুট ছাড়া
decorator কাজ করে কিনা প্রমাণ হয় না। ড্যাশবোর্ডের "Team" কার্ড এটা দেখায়, আর HTTP-স্তরের leak test
(৩.৮) এটা দিয়েই দেখায় যে টেন্যান্ট A শুধু নিজের লোকদের দেখে।

- `getTenantId()` handler-এর শুরুতে একবার — explicit `where` filter-এর জন্য (RLS-এর সাথে দ্বিতীয় স্তর)।
- `users` join — `users` global টেবিল, কিন্তু join হয় `memberships`-এর সাথে (RLS), তাই অন্য টেন্যান্টের
  ইউজার আসতেই পারে না।
- দুটো আলাদা query + `Map` দিয়ে রোল জোড়া — SQL-এর `array_agg` দিয়ে এক query-তে করা যেত, কিন্তু
  drizzle-এ তখন raw SQL আর টাইপ হাতে লিখতে হতো। সদস্য সংখ্যা ছোট, দুটো query-র খরচ নগণ্য।
  `Map.groupBy` ব্যবহার করা হয়নি কারণ সেটা ES2024-এর, আর আমাদের `target` ES2023।

**ফাইল: `apps/api/src/members/members.module.ts`** (নতুন ফাইল)

```ts
import { Module } from '@nestjs/common';

import { MembersController } from './members.controller.js';

@Module({
  controllers: [MembersController],
})
export class MembersModule {}
```

---

## ৩.৭ — সব জোড়া লাগানো

**ফাইল: `apps/api/src/health/health.controller.ts`** (আপডেট — `@Public()` যোগ)

```ts
import { Controller, Get } from '@nestjs/common';

import { Public } from '../auth/public.decorator.js';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
```

`AuthGuard` এখন global, তাই `@Public()` না দিলে `/health` 401 দিত — load balancer-এর health check
ভেঙে যেত।

**ফাইল: `apps/api/src/app.module.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthGuard } from './auth/auth.guard.js';
import { AuthMiddleware } from './auth/auth.middleware.js';
import { AuthModule } from './auth/auth.module.js';
import type { Config } from './config.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';
import { MembersModule } from './members/members.module.js';
import { PermissionGuard } from './rbac/permission.guard.js';
import { RbacModule } from './rbac/rbac.module.js';

@Module({})
export class AppModule implements NestModule {
  // config বাইরে থেকে আসে: main.ts-এ process.env থেকে, টেস্টে Testcontainers-এর URL থেকে
  static register(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.register(config), RbacModule, AuthModule, MembersModule],
      controllers: [HealthController],
      providers: [
        // ক্রম গুরুত্বপূর্ণ: আগে "কে" (AuthGuard → 401), তারপর "কী করতে পারে" (PermissionGuard → 403)
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('{*splat}');
  }
}
```

**কোন লাইন কেন:**

- `@Module({})` খালি + `static register(config)` — config বাইরে থেকে, `InfraModule`-এর মতো একই কারণে।
- `APP_GUARD` দুবার — Nest global guard **ঘোষণার ক্রমেই** চালায়। আগে `AuthGuard` (কে? নেই → 401),
  তারপর `PermissionGuard` (অনুমতি? নেই → 403)। ক্রম উল্টালে লগইন না করা ইউজারও 403 পেত, আর
  `PermissionGuard` principal ছাড়া চলত।
- `AuthMiddleware` `forRoutes('{*splat}')` — ধাপ ২-এর মতোই সব রুটে; এটা শুধু context বসায়, বাধ্য করে
  না।

**ফাইল: `apps/api/src/configure-app.ts`** (নতুন ফাইল)

```ts
import fastifyCookie from '@fastify/cookie';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import type { Config } from './config.js';

// main.ts আর integration test দুজনেই এটা ডাকে — টেস্টে ঠিক production-এর setup চলে
export async function configureApp(app: NestFastifyApplication, config: Config): Promise<void> {
  await app.register(fastifyCookie);
  app.enableCors({
    origin: config.appOrigin,
    // cross-origin fetch-এ cookie পাঠাতে/নিতে দুই দিকেই credentials লাগে
    credentials: true,
  });
}
```

**কেন আলাদা ফাইল:** `main.ts` আর integration test দুজনেই এটা ডাকে। cookie plugin বা CORS শুধু
`main.ts`-এ থাকলে টেস্টে `request.cookies` থাকত না — টেস্ট আর production আলাদা আচরণ করত।

- `enableCors({ origin, credentials: true })` — ব্রাউজার cross-origin `fetch`-এ cookie পাঠায় শুধু যখন
  ক্লায়েন্ট `credentials: 'include'` দেয় **আর** সার্ভার `Access-Control-Allow-Credentials: true` ফেরত
  দেয়। `origin` একটা নির্দিষ্ট স্ট্রিং — credentials থাকলে `*` নিষিদ্ধ। অন্য origin থেকে preflight
  এলে header-এ তবুও আমাদের origin-ই যায়; ব্রাউজার মিল না পেয়ে response আটকে দেয় (curl দিয়ে দেখা)।

**ফাইল: `apps/api/src/main.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import './env.js';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { configureApp } from './configure-app.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    new FastifyAdapter(),
  );
  await configureApp(app, config);
  // SIGTERM/SIGINT-এ onApplicationShutdown চলে — DB pool আর Redis বন্ধ হয়
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
```

- `loadConfig(process.env)` — `import './env.js'`-এর পরে, তাই `.env` ততক্ষণে লোড হয়ে গেছে।
- `enableShutdownHooks()` — এটা ছাড়া SIGTERM-এ Nest `onApplicationShutdown` ডাকে না (টেস্টের
  `app.close()` এমনিতেই ডাকে)।
- `config.port` — হার্ডকোড `3000`-এর বদলে; ডিফল্ট একই।

**ফাইল: `apps/api/package.json`** (আপডেট — ৩.৪-এর install ছাড়া হাতে বদল শুধু `test:integration`-এ)

```json
{
  "name": "@omnivo/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests --exclude \"**/*.int.spec.ts\"",
    "test:integration": "vitest run --passWithNoTests .int.spec --exclude \"**/*tenant-leak.int.spec.ts\"",
    "test:tenant-leak": "vitest run tenant-leak.int.spec"
  },
  "devDependencies": {
    "@nestjs/cli": "^12.0.3",
    "@nestjs/schematics": "^12.0.4",
    "@omnivo/config": "workspace:*",
    "@testcontainers/postgresql": "^12.1.0",
    "@types/node": "^26.6.2",
    "postgres": "^3.4.9",
    "testcontainers": "^12.1.0",
    "typescript": "^6.0.3",
    "vitest": "^5.0.1"
  },
  "dependencies": {
    "@fastify/cookie": "^11.1.2",
    "@nestjs/common": "^12.0.4",
    "@nestjs/core": "^12.0.4",
    "@nestjs/platform-fastify": "^12.0.4",
    "@omnivo/auth": "workspace:*",
    "@omnivo/contracts": "workspace:*",
    "@omnivo/db": "workspace:*",
    "dotenv": "^18.0.3",
    "drizzle-orm": "^0.45.3",
    "fastify": "5.12.5",
    "ioredis": "^6.0.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "zod": "^4.6.5"
  }
}
```

- `test:integration`-এর exclude এখন `**/*tenant-leak.int.spec.ts` (আগে ছিল `**/tenant-leak.int.spec.ts`)
  — নতুন `members.tenant-leak.int.spec.ts`-ও leak suite-এর অংশ। পুরনো pattern শুধু ঠিক ওই নামের ফাইল
  বাদ দিত, ফলে নতুনটা দুই suite-এ দুবার চলত। `test:tenant-leak`-এর positional `tenant-leak.int.spec`
  substring হিসেবে দুটো ফাইলই ধরে, তাই সেটা বদলাতে হয়নি।

**ফাইল: `apps/api/tsconfig.build.json`** (আপডেট)

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.spec.ts", "src/testing/**"]
}
```

`src/testing/**` — এই ফোল্ডারের helper-গুলো `*.spec.ts` না, কিন্তু `testcontainers` আর `vitest` import
করে। বাদ না দিলে `nest build` এগুলো `dist`-এ তুলত, আর production-এ devDependency খুঁজত। (যাচাই করা:
`dist`-এ কোনো spec বা testing ফাইল নেই।)

---

## ৩.৮ — টেস্ট

তিন স্তর:

| ফাইল | কী প্রমাণ করে | Docker |
|---|---|---|
| `packages/contracts/src/auth.spec.ts` | schema-র নিয়ম (৩.২) | না |
| `packages/auth/src/access-token.spec.ts` | JWT-এর সব আক্রমণ (৩.৩) | না |
| `apps/api/src/auth/auth.middleware.spec.ts` | header → middleware → guard → handler | না |
| `apps/api/src/auth/auth.int.spec.ts` | পুরো auth flow, rotation, RBAC, cache | হ্যাঁ (Postgres + Valkey) |
| `apps/api/src/common/tenant/tenant-leak.int.spec.ts` | DB-স্তরের RLS (ধাপ ২, harness-এ সরানো) | হ্যাঁ |
| `apps/api/src/members/members.tenant-leak.int.spec.ts` | HTTP-স্তরের tenant leak | হ্যাঁ |

তিনটা Docker-নির্ভর ফাইলই container তোলে, তাই সেই কোড একটা shared harness-এ রাখা হয়েছে। ফাইলগুলো
`src/testing/`-এ, `*.spec.ts` নামে না — কারণ এগুলো নিজে টেস্ট না, টেস্টের সরঞ্জাম (৩.৭-এর
`tsconfig.build.json` এগুলো build থেকে বাদ দেয়)।

**ফাইল: `apps/api/src/testing/containers.ts`** (নতুন ফাইল)

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { syncPermissions } from '@omnivo/db';

// src/testing → src → api → apps → repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  superuserUrl: string;
  appUrl: string;
}

// docker-compose-এর মতোই: superuser দিয়ে role, migrator দিয়ে migration + permission sync
export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('omnivo')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const urlFor = (username: string, password: string): string => {
    const url = new URL(container.getConnectionUri());
    url.username = username;
    url.password = password;
    return url.toString();
  };

  const admin = postgres(container.getConnectionUri(), { max: 1 });
  await admin.unsafe(
    readFileSync(path.join(repoRoot, 'infra/docker/postgres/init/01-roles.sql'), 'utf-8'),
  );
  await admin.end();

  const migratorClient = postgres(urlFor('omnivo_migrator', 'migrator_dev_password'), { max: 1 });
  const migratorDb = drizzle(migratorClient);
  await migrate(migratorDb, { migrationsFolder: path.join(repoRoot, 'packages/db/migrations') });
  await syncPermissions(migratorDb);
  await migratorClient.end();

  return {
    container,
    superuserUrl: container.getConnectionUri(),
    appUrl: urlFor('omnivo_app', 'app_dev_password'),
  };
}

export interface TestRedis {
  container: StartedTestContainer;
  url: string;
}

// docker-compose-এর cache সার্ভিসের একই image
export async function startRedis(): Promise<TestRedis> {
  const container = await new GenericContainer('valkey/valkey:8-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  return {
    container,
    url: `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`,
  };
}
```

**কোন লাইন কেন:**

- `startPostgres` ধাপ ২-এর leak test-এর `beforeAll`-এর কোড, একটা ফাংশনে তোলা, সাথে নতুন
  `syncPermissions(migratorDb)` — সাইনআপে Owner রোলকে permission দিতে হয়, টেবিল খালি থাকলে
  `provisionWorkspace` error দিত। `pnpm db:migrate` যা করে ঠিক তাই: migrate, তারপর sync।
- `repoRoot` চার ধাপ উপরে (`testing` → `src` → `api` → `apps` → root)। ধাপ ২-এ leak test পাঁচ ধাপ উপরে
  ছিল, কারণ সেটা এক ফোল্ডার গভীরে (`common/tenant`) ছিল।
- `superuserUrl` ফেরত দেওয়া হয় — টেস্টে RLS-এর বাইরে থেকে সেটআপ করতে লাগে (যেমন একজনকে অন্য
  টেন্যান্টে যোগ করা, যেটা ধাপ ৭-এর invite আসার আগে API দিয়ে করা যায় না)। অ্যাসারশন সবসময়
  `appUrl`-এ (`omnivo_app`, NOBYPASSRLS) — superuser দিয়ে যাচাই করলে RLS bypass হয়ে টেস্ট মিথ্যা পাস
  করত।
- `startRedis` — `GenericContainer` দিয়ে docker-compose-এর ঠিক একই `valkey/valkey:8-alpine` image।
  `@testcontainers/redis` আলাদা একটা dependency আর Redis-কে মাথায় রেখে বানানো; আমাদের শুধু একটা port
  দরকার, তাই `testcontainers`-এর (আগেই আছে) `GenericContainer` সহজ। dev আর টেস্টে একই ইঞ্জিন।
  `Wait.forLogMessage('Ready to accept connections')` — port খোলা মানেই Valkey প্রস্তুত না; এই লগ লাইন
  আসার পরেই সে command নেয়।
- `String(container.getMappedPort(6379))` — port একটা `number`, আর ESLint-এর
  `restrict-template-expressions` template-এ সংখ্যা সরাসরি বসাতে দেয় না (ধাপ ২-এর একই সমস্যা)।

**ফাইল: `apps/api/src/testing/app.ts`** (নতুন ফাইল)

```ts
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../app.module.js';
import { type Config, loadConfig } from '../config.js';
import { configureApp } from '../configure-app.js';

// .env না পড়ে টেস্টের নিজস্ব মান — loadConfig দিয়ে গেলে production-এর একই যাচাই চলে
export function testConfig(urls: { databaseUrl: string; redisUrl: string }): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urls.databaseUrl,
    REDIS_URL: urls.redisUrl,
    API_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: 'http://localhost:5173',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32-bytes',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-bytes',
  });
}

export async function createTestApp(config: Config): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    new FastifyAdapter(),
    { logger: false },
  );
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
```

- `testConfig` নিজের মান দিয়ে `loadConfig`-ই ডাকে — টেস্টেও production-এর একই Zod যাচাই চলে; কোনো env
  বাদ পড়লে টেস্টও ভাঙবে।
- `createTestApp` — `main.ts`-এর মতোই `AppModule.register()` আর `configureApp()`, শুধু `listen()`-এর
  বদলে `init()` + `ready()` (ধাপ ২-এ ব্যাখ্যা করা), কারণ টেস্ট `app.inject()` দিয়ে port ছাড়া চলে।
  `logger: false` — টেস্ট আউটপুটে Nest-এর লগ না ভরানো।

**ফাইল: `apps/api/src/testing/http.ts`** (নতুন ফাইল)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { authSessionSchema, type SignUpInput } from '@omnivo/contracts';
import { expect } from 'vitest';

type InjectResponse = Awaited<ReturnType<NestFastifyApplication['inject']>>;

// light-my-request-এর cookies: [{ name, value, ... }] — নাম দিয়ে একটা খোঁজা
export function refreshCookieOf(response: InjectResponse): string {
  const cookie = response.cookies.find((c) => c.name === 'omnivo_rt');
  if (!cookie) throw new Error(`no omnivo_rt cookie in ${String(response.statusCode)} response`);
  return cookie.value;
}

export interface SignedIn {
  accessToken: string;
  refreshToken: string;
}

export function sessionOf(response: InjectResponse): SignedIn {
  const body = authSessionSchema.parse(response.json());
  return { accessToken: body.accessToken, refreshToken: refreshCookieOf(response) };
}

export async function signUp(app: NestFastifyApplication, input: SignUpInput): Promise<SignedIn> {
  const response = await app.inject({ method: 'POST', url: '/auth/sign-up', payload: input });
  expect(response.statusCode).toBe(201);
  return sessionOf(response);
}

export function bearer(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` };
}
```

- `type InjectResponse = Awaited<ReturnType<NestFastifyApplication['inject']>>` — light-my-request-এর
  response টাইপ সরাসরি import না করে Nest-এর method থেকে বের করা। `light-my-request` আমাদের সরাসরি
  dependency না, pnpm-এর strict `node_modules`-এ import করা যেত না।
- `response.cookies` — light-my-request `Set-Cookie` header parse করে `{ name, value, httpOnly, … }`-এর
  array দেয়। টেস্টে cookie-র সব অপশন (`HttpOnly`, `SameSite`, `Path`) এভাবেই যাচাই হয়।
- `sessionOf` response body-কে `authSessionSchema` দিয়ে parse করে — `response.json()` `any` ফেরত দেয়।

**ফাইল: `apps/api/src/auth/auth.middleware.spec.ts`** (নতুন ফাইল — `tenant.middleware.spec.ts`-এর জায়গায়)

```ts
import { Controller, Get, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createAccessTokens } from '@omnivo/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import { AUTH } from '../infra/tokens.js';
import { AuthGuard } from './auth.guard.js';
import { AuthMiddleware } from './auth.middleware.js';
import { Public } from './public.decorator.js';

const tokenConfig = {
  secret: 'test-jwt-secret-that-is-at-least-32-bytes',
  issuer: 'http://localhost:3000',
  audience: 'omnivo-api',
  ttlSeconds: 900,
};
const tokens = createAccessTokens(tokenConfig);

const claims = {
  userId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8e',
  tenantId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8f',
  membershipId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d90',
  roles: ['Owner'],
};

@Controller('probe')
class ProbeController {
  @Get()
  probe(): { tenantId: string; userId: string } {
    return { tenantId: getTenantId(), userId: currentPrincipal().userId };
  }

  @Get('async')
  async probeAsync(): Promise<{ tenantId: string }> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { tenantId: getTenantId() };
  }

  @Public()
  @Get('public')
  open(): { ok: true } {
    return { ok: true };
  }
}

// DB/Redis ছাড়া: AUTH-এর জায়গায় শুধু টোকেন verifier
@Module({
  controllers: [ProbeController],
  providers: [
    { provide: AUTH, useValue: { getPrincipal: tokens.verify } },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('{*splat}');
  }
}

let app: NestFastifyApplication;
let accessToken: string;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(ProbeModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  accessToken = (await tokens.sign(claims)).token;
});

afterAll(async () => {
  await app.close();
});

describe('AuthMiddleware + AuthGuard', () => {
  it('carries the principal from the bearer token into the handler', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: claims.tenantId, userId: claims.userId });
  });

  it('keeps the context across an await inside the handler', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe/async',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.json()).toEqual({ tenantId: claims.tenantId });
  });

  it('rejects a request without a token with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(401);
  });

  it('ignores the old x-tenant-id header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': claims.tenantId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with another secret', async () => {
    const forged = createAccessTokens({
      ...tokenConfig,
      secret: 'attacker-secret-that-is-also-32-bytes!!',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: `Bearer ${(await forged.sign(claims)).token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets @Public() routes through without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe/public' });
    expect(res.statusCode).toBe(200);
  });
});
```

**কোন লাইন কেন:**

- `{ provide: AUTH, useValue: { getPrincipal: tokens.verify } }` — middleware শুধু `getPrincipal` চায়
  (৩.৫), তাই আসল `createAccessTokens` দিয়ে বানানো verifier-ই যথেষ্ট। টোকেন আসল `jose` দিয়ে
  স্বাক্ষর আর যাচাই হয় — mock না, কিন্তু DB-ও না।
- `{ provide: APP_GUARD, useClass: AuthGuard }` — probe module-এও global guard, যাতে production-এর মতো
  `@Public()` আর 401 দুটোই পরীক্ষা হয়।
- "ignores the old x-tenant-id header" — ধাপ ২-এর header দিয়ে এখন আর কিছু খোলে না, এটার regression
  টেস্ট।
- "keeps the context across an await" — ধাপ ২-এর মতোই; এবার middleware নিজেও async, তাই আরও জরুরি।
- constructor injection (`AuthGuard`-এর `Reflector`, integration test-এ `AuthService`-এর
  `PermissionService`) বাড়তি plugin ছাড়াই কাজ করে — ধাপ ২-এর শেষে এই প্রশ্ন খোলা ছিল। যাচাই করা:
  Vitest 5-এ একটা ছোট probe module-এ টাইপ দিয়ে inject সফল হয়েছে, অর্থাৎ Vitest-এর transform
  decorator metadata বসায়। তাই `unplugin-swc` লাগছে না।

**ফাইল: `apps/api/src/common/tenant/tenant-leak.int.spec.ts`** (আপডেট — শুধু উপরের অংশ বদলাবে, নিচের
ছয়টা টেস্ট হুবহু আগের মতো)

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, memberships, tenants, users } from '@omnivo/db';

import { startPostgres, type TestPostgres } from '../../testing/containers.js';
import { runWithTenant } from './tenant-context.js';
import { createWithTenant, type WithTenant } from './with-tenant.js';

let pg: TestPostgres;
let appDb: Db;
let withTenant: WithTenant;
let tenantAId: string;
let tenantBId: string;

async function seedTenant(slug: string): Promise<string> {
  const [tenant] = await appDb.insert(tenants).values({ name: slug, slug }).returning();
  const [user] = await appDb
    .insert(users)
    .values({ email: `${slug}@example.com`, fullName: slug })
    .returning();
  if (!tenant || !user) throw new Error('seed failed');

  await runWithTenant(tenant.id, () =>
    withTenant(async (tx) => {
      await tx.insert(memberships).values({ tenantId: tenant.id, userId: user.id });
    }),
  );
  return tenant.id;
}

beforeAll(async () => {
  // role, migration আর permission sync — সব shared harness-এ (src/testing/containers.ts)
  pg = await startPostgres();

  appDb = createDb(pg.appUrl, { max: 1 });
  withTenant = createWithTenant(appDb);

  tenantAId = await seedTenant('tenant-a');
  tenantBId = await seedTenant('tenant-b');
}, 120_000);

afterAll(async () => {
  await appDb.$client.end();
  await pg.container.stop();
});

// … describe('tenant isolation (RLS)', …) — ছয়টা টেস্ট আগের মতোই, বদল নেই
```

**কী বদলাল:** import-এ `readFileSync`, `path`, `fileURLToPath`, `PostgreSqlContainer`, `drizzle`,
`migrate`, `postgres` আর `repoRoot` বাদ; `let container` → `let pg: TestPostgres`; `beforeAll`-এর
container/role/migration-এর কোড → `startPostgres()`; `appDb` বানানো হয় `pg.appUrl` দিয়ে;
`afterAll`-এ `pg.container.stop()`। `seedTenant`-এর `users` insert-এ `emailVerified` দিতে হয় না,
কারণ কলামটার ডিফল্ট আছে (৩.১)।

**ফাইল: `apps/api/src/auth/auth.int.spec.ts`** (নতুন ফাইল)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { apiErrorSchema, meResponseSchema, type SignUpInput } from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PermissionService } from '../rbac/permission.service.js';
import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, refreshCookieOf, sessionOf, signUp } from '../testing/http.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
// RLS-এর বাইরে থেকে টেস্ট সেটআপ (অন্য টেন্যান্টে membership বসানো ইত্যাদি)
let superuser: postgres.Sql;

const rahman: SignUpInput = {
  companyName: 'Rahman Garments Ltd.',
  workspaceSlug: 'rahman-garments',
  fullName: 'Farhana Rahman',
  email: 'farhana@rahmangarments.com',
  password: 'Gazipur-knit-2026',
};

const karim: SignUpInput = {
  companyName: 'Karim Pharma',
  workspaceSlug: 'karim-pharma',
  fullName: 'Karim Uddin',
  email: 'karim@karimpharma.com',
  password: 'Batch-expiry-2026',
};

function login(input: { workspace: string; email: string; password: string }) {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { ...input, keepSignedIn: true },
  });
}

function refresh(refreshToken: string) {
  return app.inject({ method: 'POST', url: '/auth/refresh', cookies: { omnivo_rt: refreshToken } });
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  superuser = postgres(pg.superuserUrl, { max: 1 });
}, 120_000);

afterAll(async () => {
  await superuser.end();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('sign-up', () => {
  it('creates a workspace, returns an access token and sets a locked-down refresh cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/sign-up', payload: rahman });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');

    const cookie = res.cookies.find((c) => c.name === 'omnivo_rt');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/auth' });
    // refresh token কখনো JSON-এ না
    expect(res.body).not.toContain(cookie?.value);

    const me = meResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/auth/me',
          headers: bearer(sessionOf(res).accessToken),
        })
      ).json(),
    );
    expect(me.user.email).toBe(rahman.email);
    expect(me.tenant.slug).toBe(rahman.workspaceSlug);
    expect(me.roles).toEqual(['Owner']);
    expect(me.permissions).toEqual(['core.role.manage', 'core.user.invite', 'core.user.read']);
    expect(me.memberships).toHaveLength(1);
  });

  it('rejects a taken workspace address without creating the user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: { ...karim, workspaceSlug: rahman.workspaceSlug },
    });
    expect(res.statusCode).toBe(409);
    expect(apiErrorSchema.parse(res.json()).fieldErrors?.workspaceSlug).toBeDefined();

    const [row] = await superuser<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM users WHERE email = ${karim.email}`;
    expect(row?.n).toBe(0);
  });

  it('rejects an email that already has an account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: { ...karim, email: rahman.email },
    });
    expect(res.statusCode).toBe(409);
    expect(apiErrorSchema.parse(res.json()).fieldErrors?.email).toBeDefined();
  });

  it('returns field errors for invalid input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: { ...karim, email: 'not-an-email', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    const error = apiErrorSchema.parse(res.json());
    expect(Object.keys(error.fieldErrors ?? {}).sort()).toEqual(['email', 'password']);
  });

  it('never stores the password in plain text', async () => {
    const [row] = await superuser<{ password: string | null }[]>`
      SELECT a.password FROM accounts a JOIN users u ON u.id = a.user_id
      WHERE u.email = ${rahman.email} AND a.provider_id = 'credential'`;
    expect(row?.password).toBeTypeOf('string');
    expect(row?.password).not.toContain(rahman.password);
  });
});

describe('login', () => {
  it('signs in to the workspace named in the form', async () => {
    const res = await login({
      workspace: rahman.workspaceSlug,
      email: rahman.email,
      password: rahman.password,
    });
    expect(res.statusCode).toBe(200);
    expect(refreshCookieOf(res)).toBeTruthy();
  });

  it('rejects a wrong password with 401', async () => {
    const res = await login({
      workspace: rahman.workspaceSlug,
      email: rahman.email,
      password: 'wrong-password',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown workspace with 404', async () => {
    const res = await login({
      workspace: 'nobody-here',
      email: rahman.email,
      password: rahman.password,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a real user who is not a member of that workspace with 403', async () => {
    await signUp(app, karim);
    const res = await login({
      workspace: rahman.workspaceSlug,
      email: karim.email,
      password: karim.password,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('refresh token rotation', () => {
  it('issues a new refresh token on every refresh', async () => {
    const first = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const res = await refresh(first.refreshToken);
    expect(res.statusCode).toBe(200);
    expect(refreshCookieOf(res)).not.toBe(first.refreshToken);
  });

  it('treats reuse of an old refresh token as theft and ends the whole session', async () => {
    const first = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const second = refreshCookieOf(await refresh(first.refreshToken));

    // চোর পুরনো টোকেনটা চালাল
    const reuse = await refresh(first.refreshToken);
    expect(reuse.statusCode).toBe(401);
    expect(reuse.cookies.find((c) => c.name === 'omnivo_rt')?.value).toBe('');

    // আসল ইউজারের নতুন টোকেনও এখন অচল — পুরো family বাতিল
    expect((await refresh(second)).statusCode).toBe(401);
  });

  it('lets only one of two parallel refreshes win', async () => {
    const { refreshToken } = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const results = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it('rejects a missing or made-up refresh token', async () => {
    expect((await app.inject({ method: 'POST', url: '/auth/refresh' })).statusCode).toBe(401);
    expect((await refresh('made-up-token')).statusCode).toBe(401);
  });
});

describe('logout', () => {
  it('revokes the session so the refresh token stops working', async () => {
    const { refreshToken } = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { omnivo_rt: refreshToken },
    });
    expect(res.statusCode).toBe(204);
    expect((await refresh(refreshToken)).statusCode).toBe(401);
  });
});

describe('tenant switcher', () => {
  it('moves a user who belongs to two workspaces into the other one', async () => {
    const both: SignUpInput = {
      companyName: 'Nabil Distribution',
      workspaceSlug: 'nabil-distribution',
      fullName: 'Nabil Hasan',
      email: 'nabil@example.com',
      password: 'Depot-route-2026',
    };
    const session = await signUp(app, both);

    // Nabil-কে Rahman Garments-এও সদস্য বানানো (ধাপ ৭-এর invite-এর বদলে সরাসরি SQL)
    await superuser.begin(async (sql) => {
      const [tenant] = await sql<
        { id: string }[]
      >`SELECT id FROM tenants WHERE slug = ${rahman.workspaceSlug}`;
      const [user] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${both.email}`;
      if (!tenant || !user) throw new Error('setup: tenant or user missing');
      await sql`INSERT INTO memberships (id, tenant_id, user_id) VALUES (gen_random_uuid(), ${tenant.id}, ${user.id})`;
    });

    const before = meResponseSchema.parse(
      (
        await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(session.accessToken) })
      ).json(),
    );
    expect(before.memberships.map((m) => m.slug)).toEqual([
      both.workspaceSlug,
      rahman.workspaceSlug,
    ]);
    const target = before.memberships.find((m) => m.slug === rahman.workspaceSlug);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/switch-tenant',
      headers: bearer(session.accessToken),
      cookies: { omnivo_rt: session.refreshToken },
      payload: { tenantId: target?.tenantId },
    });
    expect(res.statusCode).toBe(200);

    const after = meResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/auth/me',
          headers: bearer(sessionOf(res).accessToken),
        })
      ).json(),
    );
    expect(after.tenant.slug).toBe(rahman.workspaceSlug);
    // রোল ছাড়া membership — তাই কোনো permission নেই
    expect(after.roles).toEqual([]);
    expect(after.permissions).toEqual([]);
  });

  it('refuses to switch into a workspace the user does not belong to, and keeps the session', async () => {
    const session = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const [karimTenant] = await superuser<
      { id: string }[]
    >`SELECT id FROM tenants WHERE slug = ${karim.workspaceSlug}`;

    const res = await app.inject({
      method: 'POST',
      url: '/auth/switch-tenant',
      headers: bearer(session.accessToken),
      cookies: { omnivo_rt: session.refreshToken },
      payload: { tenantId: karimTenant?.id },
    });
    expect(res.statusCode).toBe(403);
    // refresh token খরচ হয়নি
    expect((await refresh(session.refreshToken)).statusCode).toBe(200);
  });
});

describe('permissions', () => {
  it('asks for a sign-in (401) before it checks permissions (403)', async () => {
    // AuthGuard আগে না চললে এখানে 403 আসত (বা principal ছাড়া PermissionGuard crash করত)
    const res = await app.inject({ method: 'GET', url: '/members' });
    expect(res.statusCode).toBe(401);
  });

  it('lets the owner list members and blocks a member without the permission', async () => {
    const owner = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const allowed = await app.inject({
      method: 'GET',
      url: '/members',
      headers: bearer(owner.accessToken),
    });
    expect(allowed.statusCode).toBe(200);

    // Nabil আগের টেস্টে Rahman Garments-এ রোল ছাড়া যোগ হয়েছে
    const nabil = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: 'nabil@example.com',
        password: 'Depot-route-2026',
      }),
    );
    const denied = await app.inject({
      method: 'GET',
      url: '/members',
      headers: bearer(nabil.accessToken),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('serves permissions from the Redis cache until they are invalidated', async () => {
    const owner = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const call = () =>
      app.inject({ method: 'GET', url: '/members', headers: bearer(owner.accessToken) });
    expect((await call()).statusCode).toBe(200);

    // Owner রোল থেকে core.user.read সরানো — DB বদলেছে, cache এখনো পুরনো
    const [ids] = await superuser<{ tenant_id: string; user_id: string }[]>`
      SELECT t.id AS tenant_id, u.id AS user_id FROM tenants t, users u
      WHERE t.slug = ${rahman.workspaceSlug} AND u.email = ${rahman.email}`;
    if (!ids) throw new Error('setup: tenant or user missing');
    await superuser`
      DELETE FROM role_permissions
      WHERE tenant_id = ${ids.tenant_id}
        AND permission_id = (SELECT id FROM permissions WHERE key = 'core.user.read')`;
    expect((await call()).statusCode).toBe(200);

    await app.get(PermissionService).invalidate(ids.tenant_id, ids.user_id);
    expect((await call()).statusCode).toBe(403);
  });
});
```

**কোন টেস্ট কোন ঝুঁকি ধরে:**

- **sign-up:** তৈরি হয় আর টোকেন আসে; cookie-র `HttpOnly`, `SameSite=Strict`, `Path=/auth` ঠিক আছে;
  refresh token JSON-এ নেই; `/auth/me`-তে Owner রোল আর catalog-এর তিনটা permission। নেওয়া slug-এ 409
  **আর** ইউজার তৈরি হয়নি (pre-check কাজ করছে); নেওয়া ইমেইলে 409; ভুল ইনপুটে ঠিক দুটো ফিল্ডের error;
  DB-তে পাসওয়ার্ড plain text-এ নেই।
- **login:** ঠিক পাসওয়ার্ডে 200; ভুল পাসওয়ার্ডে 401; অচেনা workspace-এ 404; অন্য workspace-এর আসল
  ইউজার 403।
- **refresh token rotation:** প্রতিবার নতুন টোকেন; পুরনো টোকেন আবার এলে 401, cookie খালি, **আর আসল
  ইউজারের নতুন টোকেনও অচল** (family বাতিল); একই টোকেনে একসাথে দুটো refresh-এ ঠিক একটা 200; cookie না
  থাকলে বা বানানো টোকেনে 401।
- **logout:** এরপর সেই refresh token অচল।
- **tenant switcher:** দুই workspace-এর সদস্য switch করতে পারে, নতুন টোকেনে নতুন টেন্যান্ট; রোল ছাড়া
  membership-এ permission শূন্য। অন্যের workspace-এ switch-এ 403, **আর refresh token খরচ হয়নি**।
- **permissions:** টোকেন ছাড়া `/members` → 401, 403 না (guard-এর ক্রম); Owner 200, রোলহীন সদস্য 403;
  DB-তে permission সরালেও cache থেকে 200 চলতে থাকে, `invalidate()`-এর পর 403 — cache সত্যিই ব্যবহার
  হচ্ছে, আর invalidation সত্যিই কাজ করে।
- `superuser<{ n: number }[]>`…`` — postgres.js-এ query-র row টাইপ generic দিয়ে দিতে হয়; না দিলে রো
  `any` হয় আর ESLint-এর `no-unsafe-*` rule আটকায় (যাচাই করা)।
- টেস্টগুলো একই container আর ডেটা শেয়ার করে, আর ফাইলের ভেতরে ক্রমে চলে — "permissions" অংশ ধরে নেয় যে
  "tenant switcher"-এ Nabil রোল ছাড়া Rahman Garments-এ যোগ হয়েছে (মন্তব্যে লেখা আছে)।

**ফাইল: `apps/api/src/members/members.tenant-leak.int.spec.ts`** (নতুন ফাইল)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { memberListResponseSchema, meResponseSchema } from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// HTTP স্তরের leak test: আসল লগইন করা টোকেন দিয়ে, প্রতিটা এন্ডপয়েন্টে অন্য টেন্যান্টের ডেটা চাওয়া
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let tenantA: SignedIn;
let tenantBId: string;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));

  tenantA = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  const tenantB = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  const meB = meResponseSchema.parse(
    (
      await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(tenantB.accessToken) })
    ).json(),
  );
  tenantBId = meB.tenant.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('tenant isolation over HTTP', () => {
  it("tenant A's member list contains only tenant A's people", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/members',
      headers: bearer(tenantA.accessToken),
    });
    const { members } = memberListResponseSchema.parse(res.json());
    expect(members.map((m) => m.email)).toEqual(['farhana@rahmangarments.com']);
  });

  it('ignores a tenant id smuggled in through the old header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/members',
      headers: { ...bearer(tenantA.accessToken), 'x-tenant-id': tenantBId },
    });
    const { members } = memberListResponseSchema.parse(res.json());
    expect(members.map((m) => m.email)).toEqual(['farhana@rahmangarments.com']);
  });

  it('refuses to switch tenant A into tenant B', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/switch-tenant',
      headers: bearer(tenantA.accessToken),
      cookies: { omnivo_rt: tenantA.refreshToken },
      payload: { tenantId: tenantBId },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

system-design §৪.৪ বলে leak suite-কে "টেন্যান্ট A দিয়ে লগইন করে প্রতিটা এন্ডপয়েন্টে টেন্যান্ট B-র ID
দিয়ে চেষ্টা" করতে হবে। এটা সেই suite-এর প্রথম HTTP ফাইল: আসল সাইনআপ করা টোকেন দিয়ে — `/members`-এ শুধু
নিজের লোক; পুরনো header-এ B-র id পাঠালেও কিছু হয় না; B-তে switch করা যায় না। নতুন tenant-scoped
endpoint এলেই এখানে তার জন্য একটা কেস যোগ হবে। নামের শেষে `tenant-leak.int.spec.ts` থাকায় এটা
`pnpm test:tenant-leak`-এ চলে।

**mutation দিয়ে যাচাই:** টেস্ট পাস করা মানে কোড ঠিক, এটা প্রমাণ হয় শুধু যখন কোড ভাঙলে টেস্ট fail করে।
নিচের প্রতিটা বদল আলাদা করে করে দেখা হয়েছে (তারপর ফিরিয়ে আনা):

| ইচ্ছাকৃত bug | যে টেস্ট fail করল |
|---|---|
| `consumeRefreshToken`-এ `isNull(refreshTokens.usedAt)` মুছে ফেলা | reuse detection আর "দুটো একসাথে" — ২টা |
| `PermissionGuard`-এ সব request খুলে দেওয়া | "blocks a member without the permission" আর cache — ২টা |
| `switchTenant`-এ membership যাচাই বাদ | "refuses to switch tenant A into tenant B" — ১টা |
| `app.module.ts`-এ দুটো `APP_GUARD`-এর ক্রম উল্টানো | "asks for a sign-in (401) before … (403)" — ১টা |

---

## ৩.৯ — root config আর CI

**ফাইল: `package.json`** (root — শুধু `lint` বদলাবে)

```json
    "lint": "turbo run build --filter=./packages/* && eslint .",
```

ধাপ ২-এ `lint` আগে শুধু `@omnivo/db` build করত, কারণ ESLint-এর type-aware rule-কে `dist/*.d.ts` পড়তে
হয়। এখন `@omnivo/auth` আর `@omnivo/contracts`-ও একই রকম build করা প্যাকেজ; নতুন clone বা CI-তে তাদের
`dist` না থাকলে API আর app-এর প্রতিটা import-এ `no-unsafe-*` error আসত। `./packages/*` — ভবিষ্যতে
`packages/ui` এলে সেটাও নিজে থেকে ধরা পড়বে। (`packages/config`-এ `build` script নেই, turbo সেটা বাদ
দেয়।)

**ফাইল: `eslint.config.js`** (আপডেট — পুরোটা এভাবে)

```js
import config from '@omnivo/config/eslint';

export default [
  ...config,
  {
    // NestJS modules are legitimately empty classes.
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
  {
    // TanStack Router redirects by throwing its Redirect (a Response, not an Error) from
    // beforeLoad. Allow exactly that type, keep the rule for everything else.
    files: ['apps/app/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/only-throw-error': [
        'error',
        { allow: [{ from: 'package', package: '@tanstack/router-core', name: 'Redirect' }] },
      ],
    },
  },
];
```

**কেন:** TanStack Router-এর রীতি হলো `beforeLoad`-এ `throw redirect({ to: '/login' })`।
`redirect()` একটা `Redirect` ফেরত দেয়, যেটা আসলে একটা `Response`, `Error` না। তাই
`strictTypeChecked`-এর `only-throw-error` rule এটা আটকায় (যাচাই করা: দুটো error)। পুরো rule বন্ধ না
করে শুধু এই একটা টাইপকে অনুমতি দেওয়া হয়েছে, আর তাও শুধু `apps/app`-এ। বিকল্প ছিল
`redirect({ …, throw: true })` — কিন্তু তাতে কোডে `throw` শব্দটাই থাকে না, পড়ার সময় বোঝা যায় না
যে এখানে ফাংশন থেমে যাচ্ছে।

**ফাইল: `.github/workflows/ci.yml`** (আপডেট — `pnpm install`-এর ঠিক পরে একটা ধাপ)

```yaml
      - run: pnpm install --frozen-lockfile

      - name: Lockfile dedupe
        run: pnpm dedupe --check
```

**কেন:** ৩.৩-এর `drizzle-orm`-এর দুই কপির সমস্যা কেউ নতুন প্যাকেজ install করে `pnpm dedupe` চালাতে
ভুলে গেলে আবার ফিরে আসতে পারে। `--check` lockfile বদলায় না, শুধু dedupe করা যেত কিনা দেখে, আর যেত
হলে CI fail করে — তখন error-টা হয় "lockfile dedupe করুন", দুর্বোধ্য TS2345 না। (বাকি CI ধাপ বদলাতে
হবে না: integration test-এর Postgres আর Valkey Testcontainers নিজেই তোলে।)

---

## ৩.১০ — ফ্রন্টএন্ড: লগইন, সাইনআপ, protected ড্যাশবোর্ড

```bash
pnpm --filter @omnivo/app add '@tanstack/react-router@^1.170.39' 'zustand@^5.0.15' '@hugeicons/react@^1.1.10' '@hugeicons/core-free-icons@^4.3.5' '@omnivo/contracts@workspace:*' 'zod@^4.6.5' '@fontsource-variable/geist@^5.3.0' '@fontsource-variable/geist-mono@^5.3.0' '@fontsource/noto-sans-bengali@^5.3.0'
pnpm --filter @omnivo/app add -D 'tailwindcss@^4.3.3' '@tailwindcss/vite@^4.3.3'
pnpm dedupe
```

- **আইকন:** `@hugeicons/react` (একটাই `HugeiconsIcon` component) + `@hugeicons/core-free-icons` (Stroke
  Rounded সেট)। CLAUDE.md-এর rule ৪-এ প্যাকেজের নাম লেখা `hugeicons-react` — ওটা পুরনো প্যাকেজ
  (0.4.0)। একই rule-এ বলা "free `@hugeicons/core-free-icons` set"-এর সাথে যায় নতুন `@hugeicons/react`।
  CLAUDE.md-এর লাইনটা এখন ঠিক করা হয়েছে (শেষের নোট দেখুন)।
- **Router:** TanStack Router-এর **code-based** routing, file-based না — file-based-এ Vite plugin আর
  একটা generate হওয়া `routeTree.gen.ts` লাগে ("কম ম্যাজিক" নীতি)। টাইপ-নিরাপত্তা দুটোতেই সমান
  (`router.tsx`-এর `Register` দেখুন)। route বাড়লে পরে বদলানো সহজ।
- **TanStack Query এখন না** — এই ধাপে শুধু `/auth/me` আর `/members` আছে; ধাপ ৫-এর codegen নিজেই Query hook
  বানাবে। তার আগে Query আনলে দুবার লিখতে হতো।
- **ফর্ম লাইব্রেরি (React Hook Form) এখন না** — ধাপ ৪-এর `FormField`-এর কাজ। এখন সাধারণ `useState` আর
  একই Zod schema।

**ফাইল: `apps/app/package.json`** (install-এর পরে এমন হবে — হাতে কিছু বদলাতে হবে না)

```json
{
  "name": "@omnivo/app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "devDependencies": {
    "@omnivo/config": "workspace:*",
    "@tailwindcss/vite": "^4.3.3",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.1",
    "tailwindcss": "^4.3.3",
    "typescript": "^6.0.3",
    "vite": "^8.3.0",
    "vitest": "^5.0.1"
  },
  "dependencies": {
    "@fontsource-variable/geist": "^5.3.0",
    "@fontsource-variable/geist-mono": "^5.3.0",
    "@fontsource/noto-sans-bengali": "^5.3.0",
    "@hugeicons/core-free-icons": "^4.3.5",
    "@hugeicons/react": "^1.1.10",
    "@omnivo/contracts": "workspace:*",
    "@tanstack/react-router": "^1.170.39",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "zod": "^4.6.5",
    "zustand": "^5.0.15"
  }
}
```

**ফাইল: `apps/app/vite.config.ts`** (আপডেট)

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
});
```

`tailwindcss()` — Tailwind v4-এর নিজস্ব Vite plugin। v3-এর মতো `tailwind.config.js` বা PostCSS config
লাগে না; সব config থাকে CSS-এ (`@theme`)।

**ফাইল: `apps/app/src/vite-env.d.ts`** (নতুন ফাইল)

```ts
// Vite-এর ImportMetaEnv ডিফল্টে অচেনা key-কে `any` দেয় — এই অপশনে সেটা বন্ধ হয় (rule 3)
interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

**কেন:** Vite-এর ডিফল্ট `ImportMetaEnv` যেকোনো অচেনা key-কে `any` টাইপ দেয়, তাই
`import.meta.env.VITE_API_URL` হতো `any` (rule ৩ ভাঙে, আর বানান ভুল ধরা পড়ে না)। `ViteTypeOptions`-এ
`strictImportMetaEnv` দিলে Vite সেই `any` fallback তুলে নেয় (Vite 8-এর `importMeta.d.ts`-এ দেখা), আর
শুধু এখানে ঘোষণা করা key-ই চলে। `VITE_API_URL?` ঐচ্ছিক, কারণ dev-এ ডিফল্ট `http://localhost:3000`।
ফাইলে কোনো `import`/`export` নেই ইচ্ছা করে — তাহলে এটা global declaration হিসেবে Vite-এর interface-এর
সাথে merge হয়; একটা `import` থাকলেই এটা module হয়ে যেত আর merge হতো না।

**ফাইল: `apps/app/src/styles.css`** (নতুন ফাইল)

```css
@import 'tailwindcss';

/* self-hosted — অফলাইন-ফার্স্ট অ্যাপ runtime-এ Google Fonts ডাকবে না */
@import '@fontsource-variable/geist';
@import '@fontsource-variable/geist-mono';
@import '@fontsource/noto-sans-bengali/400.css';
@import '@fontsource/noto-sans-bengali/500.css';
@import '@fontsource/noto-sans-bengali/600.css';

/* CLAUDE.md-এর color token — component-এ কখনো raw hex না, শুধু এই নামগুলো */
:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --subtle: #f1f3f6;
  --line: #e4e7ec;
  --line-strong: #d0d5dd;
  --ink: #0f1728;
  --ink-2: #475467;
  --ink-3: #8a94a6;
  --brand: #1f47b5;
  --brand-hover: #193b97;
  --brand-soft: #edf1fb;
  --brand-line: #c9d5f3;
  --brand-ink: #ffffff;
  --good: #0a7a4b;
  --good-bg: #ecf8f1;
  --warn: #b25e09;
  --warn-bg: #fef6e7;
  --crit: #b42318;
  --crit-bg: #fef1f0;
  --elev-sm: 0 1px 2px rgb(16 24 40 / 0.05);
  --elev: 0 1px 2px rgb(16 24 40 / 0.04), 0 8px 24px -6px rgb(16 24 40 / 0.1);
  --elev-lg: 0 2px 4px rgb(16 24 40 / 0.04), 0 24px 48px -12px rgb(16 24 40 / 0.16);
  --focus-ring: 0 0 0 4px rgb(31 71 181 / 0.14);
}

/* OS dark হলে dark — কিন্তু data-theme="light" থাকলে সেটাই জিতবে */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
    --bg: #0b0f17;
    --surface: #111722;
    --subtle: #171e2b;
    --line: #212938;
    --line-strong: #2f394b;
    --ink: #eef1f6;
    --ink-2: #a3adbd;
    --ink-3: #6b768a;
    --brand: #7c9cf2;
    --brand-hover: #95aff5;
    --brand-soft: #16203a;
    --brand-line: #2a3a66;
    --brand-ink: #0b0f17;
    --good: #4cc98f;
    --good-bg: #0e2a1e;
    --warn: #f2b35a;
    --warn-bg: #2c2211;
    --crit: #f4837a;
    --crit-bg: #321614;
    --elev-sm: 0 1px 2px rgb(0 0 0 / 0.3);
    --elev: 0 1px 2px rgb(0 0 0 / 0.3), 0 8px 24px -6px rgb(0 0 0 / 0.5);
    --elev-lg: 0 2px 4px rgb(0 0 0 / 0.3), 0 24px 48px -12px rgb(0 0 0 / 0.6);
    --focus-ring: 0 0 0 4px rgb(124 156 242 / 0.2);
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #0b0f17;
  --surface: #111722;
  --subtle: #171e2b;
  --line: #212938;
  --line-strong: #2f394b;
  --ink: #eef1f6;
  --ink-2: #a3adbd;
  --ink-3: #6b768a;
  --brand: #7c9cf2;
  --brand-hover: #95aff5;
  --brand-soft: #16203a;
  --brand-line: #2a3a66;
  --brand-ink: #0b0f17;
  --good: #4cc98f;
  --good-bg: #0e2a1e;
  --warn: #f2b35a;
  --warn-bg: #2c2211;
  --crit: #f4837a;
  --crit-bg: #321614;
  --elev-sm: 0 1px 2px rgb(0 0 0 / 0.3);
  --elev: 0 1px 2px rgb(0 0 0 / 0.3), 0 8px 24px -6px rgb(0 0 0 / 0.5);
  --elev-lg: 0 2px 4px rgb(0 0 0 / 0.3), 0 24px 48px -12px rgb(0 0 0 / 0.6);
  --focus-ring: 0 0 0 4px rgb(124 156 242 / 0.2);
}

/* inline: utility-তে var(--x) বসে, তাই theme বদলালে rebuild ছাড়াই রং বদলায় */
@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-subtle: var(--subtle);
  --color-line: var(--line);
  --color-line-strong: var(--line-strong);
  --color-ink: var(--ink);
  --color-ink-2: var(--ink-2);
  --color-ink-3: var(--ink-3);
  --color-brand: var(--brand);
  --color-brand-hover: var(--brand-hover);
  --color-brand-soft: var(--brand-soft);
  --color-brand-line: var(--brand-line);
  --color-brand-ink: var(--brand-ink);
  --color-good: var(--good);
  --color-good-bg: var(--good-bg);
  --color-warn: var(--warn);
  --color-warn-bg: var(--warn-bg);
  --color-crit: var(--crit);
  --color-crit-bg: var(--crit-bg);

  /* fontsource-variable প্যাকেজ family নাম রেজিস্টার করে "Geist Variable" নামে, "Geist" না */
  --font-sans: 'Geist Variable', 'Noto Sans Bengali', 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'Geist Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace;

  --radius-control: 10px;
  --radius-card: 14px;
  --radius-panel: 20px;

  --shadow-sm: var(--elev-sm);
  --shadow-md: var(--elev);
  --shadow-lg: var(--elev-lg);
  --shadow-ring: var(--focus-ring);
  --shadow-ring-crit: 0 0 0 4px var(--crit-bg);
}

/* টাইপ স্কেল (CLAUDE.md-এর টেবিল) — text-body, text-label ইত্যাদি */
@theme {
  --text-display: 34px;
  --text-display--line-height: 1.15;
  --text-h1: 26px;
  --text-h1--line-height: 1.2;
  --text-h2: 24px;
  --text-h2--line-height: 1.25;
  --text-kpi: 26px;
  --text-kpi--line-height: 1.1;
  --text-h3: 15px;
  --text-h3--line-height: 1.4;
  --text-body: 14.5px;
  --text-body--line-height: 1.5;
  --text-body-sm: 13.5px;
  --text-body-sm--line-height: 1.45;
  --text-label: 13px;
  --text-label--line-height: 1.4;
  --text-caption: 12px;
  --text-caption--line-height: 1.35;
  --text-micro: 11px;
  --text-micro--line-height: 1.3;
}

@layer base {
  body {
    background: var(--color-bg);
    color: var(--color-ink);
    font-family: var(--font-sans);
    font-size: var(--text-body);
    line-height: var(--text-body--line-height);
    -webkit-font-smoothing: antialiased;
  }

  h1,
  h2,
  h3 {
    font-weight: 600;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }

  /* সব clickable element-এ pointer cursor (Tailwind v4 preflight button-এ default করে দেয়) */
  button:not(:disabled),
  [role='button']:not([aria-disabled='true']),
  a[href],
  label[for],
  summary,
  select:not(:disabled),
  input[type='checkbox']:not(:disabled),
  input[type='radio']:not(:disabled),
  input[type='file']:not(:disabled) {
    cursor: pointer;
  }
  /* disabled হলে not-allowed */
  :disabled,
  [aria-disabled='true'] {
    cursor: not-allowed;
  }

  :focus-visible {
    outline: 2px solid var(--color-brand);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      transition: none !important;
      animation: none !important;
    }
  }
}
```

**কোন অংশ কেন:**

- `@import 'tailwindcss'` — v4-এ একটা import-ই যথেষ্ট (base, components, utilities সব)।
- **Font:** `@fontsource-variable/*` আর `@fontsource/noto-sans-bengali` — font ফাইল Vite bundle-এ ঢোকে,
  Google Fonts-এ কোনো request যায় না (অ্যাপ offline-first)। Noto Sans Bengali-র শুধু 400/500/600 —
  CLAUDE.md-এর তিনটা weight; সব weight import করলে bundle বাড়ত।
- ⚠️ **`--font-sans: 'Geist Variable', …`, `'Geist'` না।** variable fontsource প্যাকেজগুলো family নাম
  রেজিস্টার করে `Geist Variable` আর `Geist Mono Variable` নামে (প্যাকেজের CSS-এ যাচাই করা)। CLAUDE.md-এর
  আগের লেখার মতো `"Geist"` লিখলে ব্রাউজার ওই নামে কোনো font খুঁজে পেত না আর চুপচাপ system font-এ চলে যেত — কোনো
  error ছাড়াই, শুধু দেখতে একটু আলাদা।
- **`:root` token** — CLAUDE.md-এর টেবিলের মান হুবহু (Prettier hex ছোট হাতের করে দেয়)। `--elev-*`
  তিনটা shadow, `--focus-ring` (light-এ brand-এর 14%, dark-এ 20%, CLAUDE.md-এর Focus ring নিয়ম)।
- **Dark mode দুই জায়গায়, একই মান দুবার** — `@media (prefers-color-scheme: dark)`-এর ভেতরে
  `:root:not([data-theme='light'])` (OS dark হলে dark, কিন্তু কেউ হাতে light বাছলে সেটাই জেতে), আর
  আলাদা `:root[data-theme='dark']` (OS light হলেও হাতে dark)। plain CSS-এ একটা block দুই selector-এ
  শেয়ার করা যায় না, তাই পুনরাবৃত্তি। `color-scheme: dark` — scrollbar, checkbox-এর মতো native জিনিসও
  dark হয়।
- **`@theme inline`** — CLAUDE.md-এর "Tailwind wiring"। `inline` থাকায় utility সরাসরি `var(--bg)` লেখে,
  ফলে মান resolve হয় যে element-এ class বসেছে সেখানে — পরে কোনো অংশে আলাদা `data-theme` বসালেও কাজ
  করবে।
- `--radius-control/card/panel` → `rounded-control` (10px), `rounded-card` (14px), `rounded-panel`
  (20px, শুধু auth side panel)। 8px-এর জন্য Tailwind-এর নিজের `rounded-lg`-ই ৮px।
- `--shadow-sm` Tailwind-এর ডিফল্টটা বদলে দেয়; CLAUDE.md-এর "shadow" এখানে `shadow-md`, আর নতুন
  `shadow-ring` / `shadow-ring-crit` — focus ring box-shadow হিসেবে, যাতে ইনপুটের `shadow-sm`-এর জায়গা নেয়
  (mockup-এর `.ctl:focus-within{box-shadow:var(--ring)}`-এর মতো)।
- **টাইপ স্কেল `@theme`-এ (inline ছাড়া)** — মানগুলো স্থির, কোনো var-এর ওপর নির্ভর করে না।
  `--text-body: 14.5px` + `--text-body--line-height: 1.5` জোড়া থেকে `text-body` utility দুটোই বসায়।
  ফলে component-এ `text-[14.5px] leading-[1.5]` না লিখে `text-body`, `text-label`, `text-caption`।
- **`@layer base`** — body-র রং/font; heading-এর 600 weight, `-0.02em`, `text-wrap: balance`
  (CLAUDE.md Typography); cursor-এর নিয়ম CLAUDE.md থেকে হুবহু; প্রতিটা interactive element-এ দৃশ্যমান focus
  (`:focus-visible` 2px brand outline); `prefers-reduced-motion`-এ transition বন্ধ।

**ফাইল: `apps/app/src/lib/cx.ts`** (নতুন ফাইল)

```ts
// শর্তসাপেক্ষ class জোড়া লাগানো — এর জন্য আলাদা dependency (clsx) লাগে না
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
```

`clsx`-এর ১% কাজ, তিন লাইনে — আলাদা dependency-র দরকার নেই। টাইপ `false | null | undefined` নেয়, তাই
`cond && 'class'` লেখা যায়।

**ফাইল: `apps/app/src/lib/format.ts`** (নতুন ফাইল)

```ts
// CLAUDE.md: UI-তে তারিখ "23 Sep 2026"। en-GB নতুন ICU-তে "Sept" লেখে, তাই en-US-এর অংশ
// নিয়ে নিজেরা সাজানো — ব্রাউজার/OS ভেদে একই ফল
const dateParts = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function formatDate(date: Date): string {
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    dateParts.formatToParts(date).find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}
```

**কেন:** CLAUDE.md বলে UI-তে তারিখ হবে `23 Sep 2026`। প্রথম চেষ্টায় `Intl.DateTimeFormat('en-GB', …)`
ছিল, কিন্তু আসল ব্রাউজারের screenshot-এ দেখা গেল "27 **Sept** 2026" — নতুন ICU ডেটায় ব্রিটিশ ইংরেজিতে
সেপ্টেম্বরের সংক্ষেপ "Sept"। `en-US`-এর মাস ("Sep") নিয়ে দিন-মাস-বছর নিজেরা সাজালে সব ব্রাউজারে একই
ফল। `formatToParts` — স্ট্রিং কেটে না, প্রতিটা অংশ আলাদা করে পাওয়া যায়।

**ফাইল: `apps/app/src/lib/session-store.ts`** (নতুন ফাইল)

```ts
import type { MeResponse } from '@omnivo/contracts';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

interface SessionState {
  // unknown = অ্যাপ সবে খুলেছে, refresh cookie দিয়ে session ফেরানো এখনো শেষ হয়নি
  status: 'unknown' | 'signed-in' | 'signed-out';
  // শুধু memory-তে — localStorage-এ রাখলে যেকোনো XSS স্ক্রিপ্ট টোকেন পড়তে পারত
  accessToken: string | null;
  me: MeResponse | null;
  setAccessToken: (accessToken: string) => void;
  signIn: (me: MeResponse) => void;
  signOut: () => void;
}

// vanilla store: React-এর বাইরে (api.ts, router-এর beforeLoad) থেকেও getState() ডাকা যায়
export const sessionStore = createStore<SessionState>()((set) => ({
  status: 'unknown',
  accessToken: null,
  me: null,
  setAccessToken: (accessToken) => {
    set({ accessToken });
  },
  signIn: (me) => {
    set({ status: 'signed-in', me });
  },
  signOut: () => {
    set({ status: 'signed-out', accessToken: null, me: null });
  },
}));

export function useSession<T>(selector: (state: SessionState) => T): T {
  return useStore(sessionStore, selector);
}
```

**কোন লাইন কেন:**

- `status: 'unknown' | 'signed-in' | 'signed-out'` — তিনটা অবস্থা, দুটো না। পেজ reload-এর পর প্রথম
  মুহূর্তে আমরা জানি না ইউজার লগইন করা কিনা (cookie দিয়ে refresh চলছে); `boolean` হলে সেই মুহূর্তে
  লগইন পেজ ঝলক দিয়ে যেত।
- `accessToken` শুধু memory-তে — `localStorage`-এ রাখলে যেকোনো XSS স্ক্রিপ্ট
  `localStorage.getItem(...)` দিয়ে টোকেন নিয়ে যেত। memory-তে রাখার দাম হলো reload-এ টোকেন হারায় —
  সেটা পুষিয়ে দেয় httpOnly refresh cookie।
- `createStore` (`zustand/vanilla`) + `useStore` — React hook ছাড়াও store পড়তে হয়: `api.ts` প্রতিটা
  request-এ টোকেন নেয়, router-এর `beforeLoad` status দেখে — দুটোই React component না। vanilla store-এ
  `sessionStore.getState()` যেকোনো জায়গা থেকে ডাকা যায়।
- action (`setAccessToken`, `signIn`, `signOut`) store-এর ভেতরে — state কীভাবে বদলায় সেটা এক জায়গায়;
  বাইরে কেউ `setState`-এ অর্ধেক অবস্থা বসাতে পারে না (যেমন token আছে কিন্তু status `signed-out`)।
- `useSession(selector)` — component শুধু যা দরকার তা বাছে (`(s) => s.me`); store-এর অন্য অংশ বদলালে
  সেই component আবার render হয় না।

**ফাইল: `apps/app/src/lib/api.ts`** (নতুন ফাইল — টোকেন refresh interceptor)

```ts
import {
  type ApiError,
  apiErrorSchema,
  type AuthSession,
  authSessionSchema,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { sessionStore } from './session-store';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
  }
}

async function toError(response: Response): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(body);
  return new ApiRequestError(
    response.status,
    parsed.success
      ? parsed.data
      : { statusCode: response.status, message: 'Something went wrong. Try again in a moment.' },
  );
}

// একই সময়ে যত request-ই 401 পাক, refresh একবারই যাবে — rotation-এ দ্বিতীয় refresh
// পুরনো cookie পাঠাত আর সার্ভার সেটাকে চুরি ভেবে পুরো session মুছে দিত
let refreshInFlight: Promise<AuthSession | null> | null = null;

export function refreshSession(): Promise<AuthSession | null> {
  refreshInFlight ??= navigator.locks
    // Web Locks: একই ব্রাউজারের একাধিক ট্যাবও একটার পর একটা refresh করবে, একসাথে না
    .request('omnivo-refresh', async () => {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) return null;
      return authSessionSchema.parse(await response.json());
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
}

// প্রতিটা API call: Bearer বসানো, 401 হলে একবার refresh করে আবার চেষ্টা, response Zod দিয়ে যাচাই
export async function apiFetch<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  options: RequestOptions = {},
): Promise<z.output<TSchema>> {
  const send = (accessToken: string | null): Promise<Response> => {
    const headers = new Headers();
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      body: options.body === undefined ? null : JSON.stringify(options.body),
    });
  };

  const tokenBefore = sessionStore.getState().accessToken;
  let response = await send(tokenBefore);

  // টোকেন ছিল কিন্তু 401 = মেয়াদ শেষ; টোকেন ছাড়া 401 (যেমন ভুল পাসওয়ার্ড) refresh দিয়ে সারে না
  if (response.status === 401 && tokenBefore) {
    const session = await refreshSession();
    if (!session) {
      sessionStore.getState().signOut();
      throw await toError(response);
    }
    sessionStore.getState().setAccessToken(session.accessToken);
    response = await send(session.accessToken);
  }

  if (!response.ok) throw await toError(response);
  return schema.parse(await response.json());
}

export async function logoutRequest(): Promise<void> {
  await fetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
}
```

**কোন লাইন কেন:**

- `ApiRequestError` — status আর parse করা body দুটোই রাখে; ফর্ম `body.fieldErrors` থেকে ফিল্ডের পাশে
  error বসায়।
- `toError`-এ `response.json().catch(() => null)` — প্রক্সির HTML error পেজ বা খালি body-তে JSON parse
  ভাঙবেই; তখন সাধারণ মেসেজ দেখানো।
- **`refreshInFlight` (single-flight)** — এটা ছাড়া rotation-এর সাথে একটা বাস্তব bug হতো: পেজে দুটো
  request একসাথে 401 পেলে দুটোই refresh ডাকত; প্রথমটা টোকেন rotate করত, দ্বিতীয়টা পুরনো cookie নিয়ে যেত
  → সার্ভার সেটাকে reuse (চুরি) ধরে **পুরো session মুছে দিত**, ইউজার অকারণে লগআউট। এখন প্রথম caller
  promise বানায়, বাকিরা একই promise-এর অপেক্ষা করে। `??=` — চলমান থাকলে নতুন বানায় না। `.finally`-তে
  খালি করা, যাতে পরের বার আবার refresh করা যায়।
- **`navigator.locks.request('omnivo-refresh', …)` (Web Locks)** — single-flight শুধু একটা ট্যাবের ভেতরে
  কাজ করে। দুটো ট্যাব খোলা থাকলে দুটোরই টোকেন একসাথে মেয়াদোত্তীর্ণ হয়, আর cookie দুজনের একই। lock
  থাকায় দ্বিতীয় ট্যাব অপেক্ষা করে, আর lock পেলে ততক্ষণে ব্রাউজারে আসা **নতুন** cookie পাঠায় — reuse
  হয় না। Web Locks সব আধুনিক ব্রাউজারে আছে (২০২২ থেকে)।
- `credentials: 'include'` — cross-origin (`5173` → `3000`) `fetch`-এ cookie পাঠানো আর `Set-Cookie`
  মানার জন্য লাগে। cookie-র `Path=/auth`, তাই `/members`-এ এটা দিলেও cookie যায় না।
- `body: options.body === undefined ? null : …` — `exactOptionalPropertyTypes`-এ `RequestInit.body`-তে
  `undefined` বসানো যায় না (টাইপ `BodyInit | null`), তাই `null`।
- `response.status === 401 && tokenBefore` — টোকেন ছিল আর 401 = মেয়াদ শেষ, refresh করলে সারবে। টোকেন
  ছাড়াই 401 (যেমন লগইনে ভুল পাসওয়ার্ড) refresh দিয়ে সারে না — সেখানে refresh ডাকলে উল্টো লগইন ফর্মের
  error-টাই হারিয়ে যেত।
- refresh ব্যর্থ → `signOut()` — session সত্যিই শেষ (লগআউট, reuse, ৩০ দিন পার)। `AppShell` এই অবস্থা
  দেখে `/login`-এ পাঠায়।
- `schema.parse(await response.json())` — `response.json()` দেয় `any`; parse করলে টাইপ আর রানটাইম চেক
  দুটোই পাওয়া যায়। ফেরত টাইপ `z.output<TSchema>`, তাই `apiFetch('/auth/me', meResponseSchema)`-এর ফল
  নিজে থেকে `MeResponse`।

**ফাইল: `apps/app/src/lib/session.ts`** (নতুন ফাইল)

```ts
import {
  type AuthSession,
  authSessionSchema,
  type LoginInput,
  meResponseSchema,
  type SignUpInput,
} from '@omnivo/contracts';

import { apiFetch, logoutRequest, refreshSession } from './api';
import { sessionStore } from './session-store';

async function startSession(session: AuthSession): Promise<void> {
  sessionStore.getState().setAccessToken(session.accessToken);
  const me = await apiFetch('/auth/me', meResponseSchema);
  sessionStore.getState().signIn(me);
}

// পেজ reload-এ memory-র টোকেন হারায়; httpOnly cookie দিয়ে নতুন টোকেন আনা।
// module-level promise: React StrictMode বা একাধিক route একসাথে ডাকলেও refresh একবারই যায়
let restoring: Promise<void> | null = null;

export function restoreSession(): Promise<void> {
  restoring ??= (async () => {
    try {
      const session = await refreshSession();
      if (session) {
        await startSession(session);
        return;
      }
    } catch {
      // API বন্ধ বা নেটওয়ার্ক নেই — reject হলে প্রতিটা route চিরতরে ভাঙত; লগইন পেজ দেখানোই নিরাপদ,
      // সেখানে চেষ্টা করলে "Could not reach the server" দেখাবে
    }
    sessionStore.getState().signOut();
  })();
  return restoring;
}

export async function login(input: LoginInput): Promise<void> {
  await startSession(
    await apiFetch('/auth/login', authSessionSchema, { method: 'POST', body: input }),
  );
}

export async function signUp(input: SignUpInput): Promise<void> {
  await startSession(
    await apiFetch('/auth/sign-up', authSessionSchema, { method: 'POST', body: input }),
  );
}

export async function switchTenant(tenantId: string): Promise<void> {
  await startSession(
    await apiFetch('/auth/switch-tenant', authSessionSchema, {
      method: 'POST',
      body: { tenantId },
    }),
  );
}

export async function logout(): Promise<void> {
  try {
    await logoutRequest();
  } finally {
    // নেটওয়ার্ক ব্যর্থ হলেও এই ট্যাবে লগআউট দেখাতে হবে
    sessionStore.getState().signOut();
  }
}
```

**কোন লাইন কেন:**

- `startSession` — টোকেন store-এ বসিয়ে তারপর `/auth/me`; `me` আসার পরেই `signed-in`। ফলে ড্যাশবোর্ড
  কখনো `me === null` নিয়ে render হয় না।
- **`restoring` promise একবারই তৈরি হয়** — React `StrictMode` dev-এ effect দুবার চালায়, আর router একই
  সাথে একাধিক route-এর `beforeLoad` ডাকতে পারে। প্রতিবার refresh গেলে rotation-এর সাথে ওই একই reuse-bug
  হতো। ব্রাউজারে মাপা হয়েছে: প্রথম লোড আর reload দুটোতেই ঠিক **একটা** `POST /auth/refresh`।
- `try/catch` — API বন্ধ বা নেটওয়ার্ক নেই হলে `fetch` throw করে। ধরা না হলে `restoring` চিরকালের জন্য
  rejected promise হয়ে থাকত আর প্রতিটা route error দেখাত। এখন লগইন পেজ আসে, আর সেখানে চেষ্টা করলে
  "Could not reach the server" দেখায় (API বন্ধ রেখে ব্রাউজারে যাচাই করা)। `catch {}` খালি কিন্তু মন্তব্য
  আছে — ESLint-এর `no-empty` মন্তব্যসহ block মেনে নেয়।
- `logout`-এ `finally` — নেটওয়ার্ক ব্যর্থ হলেও এই ট্যাবে লগআউট দেখাতে হবে; ইউজার "Sign out" চেপে লগইন
  অবস্থায় থেকে যাওয়া বিপজ্জনক (যেমন শেয়ার করা কম্পিউটারে)।

**ফাইল: `apps/app/src/lib/field-errors.ts`** (নতুন ফাইল)

```ts
import { z } from 'zod';

import { ApiRequestError } from './api';

export type FieldErrors = Partial<Record<string, string>>;

// ক্লায়েন্টে একই Zod schema — সার্ভারে যাওয়ার আগেই একই মেসেজ দেখানো
export function validate<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): { data: z.output<TSchema> } | { errors: FieldErrors } {
  const result = schema.safeParse(value);
  if (result.success) return { data: result.data };
  const errors: FieldErrors = {};
  for (const [field, messages] of Object.entries(z.flattenError(result.error).fieldErrors)) {
    if (Array.isArray(messages) && typeof messages[0] === 'string') errors[field] = messages[0];
  }
  return { errors };
}

// সার্ভারের error → ফিল্ডের পাশে (fieldErrors থাকলে) নয়তো ফর্মের উপরে
export function fromApiError(error: unknown): { fields: FieldErrors; form: string | null } {
  if (!(error instanceof ApiRequestError)) {
    return { fields: {}, form: 'Could not reach the server. Check your connection and try again.' };
  }
  const fields: FieldErrors = {};
  for (const [field, messages] of Object.entries(error.body.fieldErrors ?? {})) {
    if (messages[0]) fields[field] = messages[0];
  }
  return { fields, form: Object.keys(fields).length > 0 ? null : error.body.message };
}
```

- `validate` — সার্ভারের একই schema ব্রাউজারে; নেটওয়ার্কে যাওয়ার আগেই একই মেসেজ। প্রতিটা ফিল্ডের প্রথম
  মেসেজটাই দেখানো হয় — একসাথে তিনটা লাল লাইন ইউজারকে বিভ্রান্ত করে।
- `Array.isArray(messages) && typeof messages[0] === 'string'` — `flattenError`-এর টাইপে মান
  `string[] | undefined`, আর `noUncheckedIndexedAccess`-এ `messages[0]` হয় `string | undefined` — এই
  চেকে narrow হয়ে `string`।
- `fromApiError` — `ApiRequestError` না হলে সেটা নেটওয়ার্ক-স্তরের সমস্যা (`fetch` নিজেই throw করেছে)।
  `fieldErrors` থাকলে ফিল্ডের পাশে, না থাকলে ফর্মের উপরে (`FormAlert`)।

**ফাইল: `apps/app/src/components/logo.tsx`** (নতুন ফাইল)

```tsx
// দুটো সরানো বর্গ — ভরাট আর ফাঁকা, খাতার ডেবিট/ক্রেডিট কলাম (CLAUDE.md → Logo)
export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.02em] text-ink">
      <span aria-hidden="true" className="relative size-[26px] shrink-0">
        <span className="absolute top-0 left-0 size-4 rounded-[5px] bg-brand" />
        <span className="absolute right-0 bottom-0 size-4 rounded-[5px] border-2 border-brand bg-surface" />
      </span>
      Omnivo
    </span>
  );
}
```

CLAUDE.md-এর Logo: দুটো সরানো গোলকোণা বর্গ (ভরাট `brand` + ফাঁকা `brand`, খাতার ডেবিট/ক্রেডিট কলাম),
পাশে "Omnivo" 17px/600। mockup-এর মাপ: ২৬px বাক্স, ১৬px বর্গ, ৫px কোণ। `aria-hidden` — বর্গ দুটো শুধু
সাজ; স্ক্রিন রিডার শুধু "Omnivo" পড়ে।

**ফাইল: `apps/app/src/components/button.tsx`** (নতুন ফাইল)

```tsx
import type { ButtonHTMLAttributes } from 'react';

import { cx } from '../lib/cx';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export function Button({ variant = 'primary', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex min-h-[42px] items-center justify-center gap-2 rounded-control px-4 text-body font-medium whitespace-nowrap shadow-sm transition-colors duration-150 disabled:opacity-60',
        variant === 'primary'
          ? 'bg-brand text-brand-ink hover:bg-brand-hover'
          : 'border border-line-strong bg-surface text-ink hover:bg-subtle',
        className,
      )}
      {...props}
    />
  );
}
```

- CLAUDE.md-এর Primary/Secondary button: ৪২px উচ্চতা, `rounded-control`, `text-body font-medium`,
  `shadow-sm`, hover-এ `brand-hover` / `subtle`।
- `type = 'button'` ডিফল্ট — HTML-এ ফর্মের ভেতরে `<button>`-এর ডিফল্ট `submit`। password-এর চোখ-বাটনের
  মতো কোনো বাটনে `type` দিতে ভুলে গেলে সেটা ফর্ম জমা দিয়ে দিত। submit দরকার হলে স্পষ্ট করে
  `type="submit"`।
- `transition-colors duration-150` — CLAUDE.md: শুধু রং/border/shadow-এর 150ms transition, scale বা
  bounce না।

**ফাইল: `apps/app/src/components/text-field.tsx`** (নতুন ফাইল)

```tsx
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { InputHTMLAttributes, ReactNode } from 'react';

import { cx } from '../lib/cx';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'> {
  id: string;
  label: string;
  icon?: IconSvgElement;
  suffix?: string;
  // exactOptionalPropertyTypes: caller `errors.email` (string | undefined) সরাসরি দিতে পারে
  error?: string | undefined;
  trailing?: ReactNode;
}

export function TextField({ id, label, icon, suffix, error, trailing, ...input }: TextFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-label font-medium text-ink">
        {label}
      </label>
      <div
        className={cx(
          'flex min-h-[42px] items-center gap-2.5 rounded-control border bg-surface px-3 shadow-sm transition-[border-color,box-shadow] duration-150',
          error
            ? 'border-crit focus-within:shadow-ring-crit'
            : 'border-line-strong hover:border-ink-3 focus-within:border-brand focus-within:shadow-ring',
        )}
      >
        {icon && (
          <HugeiconsIcon icon={icon} size={17} strokeWidth={1.5} className="shrink-0 text-ink-3" />
        )}
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="min-w-0 flex-1 bg-transparent py-2.5 text-body outline-none placeholder:text-ink-3"
          {...input}
        />
        {suffix && <span className="text-body-sm whitespace-nowrap text-ink-3">{suffix}</span>}
        {trailing}
      </div>
      {error && (
        <p id={errorId} className="flex items-center gap-1.5 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
```

- CLAUDE.md-এর Input: ৪২px, `border-line-strong`, hover-এ `border-ink-3`, focus-এ `border-brand` + ring;
  বাঁদিকের আইকন ১৭px `ink-3` আর focus-এও `ink-3` থাকে; `.omnivo.app`-এর মতো suffix কন্ট্রোলের ভেতরে
  `ink-3`। error হলে `border-crit` + `crit-bg` ring, নিচে `Alert02` আইকন আর লেখা — শুধু রং দিয়ে না
  (CLAUDE.md: রং একা কখনো না)।
- `focus-within:` — focus আসলে ভেতরের `<input>`-এ, কিন্তু border/ring পুরো বাক্সে দেখাতে হয়।
- `label htmlFor={id}`, `aria-invalid`, `aria-describedby={errorId}` — স্ক্রিন রিডার ইনপুটে গেলে label
  আর error দুটোই পড়ে।
- `trailing` — পাসওয়ার্ডের দেখাও/লুকাও বাটনের জায়গা; component-এর ভেতরে পাসওয়ার্ডের বিশেষ কোনো লজিক নেই।
- `error?: string | undefined` — `exactOptionalPropertyTypes`-এ শুধু `error?: string` লিখলে caller
  `error={errors.email}` (যার টাইপ `string | undefined`) দিতে পারত না।
- `Omit<…, 'id' | 'className'>` — `id` বাধ্যতামূলক করে দেওয়া (label-এর জন্য লাগবেই), আর বাইরে থেকে
  `className` দিয়ে design system-এর মাপ বদলানো বন্ধ।

**ফাইল: `apps/app/src/components/form-alert.tsx`** (নতুন ফাইল)

```tsx
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

// ফিল্ডে বসানো যায় না এমন error (ভুল পাসওয়ার্ড, নেটওয়ার্ক) — রঙের সাথে আইকন আর লেখা
export function FormAlert({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-control border border-crit/30 bg-crit-bg px-3 py-2.5 text-body-sm text-crit"
    >
      <HugeiconsIcon icon={Alert02Icon} size={17} strokeWidth={1.5} className="mt-px shrink-0" />
      {message}
    </p>
  );
}
```

`role="alert"` — এটা হঠাৎ আসে (ভুল পাসওয়ার্ড, নেটওয়ার্ক), তাই স্ক্রিন রিডার সঙ্গে সঙ্গে পড়ে শোনায়।
`border-crit/30` — Tailwind v4 CSS-var রঙেও opacity modifier-এর জন্য `color-mix()` বানায়, তাই নতুন token
লাগে না।

**ফাইল: `apps/app/src/routes/login.tsx`** (নতুন ফাইল)

```tsx
import {
  Building03Icon,
  DeliveryTruck01Icon,
  FactoryIcon,
  LockPasswordIcon,
  Mail01Icon,
  Medicine02Icon,
  TShirtIcon,
  ViewIcon,
  ViewOffIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { loginInputSchema } from '@omnivo/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { type SubmitEvent, useState } from 'react';

import { Button } from '../components/button';
import { FormAlert } from '../components/form-alert';
import { Logo } from '../components/logo';
import { TextField } from '../components/text-field';
import { type FieldErrors, fromApiError, validate } from '../lib/field-errors';
import { login } from '../lib/session';

const INDUSTRIES = [
  { icon: TShirtIcon, label: 'Garments & textiles' },
  { icon: Medicine02Icon, label: 'Pharmaceuticals' },
  { icon: DeliveryTruck01Icon, label: 'Distribution' },
  { icon: FactoryIcon, label: 'Manufacturing' },
];

export function LoginPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ workspace: '', email: '', password: '', keepSignedIn: true });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validate(loginInputSchema, form);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      await login(result.data);
      await navigate({ to: '/' });
    } catch (error) {
      const { fields, form: message } = fromApiError(error);
      setErrors(fields);
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-dvh bg-surface min-[1040px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <section className="flex flex-col px-4 py-8 sm:px-16">
        <Logo />
        <div className="grid flex-1 place-items-center py-10">
          <div className="w-full max-w-[380px]">
            <h1 className="text-[28px] leading-[1.2]">Sign in</h1>
            <p className="mt-2 text-ink-2">Welcome back. Enter your details to continue.</p>

            <form
              noValidate
              onSubmit={(event) => void onSubmit(event)}
              className="mt-8 grid gap-[18px]"
            >
              {formError && <FormAlert message={formError} />}
              <TextField
                id="workspace"
                label="Workspace"
                icon={Building03Icon}
                suffix=".omnivo.app"
                autoComplete="organization"
                spellCheck={false}
                placeholder="rahman-garments"
                value={form.workspace}
                onChange={(e) => {
                  setForm({ ...form, workspace: e.target.value });
                }}
                error={errors.workspace}
              />
              <TextField
                id="email"
                label="Email"
                icon={Mail01Icon}
                type="email"
                autoComplete="email"
                placeholder="name@company.com"
                value={form.email}
                onChange={(e) => {
                  setForm({ ...form, email: e.target.value });
                }}
                error={errors.email}
              />
              <TextField
                id="password"
                label="Password"
                icon={LockPasswordIcon}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                value={form.password}
                onChange={(e) => {
                  setForm({ ...form, password: e.target.value });
                }}
                error={errors.password}
                trailing={
                  <button
                    type="button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => {
                      setShowPassword(!showPassword);
                    }}
                    className="-mr-1.5 grid place-items-center rounded-md p-1.5 text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink"
                  >
                    <HugeiconsIcon
                      icon={showPassword ? ViewOffIcon : ViewIcon}
                      size={17}
                      strokeWidth={1.5}
                    />
                  </button>
                }
              />
              <label htmlFor="keep" className="flex items-start gap-2.5 text-body-sm text-ink-2">
                <input
                  id="keep"
                  type="checkbox"
                  checked={form.keepSignedIn}
                  onChange={(e) => {
                    setForm({ ...form, keepSignedIn: e.target.checked });
                  }}
                  className="mt-px size-[17px] shrink-0 rounded-[5px] accent-brand"
                />
                Keep me signed in on this device
              </label>
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>

            <p className="mt-7 text-center text-body-sm text-ink-2">
              New to Omnivo?{' '}
              <Link
                to="/sign-up"
                className="font-medium text-brand underline-offset-[3px] hover:underline"
              >
                Create a workspace
              </Link>
            </p>
          </div>
        </div>
        <p className="text-[12.5px] text-ink-3">© 2026 Omnivo Technologies</p>
      </section>

      <aside
        aria-label="What Omnivo does"
        className="m-3 ml-0 hidden flex-col justify-center rounded-panel border border-brand-line bg-brand-soft px-[72px] py-14 min-[1040px]:flex"
      >
        <h2 className="max-w-lg text-display tracking-[-0.03em]">
          Production, stock and accounts. One system.
        </h2>
        <p className="mt-3 max-w-md text-[15px] text-ink-2">
          From buyer orders to payroll, every department works from the same numbers, even when the
          internet is down.
        </p>
        <ul className="mt-[18px] flex flex-wrap gap-2">
          {INDUSTRIES.map((industry) => (
            <li
              key={industry.label}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-2.5 pl-2 text-[12.5px] font-medium text-ink-2"
            >
              <HugeiconsIcon
                icon={industry.icon}
                size={14}
                strokeWidth={1.5}
                className="text-brand"
              />
              {industry.label}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
```

**কোন অংশ কেন:**

- ফিল্ড আর লেখা অনুমোদিত "Omnivo Sign In" mockup থেকে: Workspace (`Building03`, `.omnivo.app`), Email
  (`Mail01`), Password (`LockPassword` + চোখ), "Keep me signed in on this device", "Sign in", "New to
  Omnivo? Create a workspace"। ডানদিকের brand-soft প্যানেলে headline (`text-display`) আর চারটা শিল্প-চিপ।
- mockup-এর যা **বাদ**: "Forgot password?" লিঙ্ক আর "Sign in with company SSO" — এগুলোর পেছনে এখনো কিছু
  নেই, আর CLAUDE.md বলে বাটন ঠিক সেটাই করবে যা লেখা আছে; কাজ না করা লিঙ্ক রাখা সেই নিয়ম ভাঙে। ডান
  প্যানেলের ড্যাশবোর্ড-preview কার্ডগুলো শুধু সাজ — ধাপ ৪-এ `packages/ui`-এর কার্ড দিয়ে যোগ করা সহজ হবে।
- `noValidate` — ব্রাউজারের নিজের validation বুদবুদ (`type="email"`-এর) আমাদের schema-র মেসেজের সাথে
  মিলত না; সব যাচাই একই Zod schema দিয়ে।
- `validate(loginInputSchema, form)` আগে — ফাঁকা ফর্মে সার্ভারে যাওয়ার দরকার নেই।
- `SubmitEvent<HTMLFormElement>`, `FormEvent` না — `@types/react` 19.3-এ `FormEvent` deprecated
  ("FormEvent doesn't actually exist"), আর ESLint-এর `no-deprecated` সেটা error দেয় (যাচাই করা)।
- `onSubmit={(event) => void onSubmit(event)}` — async ফাংশন সরাসরি `onSubmit`-এ দিলে
  `no-misused-promises` আটকায় (যাচাই করা) — React promise-এর অপেক্ষা করে না, rejection হারিয়ে যায়। `void` দিয়ে
  স্পষ্ট বলা; আর ভেতরের `try/catch` সব error ধরে।
- চোখের বাটনে `aria-label` বদলায় ("Show password"/"Hide password") — আইকন-বাটনের লেখা নেই, স্ক্রিন রিডার
  এটাই পড়ে।
- checkbox native, `accent-brand` দিয়ে রং — CLAUDE.md-এর ৫px কোণ native checkbox-এ বসে না। সঠিক
  `Checkbox` component ধাপ ৪-এ।
- `min-[1040px]:grid-cols-…` আর `hidden … min-[1040px]:flex` — mockup-এর breakpoint: ১০৪০px-এর নিচে
  ডান প্যানেল লুকানো, ফর্ম পুরো চওড়া। `min-h-dvh` — মোবাইলে ব্রাউজারের address bar বাদ দিয়ে উচ্চতা।
  `px-4` — CLAUDE.md-এর মোবাইল gutter ১৬px।

**ফাইল: `apps/app/src/routes/sign-up.tsx`** (নতুন ফাইল)

```tsx
import {
  Building03Icon,
  Globe02Icon,
  LockPasswordIcon,
  Mail01Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { signUpInputSchema } from '@omnivo/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { type SubmitEvent, useState } from 'react';

import { Button } from '../components/button';
import { FormAlert } from '../components/form-alert';
import { Logo } from '../components/logo';
import { TextField } from '../components/text-field';
import { type FieldErrors, fromApiError, validate } from '../lib/field-errors';
import { signUp } from '../lib/session';

// "Rahman Garments Ltd." → "rahman-garments" (Workspace Setup mockup-এর নিয়ম)
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|pvt|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function SignUpPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    companyName: '',
    workspaceSlug: '',
    fullName: '',
    email: '',
    password: '',
  });
  // ইউজার নিজে slug-এ হাত দিলে কোম্পানির নাম থেকে আর অটো-বসানো হবে না
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validate(signUpInputSchema, form);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      await signUp(result.data);
      await navigate({ to: '/' });
    } catch (error) {
      const { fields, form: message } = fromApiError(error);
      setErrors(fields);
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface px-4 py-5 sm:px-10">
        <Logo />
        <p className="text-body-sm text-ink-2">
          Already have a workspace?{' '}
          <Link
            to="/login"
            className="font-medium text-brand underline-offset-[3px] hover:underline"
          >
            Sign in
          </Link>
        </p>
      </header>

      <main className="mx-auto max-w-[640px] px-4 pt-10 pb-16">
        <div className="rounded-card border border-line bg-surface px-[18px] py-[22px] shadow-md sm:p-8">
          <h1 className="text-h2">Create your workspace</h1>
          <p className="mt-1.5 text-ink-2">
            You&apos;ll be the workspace owner. You can invite your accountants, managers and store
            staff after setup.
          </p>

          <form noValidate onSubmit={(event) => void onSubmit(event)} className="mt-7 grid gap-5">
            {formError && <FormAlert message={formError} />}
            <TextField
              id="companyName"
              label="Company name"
              icon={Building03Icon}
              autoComplete="organization"
              placeholder="Rahman Garments Ltd."
              value={form.companyName}
              onChange={(e) => {
                const companyName = e.target.value;
                setForm({
                  ...form,
                  companyName,
                  workspaceSlug: slugTouched ? form.workspaceSlug : slugify(companyName),
                });
              }}
              error={errors.companyName}
            />
            <TextField
              id="workspaceSlug"
              label="Workspace address"
              icon={Globe02Icon}
              suffix=".omnivo.app"
              spellCheck={false}
              placeholder="rahman-garments"
              value={form.workspaceSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setForm({ ...form, workspaceSlug: e.target.value.toLowerCase() });
              }}
              error={errors.workspaceSlug}
            />
            <div className="grid gap-5 sm:grid-cols-2 sm:gap-4">
              <TextField
                id="fullName"
                label="Full name"
                icon={UserIcon}
                autoComplete="name"
                placeholder="Farhana Rahman"
                value={form.fullName}
                onChange={(e) => {
                  setForm({ ...form, fullName: e.target.value });
                }}
                error={errors.fullName}
              />
              <TextField
                id="email"
                label="Work email"
                icon={Mail01Icon}
                type="email"
                autoComplete="email"
                placeholder="name@company.com"
                value={form.email}
                onChange={(e) => {
                  setForm({ ...form, email: e.target.value });
                }}
                error={errors.email}
              />
            </div>
            <TextField
              id="password"
              label="Password"
              icon={LockPasswordIcon}
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={form.password}
              onChange={(e) => {
                setForm({ ...form, password: e.target.value });
              }}
              error={errors.password}
            />

            <div className="mt-2 flex justify-end border-t border-line pt-6">
              <Button type="submit" disabled={submitting} className="w-full sm:w-auto sm:min-w-40">
                {submitting ? 'Creating workspace…' : 'Create workspace'}
              </Button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
```

- অনুমোদিত "Workspace Setup" mockup তিন ধাপের wizard (Company → Setup → Your account)। এখানে শুধু যা
  এই ধাপে সত্যিই কাজ করে: কোম্পানির নাম, workspace ঠিকানা, আর account-এর ফিল্ড — mockup-এর একই panel
  (`rounded-card`, `shadow-md`, ৩২px padding, ফোনে ২২/১৮px), একই top bar আর একই লেখা। Industry, Modules,
  Fiscal year, VAT BIN আর stepper ধাপ ৮-এর onboarding-এ।
- `slugify` mockup-এর স্ক্রিপ্ট থেকেই: `"Rahman Garments Ltd."` → `rahman-garments` ("Ltd/Limited/Pvt/
  PLC" বাদ, বাকি সব হাইফেন, ৩২ অক্ষরে কাটা)। ব্রাউজারে যাচাই: "Hossain Pharma Ltd." → `hossain-pharma`।
- `slugTouched` — ইউজার নিজে ঠিকানা বদলালে তারপর কোম্পানির নাম বদলালেও তার লেখা ঠিকানা মুছে যায় না।
- ঠিকানা নেওয়া থাকলে সার্ভারের 409-এর `fieldErrors.workspaceSlug` ঠিক ঠিকানার ইনপুটের নিচে দেখায়:
  "hossain-pharma.omnivo.app is taken. Try adding your city." (ব্রাউজারে যাচাই)।
- নাম আর ইমেইল ফোনে এক কলামে, `sm`-এর ওপর দুই কলামে (mockup-এর `.two`) — CLAUDE.md: ফোনে grid এক
  কলাম।

**ফাইল: `apps/app/src/routes/app-shell.tsx`** (নতুন ফাইল)

```tsx
import { DashboardSquare01Icon, Logout01Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { Logo } from '../components/logo';
import { logout, switchTenant } from '../lib/session';
import { useSession } from '../lib/session-store';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

// একাধিক টেন্যান্টে থাকলে native <select>: কিবোর্ড, স্ক্রিন রিডার, মোবাইল পিকার সব বিনা খরচে
function TenantSwitcher() {
  const me = useSession((state) => state.me);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!me) return null;

  const tile = (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand text-[12.5px] font-semibold text-brand-ink">
      {initials(me.tenant.name)}
    </span>
  );

  if (me.memberships.length < 2) {
    return (
      <div className="flex items-center gap-2.5 rounded-control border border-line px-2.5 py-2">
        {tile}
        <span className="min-w-0">
          <span className="block truncate text-body-sm font-medium">{me.tenant.name}</span>
          <span className="block truncate text-caption text-ink-3">
            {me.tenant.slug}.omnivo.app
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <label className="relative flex items-center gap-2.5 rounded-control border border-line-strong px-2.5 py-2 shadow-sm transition-colors duration-150 hover:bg-subtle focus-within:border-brand focus-within:shadow-ring">
        {tile}
        <span className="sr-only">Switch workspace</span>
        <select
          value={me.tenant.id}
          disabled={switching}
          onChange={(event) => {
            setSwitching(true);
            setFailed(false);
            // ব্যর্থ হলে store বদলায় না, তাই select আগের workspace-এই থাকে
            switchTenant(event.target.value)
              .catch(() => {
                setFailed(true);
              })
              .finally(() => {
                setSwitching(false);
              });
          }}
          className="min-w-0 flex-1 appearance-none truncate bg-transparent pr-6 text-body-sm font-medium outline-none"
        >
          {me.memberships.map((membership) => (
            <option key={membership.tenantId} value={membership.tenantId}>
              {membership.name}
            </option>
          ))}
        </select>
        <HugeiconsIcon
          icon={UnfoldMoreIcon}
          size={16}
          strokeWidth={1.5}
          className="pointer-events-none absolute right-2.5 text-ink-3"
        />
      </label>
      {failed && (
        <p role="alert" className="px-1 text-caption text-crit">
          Couldn&apos;t switch workspace. Try again.
        </p>
      )}
    </div>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const status = useSession((state) => state.status);
  const me = useSession((state) => state.me);

  // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
  useEffect(() => {
    if (status === 'signed-out') void navigate({ to: '/login' });
  }, [status, navigate]);

  return (
    <div className="min-h-dvh min-[860px]:grid min-[860px]:grid-cols-[244px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-5 border-b border-line bg-surface px-4 py-3 min-[860px]:sticky min-[860px]:top-0 min-[860px]:h-dvh min-[860px]:border-r min-[860px]:border-b-0 min-[860px]:px-3 min-[860px]:py-5">
        <div className="flex items-center justify-between px-2">
          <Logo />
          {/* ফোনে সাইডবার নেই, তাই sign out উপরের বারে */}
          <button
            type="button"
            aria-label="Sign out"
            onClick={() => {
              void logout();
            }}
            className="grid place-items-center rounded-lg p-2 text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink min-[860px]:hidden"
          >
            <HugeiconsIcon icon={Logout01Icon} size={18} strokeWidth={1.5} />
          </button>
        </div>
        <TenantSwitcher />
        <nav aria-label="Main" className="grid gap-px">
          <Link
            to="/"
            className="flex items-center gap-2.5 rounded-lg bg-brand-soft px-2.5 py-2 text-[14px] font-medium text-brand"
          >
            <HugeiconsIcon icon={DashboardSquare01Icon} size={18} strokeWidth={1.5} />
            Overview
          </Link>
        </nav>
        <div className="mt-auto hidden border-t border-line pt-4 min-[860px]:block">
          <p className="truncate px-2 text-body-sm font-medium">{me?.user.fullName}</p>
          <p className="truncate px-2 text-caption text-ink-3">{me?.user.email}</p>
          <button
            type="button"
            onClick={() => {
              void logout();
            }}
            className="mt-3 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium text-ink-2 transition-colors duration-150 hover:bg-subtle"
          >
            <HugeiconsIcon icon={Logout01Icon} size={18} strokeWidth={1.5} className="text-ink-3" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="px-4 py-6 min-[860px]:px-8 min-[860px]:py-8">
        <Outlet />
      </main>
    </div>
  );
}
```

**কোন অংশ কেন:**

- লেআউট CLAUDE.md থেকে: ২৪৪px সাইডবার + বাকি জায়গা; ৮৬০px-এর নিচে সাইডবার উপরের বারে চলে যায়। active
  nav item `brand-soft` পটভূমি আর `brand` লেখা/আইকন।
- **TenantSwitcher:**
  - একটাই workspace হলে switcher না, শুধু নাম আর ঠিকানা দেখানো — বাছার কিছু না থাকলে dropdown অর্থহীন।
  - দুই বা তার বেশি হলে native `<select>` — কিবোর্ড, স্ক্রিন রিডার আর মোবাইলের নিজস্ব picker কোনো
    বাড়তি কোড ছাড়াই পাওয়া যায়। design system-এ এখনো কোনো dropdown/menu component নেই (ধাপ ৪)।
  - `value={me.tenant.id}` controlled — switch ব্যর্থ হলে store বদলায় না, তাই select নিজে থেকেই আগের
    workspace-এ ফিরে যায়, আর নিচে error দেখায়।
  - `<span className="sr-only">Switch workspace</span>` — চোখে দেখা যায় না, কিন্তু select-এর label
    হিসেবে স্ক্রিন রিডার পড়ে।
- **Sign out দুই জায়গায়:** ডেস্কটপে সাইডবারের নিচে, ফোনে উপরের বারে আইকন-বাটন। ব্রাউজার টেস্টে ধরা পড়া
  bug: প্রথম সংস্করণে sign-out-এর অংশ ৮৬০px-এর নিচে লুকানো ছিল, ফলে ফোনে লগআউটের কোনো উপায়ই ছিল না।
- `useEffect` + `status === 'signed-out'` → `/login` — ড্যাশবোর্ডে বসে থাকা অবস্থায় session শেষ হলে (অন্য
  ট্যাবে logout, reuse ধরা পড়া) `api.ts` store-এ `signed-out` বসায়; এখানে সেটা দেখে লগইন পেজে পাঠানো।

**ফাইল: `apps/app/src/routes/dashboard.tsx`** (নতুন ফাইল)

```tsx
import { CheckmarkCircle02Icon, UserMultipleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { memberListResponseSchema, type MemberListResponse } from '@omnivo/contracts';
import { useEffect, useState } from 'react';

import { apiFetch } from '../lib/api';
import { formatDate } from '../lib/format';
import { useSession } from '../lib/session-store';

function MembersCard({ tenantId }: { tenantId: string }) {
  const [members, setMembers] = useState<MemberListResponse['members'] | null>(null);
  const [failed, setFailed] = useState(false);

  // tenantId বদলালে (switcher) আবার আনা; পুরনো request-এর উত্তর দেরিতে এলে ফেলে দেওয়া
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    apiFetch('/members', memberListResponseSchema).then(
      (response) => {
        if (!cancelled) setMembers(response.members);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  return (
    <section className="rounded-card border border-line bg-surface shadow-sm">
      <header className="px-5 pt-[18px]">
        <h3 className="text-h3">Team</h3>
        <p className="text-label text-ink-3">People with access to this workspace</p>
      </header>
      {failed && (
        <p className="px-5 pt-3 text-body-sm text-crit">
          Couldn&apos;t load your team. Refresh the page to try again.
        </p>
      )}
      <ul className="mt-3 divide-y divide-line border-t border-line">
        {(members ?? []).map((member) => (
          <li key={member.membershipId} className="flex items-center gap-3 px-5 py-3">
            <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand">
              {member.fullName.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body-sm font-medium">{member.fullName}</span>
              <span className="block truncate text-caption text-ink-3">{member.email}</span>
            </span>
            <span className="text-caption text-ink-2">{member.roles.join(', ') || 'No role'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DashboardPage() {
  const me = useSession((state) => state.me);
  if (!me) return null;

  // UI-তে permission দেখে লুকানো শুধু সুবিধা; আসল পাহারা API-র PermissionGuard
  const canSeeTeam = me.permissions.includes('core.user.read');

  return (
    <div className="grid max-w-5xl gap-5">
      <header>
        <h1 className="text-h1">Overview</h1>
        <p className="mt-1 text-label text-ink-3">
          {me.tenant.name} · {formatDate(new Date())}
        </p>
      </header>

      <section className="rounded-card border border-line bg-surface p-8 text-center shadow-sm">
        <span className="mx-auto grid size-[52px] place-items-center rounded-full bg-good-bg text-good">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={26} strokeWidth={1.5} />
        </span>
        <h2 className="mt-4 text-h2">Your workspace is ready</h2>
        <p className="mx-auto mt-2 max-w-md text-ink-2">
          Next, set up your chart of accounts and invite your accountant. Buyer POs, LCs and stock
          will show up here once you start recording them.
        </p>
      </section>

      {canSeeTeam ? (
        <MembersCard tenantId={me.tenant.id} />
      ) : (
        <p className="flex items-center gap-2 text-body-sm text-ink-3">
          <HugeiconsIcon icon={UserMultipleIcon} size={16} strokeWidth={1.5} />
          Ask a workspace owner for the core.user.read permission to see your team.
        </p>
      )}
    </div>
  );
}
```

- "Overview" (`text-h1`), নিচে workspace আর আজকের তারিখ (`formatDate`)।
- খালি অবস্থার কার্ড — CLAUDE.md: empty state-এ শিল্পের আসল উদাহরণ ("Buyer POs, LCs and stock"),
  lorem ipsum না।
- `MembersCard` — `/members`-এর প্রথম ব্যবহারকারী; টেবিল-সারির নিয়মে ৩০px avatar টাইল (`brand-soft` +
  `brand` আদ্যক্ষর), নাম আর নিচে `ink-3` রঙে ইমেইল।
  - `cancelled` ফ্ল্যাগ — workspace বদলালে পুরনো workspace-এর দেরিতে আসা উত্তর যেন নতুনটার ওপর না বসে।
  - `tenantId` dependency — switch করলে আবার আনা।
  - ব্যর্থ হলে লাল লেখা, unhandled promise rejection না।
- `canSeeTeam` — `me.permissions`-এ `core.user.read` না থাকলে কার্ড না দেখিয়ে কী করতে হবে তা বলা। **UI-তে
  লুকানো শুধু সুবিধার জন্য; আসল পাহারা API-র `PermissionGuard`।** কেউ UI বাইপাস করে সরাসরি `/members`
  ডাকলে তবুও 403 পাবে।

**ফাইল: `apps/app/src/router.tsx`** (নতুন ফাইল)

```tsx
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';

import { restoreSession } from './lib/session';
import { sessionStore } from './lib/session-store';
import { AppShell } from './routes/app-shell';
import { DashboardPage } from './routes/dashboard';
import { LoginPage } from './routes/login';
import { SignUpPage } from './routes/sign-up';

const rootRoute = createRootRoute({ component: Outlet });

// লগইন করা ইউজার /login বা /sign-up-এ এলে সোজা ড্যাশবোর্ডে
async function redirectIfSignedIn(): Promise<void> {
  await restoreSession();
  if (sessionStore.getState().status === 'signed-in') {
    throw redirect({ to: '/' });
  }
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: redirectIfSignedIn,
  component: LoginPage,
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-up',
  beforeLoad: redirectIfSignedIn,
  component: SignUpPage,
});

// pathless layout route: এর নিচের সব পেজ protected, আর সবগুলো AppShell-এর ভেতরে
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async () => {
    await restoreSession();
    if (sessionStore.getState().status !== 'signed-in') {
      throw redirect({ to: '/login' });
    }
  },
  component: AppShell,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: DashboardPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signUpRoute,
  appRoute.addChildren([dashboardRoute]),
]);

export const router = createRouter({ routeTree });

// <Link to="…"> আর navigate({ to }) এখন route tree থেকে টাইপ পায় — ভুল path compile error
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
```

**কোন লাইন কেন:**

- `createRootRoute({ component: Outlet })` — root-এ কোনো লেআউট নেই, কারণ লগইন পেজ আর অ্যাপের লেআউট পুরো
  আলাদা।
- `redirectIfSignedIn` — লগইন করা ইউজার `/login`-এ এলে সোজা ড্যাশবোর্ডে। `/login` আর `/sign-up` দুটোতেই
  একই ফাংশন।
- `appRoute`-এ `id: 'app'`, `path` না — "pathless layout route": URL-এ কিছু যোগ করে না, কিন্তু নিচের
  সব পেজকে একই `beforeLoad` (লগইন বাধ্যতামূলক) আর একই `AppShell`-এর ভেতরে রাখে। নতুন protected পেজ মানে
  শুধু `appRoute`-এর child হিসেবে যোগ করা।
- `beforeLoad`-এ `await restoreSession()` তারপর status — reload-এর পর cookie দিয়ে session ফেরত আসা
  পর্যন্ত route অপেক্ষা করে, তাই লগইন করা ইউজার ভুল করে লগইন পেজে যায় না।
- `throw redirect(...)` — TanStack Router-এর রীতি; ESLint-এর ছাড় ৩.৯-এ।
- `declare module '@tanstack/react-router' { interface Register { router: typeof router } }` — এটাই
  code-based routing-এ টাইপ-নিরাপত্তা দেয়: `<Link to="/sigup">`-এর মতো ভুল path compile error।

**ফাইল: `apps/app/src/main.tsx`** (আপডেট — পুরোটা এভাবে)

```tsx
import './styles.css';

import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { router } from './router';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

- `import './styles.css'` সবার আগে — Tailwind আর font কোনো component render হওয়ার আগেই লোড হয়।
- `<App />` → `<RouterProvider router={router} />`। `StrictMode` থাকছে — dev-এ effect দুবার চালিয়ে bug
  ধরে; আর `restoreSession`-এর একবার-চলা promise ঠিক এই কারণেই।

**ফাইল: `apps/app/src/App.tsx`** — **মুছে ফেলুন।**

---

## ৩.১১ — রান করুন

```bash
pnpm install                 # lockfile আপডেট
pnpm dedupe --check          # drizzle-orm-এর একটাই কপি?
pnpm db:up                   # Postgres + Valkey (cache) + Mailpit + MinIO
pnpm db:migrate              # 0005, 0006 + permissions sync
pnpm dev                     # API :3000, app :5173, আর তিন প্যাকেজের tsc --watch
```

(`.env`-এ ৩.৪-এর নতুন লাইন না থাকলে API চালুর সময়েই থামবে আর বলবে
`Invalid environment — compare your .env with .env.example`, সাথে কোন ভেরিয়েবল নেই।)

### যা দেখবেন

1. `http://localhost:5173` খুলুন → নিজে থেকেই `/login`-এ যাবে।
2. "Create a workspace" → কোম্পানির নাম লিখলে ঠিকানা নিজে থেকে বসে → "Create workspace" → 🎉 ড্যাশবোর্ড:
   "Overview", আপনার workspace, আর "Team" কার্ডে আপনি **Owner**।
3. পেজ reload করুন → লগইন অবস্থাই থাকবে। DevTools → Network-এ ঠিক একটা `POST /auth/refresh`।
4. DevTools → Application:
   - Cookies (`http://localhost:3000`) → `omnivo_rt`: HttpOnly ✓, SameSite Strict, Path `/auth`।
   - Local Storage → খালি (টোকেন শুধু memory-তে)।
5. Sign out → আবার "Sign in", Workspace-এ আপনার ঠিকানা (যেমন `rahman-garments`) লিখে লগইন।
6. ভুল পাসওয়ার্ড দিন → ফর্মের উপরে লাল বার্তা; ফাঁকা ফর্ম জমা দিন → প্রতিটা ফিল্ডের নিচে বার্তা।
7. DevTools-এর device toolbar-এ ৩৯০px চওড়া → সাইডবার উপরে চলে আসে, পাশে sign-out আইকন, আড়াআড়ি scroll
   নেই। OS dark mode চালু করলে সব dark।
8. Permission cache চোখে দেখা:

   ```bash
   docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli --scan --pattern 't:*'
   # → t:<tenant-id>:perm:<user-id>
   docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli ttl 't:<tenant-id>:perm:<user-id>'
   # → ৬০০-এর নিচের কোনো সংখ্যা
   ```

9. পাসওয়ার্ড কোথায় আছে (`pnpm db:psql`):

   ```sql
   SELECT u.email, a.provider_id, length(a.password) FROM users u JOIN accounts a ON a.user_id = u.id;
   ```

   পাসওয়ার্ড না, একটা লম্বা hash — আর `users`-এ `password_hash` কলাম আর নেই।

---

## যাচাইয়ের তালিকা

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # ১৬টা: contracts ৩ + auth ৭ + api middleware ৬ — Docker লাগে না
pnpm test:integration        # ১৯টা — Docker চালু থাকতে হবে
pnpm test:tenant-leak        # ৯টা: ধাপ ২-এর ৬ + HTTP-স্তরের ৩
pnpm build
pnpm boundaries
```

শেষে [build-plan.bn.md](build-plan.bn.md)-এর "৯. অগ্রগতি"-তে ধাপ ২ আর ধাপ ৩ টিক দিন। চাইলে
[COMMANDS.md](../COMMANDS.md)-এর "Database" অংশে `db:migrate`-এর পাশে লিখে রাখুন যে এটা এখন permission-ও
sync করে, আর উপরের `valkey-cli` কমান্ড দুটো যোগ করুন।

---

## পরের ধাপগুলোর জন্য রেখে যাওয়া নোট

**ধাপ ৪ (`packages/ui`):**

- `apps/app/src/styles.css` আর `components/` (Logo, Button, TextField, FormAlert) `packages/ui`-এ সরবে।
- সঠিক `Checkbox` (১৭px, ৫px কোণ, checked-এ `brand`), dropdown/menu (tenant switcher-এর জন্য), Toast।
- ফোনে সাইডবারের nav আড়াআড়ি (CLAUDE.md), এখন একটাই item তাই উল্লম্ব।
- favicon নেই — ব্রাউজার console-এ `/favicon.ico` 404 দেখায় (ক্ষতিকর না)।
- লগইনের ডান প্যানেলের ড্যাশবোর্ড-preview কার্ড।

**CLAUDE.md-এ যা ঠিক করা হয়েছে** (২০২৬-০৯-২৭, "If something is missing, extend this section first" নিয়মে):

- rule ৪: প্যাকেজ `hugeicons-react` → `@hugeicons/react` + `@hugeicons/core-free-icons`।
- Typography: font stack-এ `"Geist"` → `"Geist Variable"`, `"Geist Mono"` → `"Geist Mono Variable"`
  (fontsource-variable-এর রেজিস্টার করা নাম)।
- Tailwind wiring: `--shadow-sm/md/lg`, `--shadow-ring`, `--shadow-ring-crit`, `--radius-panel` আর
  টাইপ স্কেলের `--text-*` token যোগ।

**নিরাপত্তা — beta-র আগে (ADR 0002 "Consequences"):**

- **লগইন আর সাইনআপে rate limit** — এখন নেই। Valkey-তে IP + ইমেইল ধরে গণনা (system-design §৪.৬-এর
  token bucket)। Better Auth-এর নিজস্ব rate limit শুধু তার HTTP handler-এ কাজ করে, যেটা আমরা ব্যবহার করি
  না।
- **ইমেইল যাচাই আর পাসওয়ার্ড রিসেট** — ধাপ ৮-এ Mailpit-এর সাথে (`verifications` টেবিল তৈরি)।
- **`accounts.password` hash `omnivo_app` পড়তে পারে** (ধাপ ২-এর শেষ নোটের প্রশ্ন)। পাসওয়ার্ড যাচাই API-র
  কাজ, তাই পড়তে হয়ই; আলাদা `omnivo_auth` DB role আর আলাদা connection pool দিলে সাধারণ query কখনো hash
  দেখত না। দাম: দ্বিতীয় pool। beta-র security review-এ সিদ্ধান্ত নিন।
- **ব্যবহৃত refresh token-এর রো জমতে থাকে** (সক্রিয় ইউজারের প্রতি ১৫ মিনিটে একটা)। ধাপ ৮-এর worker-এ
  দৈনিক job: মেয়াদোত্তীর্ণ session মুছলে cascade-এ তাদের টোকেনও যায়।
- **access token ১৫ মিনিট পর্যন্ত বাতিল করা যায় না** — লগআউটের পরেও চুরি হওয়া access token মেয়াদ শেষ
  পর্যন্ত চলে। তাৎক্ষণিক বাতিল লাগলে Valkey-তে `jti`-এর blocklist (টোকেনে `jti` আগে থেকেই আছে)।
- **Production:** app আর API একই site-এ রাখতে হবে (যেমন `app.omnivo.app` আর `api.omnivo.app`) —
  আলাদা domain-এ `SameSite=Strict` cookie যাবেই না। প্রতিটা environment-এ আলাদা `BETTER_AUTH_SECRET` আর
  `JWT_SECRET` (`openssl rand -base64 32`), `NODE_ENV=production` (তাতে `Secure` cookie চালু হয়)।

**অন্য ধাপের সাথে জোড়া:**

- ধাপ ৬: audit log-এ লগইন, সাইনআপ, টেন্যান্ট switch আর reuse ধরা পড়ার ঘটনা লেখা।
- ধাপ ৭: রোল বা permission বদলানোর প্রতিটা কোড `PermissionService.invalidate(tenantId, userId)` ডাকবে —
  নাহলে সর্বোচ্চ ১০ মিনিট পুরনো অধিকার চলবে। invite-এর পর নতুন সদস্য `/auth/login`-এ ওই workspace দিয়ে
  ঢুকবে।
- ধাপ ৮: onboarding wizard (Industry → Modules → Fiscal year) সাইনআপের পরে; `provisionWorkspace` তখন
  idempotent job-এ সরবে।
