# Step 8: Queue, worker and outbox — background jobs, onboarding wizard, notifications

> The implementation guide for "Phase 2 → Step 8" of [build-plan.bn.md](build-plan.bn.md): which file gets what
> code, and which command runs where.
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `f5b98c4`, the end of
> step 7) and checked on 2026-09-30: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`,
> `pnpm test` (98 — 3 new), `pnpm test:integration` (101 — 23 new), `pnpm test:tenant-leak` (26 — 8 new),
> `pnpm build`, `pnpm test:bundle-size` (first load 171.4 KB gz, budget 200), `pnpm gen:openapi` (37 paths),
> `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 34 — 4 new, desktop and 390px, three
> runs in a row) — all pass, with the turbo cache cleared.
>
> Also checked by hand:
>
> - **The real processes.** Fresh Postgres, Valkey, Mailpit and MinIO containers on other ports, `pnpm db:migrate`,
>   then `node dist/main.js` and `node dist/worker.js` as two processes. Sign-up → the welcome email in Mailpit;
>   `POST /setup` → `provisioning` → `ready` in under a second, with the garments roles. The worker stopped with
>   SIGTERM in 0.2 s. With the worker **stopped**, an invitation was still created (201), its outbox row waited,
>   and when the worker started again the email went out and the invitation turned `sent`.
> - **Every guard test broken on purpose.** Remove the job id → the relay test fails. Remove the `REVOKE` → the
>   outbox leak test fails. Remove the relay's policy → the leak test fails. Remove the "already ready" check from
>   the setup job → the "runs twice" test fails. Remove the user filter from notifications → four tests fail.
>   Never call `onGiveUp` → the "mail server down" test fails. Remove the `emit()` from `create` → eleven
>   invitation tests fail.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database. Your database volume is older
> than the new `omnivo_worker` role: **you must create that role by hand before `pnpm db:migrate`** (8.16), or
> migration 0012 stops with `role "omnivo_worker" does not exist`. (2) A real SMTP server (only Mailpit).
> (3) The new tests on GitHub Actions. (4) `turbo run dev dev:worker` as one command. Each half was run on its
> own (`nest start --watch` for the API, and `nest start --watch --entryFile worker --path tsconfig.worker.json`
> for the worker), but not the two together through turbo.

## Goal

⚙️ **Work that happens after the click.** Until step 7, everything happened inside the HTTP request: sign-up
created everything, and an invitation's email went out before the "Invite" button stopped spinning. If the mail
server was slow, the button was slow. If it was down, the email was lost, and a person had to press "Resend".

After this step:

- **A second process, the worker.** Same code base, same build, its own entry point (`node dist/worker.js`). It
  runs jobs from two BullMQ queues on Valkey: `email` and `jobs`.
- **The transactional outbox.** The API never talks to the queue. It writes an `outbox_events` row **in the same
  transaction** as the change. A relay in the worker moves committed rows onto the queue. Nothing is sent for a
  change that rolled back, and nothing is lost when a process dies right after a commit.
- **Emails from the worker, with retries.** The invitation email and a new welcome email. A failed send is tried
  again after 2, 4, 8 and 16 seconds. After the last try the team page shows "Email not sent", and the person who
  sent it gets a notification. The invitation link's token is made by the worker, right before sending, so it
  never sits in the outbox or in Redis.
- **An idempotent setup job.** A new workspace starts `pending`. The onboarding wizard asks for the business type
  (garments, pharma, distribution…). The job then creates the roles such a company usually needs. It is safe to
  run twice. In step 9 it also creates the chart of accounts.
- **The onboarding wizard.** Business type → company details → invite your team. It shows the job's status live
  ("Preparing the roles for Garments & textiles…" → "Roles ready: Accountant, Merchandiser, Store keeper").
- **In-app notifications.** A bell next to the logo, with an unread count: "Nasrin Akter joined the workspace",
  "The invitation email to … couldn't be sent", "Your workspace is set up". Each one is stored as a type plus a
  few values, so it shows in the reader's own language.

## The whole picture

```
packages/contracts   setup (INDUSTRIES, SETUP_STATUSES, /setup) · notifications (types, /notifications)
      │               invitation.delivery ('sending' | 'sent' | 'failed') instead of sentAt
      │               me.tenant.setupStatus · 2 audit actions · 2 error codes
      ▼
packages/db          outbox_events (tenant RLS + omnivo_worker's relay policy; omnivo_app may only INSERT)
                     notifications (tenant RLS, unique (tenant, event, user) = idempotent)
                     tenants.industry + tenants.setup_status · invitations.token_hash NULL-able + send_failed_at
                     migration 0011 (drizzle) + 0012 (RLS, grants, backfill) · init: CREATE ROLE omnivo_worker
      │
      ▼
apps/api (API)       emit(tx, type, payload) — the ONLY way to hand work to the worker
                     SetupModule (/setup)  NotificationsModule (/notifications)  no SMTP, no queue any more
apps/api (worker)    src/worker.ts → WorkerModule
                     OutboxRelay ── omnivo_worker ── SELECT … FOR UPDATE SKIP LOCKED → BullMQ addBulk (jobId = row id)
                     JobRunner ── 2 queues (email, jobs) → handler by event type, in the event's tenant context
                     handlers: WelcomeEmail · InvitationEmail · Provisioning · MemberJoined  (+ hourly outbox cleanup)
      │
      ▼
apps/app             /onboarding (Stepper + SelectableCardGroup)   NotificationBell (polls every 30 s)
                     team page: "Sending" → "Sent" / "Email not sent" (polls every 2 s while sending)

one invitation, from click to inbox:
  admin ──POST /invitations──► API tx: invitation (no token) + invitation_roles + audit + outbox row → commit → 201 "sending"
  worker relay (≤ 1 s later): claims the row (SKIP LOCKED) → email queue (jobId = row id) → marks it published
  worker job: tx 1: make token, store its hash → SMTP → tx 2: sent_at (only if the hash is still ours)
    fails? retried after 2, 4, 8, 16 s → last try failed → send_failed_at + notification to the sender
  team page polls every 2 s while "sending" → "Sent"
```

## The decisions behind this step

1. **The worker is a second entry point of `apps/api`, not a separate `apps/worker` package.** (You chose this,
   2026-09-30.) The build plan says `apps/worker/`, but the worker needs `MailService`, `audit()`, `withTenant`,
   the tenant context and the contracts — everything already in `apps/api`. A separate package would first need a
   shared server package and a large move of imports. Now it is the usual modular-monolith shape (like Rails and
   Sidekiq): one code base, one Docker image, two commands (`node dist/main.js`, `node dist/worker.js`). They
   still scale, restart and fail separately.
2. **The worker makes the invitation token.** (You chose this.) Step 7's note planned an encrypted token in the
   outbox. Instead, the API stores the invitation without a token (`token_hash` NULL). The worker makes the token
   right before sending and stores only its hash. So nothing secret is in the outbox, in Redis or in a backup, and
   there is no encryption key to manage or rotate. The cost: if the worker dies **after** the mail server took
   the email but before it marks the job done, the retry sends a second email, and the first link stops working.
   That is rare, and the fix is simple (use the newest email).
3. **Sign-up stays small and synchronous; the industry template is a job.** (You chose this.) Sign-up still
   creates the tenant, the owner membership and role, the settings row and the head-office branch in one
   transaction, so the owner can sign in at once and every page finds what it expects. What depends on the
   business type (roles now, the chart of accounts in step 9) comes from a background job after the wizard's
   first step.
4. **Notifications arrive by polling, every 30 seconds.** (You chose this.) No open connection per tab, nothing new
   to run, and it works behind any proxy. Polling stops while the tab is hidden and runs at once when you come
   back. Server-Sent Events can replace it later without changing the table or the API.
5. **The API never touches the queue.** It only calls `emit()`, inside its transaction. A job put on the queue
   from a request could run before the transaction commits (and not find its data), or be sent for a change that
   later rolled back. A new dependency-cruiser rule makes this a CI error: only `src/worker/` may import `bullmq`.
6. **The relay has its own database role, `omnivo_worker`.** It must read the outbox of **every** tenant, which
   tenant RLS forbids by design. A policy `TO omnivo_worker USING (true)` on `outbox_events` only gives it
   exactly that. It has no rights on any other table, and the jobs themselves still run as `omnivo_app` with a
   tenant context, like the API. The API's role may only **insert** into the outbox (`REVOKE SELECT, UPDATE,
   DELETE`).
7. **Every handler is idempotent, because a job can run twice.** BullMQ delivers "at least once": a crash after
   the work but before the "done" mark re-runs the job. The setup job locks the tenant row and stops if the status
   is already `ready`. The invitation job stops if `sent_at` is set. Notifications have a unique index on
   (tenant, event, user). The job id is the outbox row id, so a row published twice becomes one job.
8. **Payloads carry ids only.** `{ invitationId, actorUserId }`, never an email address or a name. The handler
   reads the current rows when it runs. So a payload cannot go stale, and no personal data sits in Redis.
9. **Retries: 5 attempts, exponential, from 2 seconds** (2, 4, 8, 16 s — about 30 s in all). Long enough to ride
   out a mail server restart, short enough that "Email not sent" shows up while the admin still looks at the page.
   A `PermanentJobError` (broken data) skips the rest of the retries.
10. **A failure ends where a person sees it.** Each handler can have an `onGiveUp`, which runs once after the last
    attempt: the invitation gets `send_failed_at` plus a notification to its sender; the setup turns `failed`, and
    the wizard offers "Try again".
11. **The worker keeps the request id.** The outbox row stores the id of the request that caused it. The worker
    runs the job inside that id, so its audit rows carry it too. One click can be followed from the request to
    everything that happened in the background.
12. **Notifications are a type plus values.** `member.joined` + `{ name: 'Nasrin Akter' }`, never a sentence. The
    app writes the sentence in the reader's language. That is the same rule as error codes (step 5).
13. **The business type is picked once.** Changing it later would mean undoing a template — roles now, and in
    step 9 a chart of accounts that may already have posted entries. So `POST /setup` works only while the status
    is `pending`. After a failure, `POST /setup/retry` runs the same job again.

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| A queue dashboard (Bull Board, Taskforce) | An operations tool, with its own login. Step 25, with observability. Until then: the worker's log, `valkey-cli` (8.16) and the `outbox_events` table |
| Server-Sent Events / WebSocket for the bell | Decision 4. Polling is enough for "someone joined" |
| Per-tenant job limits (noisy neighbour, system-design §4.6) | No heavy jobs yet. With the first import or big report (steps 11, 12) |
| A rate limit on the email queue | Mailpit has none. With the real mail provider (step 25): BullMQ's `limiter` on the `email` worker |
| Changing the business type after setup | Decision 13. A support task |
| The chart of accounts in the template | Step 9 adds it to `INDUSTRY_TEMPLATES` and to the setup job |
| Email notifications, notification settings | Only in-app now. With the first email-worthy events (overdue invoice, step 15) |
| Deleting old notifications | A few per person per week. A cleanup job like the outbox's when it matters |
| Choosing modules in the wizard | Billing and entitlements come in step 24 |
| The welcome email in the sign-up language | Sign-up does not send the page's language yet; the email uses the account's language, which is still empty, so English |

## What changes in the code you already have

- **Your dev database needs a new role before migrating**: `omnivo_worker` (8.16). The init script only runs on a
  new, empty volume.
- **`.env` needs a new line**: `WORKER_DATABASE_URL`. Without it the worker stops at start with "Invalid
  environment". The API does not read it.
- **The API does not read `SMTP_URL` or `MAIL_FROM` any more.** They stay in `.env`, because the worker reads them.
- `MailService` moves out of the API's `InfraModule` into the `WorkerModule`. `send()` now **throws** when the
  mail server does not take the message (before: it returned `false`), because the throw is what makes the queue
  retry.
- `invitations.service.ts`: `deliver()` is gone. `create` and `resend` call `emit(tx, 'invitation.issued', …)`
  and answer at once with `delivery: 'sending'`. Resend sets `token_hash` to NULL, so the old link dies
  immediately. `join` emits `member.joined`.
- Contracts: `Invitation.sentAt` → `Invitation.delivery` (`'sending' | 'sent' | 'failed'`), and
  `me.tenant.setupStatus` is new.
- `auth.service.ts`: sign-up emits `workspace.created` (the welcome email). `me()` returns `setupStatus`.
- `mail/invitation-email.ts`: the HTML frame and `escapeHtml` move to the new `mail/layout.ts`, which the welcome
  email uses too.
- `apps/app`: the invite dialog (`InviteForm`, `useRoleOptions`) moves from `routes/team.tsx` to
  `components/invite-form.tsx`, because the wizard uses it as well. `toForm` moves from `routes/settings.tsx` to
  `lib/settings-form.ts`, for the same reason.
- The toasts change: "Invitation sent to …" → "Sending the invitation to …". The long `team.notSent` text is
  removed (the list shows "Email not sent" instead).
- The testing harness: `testConfig` has no `mailUrl` any more. There are new `testWorkerConfig`,
  `createTestWorker` and `eventually`, and a `workerUrl` in `startPostgres()`. Mailpit reading moves to
  `testing/mailpit.ts`.
- `.dependency-cruiser.cjs`: a bug fix. `exclude` dropped every `node_modules` package from the graph, so the
  rules that point at a package (`contracts-only-zod`) never fired (8.7).
- `pnpm dev` now runs `turbo run dev dev:worker`: API, app and worker together.

---

## 8.1 — `packages/contracts`: the contract

As in every step, the contract comes first: the API, the app, the mocks and the database all take their types
from here.

### Workspace setup

**File: `packages/contracts/src/setup.ts`** (new)

```ts
import { z } from 'zod';

import { defineRoute } from './http.js';

// The kinds of business Omnivo sets a workspace up for. The choice picks the starting roles now,
// and the chart of accounts from step 9. 'other' gets a small general set.
export const INDUSTRIES = [
  'garments',
  'pharma',
  'distribution',
  'manufacturing',
  'retail',
  'other',
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export function isIndustry(value: string): value is Industry {
  return INDUSTRIES.some((industry) => industry === value);
}

// pending      = the owner has not picked a business type yet (the app shows the wizard)
// provisioning = the background job is creating the starting data
// ready        = done
// failed       = the job gave up after its retries; the owner can retry
export const SETUP_STATUSES = ['pending', 'provisioning', 'ready', 'failed'] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

export const setupSchema = z.object({
  status: z.enum(SETUP_STATUSES),
  industry: z.enum(INDUSTRIES).nullable(),
});
export type Setup = z.infer<typeof setupSchema>;

export const startSetupInputSchema = z.object({ industry: z.enum(INDUSTRIES) });
export type StartSetupInput = z.infer<typeof startSetupInputSchema>;

export const setupRoutes = {
  // Any member may read it: the wizard polls it while the job runs
  get: defineRoute({
    method: 'GET',
    path: '/setup',
    summary: 'Where the workspace setup is: pending, provisioning, ready or failed',
    auth: 'bearer',
    status: 200,
    response: setupSchema,
  }),
  start: defineRoute({
    method: 'POST',
    path: '/setup',
    summary: 'Pick the business type and start the background setup job',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    body: startSetupInputSchema,
    response: setupSchema,
  }),
  retry: defineRoute({
    method: 'POST',
    path: '/setup/retry',
    summary: 'Run the setup job again after it failed',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    response: setupSchema,
  }),
};
```

- `INDUSTRIES` is the single list of business types. The database column, the API's templates
  (`Record<Industry, …>`), the wizard's icons and the translations are all tied to it by type. A new industry that
  is missing anywhere does not compile.
- `isIndustry()` exists for the one place where the value comes from outside TypeScript's view: the worker reads
  `tenants.industry` from the database, where it is plain text (8.5).
- `setupSchema` is an object, not only the status. The wizard needs the industry too, to say "Preparing the roles
  for **Garments & textiles**…".
- `GET /setup` has no permission, on purpose: any member may see whether setup is done, and the wizard polls it.
  Starting and retrying need `core.settings.manage`: choosing a template changes the whole workspace.
- Both `start` and `retry` answer with the new state (`provisioning`), not 202 with nothing. The wizard puts that
  answer in its cache and starts polling from there.

### Notifications

**File: `packages/contracts/src/notifications.ts`** (new)

```ts
import { z } from 'zod';

import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// Every kind of in-app notification. The server stores the type and a few values (params), never a
// sentence: the app turns them into text in the reader's language (notifications.types.* in en.ts).
export const NOTIFICATION_TYPES = [
  'workspace.ready',
  'member.joined',
  'invitation.failed',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: string): value is NotificationType {
  return NOTIFICATION_TYPES.some((type) => type === value);
}

// Values placed into the text, like {{name}}. Plain values only, the same rule as audit changes.
export const notificationParamsSchema = z.record(z.string(), z.union([z.string(), z.number()]));
export type NotificationParams = z.infer<typeof notificationParamsSchema>;

export const notificationSchema = z.object({
  id: z.uuid(),
  // z.string(), not an enum: a new type from a newer server must not break the parse in an older
  // offline client (the same rule as error codes and audit actions). The app narrows it with
  // isNotificationType() and skips types it does not know.
  type: z.string(),
  params: notificationParamsSchema,
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationPageSchema = pageOf(notificationSchema);
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const unreadCountSchema = z.object({ count: z.number().int().min(0) });

const notificationParamsPathSchema = z.object({ id: z.uuid() });

// No permission on any of these: everyone may read and clear their own notifications, and the
// server only ever touches rows of the signed-in user.
export const notificationRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/notifications',
    summary: "The signed-in user's notifications in this workspace, newest first",
    auth: 'bearer',
    status: 200,
    query: pageQuerySchema,
    response: notificationPageSchema,
  }),
  // The bell polls this every 30 seconds, so it is a tiny, separate call
  unreadCount: defineRoute({
    method: 'GET',
    path: '/notifications/unread-count',
    summary: 'How many notifications are unread',
    auth: 'bearer',
    status: 200,
    response: unreadCountSchema,
  }),
  markRead: defineRoute({
    method: 'POST',
    path: '/notifications/:id/read',
    summary: 'Mark one notification as read',
    auth: 'bearer',
    status: 204,
    params: notificationParamsPathSchema,
    response: z.void(),
  }),
  markAllRead: defineRoute({
    method: 'POST',
    path: '/notifications/read-all',
    summary: 'Mark every notification as read',
    auth: 'bearer',
    status: 204,
    response: z.void(),
  }),
};
```

- `type: z.string()` on the wire, but `NOTIFICATION_TYPES` in code: the same rule as error codes and audit
  actions. An offline PWA with an old build must not break its whole list because a newer server sent a type it
  does not know. The bell filters with `isNotificationType()` and skips the rest.
- `params` accepts only strings and numbers. A notification can never carry an object (a whole row, by mistake).
- `unreadCount` is its own tiny endpoint. The bell polls it every 30 seconds in every open tab, so it must not
  return 20 rows each time.
- `markRead` is `POST /notifications/:id/read`, not `PATCH` with a body. It has one meaning ("I read it") and it
  is idempotent: reading twice changes nothing.
- `list` reuses `pageQuerySchema`, so it is keyset-paginated like every other list.

### Invitations: `delivery` instead of `sentAt`

**File: `packages/contracts/src/invitations.ts`** (change)

```diff
@@ -18,14 +18,19 @@ export function invitationLink(appOrigin: string, token: string): string {
 // এক সপ্তাহ: সাপ্তাহিক ছুটি পেরিয়েও কাজ করে, আবার পুরনো ইমেইলে পড়ে থাকা লিংক চিরকাল খোলা থাকে না
 export const INVITATION_TTL_DAYS = 7;
 
+// Where the email is. The worker sends it after the request has finished (outbox, step 8):
+// sending = queued or being retried, sent = the mail server took it, failed = the worker gave up
+// after its retries. Resend starts again from sending.
+export const INVITATION_DELIVERIES = ['sending', 'sent', 'failed'] as const;
+export type InvitationDelivery = (typeof INVITATION_DELIVERIES)[number];
+
 export const invitationSchema = z.object({
   id: z.uuid(),
   email: z.string(),
   roles: z.array(roleRefSchema),
   // null = যিনি পাঠিয়েছিলেন তাঁর অ্যাকাউন্ট আর নেই
   invitedBy: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
-  // null = ইমেইল যায়নি (mail server বন্ধ ছিল) — UI "Not sent" দেখায়, "Resend" নতুন লিংক পাঠায়
-  sentAt: z.iso.datetime().nullable(),
+  delivery: z.enum(INVITATION_DELIVERIES),
   expiresAt: z.iso.datetime(),
   createdAt: z.iso.datetime(),
   version: z.number().int(),
```

- `sentAt: null` meant "not sent" in step 7, because the request knew the result before answering. Now the answer
  comes before the email, so null has two meanings: "still sending" and "gave up". `delivery` names the three
  states. The UI shows a different pill for each, and polls only while one is `sending`.
- The old field is removed, not kept next to the new one. Two fields for one fact can disagree.

### `/auth/me`: the setup status

**File: `packages/contracts/src/auth.ts`** (change)

```diff
@@ -3,6 +3,7 @@ import { z } from 'zod';
 import { errorCode } from './errors.js';
 import { defineRoute } from './http.js';
 import { preferencesSchema } from './preferences.js';
+import { SETUP_STATUSES } from './setup.js';
 
 // workspace-এর ঠিকানা হবে `{slug}.omnivo.app` — তাই DNS label-এর নিয়ম মানতে হবে
 const workspaceSlugFormat = z
@@ -87,7 +88,13 @@ export type AuthSession = z.infer<typeof authSessionSchema>;
 
 export const meResponseSchema = z.object({
   user: z.object({ id: z.uuid(), email: z.string(), fullName: z.string() }),
-  tenant: z.object({ id: z.uuid(), name: z.string(), slug: z.string() }),
+  // setupStatus: the app sends an owner to the onboarding wizard while it is 'pending'
+  tenant: z.object({
+    id: z.uuid(),
+    name: z.string(),
+    slug: z.string(),
+    setupStatus: z.enum(SETUP_STATUSES),
+  }),
   roles: z.array(z.string()),
   permissions: z.array(z.string()),
   memberships: z.array(z.object({ tenantId: z.uuid(), name: z.string(), slug: z.string() })),
```

- The router decides "wizard or dashboard" before any page loads. It already has `me` in memory (the session
  store), so the status rides along there. No extra request on every navigation.
- `z.enum` and not `z.string()`: this status is a closed state machine that only this code base moves. A new state
  would need a new UI anyway.

### Audit actions and error codes

**File: `packages/contracts/src/audit.ts`** (change)

```diff
@@ -7,6 +7,8 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // লেখা i18n-এর audit.actions.*-এ রাখে (en.ts-এর satisfies নতুন action-এর অনুবাদ ভুলতে দেয় না)
 export const AUDIT_ACTIONS = [
   'workspace.created',
+  'workspace.setup_started',
+  'workspace.provisioned',
   'auth.signed_in',
   'auth.switched_in',
   'settings.updated',
@@ -64,7 +66,7 @@ export const auditEntrySchema = z.object({
   action: z.string(),
   entityType: z.string(),
   entityId: z.uuid(),
-  // null = সিস্টেম নিজে (পরে ধাপ ৮-এর background job)
+  // null = the system itself: a background job in the worker (step 8)
   actor: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
   changes: auditChangesSchema,
   ipAddress: z.string().nullable(),
```

- `workspace.setup_started` is the owner's click (actor = the owner). `workspace.provisioned` is the job's work
  (actor = null, shown as "System"). Two rows, because they are two moments by two actors — and the pair shows how
  long the job took.
- The comment about `actor: null` said "later, step 8's background job". That is now true, so it says so.

**File: `packages/contracts/src/errors.ts`** (change)

```diff
@@ -54,6 +54,9 @@ export const ERROR_CODES = [
   'last_owner',
   'own_membership',
   'role_in_use',
+  // workspace setup (onboarding)
+  'setup_started',
+  'setup_not_failed',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- `setup_started`: `POST /setup` when the status is not `pending` (someone already started it).
- `setup_not_failed`: `POST /setup/retry` when there is nothing to retry. The wizard shows the button only after a
  failure, so a person meets these only with two tabs open.

### Registry and exports

**File: `packages/contracts/src/routes.ts`** (change)

```diff
@@ -7,10 +7,12 @@ import { branchRoutes } from './branches.js';
 import { defineRoute } from './http.js';
 import { invitationRoutes } from './invitations.js';
 import { memberRoutes } from './members.js';
+import { notificationRoutes } from './notifications.js';
 import { numberSeriesRoutes } from './numbering.js';
 import { meRoutes } from './preferences.js';
 import { roleRoutes } from './roles.js';
 import { settingsRoutes } from './settings.js';
+import { setupRoutes } from './setup.js';
 
 export const healthRoutes = {
   check: defineRoute({
@@ -37,4 +39,6 @@ export const routes = {
   numberSeries: numberSeriesRoutes,
   audit: auditRoutes,
   attachments: attachmentRoutes,
+  setup: setupRoutes,
+  notifications: notificationRoutes,
 };
```

**File: `packages/contracts/src/index.ts`** (change)

```diff
@@ -7,6 +7,7 @@ export * from './fields.js';
 export * from './http.js';
 export * from './invitations.js';
 export * from './members.js';
+export * from './notifications.js';
 export * from './numbering.js';
 export * from './pagination.js';
 export * from './permissions.js';
@@ -14,3 +15,4 @@ export * from './preferences.js';
 export * from './roles.js';
 export * from './routes.js';
 export * from './settings.js';
+export * from './setup.js';
```

- The API's `contract.spec.ts` checks that Nest's routes and this registry match exactly. Registering the routes
  here without the controllers (or the other way round) fails `pnpm test`.

---

## 8.2 — `packages/db`: tables, migrations, a new role

### New tenant columns

**File: `packages/db/src/schema/tenants.ts`** (whole file)

```ts
import { INDUSTRIES, SETUP_STATUSES } from '@omnivo/contracts';
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';

export const tenants = pgTable(
  'tenants',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    deletedAt: baseColumns().deletedAt,
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    // Picked once in the onboarding wizard; NULL until then. It chooses the starting template.
    industry: text('industry', { enum: INDUSTRIES }),
    // The tenant lifecycle's first stage (system-design §4.7). Here, not in tenant_settings:
    // settings is the company profile the owner edits; this is state the system moves forward.
    setupStatus: text('setup_status', { enum: SETUP_STATUSES }).notNull().default('pending'),
  },
  (table) => [uniqueIndex('tenants_slug_idx').on(table.slug)],
);
```

- On `tenants`, not on `tenant_settings`. Settings is the company profile the owner edits, with a `version` for
  optimistic locking. The setup status is moved by the system. Keeping it out of settings means the job never
  bumps the settings' version, so it never causes a "someone else saved changes" conflict in an open settings
  form.
- `tenants` has no RLS (sign-in reads it before any tenant is known). The API still reads only the row of the
  token's tenant (`getTenantId()`), never an id from the request.
- `default('pending')`: every new workspace starts in the wizard, and there is no code path that forgets to set it.
  Old workspaces are moved to `ready` by migration 0012.

### Invitations: a token that can be missing

**File: `packages/db/src/schema/invitations.ts`** (change)

```diff
@@ -15,10 +15,15 @@ export const invitations = pgTable(
       .references(() => tenants.id),
     // contracts-এর emailSchema-র পরে — ছোট হাতে, তাই users.email-এর সাথে সরাসরি মেলে
     email: text('email').notNull(),
-    tokenHash: text('token_hash').notNull(),
+    // NULL until the worker makes the link (step 8): the token is created right before the email
+    // goes out, so it never sits in the outbox or in a queue. Resend sets it back to NULL, which
+    // kills the old link at once. A unique index allows many NULLs.
+    tokenHash: text('token_hash'),
     expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
-    // null = ইমেইল পাঠানো যায়নি (SMTP বন্ধ) — commit-এর পরে পাঠানো সফল হলে তবেই বসে
+    // Set by the worker once the mail server has taken the email
     sentAt: timestamp('sent_at', { withTimezone: true }),
+    // Set by the worker when it gives up after its retries — the app shows "Email not sent"
+    sendFailedAt: timestamp('send_failed_at', { withTimezone: true }),
     acceptedAt: timestamp('accepted_at', { withTimezone: true }),
     revokedAt: timestamp('revoked_at', { withTimezone: true }),
   },
```

- `token_hash` loses `NOT NULL`. An invitation now exists for a moment without a link: from the API's commit until
  the worker makes one. The unique index stays: Postgres treats NULLs as distinct, so many "no link yet" rows are
  fine, while two equal hashes are still impossible.
- The public lookup (`invitation_by_token` policy, step 7) compares `token_hash = <hash>`. A NULL never equals
  anything, so a row without a link can never be found by any token.
- `send_failed_at` is the third state. `sent_at` and `send_failed_at` are both NULL while the worker is still
  trying.

### The outbox table

**File: `packages/db/src/schema/outbox-events.ts`** (new)

```ts
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// Every event the API can hand to the worker. Named as facts ("this happened"), not as orders:
// the worker decides what to do about each one. Server-only, so the list lives here and not in
// contracts — the browser never sees an outbox event.
export const OUTBOX_EVENT_TYPES = [
  'workspace.created',
  'workspace.setup_requested',
  'invitation.issued',
  'member.joined',
] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

// The transactional outbox (system-design §5.5). The API inserts a row in the SAME transaction as
// the change itself, so both commit or neither does. The worker's relay later reads new rows and
// puts them on the queue. No baseColumns: a row is written once and never edited by the app.
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // $type: plain text in the DB (an old row survives a renamed type), but code can only write
    // a type from the list above
    type: text('type').$type<OutboxEventType>().notNull(),
    // Ids only (which invitation, which user), never copies of data or secrets. The worker reads
    // the current rows when it runs, and the API layer checks the shape with a Zod schema.
    payload: jsonb('payload').notNull(),
    // The HTTP request that caused the event. The worker writes it into its audit rows, so one
    // click can be followed from the request to everything that happened in the background.
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // NULL = not on the queue yet. The relay sets it in the same transaction that claimed the row.
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    // The relay's only query: the oldest unpublished rows across ALL tenants. That is why this
    // index does not start with tenant_id, unlike every other index. Partial: published rows (all
    // but a handful) are not in it, so it stays tiny however big the table grows.
    index('outbox_events_unpublished_idx')
      .on(table.createdAt, table.id)
      .where(sql`${table.publishedAt} IS NULL`),
  ],
);
```

- `OUTBOX_EVENT_TYPES` lives in `packages/db`, not in contracts. The browser never sees an outbox event, and
  contracts is loaded by the browser.
- Event names are facts (`invitation.issued`), not orders (`send-invitation-email`). The API says what happened;
  the worker decides what to do about it. When a second reaction is needed later (for example analytics), the
  event does not change.
- `payload` is `jsonb` without a `$type`: the database cannot promise its shape. The API checks it with Zod when it
  writes, and the worker checks it again when it reads (8.3, 8.4).
- `published_at` NULL = still waiting. The relay reads only these rows.
- **The partial index does not start with `tenant_id`**, unlike every other index in the schema. The relay asks
  "the oldest waiting rows of all tenants", so a `tenant_id` first column would be useless for it. `WHERE
  published_at IS NULL` keeps the index to the handful of waiting rows, however big the table grows.
- There is no index for the cleanup's `published_at < now() - 7 days`. It runs once an hour on a table that holds
  about a week of rows; a sequential scan is fine there.

### The notifications table

**File: `packages/db/src/schema/notifications.ts`** (new)

```ts
import type { NotificationParams, NotificationType } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// In-app notifications: one row per person. Stored as a type plus plain values, never as a
// sentence, so the app shows each one in the reader's own language.
export const notifications = pgTable(
  'notifications',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Who sees it. The same person in another workspace does not: tenant RLS hides the row.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type').$type<NotificationType>().notNull(),
    params: jsonb('params').$type<NotificationParams>().notNull().default({}),
    // The outbox event that created it. The worker may run a job twice (a retry after a crash), so
    // the unique index below turns the second insert into a no-op instead of a duplicate.
    eventId: uuid('event_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The bell's list: one person's rows, newest first, keyset on (created_at, id)
    index('notifications_tenant_user_created_idx').on(
      table.tenantId,
      table.userId,
      table.createdAt,
      table.id,
    ),
    // The unread count, polled every 30 seconds by every open tab. Partial: read rows (most of
    // them after a while) are not in it, so the count reads a few index entries.
    index('notifications_tenant_user_unread_idx')
      .on(table.tenantId, table.userId)
      .where(sql`${table.readAt} IS NULL`),
    // Idempotency. NULL event ids never clash, so a notification made without an event is fine.
    uniqueIndex('notifications_tenant_event_user_idx').on(
      table.tenantId,
      table.eventId,
      table.userId,
    ),
  ],
);
```

- One row per person, not one per event with a list of readers. "Read" is a per-person fact, and one column
  (`read_at`) says it.
- Three indexes, each for one query:
  - `(tenant_id, user_id, created_at, id)`: the bell's list. It is the keyset order, and reading it backwards gives
    "newest first".
  - The partial unread index: the count that every open tab polls. Most rows get read and leave this index.
  - The unique `(tenant_id, event_id, user_id)`: idempotency. A job that runs twice inserts the same key twice; the
    second insert does nothing (`ON CONFLICT DO NOTHING`, 8.5). A notification made without an event has
    `event_id` NULL, and NULLs never clash.
- `user_id` references `users` (a global table) and has no composite FK with the tenant. Membership is checked by
  the code that writes it; the read side filters by both tenant (RLS) and user (the service).

**File: `packages/db/src/schema/index.ts`** (add at the end)

```ts
export * from './outbox-events.js';
export * from './notifications.js';
```

### Migration 0011 (generated)

```bash
pnpm db:generate --name worker-outbox
```

**File: `packages/db/migrations/0011_worker-outbox.sql`** (generated — do not edit)

```sql
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "industry" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "setup_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "send_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("created_at","id") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_tenant_user_created_idx" ON "notifications" USING btree ("tenant_id","user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "notifications_tenant_user_unread_idx" ON "notifications" USING btree ("tenant_id","user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_tenant_event_user_idx" ON "notifications" USING btree ("tenant_id","event_id","user_id");
```

- This time drizzle-kit wrote everything in a working order, so nothing had to be moved by hand (unlike step 7's
  0009). Still read the file before you commit it.
- `ADD COLUMN setup_status … DEFAULT 'pending' NOT NULL` fills every existing row with `'pending'`. Migration 0012
  corrects that for old workspaces.

### Migration 0012 (custom)

```bash
pnpm db:generate --custom --name worker-outbox-rls
```

**File: `packages/db/migrations/0012_worker-outbox-rls.sql`**

```sql
-- Custom SQL migration file, put your code below! --

-- 1) Workspaces that exist before step 8 were set up by the old sign-up, which did everything in
--    one transaction. They must not be sent to the onboarding wizard. tenants has no RLS, so a
--    plain UPDATE sees every row. New workspaces keep the column default, 'pending'.
UPDATE tenants SET setup_status = 'ready';

-- 2) The two new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['outbox_events', 'notifications'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- 3) The API only ever adds to the outbox. Without these rights, a bug (or an injected query) in
--    the API cannot read other events, mark them published, or delete them.
REVOKE SELECT, UPDATE, DELETE ON outbox_events FROM omnivo_app;

-- 4) The relay reads new events of EVERY tenant, so tenant_isolation alone would show it nothing.
--    It connects as its own role, omnivo_worker (infra/docker/postgres/init/01-roles.sql), and
--    this policy applies to that role only. Policies are OR-ed, so omnivo_worker sees all outbox
--    rows while omnivo_app still sees only its tenant's. omnivo_worker has no rights on any other
--    table: the worker's jobs use omnivo_app with a tenant context, like the API.
GRANT SELECT, UPDATE, DELETE ON outbox_events TO omnivo_worker;
CREATE POLICY outbox_relay ON outbox_events
  TO omnivo_worker
  USING (true)
  WITH CHECK (true);
```

- **(1) The backfill.** Workspaces created before this step did everything at sign-up; sending their owners into a
  wizard would be wrong. `tenants` has no RLS, so this plain `UPDATE` really sees every row (compare the
  per-tenant loop that 0010 needed for `roles`).
- **(2)** The same `ENABLE` + `FORCE` + `tenant_isolation` as every tenant table. The RLS coverage test would fail
  the build without it.
- **(3) The API's outbox rights: insert only.** The API needs nothing more, and a bug or an injected query in the
  API can then not read other events, mark them done or delete them. Tested in 8.8.
- **(4) The relay's policy.** `TO omnivo_worker`: this policy does not even exist for `omnivo_app`. Postgres ORs
  the permissive policies of a table. For `omnivo_worker`, `true OR tenant_isolation` = every row; for
  `omnivo_app`, only `tenant_isolation` applies. Because of `FORCE ROW LEVEL SECURITY`, without this policy the
  relay would see zero rows and publish nothing — silently.
- `GRANT` without `INSERT`: the relay must not create events. Only the API does, inside its transactions.
- **This migration fails if `omnivo_worker` does not exist.** On a new volume the init script creates it; on your
  existing dev database you create it once by hand (8.16).

### The role, for new databases

**File: `infra/docker/postgres/init/01-roles.sql`** (add at the end)

```sql
-- The worker's outbox relay (step 8). No default privileges: it gets rights on outbox_events
-- only, from migration 0012. Its jobs connect as omnivo_app, like the API.
CREATE ROLE omnivo_worker WITH LOGIN PASSWORD 'worker_dev_password' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE omnivo TO omnivo_worker;
GRANT USAGE ON SCHEMA public TO omnivo_worker;
```

- `NOBYPASSRLS`: the relay sees all outbox rows only because of the one policy above, not because RLS is off for
  it. Every other table stays closed to it.
- Not in the `ALTER DEFAULT PRIVILEGES` of `omnivo_app`: new tables in later steps do not open to the relay by
  accident.
- Testcontainers runs this same file for every test database, so all tests have the role.

---

## 8.3 — The API's foundation: config, mail, `emit()`

### One `.env`, two configs

**File: `apps/api/src/config.ts`** (whole file)

```ts
import { z } from 'zod';

// Both processes (API and worker) read the same .env, but each checks only what it uses. So the
// worker never holds the JWT secret, and the API never holds the SMTP password.
const sharedEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  APP_ORIGIN: z.url(),
});

// process.env-এর সব মান string | undefined — এখানে একবার যাচাই করে টাইপ-নিরাপদ Config বানানো
const envSchema = sharedEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(3000),
  API_BASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  JWT_SECRET: z.string().min(32),
  // S3-এর মতো storage: dev-এ MinIO (docker-compose), production-এ Cloudflare R2 (system-design §৩.৭)
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('omnivo'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

const workerEnvSchema = sharedEnvSchema.extend({
  // The relay's own database role (omnivo_worker): it may read every tenant's outbox rows, and
  // nothing else. The jobs themselves use DATABASE_URL (omnivo_app) with a tenant context.
  WORKER_DATABASE_URL: z.url(),
  // ইমেইল: dev-এ docker-compose-এর Mailpit (smtp://localhost:1025, সব চিঠি http://localhost:8025-এ),
  // production-এ আসল SMTP (smtps://user:pass@host:465)। পাসওয়ার্ড URL-এর ভেতরেই — একটাই secret
  SMTP_URL: z.url(),
  MAIL_FROM: z.string().min(3).default('Omnivo <no-reply@omnivo.app>'),
});

const DAY = 24 * 60 * 60;

function parseEnv<S extends z.ZodType>(schema: S, env: Record<string, string | undefined>) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment — compare your .env with .env.example:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function loadConfig(env: Record<string, string | undefined>) {
  const e = parseEnv(envSchema, env);
  return {
    port: e.PORT,
    apiBaseUrl: e.API_BASE_URL,
    // /openapi.json আর /docs — production-এ API-র পুরো নকশা বাইরে দেখানো হয় না
    exposeDocs: e.NODE_ENV !== 'production',
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appOrigin: e.APP_ORIGIN,
    // localhost-এ http, তাই dev-এ Secure cookie বন্ধ; production-এ বাধ্যতামূলক
    secureCookies: e.NODE_ENV === 'production',
    storage: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      // dev আর test-এ bucket না থাকলে API নিজে বানায়; production-এ bucket IaC-র কাজ (ধাপ ২৫),
      // সেখানে API-র bucket বানানোর অধিকারই থাকবে না
      createBucket: e.NODE_ENV !== 'production',
    },
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

export function loadWorkerConfig(env: Record<string, string | undefined>) {
  const e = parseEnv(workerEnvSchema, env);
  return {
    databaseUrl: e.DATABASE_URL,
    relayDatabaseUrl: e.WORKER_DATABASE_URL,
    redisUrl: e.REDIS_URL,
    // Links inside emails (the invitation link) point at the app
    appOrigin: e.APP_ORIGIN,
    mail: {
      url: e.SMTP_URL,
      from: e.MAIL_FROM,
    },
    relay: {
      // How long the relay sleeps when it found nothing to publish. One second keeps an invitation
      // email about a second behind the click, for one cheap index read per second.
      idleMs: 1_000,
      batchSize: 100,
      // How long one publish to Redis may take before the relay gives up and rolls back
      publishTimeoutMs: 5_000,
    },
    retry: {
      // A failed job runs again after 2, 4, 8 and 16 seconds, then gives up (about 30 seconds in
      // all). Long enough to ride out a mail server restart, short enough that "Email not sent"
      // shows up while the admin is still looking at the team page.
      attempts: 5,
      backoffMs: 2_000,
    },
    // Published outbox rows are kept this long for debugging ("did the event go out?"), then
    // deleted by an hourly job
    outboxRetentionDays: 7,
  };
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
```

- **Three schemas instead of one.** `sharedEnvSchema` holds what both processes need. The API's `envSchema` and
  the worker's `workerEnvSchema` extend it. Each process checks only its own variables. So the worker never holds
  the JWT secret or the S3 keys, and the API never holds the SMTP password — in production each gets only its own
  secrets.
- `SMTP_URL` and `MAIL_FROM` moved from the API's schema to the worker's. The API does not send email any more.
- `parseEnv` is generic in the schema, so both loaders keep one error message ("compare your .env with
  .env.example") without copying it.
- `relay.idleMs: 1_000`: when the outbox is empty, the relay waits one second. An email is then at most about a
  second behind the click, and an idle system pays one small index read per second. (Postgres `LISTEN/NOTIFY`
  could make it instant; it is not worth the extra connection handling yet.)
- `relay.batchSize: 100`: one round claims at most 100 rows. The claim holds row locks until Redis has taken the
  jobs, so a round must stay short.
- `relay.publishTimeoutMs: 5_000`: see the relay (8.4) — found by a test, not planned.
- `retry` and `outboxRetentionDays` live in the config, not as constants, so the tests can make them fast
  (`testWorkerConfig`, 8.8) and production can change them in one place.

### The mail layer

**File: `apps/api/src/mail/layout.ts`** (new)

```ts
import type { LanguageCode } from '@omnivo/contracts';

// HTML-এ বসানোর আগে: কোম্পানির নাম আর মানুষের নাম ইউজারের লেখা — "<a href=…>" নামে কোম্পানি খুললে
// escape ছাড়া সেটা ইমেইলে সত্যিকারের লিংক হয়ে যেত (phishing-এর সহজ পথ)
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface EmailBody {
  language: LanguageCode;
  intro: string;
  button: { label: string; href: string };
  // Small grey lines under the button (how long the link works, why you got this)
  footer: string[];
}

// One frame for every email, so they all look the same. Inline styles only: most mail apps drop
// <style> blocks. Every text passes through escapeHtml here, so a template cannot forget it.
export function emailHtml(body: EmailBody): string {
  const footer = body.footer.map(escapeHtml).join('<br>');
  return `<!doctype html>
<html lang="${body.language}">
  <body style="margin:0;padding:32px 16px;background:#F6F7F9;font-family:'Segoe UI',system-ui,sans-serif;color:#0F1728">
    <div style="max-width:480px;margin:0 auto;padding:32px;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:14px">
      <p style="margin:0 0 24px;font-size:17px;font-weight:600">Omnivo</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.5">${escapeHtml(body.intro)}</p>
      <a href="${escapeHtml(body.button.href)}" style="display:inline-block;padding:11px 16px;background:#1F47B5;color:#FFFFFF;border-radius:10px;font-weight:500;text-decoration:none">${escapeHtml(body.button.label)}</a>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.45;color:#475467">${footer}</p>
    </div>
  </body>
</html>
`;
}

// The plain-text part, for mail apps (and spam filters) that do not show HTML
export function emailText(body: EmailBody): string {
  return `${body.intro}\n\n${body.button.label}: ${body.button.href}\n\n${body.footer.join('\n')}\n`;
}
```

- The HTML frame and `escapeHtml` came out of `invitation-email.ts`. A second email (welcome) would otherwise copy
  them, and a copy is where someone forgets the escaping.
- `emailHtml` escapes **every** text it puts in, including the button's link. A template cannot hand it raw HTML
  by mistake. The phishing test from step 7 now tests both emails (8.8).
- The colours are the design tokens' light values written out. Mail apps ignore CSS variables and `<style>`
  blocks, so inline styles are the only thing that works everywhere.

**File: `apps/api/src/mail/invitation-email.ts`** (whole file)

```ts
import { INVITATION_TTL_DAYS, type LanguageCode } from '@omnivo/contracts';

import { emailHtml, emailText } from './layout.js';
import type { MailMessage } from './mail.service.js';

interface InvitationEmailInput {
  to: string;
  workspaceName: string;
  inviterName: string;
  link: string;
  // যিনি ডাকছেন তাঁর ভাষা — একই কোম্পানির লোক সাধারণত একই ভাষায় কাজ করে। তিনি না বাছলে ইংরেজি
  language: LanguageCode;
}

interface Copy {
  subject: string;
  intro: string;
  button: string;
  expiry: string;
  ignore: string;
}

// ইমেইলের লেখা সার্ভারে, i18n-এ না: @omnivo/i18n ব্রাউজারের জন্য (React hook, i18next) — API-তে সেটা
// টানলে সার্ভারে React আসত। দুই ভাষার লেখা এখানে পাশাপাশি; satisfies দুটোকেই একই আকারে বাঁধে
function copy(input: InvitationEmailInput): Record<LanguageCode, Copy> {
  const { workspaceName: workspace, inviterName: inviter } = input;
  return {
    en: {
      subject: `${inviter} invited you to ${workspace} on Omnivo`,
      intro: `${inviter} invited you to join ${workspace} on Omnivo.`,
      button: `Join ${workspace}`,
      expiry: `The link works for ${String(INVITATION_TTL_DAYS)} days and only once.`,
      ignore: "If you weren't expecting this, you can ignore this email.",
    },
    bn: {
      subject: `${inviter} আপনাকে Omnivo-তে ${workspace}-এ যোগ দিতে ডেকেছেন`,
      intro: `${inviter} আপনাকে Omnivo-তে ${workspace}-এ যোগ দিতে ডেকেছেন।`,
      button: `${workspace}-এ যোগ দিন`,
      expiry: `লিংকটা ${new Intl.NumberFormat('bn-BD').format(INVITATION_TTL_DAYS)} দিন কাজ করবে, একবারই।`,
      ignore: 'এই ইমেইল আশা না করে থাকলে এটা এড়িয়ে যান।',
    },
  } satisfies Record<LanguageCode, Copy>;
}

export function invitationEmail(input: InvitationEmailInput): MailMessage {
  const text = copy(input)[input.language];
  const body = {
    language: input.language,
    intro: text.intro,
    button: { label: text.button, href: input.link },
    footer: [text.expiry, text.ignore],
  };
  return { to: input.to, subject: text.subject, text: emailText(body), html: emailHtml(body) };
}
```

- The texts and the two languages are unchanged. Only the frame moved out, so the file is now "what the email
  says", not "how an email is built".

**File: `apps/api/src/mail/welcome-email.ts`** (new)

```ts
import type { LanguageCode } from '@omnivo/contracts';

import { emailHtml, emailText } from './layout.js';
import type { MailMessage } from './mail.service.js';

interface WelcomeEmailInput {
  to: string;
  fullName: string;
  workspaceName: string;
  workspaceSlug: string;
  // Where the sign-in page is: {APP_ORIGIN}/login
  signInLink: string;
  language: LanguageCode;
}

interface Copy {
  subject: string;
  intro: string;
  button: string;
  address: string;
  reason: string;
}

// Same shape as invitation-email.ts: both languages side by side, satisfies keeps them equal.
// The address line matters: people forget their workspace address, and sign-in asks for it.
function copy(input: WelcomeEmailInput): Record<LanguageCode, Copy> {
  const { fullName: name, workspaceName: workspace } = input;
  const address = `${input.workspaceSlug}.omnivo.app`;
  return {
    en: {
      subject: `Welcome to Omnivo, ${name}`,
      intro: `${workspace} is ready. Pick your business type in the setup wizard, then invite your accountant and managers.`,
      button: `Open ${workspace}`,
      address: `Your workspace address is ${address}. You need it to sign in.`,
      reason: 'You get this email because you created a workspace on Omnivo.',
    },
    bn: {
      subject: `Omnivo-তে স্বাগতম, ${name}`,
      intro: `${workspace} তৈরি। setup wizard-এ ব্যবসার ধরন বাছুন, তারপর আপনার অ্যাকাউন্ট্যান্ট আর ম্যানেজারদের ডাকুন।`,
      button: `${workspace} খুলুন`,
      address: `আপনার workspace-এর ঠিকানা ${address}। লগইন করতে এটা লাগবে।`,
      reason: 'Omnivo-তে workspace তৈরি করেছেন বলে এই ইমেইল পেয়েছেন।',
    },
  } satisfies Record<LanguageCode, Copy>;
}

export function welcomeEmail(input: WelcomeEmailInput): MailMessage {
  const text = copy(input)[input.language];
  const body = {
    language: input.language,
    intro: text.intro,
    button: { label: text.button, href: input.signInLink },
    footer: [text.address, text.reason],
  };
  return { to: input.to, subject: text.subject, text: emailText(body), html: emailHtml(body) };
}
```

- **The workspace address is the most useful line.** Sign-in asks for it, and it is the thing people forget.
- The button goes to `/login`, not to the dashboard. The email may be opened on another device, without a session.
- The footer says why the email came. Mail providers and spam filters look for that line in unexpected mail.

**File: `apps/api/src/mail/mail.service.ts`** (whole file)

```ts
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport } from 'nodemailer';

import { CONFIG } from '../infra/tokens.js';

export interface MailMessage {
  to: string;
  subject: string;
  // দুটোই: HTML না দেখানো মেইল-অ্যাপ (আর স্প্যাম ফিল্টার) শুধু-লেখার অংশ পড়ে
  text: string;
  html: string;
}

// Only the part of the config this service reads. The worker's CONFIG is a WorkerConfig, and a
// narrow type lets the service accept it without knowing about the rest.
interface MailConfig {
  mail: { url: string; from: string };
}

// SMTP-র একমাত্র জায়গা। dev-এ Mailpit, production-এ আসল SMTP — কোড একই, শুধু SMTP_URL আলাদা।
// Since step 8 only the worker uses it: the API never talks to the mail server during a request.
@Injectable()
export class MailService implements OnApplicationShutdown {
  private readonly transport: ReturnType<typeof createTransport>;
  private readonly from: string;

  constructor(@Inject(CONFIG) config: MailConfig) {
    this.from = config.mail.from;
    // nodemailer's default connection timeout is 2 minutes. A job holds its queue lock for 30
    // seconds (BullMQ's lockDuration), so a slow mail server must fail well before that; the
    // queue then retries the job instead of thinking the worker died.
    this.transport = createTransport({
      url: config.mail.url,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  // Throws when the mail server does not take the message. The queue catches that and runs the
  // job again later — that is the whole retry mechanism, so nothing is swallowed here. Never log
  // the address or the body: an invitation email carries a link that lets you into a workspace.
  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
```

- `send()` now **throws** on failure. In step 7 it returned `false`, because the request had to answer anyway. Now
  the throw is the signal: the job fails, and BullMQ runs it again later. Swallowing the error here would turn
  every failure into a silent success.
- `MailConfig` is a narrow type (`{ mail: … }`). The worker's `CONFIG` holds a `WorkerConfig`, not the API's
  `Config`. With the narrow type, the service accepts either, and states what it really reads.
- The timeouts stay short, for a new reason: a BullMQ job holds a 30-second lock. A send that hangs longer would
  look like a dead worker, and a second worker would take the same job while the first was still sending.

### `emit()`: the only way to hand over work

**File: `apps/api/src/common/outbox/outbox.ts`** (new)

```ts
import { type OutboxEventType, outboxEvents } from '@omnivo/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { currentRequest } from '../request/request-context.js';
import type { Transaction } from '../tenant/with-tenant.js';

// What each event carries: ids, never copies of data. The worker reads the current rows when the
// job runs, so a payload cannot go stale, and nothing private (an email, a token) sits in the
// outbox table, in Redis or in a backup. satisfies: a new event type without a schema does not
// compile.
export const outboxPayloadSchemas = {
  'workspace.created': z.object({ userId: z.uuid() }),
  'workspace.setup_requested': z.object({ userId: z.uuid() }),
  // actorUserId: who sent or resent it — their name goes in the email, and they hear if it fails
  'invitation.issued': z.object({ invitationId: z.uuid(), actorUserId: z.uuid() }),
  // inviterId is null when the invitation's creator is unknown (an old row)
  'member.joined': z.object({ membershipId: z.uuid(), inviterId: z.uuid().nullable() }),
} satisfies Record<OutboxEventType, z.ZodObject>;

export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;

// An event as the worker's handlers see it: the outbox row with a checked payload
export interface OutboxEvent<T extends OutboxEventType> {
  id: string;
  tenantId: string;
  type: T;
  payload: OutboxPayload<T>;
  requestId: string | null;
}

// Hand work to the worker. Call it with the SAME transaction that makes the change: if the change
// rolls back, the event is gone too, and if it commits, the event is safely stored — even if the
// process dies a millisecond later. Never publish to the queue straight from a request.
export async function emit<T extends OutboxEventType>(
  tx: Transaction,
  type: T,
  payload: OutboxPayload<T>,
): Promise<void> {
  await tx.insert(outboxEvents).values({
    // Like audit(): the tenant comes from the transaction's own context, so the event always
    // belongs to the tenant whose data changed. Without a context: NULL → NOT NULL error.
    tenantId: sql`NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    type,
    // parse drops any field the schema does not know. A caller cannot slip extra data (a name, an
    // email) into the outbox by passing a wider object.
    payload: outboxPayloadSchemas[type].parse(payload),
    requestId: currentRequest()?.id ?? null,
  });
}

// What the worker does with one event type. Handlers live in their feature folder (invitations/,
// setup/) and know nothing about BullMQ; worker/handlers.ts wires each one to its event type.
export interface EventHandler<T extends OutboxEventType> {
  // Runs inside the event's tenant context (getTenantId() works). Must be idempotent: a job can
  // run twice (a retry after a crash), and the second run must not send, create or count anything
  // twice.
  handle(event: OutboxEvent<T>): Promise<void>;
  // Runs once, after the last attempt failed — to record the failure where a person will see it
  onGiveUp?(event: OutboxEvent<T>): Promise<void>;
}

// Throw this when running the job again cannot help (the data it needs is gone or broken). The
// worker then skips the remaining retries and goes straight to onGiveUp.
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError';
}
```

- `outboxPayloadSchemas` with `satisfies Record<OutboxEventType, z.ZodObject>`: a new event type without a schema
  does not compile. `OutboxPayload<T>` comes from the schemas (`z.output`), so there is no second, hand-written
  copy of each payload's type.
- **`emit()` takes the transaction as its first argument.** You cannot call it without one, so you cannot emit
  "after" a change or "next to" it — only inside it. That one parameter is the whole outbox pattern.
- `tenantId` comes from `current_setting('app.tenant_id')`, like `audit()`. The event belongs to the tenant whose
  data changed, and a call without a tenant context fails loudly (NULL into a NOT NULL column), not quietly.
- `outboxPayloadSchemas[type].parse(payload)` looks redundant — TypeScript already checked the type. It is there
  for what TypeScript allows: an object with **extra** fields (a wider variable, a spread). `z.object` drops
  unknown keys, so an email or a name can never slip into the outbox. Tested in 8.8.
- `requestId` is written with the event (decision 11).
- `EventHandler<T>`: the shape every handler has. It lives here, next to `OutboxEvent`, and not in `worker/`, so the
  feature folders (`invitations/`, `setup/`) can implement it without importing the worker. 8.7 makes that import
  a CI error.
- `onGiveUp` is optional: the welcome email has none (a lost welcome email needs no alarm).
- `PermanentJobError` is our own class, not BullMQ's `UnrecoverableError`. Handlers stay free of BullMQ, and the
  job runner translates one into the other.

### The request id in the worker

**File: `apps/api/src/common/request/request-context.ts`** (add after `currentRequest()`)

```diff
@@ -19,6 +19,13 @@ export function currentRequest(): RequestMeta | undefined {
   return requestStorage.getStore();
 }
 
+// The worker runs each job inside the id of the request that caused it (from the outbox row). Then
+// audit rows written by the job carry that id, and one click can be traced to all its effects.
+// IP and user agent stay null: a job has no client.
+export function runWithRequest<T>(meta: RequestMeta, fn: () => T): T {
+  return requestStorage.run(meta, fn);
+}
+
 // Nest-এর Fastify adapter middleware-কে Node-এর কাঁচা request দেয়; @fastify/middie তাতে Fastify-র
 // id (genReqId, configure-app.ts) আর ip বসিয়ে দেয়। Node-এর টাইপে এরা নেই — তাই `in` দিয়ে narrow,
 // cast না। middie ছাড়া চললেও (ভবিষ্যতে অন্য adapter) request ভাঙবে না, নিজের id বানাবে
```

- The same `AsyncLocalStorage` the HTTP middleware uses. `audit()` already reads `currentRequest()?.id`, so audit
  rows written by a job get the original request's id with no change to `audit()`.

**File: `apps/api/src/infra/tokens.ts`** (add at the end)

```ts
// The worker's second database pool, as omnivo_worker: only the outbox relay and its cleanup use it
export const RELAY_DB = Symbol('RELAY_DB');
```

---

## 8.4 — The worker process

### Queues

**File: `apps/api/src/worker/queues.ts`** (new)

```ts
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { OUTBOX_EVENT_TYPES, type OutboxEventType, type outboxEvents } from '@omnivo/db';
import { Queue } from 'bullmq';
import { z } from 'zod';

import type { WorkerConfig } from '../config.js';
import { CONFIG } from '../infra/tokens.js';

export const QUEUE_NAMES = ['email', 'jobs'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

// Two queues, so a slow or broken mail server never holds up workspace setup. Each queue gets its
// own workers, and the email queue can get a rate limit later (a mail provider allows N per second).
// satisfies: a new event type without a queue does not compile.
const QUEUE_OF = {
  'workspace.created': 'email',
  'invitation.issued': 'email',
  'workspace.setup_requested': 'jobs',
  'member.joined': 'jobs',
} satisfies Record<OutboxEventType, QueueName>;

// The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
export const OUTBOX_CLEANUP = 'outbox.cleanup';

// What a job carries: the outbox row minus its bookkeeping. The job name is the event type.
// Redis is data from outside this process, so the worker checks this shape before using it.
export const eventJobDataSchema = z.object({
  eventId: z.uuid(),
  tenantId: z.uuid(),
  payload: z.unknown(),
  requestId: z.string().nullable(),
});
export type EventJobData = z.infer<typeof eventJobDataSchema>;

export function isOutboxEventType(value: string): value is OutboxEventType {
  return OUTBOX_EVENT_TYPES.some((type) => type === value);
}

type OutboxRow = typeof outboxEvents.$inferSelect;

const HOUR_MS = 60 * 60 * 1000;
const DAY_S = 24 * 60 * 60;

@Injectable()
export class Queues implements OnApplicationShutdown {
  private readonly logger = new Logger(Queues.name);
  private readonly queues: Record<QueueName, Queue>;

  constructor(@Inject(CONFIG) private readonly config: WorkerConfig) {
    // enableOfflineQueue: false — commands are not parked in memory while Redis is away. That alone
    // does not make add() fail fast (BullMQ first waits for the connection), so the relay also
    // puts a time limit on each publish (outbox-relay.ts).
    const connection = { url: config.redisUrl, enableOfflineQueue: false };
    this.queues = {
      email: new Queue('email', { connection }),
      jobs: new Queue('jobs', { connection }),
    };
    // As in job-runner.ts: without a listener, every failed reconnect is an "unhandled error"
    // printed by ioredis. The relay already reports the failures that matter.
    for (const name of QUEUE_NAMES) {
      this.queues[name].on('error', (error) => {
        this.logger.warn(`queue ${name}: ${error.message}`);
      });
    }
  }

  async publish(rows: readonly OutboxRow[]): Promise<void> {
    for (const name of QUEUE_NAMES) {
      const jobs = rows
        .filter((row) => QUEUE_OF[row.type] === name)
        .map((row) => ({
          name: row.type,
          data: {
            eventId: row.id,
            tenantId: row.tenantId,
            payload: row.payload,
            requestId: row.requestId,
          } satisfies EventJobData,
          opts: {
            // The outbox id as the job id: BullMQ ignores an add() whose id already exists. If the
            // relay publishes a row twice (it pushed to Redis, then crashed before marking the row),
            // the second add is a no-op while the first job is still kept.
            jobId: row.id,
            attempts: this.config.retry.attempts,
            backoff: { type: 'exponential', delay: this.config.retry.backoffMs },
            // Keep finished jobs for a day and failed ones for a week (ages in seconds), so they
            // can be inspected; after that Redis would only fill up with them
            removeOnComplete: { age: DAY_S },
            removeOnFail: { age: 7 * DAY_S },
          },
        }));
      // One round trip per queue for the whole batch
      if (jobs.length > 0) await this.queues[name].addBulk(jobs);
    }
  }

  // upsert: every worker process calls this on start. With the same id there is still exactly one
  // schedule, however many workers run or restart.
  async scheduleCleanup(): Promise<void> {
    await this.queues.jobs.upsertJobScheduler(
      'outbox-cleanup',
      { every: HOUR_MS },
      { name: OUTBOX_CLEANUP },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(QUEUE_NAMES.map((name) => this.queues[name].close()));
  }
}
```

- **Two queues.** `email` talks to a slow outside service; `jobs` works in our own database. With one queue, ten
  emails stuck on a slow mail server could block a workspace's setup behind them.
- `QUEUE_OF` with `satisfies`: a new event type without a queue does not compile.
- `eventJobDataSchema`: Redis is outside this process, so the job's data is checked before use, the same way the
  permission cache is checked (step 7). An old job from a previous version, or a hand-made one, does not crash
  the handler — it fails as "broken data" without retries.
- **`jobId: row.id` is what makes publishing idempotent.** BullMQ ignores `add()` for an id it already has. The
  relay can publish the same row twice (it pushed to Redis, then died before marking the row); the second time is
  a no-op. Tested by breaking it (the relay test fails without it).
- `removeOnComplete: { age: DAY_S }`: done jobs are kept a day, so the dedupe above works for a day, and you can
  still inspect them. Without it, Redis would keep every job forever.
- `enableOfflineQueue: false`: ioredis must not park commands in memory while Redis is away. But see the relay:
  this alone does **not** make `add()` fail fast.
- The `'error'` listeners: ioredis prints every failed reconnect as an "unhandled error event" when nobody listens.
  With the listener, it is one warning line per queue.
- `upsertJobScheduler` with a fixed id: every worker process calls it at start, and there is still exactly one
  schedule. Note: a scheduled job with `every` runs once right away, then every hour — you see "outbox cleanup: 0
  old rows deleted" in the log when the worker starts.

### The relay

**File: `apps/api/src/worker/outbox-relay.ts`** (new)

```ts
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type Db, outboxEvents } from '@omnivo/db';
import { asc, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { WorkerConfig } from '../config.js';
import { CONFIG, RELAY_DB } from '../infra/tokens.js';
import { Queues } from './queues.js';

// Waits, but wakes up at once when the worker shuts down
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    // aborted: the worker is stopping
  }
}

// Rejects after ms, unless the signal says the race is already over
function timeLimit(ms: number, signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Redis did not take the jobs within ${String(ms)} ms`));
    }, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
    });
  });
}

// Moves committed outbox rows onto the queue. It is the only code that reads the outbox, and it
// uses its own database role (omnivo_worker) because it must see the rows of every tenant.
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly stopping = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(RELAY_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: WorkerConfig,
    private readonly queues: Queues,
  ) {}

  onApplicationBootstrap(): void {
    // Not awaited: the loop runs for the life of the process. Nest's bootstrap would never finish.
    this.loop = this.run();
  }

  // Before the queues and the database close: let the current batch finish, then stop
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { batchSize, idleMs } = this.config.relay;
    while (!this.stopping.signal.aborted) {
      let published = 0;
      try {
        published = await this.publishBatch();
      } catch (error) {
        // Redis or Postgres is down. The rows stay unpublished (the transaction rolled back), so
        // nothing is lost: the next round takes the same rows again.
        this.logger.warn(`publishing outbox events failed: ${String(error)}`);
      }
      // A full batch means more rows are probably waiting: go again at once. Otherwise sleep.
      if (published < batchSize) await pause(idleMs, this.stopping.signal);
    }
  }

  // One round: claim, publish, mark — all in one transaction. Public for the tests.
  async publishBatch(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt))
        // Oldest first: a resend is published after the invitation it resends
        .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
        .limit(this.config.relay.batchSize)
        // FOR UPDATE: another relay (a second worker process) cannot take the same rows.
        // SKIP LOCKED: it does not wait for them either — it takes the next unlocked rows. So any
        // number of workers can run the relay side by side without publishing a row twice.
        .for('update', { skipLocked: true });
      if (rows.length === 0) return 0;

      // Redis first, then the mark. If the mark fails after Redis took the jobs, the rows are
      // published again next round — and the queue ignores them, because the job id is the row id.
      // The other order could lose an event: marked as published, but never on the queue.
      // With a time limit: while Redis is unreachable BullMQ waits for it indefinitely, and this
      // transaction would hold its row locks all that time. Giving up rolls back and frees them.
      // If Redis takes the jobs after we gave up, nothing breaks: the rows are still unpublished,
      // the next round adds them again, and BullMQ ignores the repeats (same job ids).
      const done = new AbortController();
      try {
        await Promise.race([
          this.queues.publish(rows),
          timeLimit(this.config.relay.publishTimeoutMs, done.signal),
        ]);
      } finally {
        done.abort();
      }
      await tx
        .update(outboxEvents)
        .set({ publishedAt: sql`now()` })
        .where(
          inArray(
            outboxEvents.id,
            rows.map((row) => row.id),
          ),
        );
      return rows.length;
    });
  }

  // The hourly job: published rows older than the retention period go. Unpublished rows are never
  // deleted, however old — they are work that has not been done yet.
  async deletePublished(): Promise<number> {
    const rows = await this.db
      .delete(outboxEvents)
      .where(
        lt(
          outboxEvents.publishedAt,
          sql`now() - make_interval(days => ${this.config.outboxRetentionDays})`,
        ),
      )
      .returning({ id: outboxEvents.id });
    return rows.length;
  }
}
```

- **The loop.** `onApplicationBootstrap` starts it and does not wait (it runs for the life of the process).
  `beforeApplicationShutdown` aborts the sleep and waits for the current round. So a deploy never stops the relay
  in the middle of a transaction.
- **A full batch means "go again at once".** Only a short round sleeps. After a burst (a CSV import in a later
  step) the relay empties the outbox at full speed.
- **One transaction per round: claim, publish, mark.**
  - `FOR UPDATE SKIP LOCKED`: a second worker process takes **different** rows instead of waiting, or publishing the
    same rows. Tested with two relays at once: 40 rows, each published once.
  - **Redis first, then the mark.** If the mark fails after Redis took the jobs, the rows come back next round, and
    the job id dedupes them. The other order could mark a row as published that never reached the queue — a lost
    event, the one thing the outbox exists to prevent.
- **`timeLimit` — found by a test.** The plan was: Redis down → `add()` fails → rollback → next round. The test
  "keeps the rows when Redis is down" instead hung. BullMQ waits for the connection before it sends anything,
  even with `enableOfflineQueue: false`. The transaction then held its row locks forever, and the next test's
  `DELETE` waited on them. Now the publish races a 5-second timer; on timeout the transaction rolls back and frees
  the rows. If Redis takes the jobs after we gave up, nothing breaks: the rows are still unpublished, the next
  round adds them again, and BullMQ ignores the repeats.
- The `finally { done.abort() }` clears the timer after a normal publish. Without it, every round would leave a
  5-second timer running, which also keeps a test process alive after it has finished.
- **`deletePublished()`** keeps unpublished rows however old they are: they are work that has not been done.
  `lt(published_at, …)` is false for NULL, so the condition itself protects them. It uses `make_interval(days =>
  $1)` so the number is a parameter, not text glued into SQL.

### The job runner

**File: `apps/api/src/worker/job-runner.ts`** (new)

```ts
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { OutboxEventType } from '@omnivo/db';
import { type Job, UnrecoverableError, Worker } from 'bullmq';

import {
  type OutboxEvent,
  outboxPayloadSchemas,
  PermanentJobError,
} from '../common/outbox/outbox.js';
import { runWithRequest } from '../common/request/request-context.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { EventHandlers } from './handlers.js';
import { OutboxRelay } from './outbox-relay.js';
import {
  eventJobDataSchema,
  type EventJobData,
  isOutboxEventType,
  OUTBOX_CLEANUP,
  QUEUE_NAMES,
  Queues,
} from './queues.js';

// How many jobs of one queue run at the same time in one worker process. Jobs spend most of their
// time waiting (for SMTP, for Postgres), so a few in parallel use one CPU well.
const CONCURRENCY = 5;

// Takes jobs from the queues and runs the matching handler, inside the event's tenant.
@Injectable()
export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(JobRunner.name);
  private workers: Worker[] = [];

  constructor(
    @Inject(CONFIG) private readonly config: WorkerConfig,
    private readonly handlers: EventHandlers,
    private readonly queues: Queues,
    private readonly relay: OutboxRelay,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.workers = QUEUE_NAMES.map((name) => {
      const worker = new Worker(name, (job) => this.process(job), {
        connection: { url: this.config.redisUrl },
        concurrency: CONCURRENCY,
      });
      // Without an 'error' listener, a lost Redis connection would be an unhandled 'error' event
      // and crash the process. BullMQ reconnects by itself; we only log.
      worker.on('error', (error) => {
        this.logger.warn(`queue ${name}: ${error.message}`);
      });
      return worker;
    });
    await this.queues.scheduleCleanup();
  }

  // close() stops taking new jobs and waits for the running ones, before the database closes
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }

  private async process(job: Job): Promise<void> {
    if (job.name === OUTBOX_CLEANUP) {
      const deleted = await this.relay.deletePublished();
      this.logger.log(`outbox cleanup: ${String(deleted)} old rows deleted`);
      return;
    }
    // A job we cannot read will never become readable: no retries
    if (!isOutboxEventType(job.name)) throw new UnrecoverableError(`Unknown job ${job.name}`);
    const data = eventJobDataSchema.safeParse(job.data);
    if (!data.success) throw new UnrecoverableError(`Job ${String(job.id)} has broken data`);
    await this.dispatch(job, job.name, data.data);
  }

  // The schema and the handler are both picked by the same `type`, so the payload that reaches a
  // handler is the one its event type promises. worker/handlers.ts checks the wiring at compile
  // time: each event type maps to a handler of exactly that type.
  private async dispatch(job: Job, type: OutboxEventType, data: EventJobData): Promise<void> {
    const payload = outboxPayloadSchemas[type].safeParse(data.payload);
    if (!payload.success) throw new UnrecoverableError(`${type} ${data.eventId}: broken payload`);
    const event: OutboxEvent<OutboxEventType> = {
      id: data.eventId,
      tenantId: data.tenantId,
      type,
      payload: payload.data,
      requestId: data.requestId,
    };
    const handler = this.handlers.for(type);
    // Every log line names the event and the tenant (system-design §4.5), never the payload
    const label = `${type} ${event.id} (tenant ${event.tenantId})`;
    const started = performance.now();

    try {
      await this.inContext(event, () => handler.handle(event));
      this.logger.log(`${label} done in ${String(Math.round(performance.now() - started))} ms`);
    } catch (error) {
      // attemptsMade counts the attempts that already failed, not this one — hence + 1
      const permanent = error instanceof PermanentJobError;
      const lastAttempt = permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      this.logger.warn(
        `${label} failed (attempt ${String(job.attemptsMade + 1)}): ${String(error)}`,
      );
      if (lastAttempt && handler.onGiveUp) {
        const onGiveUp = handler.onGiveUp.bind(handler);
        // A failure here must not hide the real error, which BullMQ stores on the job
        await this.inContext(event, () => onGiveUp(event)).catch((giveUpError: unknown) => {
          this.logger.error(`${label} onGiveUp failed: ${String(giveUpError)}`);
        });
      }
      throw permanent ? new UnrecoverableError(error.message) : error;
    }
  }

  // The same context an HTTP request has: the tenant (for withTenant, audit, emit) and, when the
  // event came from a request, that request's id (for audit rows)
  private inContext<R>(event: OutboxEvent<OutboxEventType>, fn: () => Promise<R>): Promise<R> {
    return runWithTenant(event.tenantId, () =>
      event.requestId === null
        ? fn()
        : runWithRequest({ id: event.requestId, ipAddress: null, userAgent: null }, fn),
    );
  }
}
```

- `concurrency: 5`: most of a job's time is waiting (SMTP, Postgres). Five at once keeps one CPU busy. Raise it
  when the queue gets long, or run a second worker process.
- **Bad jobs fail without retries.** An unknown name, broken data or a payload that does not match its schema will
  never become readable, so they throw `UnrecoverableError`, which skips BullMQ's retries.
- `dispatch` is not generic. The payload schema and the handler are both chosen by the same `type`, and the typed
  handler map (below) guarantees that each event type has a handler of exactly that type. (A generic version was
  tried; ESLint's `no-unnecessary-type-parameters` flagged it, because the type parameter only linked types
  inside the body.)
- **`job.attemptsMade + 1`**: `attemptsMade` counts the attempts that already failed, not the running one. On the
  5th of 5 attempts it is 4. Without the `+ 1`, `onGiveUp` would run one attempt too late — never, in fact.
- **`onGiveUp` runs inside `catch`, before the rethrow.** A failure inside it is logged and swallowed, so BullMQ
  still stores the original error on the job.
- `throw permanent ? new UnrecoverableError(…) : error`: our `PermanentJobError` becomes BullMQ's own class here —
  the only place that knows both.
- **`inContext`** gives a job the same context a request has. `runWithTenant` makes `getTenantId()`,
  `withTenant()`, `audit()` and `emit()` work unchanged inside handlers. `runWithRequest` (only when the event came
  from a request) puts the request id on the job's audit rows.
- The log line names the event, its id and the tenant (system-design §4.5: every log line has a tenant id), never
  the payload.

### Which handler for which event

**File: `apps/api/src/worker/handlers.ts`** (new)

```ts
import { Injectable } from '@nestjs/common';
import type { OutboxEventType } from '@omnivo/db';

import type { EventHandler } from '../common/outbox/outbox.js';
import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
import { ProvisioningHandler } from '../setup/provisioning.handler.js';
import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';

// Which handler runs for which event — the one place to look. The mapped type ties each key to a
// handler of exactly that event, so wiring the invitation handler to 'member.joined' (or leaving
// an event out) does not compile. One handler per event for now; when an event needs a second
// consumer, the value becomes a list and the job id gets the handler's name.
type HandlerMap = { [T in OutboxEventType]: EventHandler<T> };

@Injectable()
export class EventHandlers {
  private readonly byType: HandlerMap;

  constructor(
    welcome: WelcomeEmailHandler,
    provisioning: ProvisioningHandler,
    invitationEmail: InvitationEmailHandler,
    memberJoined: MemberJoinedHandler,
  ) {
    this.byType = {
      'workspace.created': welcome,
      'workspace.setup_requested': provisioning,
      'invitation.issued': invitationEmail,
      'member.joined': memberJoined,
    };
  }

  for<T extends OutboxEventType>(type: T): EventHandler<T> {
    return this.byType[type];
  }
}
```

- `HandlerMap` is a mapped type: the key `'member.joined'` requires an `EventHandler<'member.joined'>`. Wiring the
  wrong handler to an event, or leaving an event without one, does not compile.
- A new event means three edits, all forced by the compiler: `OUTBOX_EVENT_TYPES` (db), its schema
  (`outbox.ts`), and its queue and handler (here and in `queues.ts`).

### The module and the entry point

**File: `apps/api/src/worker/worker.module.ts`** (new)

```ts
import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@omnivo/db';

import { createWithTenant } from '../common/tenant/with-tenant.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG, DB, RELAY_DB, WITH_TENANT } from '../infra/tokens.js';
import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
import { MailService } from '../mail/mail.service.js';
import { ProvisioningHandler } from '../setup/provisioning.handler.js';
import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
import { EventHandlers } from './handlers.js';
import { JobRunner } from './job-runner.js';
import { OutboxRelay } from './outbox-relay.js';
import { Queues } from './queues.js';

// The worker process: no HTTP server, no controllers — the relay and the queue workers. It does
// not import InfraModule: that one brings the API's things (auth, S3 storage, the permission
// cache) which the worker neither needs nor should hold the secrets for.
@Module({})
export class WorkerModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELAY_DB) private readonly relayDb: Db,
  ) {}

  static register(config: WorkerConfig): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: CONFIG, useValue: config },
        // The jobs' pool: omnivo_app, tenant context per transaction — exactly like the API
        { provide: DB, useFactory: () => createDb(config.databaseUrl) },
        // The relay's pool: omnivo_worker. Two connections: one for the relay, one for the cleanup
        { provide: RELAY_DB, useFactory: () => createDb(config.relayDatabaseUrl, { max: 2 }) },
        { provide: WITH_TENANT, inject: [DB], useFactory: (db: Db) => createWithTenant(db) },
        MailService,
        Queues,
        OutboxRelay,
        JobRunner,
        EventHandlers,
        WelcomeEmailHandler,
        ProvisioningHandler,
        InvitationEmailHandler,
        MemberJoinedHandler,
      ],
    };
  }

  // Last: the relay and the queue workers have stopped in beforeApplicationShutdown by now
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.db.$client.end(), this.relayDb.$client.end()]);
  }
}
```

- **It does not import `InfraModule`.** That module builds the API's auth (JWT secret), S3 storage (which creates
  the bucket on start) and the permission-cache Redis client. The worker needs none of them, and should not hold
  their secrets.
- **Two pools.** `DB` (`omnivo_app`) for the jobs: they go through `withTenant`, like the API. `RELAY_DB`
  (`omnivo_worker`) for the relay and the cleanup only, with 2 connections.
- **The shutdown order.** Nest calls every `beforeApplicationShutdown` first (the relay stops, the queue workers
  finish their running jobs), then every `onApplicationShutdown` (the queues close, the pools close, the mail
  transport closes). If the pools closed first, a job still running would fail on a closed connection.

**File: `apps/api/src/worker.ts`** (new)

```ts
import './env.js';
import { NestFactory } from '@nestjs/core';

import { loadWorkerConfig } from './config.js';
import { WorkerModule } from './worker/worker.module.js';

// The second entry point of the same code base: `node dist/worker.js`. Same build and Docker
// image as the API, a different process — it can be restarted, scaled or stopped on its own.
async function bootstrap(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  // An application context, not an app: Nest's DI and lifecycle hooks, but no HTTP server
  const app = await NestFactory.createApplicationContext(WorkerModule.register(config));
  // SIGTERM (a deploy) → finish the running jobs, stop the relay, close the pools
  app.enableShutdownHooks();
}

void bootstrap();
```

- `createApplicationContext`, not `create`: Nest's DI and lifecycle hooks, without an HTTP server or a port.
- `import './env.js'` first: the same root `.env` as the API. From `dist-worker/` the path to the repo root is the
  same depth as from `dist/`, so `env.ts` needs no change.
- There is no health endpoint yet. In production (step 25) a liveness check can look at the worker's heartbeat
  in Redis.

### Running it

**File: `apps/api/tsconfig.worker.json`** (new)

```json
{
  "extends": "./tsconfig.build.json",
  "compilerOptions": {
    "outDir": "./dist-worker"
  }
}
```

**File: `apps/api/package.json`** (scripts; `bullmq` is added by the command below)

```diff
@@ -5,8 +5,10 @@
   "type": "module",
   "scripts": {
     "dev": "nest start --watch",
+    "dev:worker": "nest start --watch --entryFile worker --path tsconfig.worker.json",
     "build": "nest build",
     "start": "node dist/main.js",
+    "start:worker": "node dist/worker.js",
     "typecheck": "tsc --noEmit",
     "test": "vitest run --passWithNoTests --exclude \"**/*.int.spec.ts\"",
     "test:integration": "vitest run --passWithNoTests .int.spec --exclude \"**/*tenant-leak.int.spec.ts\"",
@@ -33,6 +35,7 @@
     "@omnivo/auth": "workspace:*",
     "@omnivo/contracts": "workspace:*",
     "@omnivo/db": "workspace:*",
+    "bullmq": "^6.3.9",
     "dotenv": "^18.0.3",
     "drizzle-orm": "^0.45.3",
     "fastify": "5.12.5",
```

```bash
pnpm --filter @omnivo/api add bullmq
```

- **Why a second tsconfig for dev.** `nest start --watch` compiles into `dist/`, and `deleteOutDir: true` empties
  `dist/` on every start. Two watchers on the same `dist/` would delete each other's output. The worker's watcher
  writes to `dist-worker/` instead. It costs a second compile in dev only; production builds once (`nest build`)
  and runs `node dist/worker.js`.
- `--entryFile worker`: Nest runs `worker.js` instead of `main.js` from that output folder.
- `bullmq` 6 uses the `ioredis` the API already has (a peer dependency), so there is still one ioredis in the
  lockfile, and `pnpm dedupe --check` stays green.

**File: `pnpm-workspace.yaml`** (under `allowBuilds`)

```yaml
  msgpackr-extract: false # bullmq: the prebuilt binary comes as an optional platform package; the script only compiles when none matches
```

- pnpm 12 refuses to install a package with an install script until you decide. `msgpackr-extract` (a BullMQ
  dependency) ships prebuilt binaries per platform; its script only compiles with node-gyp when none matches. So
  `false`, like `protobufjs`.

**File: `turbo.json`** (next to `dev`)

```diff
@@ -10,6 +10,11 @@
       "cache": false,
       "persistent": true
     },
+    "dev:worker": {
+      "dependsOn": ["^build"],
+      "cache": false,
+      "persistent": true
+    },
     "typecheck": {
       "dependsOn": ["^build"]
     },
```

**File: `package.json`** (root)

```diff
@@ -7,7 +7,7 @@
     "node": ">=24 <25"
   },
   "scripts": {
-    "dev": "turbo run dev",
+    "dev": "turbo run dev dev:worker",
     "dev:mock": "turbo run dev:mock",
     "build": "turbo run build",
     "typecheck": "turbo run typecheck",
```

- `turbo run dev dev:worker` runs both tasks of every package that has them. Only `apps/api` has `dev:worker`. The
  log lines show `@omnivo/api:dev:worker:` in front, so you can tell the processes apart.

---

## 8.5 — The handlers: what the worker does

Each handler sits in the feature folder it belongs to, next to that feature's API code. `worker/` only wires them.

### Notifications, written by jobs

**File: `apps/api/src/notifications/notify.ts`** (new)

```ts
import type { NotificationParams, NotificationType } from '@omnivo/contracts';
import { notifications } from '@omnivo/db';
import { sql } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';

interface NotifyInput {
  userId: string;
  type: NotificationType;
  params?: NotificationParams;
  // The event that caused it — the key that makes a second run of the same job harmless
  eventId: string;
}

// Adds a notification in the transaction's tenant, as part of the job's other work: if the job
// rolls back, no notification; if the job runs twice, still one notification.
export async function notify(tx: Transaction, input: NotifyInput): Promise<void> {
  await tx
    .insert(notifications)
    .values({
      tenantId: sql`NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      userId: input.userId,
      type: input.type,
      params: input.params ?? {},
      eventId: input.eventId,
    })
    .onConflictDoNothing({
      target: [notifications.tenantId, notifications.eventId, notifications.userId],
    });
}
```

- It takes the job's transaction, so the notification commits with the work it reports. "Workspace ready" can
  never appear for a setup that rolled back.
- `onConflictDoNothing` with the unique index as its target: the second run of the same job inserts nothing. The
  target must be named, so a different unique violation (a bug) still throws instead of being swallowed.

### The industry templates

**File: `apps/api/src/setup/templates.ts`** (new)

```ts
import type { Industry, PermissionKey } from '@omnivo/contracts';

export interface RoleTemplate {
  name: string;
  description: string;
  permissions: PermissionKey[];
}

// Starting data for each business type. Now: roles that match how such a company is staffed.
// Step 9 adds the chart of accounts here, step 12 the product tracking (batch for pharma).
// These roles are ordinary custom roles: the workspace can rename, change or delete them, and a
// later change to this file never touches workspaces that already exist.
export interface IndustryTemplate {
  roles: RoleTemplate[];
}

// Some roles have few permissions today because the modules they will use (stock, sales) do not
// exist yet. Each of those steps adds its permissions to these templates for new workspaces.
const ACCOUNTANT: RoleTemplate = {
  name: 'Accountant',
  description: 'Books, VAT returns and Mushak 6.3',
  permissions: ['core.user.read', 'core.audit.read'],
};

const STORE_KEEPER: RoleTemplate = {
  name: 'Store keeper',
  description: 'Receives goods and writes GRNs',
  permissions: [],
};

// satisfies Record<Industry, …>: a new industry in contracts does not compile until it has a template
export const INDUSTRY_TEMPLATES = {
  garments: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Merchandiser',
        description: 'Buyer POs, LCs and shipment dates',
        permissions: ['core.user.read'],
      },
      STORE_KEEPER,
    ],
  },
  pharma: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Depot manager',
        description: 'Stock by batch and expiry at a depot',
        permissions: ['core.branch.manage'],
      },
      { name: 'Sales representative', description: 'Orders from pharmacies', permissions: [] },
    ],
  },
  distribution: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Depot manager',
        description: 'Stock and deliveries at a depot',
        permissions: ['core.branch.manage'],
      },
      {
        name: 'Sales officer',
        description: 'Orders and collections from retailers',
        permissions: [],
      },
    ],
  },
  manufacturing: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Production manager',
        description: 'Production orders and material use',
        permissions: ['core.user.read'],
      },
      STORE_KEEPER,
    ],
  },
  retail: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Shop manager',
        description: 'Runs a shop and its staff',
        permissions: ['core.user.read', 'core.branch.manage'],
      },
      { name: 'Cashier', description: 'Sells at the counter', permissions: [] },
    ],
  },
  other: {
    roles: [
      ACCOUNTANT,
      { name: 'Manager', description: 'Runs day-to-day work', permissions: ['core.user.read'] },
    ],
  },
} satisfies Record<Industry, IndustryTemplate>;
```

- **TypeScript, not JSON.** The build plan says "template JSON". A `.ts` file with `satisfies Record<Industry, …>`
  and `PermissionKey[]` checks every permission name and every industry at compile time. A JSON file would find a
  typo only when a customer signs up.
- Roles are real custom roles, owned by the workspace. The template only gives them a starting point. A later
  change to this file never reaches workspaces that already exist (they are not "linked" to the template).
- Some roles have no permissions yet (Store keeper, Cashier). The modules they will use arrive in later steps, and
  each of those steps adds its permissions to the templates for **new** workspaces.
- English names: they are data, not UI text. Offices in Bangladesh use these English role names in Bangla speech
  too, and the owner can rename them.

### The setup job

**File: `apps/api/src/setup/provisioning.handler.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import { isIndustry } from '@omnivo/contracts';
import { permissions, rolePermissions, roles, tenants } from '@omnivo/db';
import { and, eq, inArray } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { type EventHandler, type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';
import { INDUSTRY_TEMPLATES, type RoleTemplate } from './templates.js';

type Event = OutboxEvent<'workspace.setup_requested'>;

// Creates the template's roles and their permissions. A role whose name is already taken (the
// owner made an "Accountant" before the job ran) is left alone — ON CONFLICT DO NOTHING on the
// lower(name) index — and gets no permissions from us: it is the owner's role, not ours.
async function seedRoles(
  tx: Transaction,
  tenantId: string,
  templates: readonly RoleTemplate[],
): Promise<{ id: string; name: string }[]> {
  const inserted = await tx
    .insert(roles)
    .values(
      templates.map((role) => ({
        tenantId,
        name: role.name,
        description: role.description,
        kind: 'custom' as const,
      })),
    )
    .onConflictDoNothing()
    // Only the rows really inserted come back — the skipped names do not
    .returning({ id: roles.id, name: roles.name });

  const keys = [...new Set(templates.flatMap((role) => role.permissions))];
  if (inserted.length === 0 || keys.length === 0) return inserted;

  // permissions is the global catalog (no tenant, no RLS): key → id
  const catalog = await tx
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions)
    .where(inArray(permissions.key, keys));
  const idOf = new Map(catalog.map((row) => [row.key, row.id]));

  const links = inserted.flatMap((role) => {
    const template = templates.find((candidate) => candidate.name === role.name);
    return (template?.permissions ?? []).flatMap((key) => {
      const permissionId = idOf.get(key);
      return permissionId === undefined ? [] : [{ tenantId, roleId: role.id, permissionId }];
    });
  });
  if (links.length > 0) await tx.insert(rolePermissions).values(links);
  return inserted;
}

@Injectable()
export class ProvisioningHandler implements EventHandler<'workspace.setup_requested'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // One transaction for everything, so the job is idempotent in a simple way: either all of it
  // committed (then the status is 'ready' and a second run stops at the check), or none of it did
  // (then a second run starts from a clean slate). Nothing is ever half set up.
  async handle(event: Event): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // FOR UPDATE: two runs of this job at once (a stalled job restarted while the first is still
      // going) take turns. The second one waits, then sees 'ready' and stops.
      const [tenant] = await tx
        .select({ status: tenants.setupStatus, industry: tenants.industry })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw new PermanentJobError('The workspace no longer exists');
      if (tenant.status === 'ready') return;
      // The column is plain text in the DB; a value outside the list is broken data, and running
      // the job again will not fix it
      if (tenant.industry === null || !isIndustry(tenant.industry)) {
        throw new PermanentJobError('The workspace has no known business type');
      }

      const industry = tenant.industry;
      const seeded = await seedRoles(tx, tenantId, INDUSTRY_TEMPLATES[industry].roles);
      await tx.update(tenants).set({ setupStatus: 'ready' }).where(eq(tenants.id, tenantId));
      // No actorUserId: the audit log shows "System" — the job did it, not a person
      await audit(tx, {
        action: 'workspace.provisioned',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({
          industry,
          roles: seeded.length === 0 ? null : seeded.map((role) => role.name).join(', '),
        }),
      });
      await notify(tx, {
        userId: event.payload.userId,
        type: 'workspace.ready',
        eventId: event.id,
      });
    });
  }

  // After the last retry: the wizard stops waiting and offers "Try again". Only from
  // 'provisioning' — if a later run already finished, 'ready' must stay.
  async onGiveUp(): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant((tx) =>
      tx
        .update(tenants)
        .set({ setupStatus: 'failed' })
        .where(and(eq(tenants.id, tenantId), eq(tenants.setupStatus, 'provisioning'))),
    );
  }
}
```

- **The idempotency is one transaction plus one check.** Either all of the job committed — then the status is
  `ready`, and the next run stops at the check — or none of it did, and the next run starts clean. There is never a
  half-seeded workspace to repair. Tested by running the job twice (8.8), and by removing the check (the test
  fails: a second "Workspace ready" notification).
- **`FOR UPDATE` on the tenant row.** A stalled job can be restarted by BullMQ while the first run is still going.
  The lock makes the second run wait. Then it sees `ready` and stops.
- **`PermanentJobError` for broken data.** An unknown industry (the column is plain text) will not fix itself on a
  retry. Throwing this error skips the retries and goes straight to `onGiveUp`.
- **`seedRoles` and existing names.** `ON CONFLICT DO NOTHING` without a target also covers the expression index
  `lower(name)` (drizzle's `target` takes columns, and this index is on an expression). If the owner already made an "Accountant"
  before the job ran, theirs is kept and gets **no** permissions from us — `returning()` gives back only the rows
  really inserted, and only those get the template's permissions.
- **The audit row has no actor.** The viewer shows "System": the job did it, not a person. It still carries the
  request id of the owner's click (decision 11).
- **`onGiveUp` only moves `provisioning` → `failed`.** If a later run already finished (`ready`), a late give-up
  must not undo it.

### The welcome email

**File: `apps/api/src/setup/welcome-email.handler.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import { type Db, tenants, users } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG, DB } from '../infra/tokens.js';
import { MailService } from '../mail/mail.service.js';
import { welcomeEmail } from '../mail/welcome-email.js';

// Sign-up used to finish only after everything was done. Now it commits and answers at once; the
// email goes from here, a second later, and a slow mail server cannot make sign-up slow or fail.
@Injectable()
export class WelcomeEmailHandler implements EventHandler<'workspace.created'> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: WorkerConfig,
    private readonly mail: MailService,
  ) {}

  // Not fully idempotent, and cannot be: if the process dies after the mail server took the
  // email but before the queue marks the job done, the retry sends it again. A second welcome
  // email is harmless; a lost one is not — so "at least once" is the right side to err on.
  async handle(event: OutboxEvent<'workspace.created'>): Promise<void> {
    // users and tenants are global tables (no RLS), so no tenant transaction is needed to read them
    const [user] = await this.db
      .select({ email: users.email, fullName: users.fullName, language: users.language })
      .from(users)
      .where(eq(users.id, event.payload.userId));
    const [tenant] = await this.db
      .select({ name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, getTenantId()));
    // The account or the workspace was deleted before the job ran — nobody to welcome
    if (!user || !tenant) return;

    await this.mail.send(
      welcomeEmail({
        to: user.email,
        fullName: user.fullName,
        workspaceName: tenant.name,
        workspaceSlug: tenant.slug,
        signInLink: `${this.config.appOrigin}/login`,
        language: user.language ?? 'en',
      }),
    );
  }
}
```

- It lives in `setup/`: it is part of a workspace's start, not of mail in general.
- No `onGiveUp`: a lost welcome email is not worth an alarm; the owner is already signed in.
- **Not fully idempotent, and it cannot be.** Email has no "undo" and no "did you get it?". If the process dies
  after SMTP took the message but before BullMQ marks the job done, the job runs again. A duplicate welcome email
  is harmless; a missing invitation is not — so "at least once" is the right side.
- User or tenant gone → `return`, not throw. There is nothing to retry.

### The invitation email

**File: `apps/api/src/invitations/invitation-email.handler.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import { invitationLink } from '@omnivo/contracts';
import { invitations, tenants, users } from '@omnivo/db';
import { and, eq, gt, isNull } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG, WITH_TENANT } from '../infra/tokens.js';
import { invitationEmail } from '../mail/invitation-email.js';
import { MailService } from '../mail/mail.service.js';
import { notify } from '../notifications/notify.js';
import { newInvitationToken } from './invitation-token.js';

type Event = OutboxEvent<'invitation.issued'>;

// Sends the invitation email. The link's token is made HERE, right before sending — so the token
// never sits in the outbox table, in a Redis job or in a backup. Only its hash is stored, as
// before (step 7).
@Injectable()
export class InvitationEmailHandler implements EventHandler<'invitation.issued'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: WorkerConfig,
    private readonly mail: MailService,
  ) {}

  async handle(event: Event): Promise<void> {
    const tenantId = getTenantId();
    const { token, hash } = newInvitationToken();

    // Step 1 (own transaction): check there is still something to send, and store the new hash.
    // It must commit BEFORE the email goes out: a link in someone's inbox has to work already.
    const context = await this.withTenant(async (tx) => {
      const [row] = await tx
        .select({
          email: invitations.email,
          sentAt: invitations.sentAt,
          workspaceName: tenants.name,
        })
        .from(invitations)
        .innerJoin(tenants, eq(tenants.id, invitations.tenantId))
        .where(
          and(
            eq(invitations.tenantId, tenantId),
            eq(invitations.id, event.payload.invitationId),
            // Still open: accepted, cancelled or expired invitations get no email
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, new Date()),
          ),
        )
        // Only the invitation row, not tenants: a resend at the same moment waits for us
        .for('update', { of: invitations });
      // sentAt set = a working link is already out. That covers two cases: this job ran before
      // (retry after a crash), or an invitation was resent twice quickly and the first job already
      // sent the fresh link. Either way, a second email would only kill the first link.
      // (No row at all — accepted, cancelled or expired — also ends here: undefined !== null.)
      if (row?.sentAt !== null) return null;

      await tx
        .update(invitations)
        .set({ tokenHash: hash, sendFailedAt: null })
        .where(
          and(eq(invitations.tenantId, tenantId), eq(invitations.id, event.payload.invitationId)),
        );

      const [inviter] = await tx
        .select({ fullName: users.fullName, language: users.language })
        .from(users)
        .where(eq(users.id, event.payload.actorUserId));
      return { ...row, inviter };
    });
    if (!context) return;

    // Step 2: the email, outside any transaction — a slow mail server holds no database lock.
    // If this throws, the job is retried: step 1 runs again with a new token, and this unsent
    // link simply never works.
    await this.mail.send(
      invitationEmail({
        to: context.email,
        workspaceName: context.workspaceName,
        inviterName: context.inviter?.fullName ?? context.workspaceName,
        link: invitationLink(this.config.appOrigin, token),
        language: context.inviter?.language ?? 'en',
      }),
    );

    // Step 3: mark it sent — only if the hash is still ours. If someone pressed Resend while we
    // were sending, the row now waits for a different link, and must not look "sent".
    await this.withTenant((tx) =>
      tx
        .update(invitations)
        .set({ sentAt: new Date() })
        .where(
          and(
            eq(invitations.tenantId, tenantId),
            eq(invitations.id, event.payload.invitationId),
            eq(invitations.tokenHash, hash),
          ),
        ),
    );
  }

  // After the last retry: the team page shows "Email not sent", and the person who sent it hears
  // about it in the bell — they may have closed the page long ago.
  async onGiveUp(event: Event): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [failed] = await tx
        .update(invitations)
        .set({ sendFailedAt: new Date() })
        .where(
          and(
            eq(invitations.tenantId, tenantId),
            eq(invitations.id, event.payload.invitationId),
            isNull(invitations.sentAt),
          ),
        )
        .returning({ email: invitations.email });
      if (!failed) return;
      await notify(tx, {
        userId: event.payload.actorUserId,
        type: 'invitation.failed',
        params: { email: failed.email },
        eventId: event.id,
      });
    });
  }
}
```

Three steps, and the order matters:

1. **Transaction 1 stores the new hash, and commits, before sending.** A link in someone's inbox must already work
   when they click it, even a second after the email arrives.
2. **The email goes out with no transaction open.** A slow mail server holds no row locks.
3. **Transaction 2 sets `sent_at` only if the hash is still ours.** If an admin pressed Resend during step 2, the
   row now waits for a different link. Marking it "sent" would show "Sent" for an email that is not the valid one.

- **`FOR UPDATE … OF invitations`** locks the invitation, not the joined `tenants` row. A resend of the same
  invitation waits for step 1 to commit; other invitations of the workspace are not blocked.
- **`row?.sentAt !== null` → stop.** This one line covers two cases. A retry after a crash (the email went out, the
  job did not finish): no second email. And two quick Resends: the second job finds the first job's fresh link
  already sent, and does not kill it with a third one. (`undefined !== null` is also true, so a row that is gone —
  accepted, cancelled or expired — ends here too. ESLint's `prefer-optional-chain` asked for this form.)
- **A retry makes a new token.** The previous attempt's link never reached anyone, so replacing its hash loses
  nothing.
- The inviter's language picks the email's language (as in step 7). The inviter is the **actor** of this
  send, which after a Resend can be someone other than the invitation's creator.
- **`onGiveUp`** marks the failure only where nothing was sent (`sent_at IS NULL`), and tells the person who sent
  it, in the same transaction. They may have closed the page long ago, so the pill alone is not enough.

### "… joined the workspace"

**File: `apps/api/src/invitations/member-joined.handler.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import { memberships, users } from '@omnivo/db';
import { and, eq, isNull } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';

// "Nasrin Akter joined the workspace" in the bell of whoever invited her. Idempotent through
// notify(): a second run of this job adds nothing.
@Injectable()
export class MemberJoinedHandler implements EventHandler<'member.joined'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: OutboxEvent<'member.joined'>): Promise<void> {
    const { inviterId, membershipId } = event.payload;
    if (inviterId === null) return;
    const tenantId = getTenantId();

    await this.withTenant(async (tx) => {
      const [joined] = await tx
        .select({ fullName: users.fullName, userId: users.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));
      // The inviter must still be in the workspace: a removed person gets no news about it
      const [inviter] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, inviterId),
            isNull(memberships.deletedAt),
          ),
        );
      // Inviting yourself is impossible (already_member), but a joined person never hears about
      // their own joining, whatever the data says
      if (!joined || !inviter || joined.userId === inviterId) return;

      await notify(tx, {
        userId: inviterId,
        type: 'member.joined',
        params: { name: joined.fullName },
        eventId: event.id,
      });
    });
  }
}
```

- It checks that the inviter is still a member. A removed person gets no more news from the workspace.
- It reads the name when the job runs, not when the event was written. The payload carries ids only (decision 8).

---

## 8.6 — The API's modules

### Setup

**File: `apps/api/src/setup/setup.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Industry, Setup, SetupStatus } from '@omnivo/contracts';
import { tenants } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// The business type is picked once. Changing it later would mean undoing a template (roles now, a
// chart of accounts with posted entries later) — that is a support task, not a button.
function setupStarted(): AppError {
  return new AppError(409, 'setup_started', 'The workspace setup has already started.');
}

function setupNotFailed(): AppError {
  return new AppError(409, 'setup_not_failed', 'Only a failed setup can be retried.');
}

@Injectable()
export class SetupService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  get(): Promise<Setup> {
    return this.withTenant((tx) => this.read(tx));
  }

  // The API does only the quick part: record the choice and queue the work. The response comes
  // back in milliseconds, whatever the template holds (a chart of accounts from step 9 is ~150 rows).
  start(industry: Industry): Promise<Setup> {
    return this.withTenant(async (tx) => {
      const current = await this.lock(tx);
      // Two owners pressing Continue at once: the lock makes the second wait, and then it sees
      // 'provisioning' and gets 409 — one job, one industry
      if (current.status !== 'pending') throw setupStarted();
      await this.moveTo(tx, 'provisioning', industry);
      await audit(tx, {
        action: 'workspace.setup_started',
        entityType: 'workspace',
        entityId: getTenantId(),
        changes: created({ industry }),
      });
      // Same transaction: if anything above fails, no job is queued; once it commits, the job
      // will run even if this process dies right after
      await emit(tx, 'workspace.setup_requested', { userId: currentPrincipal().userId });
      return { status: 'provisioning', industry };
    });
  }

  // The job is idempotent, so running it again is always safe. A new event, not the old job: the
  // old one has used up its retries.
  retry(): Promise<Setup> {
    return this.withTenant(async (tx) => {
      const current = await this.lock(tx);
      if (current.status !== 'failed') throw setupNotFailed();
      await this.moveTo(tx, 'provisioning');
      await emit(tx, 'workspace.setup_requested', { userId: currentPrincipal().userId });
      return { status: 'provisioning', industry: current.industry };
    });
  }

  private async read(tx: Transaction): Promise<Setup> {
    const [row] = await tx
      .select({ status: tenants.setupStatus, industry: tenants.industry })
      .from(tenants)
      .where(eq(tenants.id, getTenantId()));
    if (!row) throw notFound('Workspace');
    return row;
  }

  // tenants has no RLS; the id comes from the token, never from the request body
  private async lock(tx: Transaction): Promise<Setup> {
    const [row] = await tx
      .select({ status: tenants.setupStatus, industry: tenants.industry })
      .from(tenants)
      .where(eq(tenants.id, getTenantId()))
      .for('update');
    if (!row) throw notFound('Workspace');
    return row;
  }

  private async moveTo(tx: Transaction, status: SetupStatus, industry?: Industry): Promise<void> {
    await tx
      .update(tenants)
      .set({ setupStatus: status, ...(industry !== undefined && { industry }) })
      .where(eq(tenants.id, getTenantId()));
  }
}
```

- **The API does the quick part.** Store the choice, write the audit row, emit the event — milliseconds, however
  big the template gets in step 9.
- **`lock()` with `FOR UPDATE`.** Two owners (or two tabs) press Continue at once. Without the lock both would see
  `pending`, both would store their industry and emit an event. With it the second waits, then sees
  `provisioning` and gets 409.
- **`retry()` emits a new event**, not "retry the old job": the old job has used up its attempts, and BullMQ would
  ignore a re-add with the same id anyway.
- `moveTo` spreads the industry in only when given (`exactOptionalPropertyTypes`). The retry keeps the stored
  industry.

**File: `apps/api/src/setup/setup.controller.ts`** (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { SetupService } from './setup.service.js';

type Routes = typeof routes.setup;

@Controller()
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Endpoint(routes.setup.get)
  get(): Promise<RouteResponse<Routes['get']>> {
    return this.setup.get();
  }

  @Endpoint(routes.setup.start)
  start({ body }: RouteInput<Routes['start']>): Promise<RouteResponse<Routes['start']>> {
    return this.setup.start(body.industry);
  }

  @Endpoint(routes.setup.retry)
  retry(): Promise<RouteResponse<Routes['retry']>> {
    return this.setup.retry();
  }
}
```

**File: `apps/api/src/setup/setup.module.ts`** (new)

```ts
import { Module } from '@nestjs/common';

import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

// The API half of the setup: read the status, start it, retry it. The work itself is the worker's
// ProvisioningHandler, wired in worker/worker.module.ts.
@Module({
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
```

- The module has no handlers. `ProvisioningHandler` and `WelcomeEmailHandler` are providers of the
  `WorkerModule`. Registering them here would construct them in the API process too, for nothing.

### Notifications

**File: `apps/api/src/notifications/notifications.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { NotificationPage } from '@omnivo/contracts';
import { notifications } from '@omnivo/db';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { notFound } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// Every query here filters by the signed-in user as well as the tenant. RLS only knows the tenant:
// without the user filter, anyone in the workspace could read or clear a colleague's notifications.
function mine() {
  return and(
    eq(notifications.tenantId, getTenantId()),
    eq(notifications.userId, currentPrincipal().userId),
  );
}

@Injectable()
export class NotificationsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // Newest first, keyset on (created_at, id) — the same cursor as the audit log, created_at as
  // text so the microseconds survive the round trip (see audit.controller.ts)
  list(query: { limit: number; cursor?: string | undefined }): Promise<NotificationPage> {
    const after = decodeCursor(query.cursor, z.tuple([z.string().max(64), z.uuid()]));
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({
          id: notifications.id,
          type: notifications.type,
          params: notifications.params,
          readAt: notifications.readAt,
          createdAt: notifications.createdAt,
          createdAtText: sql<string>`${notifications.createdAt}::text`,
        })
        .from(notifications)
        .where(
          and(
            mine(),
            after &&
              sql`(${notifications.createdAt}, ${notifications.id}) < (${after[0]}::text::timestamptz, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit + 1);

      const page = toPage(rows, query.limit, (last) => [last.createdAtText, last.id]);
      return {
        items: page.items.map((row) => ({
          id: row.id,
          type: row.type,
          params: row.params,
          readAt: row.readAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  // Served by the partial "unread" index: only unread rows are in it, so this stays cheap however
  // many old notifications a person has
  async unreadCount(): Promise<number> {
    const [row] = await this.withTenant((tx) =>
      tx
        .select({ count: count() })
        .from(notifications)
        .where(and(mine(), isNull(notifications.readAt))),
    );
    return row?.count ?? 0;
  }

  // Idempotent: marking a read notification again keeps its first read time (coalesce) and still
  // succeeds. 404 only when the row is not this user's — someone else's id looks like no id.
  async markRead(id: string): Promise<void> {
    const updated = await this.withTenant((tx) =>
      tx
        .update(notifications)
        .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
        .where(and(mine(), eq(notifications.id, id)))
        .returning({ id: notifications.id }),
    );
    if (updated.length === 0) throw notFound('Notification');
  }

  async markAllRead(): Promise<void> {
    await this.withTenant((tx) =>
      tx
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(and(mine(), isNull(notifications.readAt))),
    );
  }
}
```

- **`mine()` is the security of this module.** RLS separates tenants, but two people of the same workspace share a
  tenant. Without the user filter, anyone could read or clear a colleague's notifications. Tested by removing it:
  four tests fail.
- The cursor is `[created_at as text, id]`, exactly like the audit log (step 6): text keeps Postgres's
  microseconds, which a JS `Date` would round away, losing or repeating rows at page borders.
- `markRead` uses `coalesce(read_at, now())`: the first read time stays. A second call is still a success (204)
  — the client does not need to know whether it was already read.
- **Someone else's id gives 404, not 403.** A 403 would confirm that the id exists.
- No `audit()`: reading a notification is not a change to the business's data.

**File: `apps/api/src/notifications/notifications.controller.ts`** (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { NotificationsService } from './notifications.service.js';

type Routes = typeof routes.notifications;

@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Endpoint(routes.notifications.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.notifications.list(query);
  }

  @Endpoint(routes.notifications.unreadCount)
  async unreadCount(): Promise<RouteResponse<Routes['unreadCount']>> {
    return { count: await this.notifications.unreadCount() };
  }

  @Endpoint(routes.notifications.markRead)
  markRead({ params }: RouteInput<Routes['markRead']>): Promise<void> {
    return this.notifications.markRead(params.id);
  }

  @Endpoint(routes.notifications.markAllRead)
  markAllRead(): Promise<void> {
    return this.notifications.markAllRead();
  }
}
```

**File: `apps/api/src/notifications/notifications.module.ts`** (new)

```ts
import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

// Reading and clearing notifications. Creating them is the worker's job (notify.ts), inside the
// same transaction as the work they report on.
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
```

### Invitations: emit instead of deliver

**File: `apps/api/src/invitations/invitations.service.ts`** (change)

```diff
@@ -4,8 +4,8 @@ import {
   type AcceptInvitationInput,
   type CreateInvitationInput,
   type Invitation,
+  type InvitationDelivery,
   INVITATION_TTL_DAYS,
-  invitationLink,
   type InvitationPreview,
   type RoleRef,
 } from '@omnivo/contracts';
@@ -25,15 +25,13 @@ import { AuthService } from '../auth/auth.service.js';
 import { audit, created } from '../common/audit/audit.js';
 import { isUniqueViolation } from '../common/db/pg-errors.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
+import { emit } from '../common/outbox/outbox.js';
 import { currentPrincipal, getTenantId, runWithTenant } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
-import type { Config } from '../config.js';
-import { AUTH, CONFIG, DB, WITH_TENANT } from '../infra/tokens.js';
-import { invitationEmail } from '../mail/invitation-email.js';
-import { MailService } from '../mail/mail.service.js';
+import { AUTH, DB, WITH_TENANT } from '../infra/tokens.js';
 import { assertCanGrant, loadRoles } from '../rbac/grants.js';
 import { PermissionService } from '../rbac/permission.service.js';
-import { hashInvitationToken, newInvitationToken } from './invitation-token.js';
+import { hashInvitationToken } from './invitation-token.js';
 
 type InvitationRow = typeof invitations.$inferSelect;
 
@@ -48,6 +46,12 @@ function isUsable(row: InvitationRow): boolean {
   return row.acceptedAt === null && row.revokedAt === null && row.expiresAt > new Date();
 }
 
+// The email's state, from the two times the worker sets
+function deliveryOf(row: Pick<InvitationRow, 'sentAt' | 'sendFailedAt'>): InvitationDelivery {
+  if (row.sentAt !== null) return 'sent';
+  return row.sendFailedAt !== null ? 'failed' : 'sending';
+}
+
 function names(list: readonly { name: string }[]): string | null {
   return list.length === 0 ? null : list.map((role) => role.name).join(', ');
 }
@@ -80,10 +84,8 @@ export class InvitationsService {
     @Inject(DB) private readonly db: Db,
     @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
     @Inject(AUTH) private readonly auth: Auth,
-    @Inject(CONFIG) private readonly config: Config,
     private readonly authService: AuthService,
     private readonly permissionService: PermissionService,
-    private readonly mail: MailService,
   ) {}
 
   list(): Promise<Invitation[]> {
@@ -94,11 +96,9 @@ export class InvitationsService {
     const tenantId = getTenantId();
     const actor = currentPrincipal();
     const access = await this.permissionService.ofCurrentUser();
-    const { token, hash } = newInvitationToken();
 
-    let invitationId: string;
     try {
-      invitationId = await this.withTenant(async (tx) => {
+      return await this.withTenant(async (tx) => {
         const granted = await loadRoles(tx, tenantId, input.roleIds);
         // invite = ভবিষ্যতে রোল দেওয়া — তাই এখনই একই নিয়ম (grants.ts)
         assertCanGrant(access, granted);
@@ -137,10 +137,10 @@ export class InvitationsService {
 
         const [row] = await tx
           .insert(invitations)
+          // No token yet: the worker makes it right before sending (tokenHash stays NULL until then)
           .values({
             tenantId,
             email: input.email,
-            tokenHash: hash,
             expiresAt: expiry(),
             createdBy: actor.userId,
           })
@@ -160,15 +160,18 @@ export class InvitationsService {
           entityId: row.id,
           changes: created({ email: input.email, roles: names(granted) }),
         });
-        return row.id;
+        // The email goes out from the worker a moment after this commits. The answer below says
+        // "sending"; the team page polls until it turns into "sent" or "failed".
+        await emit(tx, 'invitation.issued', { invitationId: row.id, actorUserId: actor.userId });
+        const [invitation] = await this.readOpen(tx, [row.id]);
+        if (!invitation) throw notFound('Invitation');
+        return invitation;
       });
     } catch (error) {
       // দুজন admin একসাথে একই ইমেইল — partial unique index একজনকে আটকায় (আগে SELECT করে দেখা না)
       if (isUniqueViolation(error, 'invitations_tenant_email_open_idx')) throw alreadyInvited();
       throw error;
     }
-
-    return this.deliver(invitationId, token, hash);
   }
 
   // নতুন token (পুরনো লিংক সাথে সাথে অচল), নতুন মেয়াদ, আবার ইমেইল। ইমেইল হারানো, মেয়াদ পেরোনো বা
@@ -177,19 +180,21 @@ export class InvitationsService {
     const tenantId = getTenantId();
     const actor = currentPrincipal();
     const access = await this.permissionService.ofCurrentUser();
-    const { token, hash } = newInvitationToken();
 
-    await this.withTenant(async (tx) => {
+    return this.withTenant(async (tx) => {
       const before = await this.lockOpen(tx, id);
       if (before.version !== version) throw versionConflict();
       // আবার পাঠানো = আবার রোল দেওয়ার প্রস্তাব; যে পাঠাচ্ছে তার সীমায় থাকতে হবে
       assertCanGrant(access, await loadRoles(tx, tenantId, await this.roleIdsOf(tx, id)));
       await tx
         .update(invitations)
+        // tokenHash NULL: the old link stops working now, not when the new email arrives.
+        // sentAt and sendFailedAt NULL: the state goes back to "sending"
         .set({
-          tokenHash: hash,
+          tokenHash: null,
           expiresAt: expiry(),
           sentAt: null,
+          sendFailedAt: null,
           version: sql`${invitations.version} + 1`,
           updatedBy: actor.userId,
         })
@@ -201,9 +206,11 @@ export class InvitationsService {
         // নতুন লিংক কাকে গেল — viewer-এ "Email: — → nasrin@…"
         changes: created({ email: before.email }),
       });
+      await emit(tx, 'invitation.issued', { invitationId: id, actorUserId: actor.userId });
+      const [invitation] = await this.readOpen(tx, [id]);
+      if (!invitation) throw notFound('Invitation');
+      return invitation;
     });
-
-    return this.deliver(id, token, hash);
   }
 
   async revoke(id: string, version: number): Promise<void> {
@@ -368,6 +375,8 @@ export class InvitationsService {
       actorUserId: userId,
       changes: created({ email: invitation.email, roles: names(granted) }),
     });
+    // The inviter hears about it in the bell (worker, MemberJoinedHandler)
+    await emit(tx, 'member.joined', { membershipId, inviterId: invitation.createdBy });
   }
 
   // token দিয়ে খোঁজা, টেন্যান্ট জানার আগে। invitations-এ FORCE RLS; migration 0010-এর invitation_by_token
@@ -382,56 +391,6 @@ export class InvitationsService {
     return row;
   }
 
-  // commit-এর পরে ইমেইল — transaction-এর ভেতরে পাঠালে দুটো ভুল হতে পারত: চিঠি চলে গেল কিন্তু পরে
-  // rollback (লিংক অচল), অথবা ধীর SMTP পুরো সময় DB-র lock ধরে রাখল। ধাপ ৮-এর outbox এটাকে পাকা করবে
-  private async deliver(id: string, token: string, hash: string): Promise<Invitation> {
-    const tenantId = getTenantId();
-    const [context] = await this.withTenant((tx) =>
-      tx
-        .select({
-          email: invitations.email,
-          workspaceName: tenants.name,
-          inviterName: users.fullName,
-          language: users.language,
-        })
-        .from(invitations)
-        .innerJoin(tenants, eq(tenants.id, invitations.tenantId))
-        .innerJoin(users, eq(users.id, currentPrincipal().userId))
-        .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, id))),
-    );
-    if (!context) throw notFound('Invitation');
-
-    const sent = await this.mail.send(
-      invitationEmail({
-        to: context.email,
-        workspaceName: context.workspaceName,
-        inviterName: context.inviterName,
-        link: invitationLink(this.config.appOrigin, token),
-        language: context.language ?? 'en',
-      }),
-    );
-
-    return this.withTenant(async (tx) => {
-      if (sent) {
-        // token_hash-ও শর্তে: পাঠানোর মাঝে আরেকজন "Resend" করলে সেটা নতুন token — আমাদের পাঠানো পুরনো
-        // লিংকের "পাঠানো হয়েছে" নতুনটার গায়ে বসত না
-        await tx
-          .update(invitations)
-          .set({ sentAt: new Date() })
-          .where(
-            and(
-              eq(invitations.tenantId, tenantId),
-              eq(invitations.id, id),
-              eq(invitations.tokenHash, hash),
-            ),
-          );
-      }
-      const [invitation] = await this.readOpen(tx, [id]);
-      if (!invitation) throw notFound('Invitation');
-      return invitation;
-    });
-  }
-
   private async lockOpen(tx: Transaction, id: string): Promise<InvitationRow> {
     const [row] = await tx
       .select()
@@ -515,7 +474,7 @@ export class InvitationsService {
         invitation.createdBy !== null && inviterName !== null
           ? { id: invitation.createdBy, fullName: inviterName }
           : null,
-      sentAt: invitation.sentAt?.toISOString() ?? null,
+      delivery: deliveryOf(invitation),
       expiresAt: invitation.expiresAt.toISOString(),
       createdAt: invitation.createdAt.toISOString(),
       version: invitation.version,
```

- **`deliver()` is gone**, with the `CONFIG`, `MailService` and `invitationEmail` it needed. The service does not
  know email exists; it states that an invitation was issued.
- `create`: the invitation is inserted without a `tokenHash`, and the answer is read **inside** the same
  transaction (`readOpen(tx, …)`). Before, a second transaction read it after the email.
- `resend`: `tokenHash: null` kills the old link **now**. Waiting for the new email would leave the old link
  working for a few more seconds after the admin decided it should stop. `sendFailedAt: null` puts the state back
  to "sending".
- `join`: `member.joined` with the invitation's `createdBy`. It is emitted inside the join's transaction: a join
  that rolls back (the invitation was revoked a moment earlier) tells nobody anything.
- `deliveryOf()` turns the two timestamps into the contract's three states. `sent_at` wins: a row that was sent is
  "sent", even if an older attempt had failed.

### Sign-up and `/auth/me`

**File: `apps/api/src/auth/auth.service.ts`** (change)

```diff
@@ -30,6 +30,7 @@ import {
 import { audit, created } from '../common/audit/audit.js';
 import { isUniqueViolation } from '../common/db/pg-errors.js';
 import { accessRevoked, AppError } from '../common/http/app-error.js';
+import { emit } from '../common/outbox/outbox.js';
 import { runWithTenant } from '../common/tenant/tenant-context.js';
 import { setTenantContext, type WithTenant } from '../common/tenant/with-tenant.js';
 import type { WithUser } from '../common/tenant/with-user.js';
@@ -250,7 +251,12 @@ export class AuthService {
       .from(users)
       .where(eq(users.id, principal.userId));
     const [tenant] = await this.db
-      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
+      .select({
+        id: tenants.id,
+        name: tenants.name,
+        slug: tenants.slug,
+        setupStatus: tenants.setupStatus,
+      })
       .from(tenants)
       .where(eq(tenants.id, principal.tenantId));
     if (!user || !tenant) throw sessionEnded();
@@ -428,6 +434,9 @@ export class AuthService {
         actorUserId: userId,
         changes: created({ name: input.companyName, slug: input.workspaceSlug }),
       });
+      // The welcome email: queued in this transaction, sent by the worker after the commit.
+      // Sign-up no longer waits for a mail server, and cannot fail because of one.
+      await emit(tx, 'workspace.created', { userId });
 
       return { tenantId: tenant.id, membershipId: membership.id, roles: [OWNER_ROLE_NAME] };
     });
```

- The welcome email is emitted inside `provisionWorkspace`'s transaction. If sign-up fails after it (the slug race
  from step 3), the event rolls back with everything else: no welcome email for a workspace that does not exist.
- Sign-up no longer depends on the mail server in any way. That was true for invitations in step 7 already (sent
  after the commit); now sign-up does not even wait for the send.

### Wiring

**File: `apps/api/src/infra/infra.module.ts`** (change)

```diff
@@ -12,7 +12,6 @@ import { Redis } from 'ioredis';
 import { createWithTenant } from '../common/tenant/with-tenant.js';
 import { createWithUser } from '../common/tenant/with-user.js';
 import type { Config } from '../config.js';
-import { MailService } from '../mail/mail.service.js';
 import { StorageService } from '../storage/storage.service.js';
 import { AUTH, CONFIG, DB, REDIS, WITH_TENANT, WITH_USER } from './tokens.js';
 
@@ -52,9 +51,8 @@ export class InfraModule implements OnApplicationShutdown {
         { provide: REDIS, useFactory: () => createRedis(config.redisUrl) },
         { provide: AUTH, inject: [DB], useFactory: (db: Db) => createAuth({ db, ...config.auth }) },
         StorageService,
-        MailService,
       ],
-      exports: [CONFIG, DB, WITH_TENANT, WITH_USER, REDIS, AUTH, StorageService, MailService],
+      exports: [CONFIG, DB, WITH_TENANT, WITH_USER, REDIS, AUTH, StorageService],
     };
   }
 
```

**File: `apps/api/src/app.module.ts`** (change)

```diff
@@ -21,11 +21,13 @@ import { HealthController } from './health/health.controller.js';
 import { InfraModule } from './infra/infra.module.js';
 import { InvitationsModule } from './invitations/invitations.module.js';
 import { MembersModule } from './members/members.module.js';
+import { NotificationsModule } from './notifications/notifications.module.js';
 import { NumberingModule } from './numbering/numbering.module.js';
 import { PermissionGuard } from './rbac/permission.guard.js';
 import { RbacModule } from './rbac/rbac.module.js';
 import { RolesModule } from './roles/roles.module.js';
 import { SettingsModule } from './settings/settings.module.js';
+import { SetupModule } from './setup/setup.module.js';
 
 @Module({})
 export class AppModule implements NestModule {
@@ -45,6 +47,8 @@ export class AppModule implements NestModule {
         NumberingModule,
         AuditModule,
         AttachmentsModule,
+        SetupModule,
+        NotificationsModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

---

## 8.7 — Module boundaries: only the worker touches the queue

**File: `.dependency-cruiser.cjs`** (change)

```diff
@@ -42,11 +42,37 @@ module.exports = {
         dependencyTypesNot: ['dynamic-import'],
       },
     },
-    // Module boundary rules inside apps/api (accounting must not import inventory internals,
-    // etc.) get added as the modular monolith takes shape — steps 6-8.
+    {
+      name: 'queue-only-in-worker',
+      severity: 'error',
+      comment:
+        'The API hands work to the worker by writing an outbox row with emit(), in the same transaction as the change. A job put on the queue straight from a request is lost when that transaction rolls back after it, or runs before the data it needs is committed.',
+      from: {
+        path: '^apps/api/src/',
+        pathNot: ['^apps/api/src/worker/', '^apps/api/src/worker\\.ts$', '\\.spec\\.ts$'],
+      },
+      to: { path: 'node_modules/bullmq/' },
+    },
+    {
+      name: 'api-not-to-worker',
+      severity: 'error',
+      comment:
+        'worker/ is the other process (relay, queues, job runner). Feature code provides handlers that worker/ imports; it never imports worker/ itself, so the HTTP process never starts queue workers by accident.',
+      from: {
+        path: '^apps/api/src/',
+        pathNot: ['^apps/api/src/worker/', '^apps/api/src/worker\\.ts$', '^apps/api/src/testing/'],
+      },
+      to: { path: '^apps/api/src/worker/' },
+    },
+    // More module boundary rules inside apps/api (accounting must not import inventory internals,
+    // etc.) get added as the modular monolith takes shape.
   ],
   options: {
     doNotFollow: { path: 'node_modules' },
-    exclude: { path: '(^|/)(node_modules|dist|build|coverage)(/|$)' },
+    // Only our own build output. node_modules must stay in the graph (doNotFollow above already
+    // stops the cruise there): excluding it — or any path with /dist/ in it, which is where most
+    // packages keep their code — removed the packages themselves, so rules that point at a package
+    // (contracts-only-zod, queue-only-in-worker) could never fire.
+    exclude: { path: '^(apps|packages)/[^/]+/(dist|dist-worker|build|coverage)/' },
   },
 };
```

- **`queue-only-in-worker`** makes decision 5 a CI error. A developer who writes `queue.add()` in a service fails
  `pnpm boundaries`, with the reason in the message.
- **`api-not-to-worker`**: feature code provides handlers; `worker/` imports them, never the other way. Otherwise
  the HTTP process could start queue workers by importing the wrong file. `testing/` may import it (the tests
  start a worker).
- **The `exclude` fix, found while testing the rule above.** The first run of the new rule caught nothing, even
  with a `bullmq` import planted on purpose. The reason: `exclude: '(^|/)(node_modules|dist|…)'` removed every
  package from the graph, and then `(^|/)dist/` also removed most packages' code (BullMQ lives in
  `node_modules/…/bullmq/dist/`). So a rule that points at a package could never match. That includes step 5's
  `contracts-only-zod`: until now, contracts could have imported `drizzle-orm`, and CI would have stayed green.
  Now only our own build folders are excluded. `doNotFollow` (already set) still stops the cruise at a package's
  edge, so the scan stays fast.
- Checked by breaking it: a `bullmq` import in `setup/` → `queue-only-in-worker`; a `drizzle-orm` import in
  contracts → `contracts-only-zod`; a `worker/` import in `setup/` → `api-not-to-worker`.
- A gap that remains: `packages/ui` importing `@omnivo/db` is not caught by the path rule, because workspace
  packages resolve to their `dist/` (excluded). Today that import fails the type check anyway, because `ui` does
  not depend on `db`. It is noted for later (the end of this guide).

---

## 8.8 — The API's tests

### The harness

**File: `apps/api/src/testing/app.ts`** (whole file)

```ts
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { INestApplicationContext } from '@nestjs/common';

import { AppModule } from '../app.module.js';
import { type Config, loadConfig, loadWorkerConfig, type WorkerConfig } from '../config.js';
import { configureApp, createAdapter } from '../configure-app.js';
import { WorkerModule } from '../worker/worker.module.js';

// .env না পড়ে টেস্টের নিজস্ব মান — loadConfig দিয়ে গেলে production-এর একই যাচাই চলে
// storageUrl না দিলে অচল ঠিকানা — যে টেস্ট ফাইল ছোঁয় না তার জন্য MinIO container তুলতে হয় না
export function testConfig(urls: {
  databaseUrl: string;
  redisUrl: string;
  storageUrl?: string;
}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urls.databaseUrl,
    REDIS_URL: urls.redisUrl,
    API_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: 'http://localhost:5173',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32-bytes',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-bytes',
    S3_ENDPOINT: urls.storageUrl ?? 'http://127.0.0.1:1',
    S3_ACCESS_KEY_ID: 'omnivo',
    S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
  });
}

export async function createTestApp(config: Config): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    createAdapter(),
    { logger: false },
  );
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

// The worker's config, checked like production's, but fast: the relay looks every 50 ms and a
// failed job gives up after 2 quick tries, so a test waits well under a second for either. With
// no mailUrl the SMTP address is dead (port 1): every send fails at once, which is how the tests
// see "Email not sent".
export function testWorkerConfig(urls: {
  databaseUrl: string;
  workerDatabaseUrl: string;
  redisUrl: string;
  mailUrl?: string;
}): WorkerConfig {
  const config = loadWorkerConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urls.databaseUrl,
    WORKER_DATABASE_URL: urls.workerDatabaseUrl,
    REDIS_URL: urls.redisUrl,
    APP_ORIGIN: 'http://localhost:5173',
    SMTP_URL: urls.mailUrl ?? 'smtp://127.0.0.1:1',
  });
  return {
    ...config,
    relay: { ...config.relay, idleMs: 50, publishTimeoutMs: 500 },
    retry: { attempts: 2, backoffMs: 50 },
  };
}

// The real worker, in the test's own process: relay, queues and handlers exactly as in
// production — only the timings above differ
export async function createTestWorker(config: WorkerConfig): Promise<INestApplicationContext> {
  const worker = await NestFactory.createApplicationContext(WorkerModule.register(config), {
    logger: process.env.DEBUG_WORKER ? ['log', 'warn', 'error'] : false,
  });
  await worker.init();
  return worker;
}

// Waits until check() stops throwing — for things the worker does a moment later (an email in
// Mailpit, a status that turns 'ready'). Fails with check()'s own error after the timeout, which
// is below vitest's 5-second test timeout: then the report shows the real assertion, and no loop
// keeps running in the background after the test has already been given up.
export async function eventually<T>(check: () => Promise<T>, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
```

- `testConfig` lost `mailUrl`: the API has no SMTP setting any more. (An `SMTP_URL` passed in would only be
  dropped by the schema, and a test that sets it would suggest the API still sends email.)
- **`testWorkerConfig` goes through `loadWorkerConfig`**, like production, and only then changes the timings. The
  relay looks every 50 ms and a job gives up after two quick tries, so "wait for the worker" takes well under a
  second in a test.
- **`createTestWorker` is the real `WorkerModule`**, in the test's own process: the relay, both queues and all
  handlers. Only the timings differ from production.
- The worker's logger is off, unless `DEBUG_WORKER=1`. That switch helped find the shutdown problems below; keep
  it for your own debugging.
- **`eventually` stops after 4 seconds, below vitest's 5-second test timeout.** A first version waited 10 seconds.
  When a check really failed, vitest gave up on the test at 5 seconds, but the loop kept running in the
  background, and the report showed a timeout instead of the real assertion. Now the loop fails first, with the
  check's own message.

**File: `apps/api/src/testing/containers.ts`** (change)

```diff
@@ -15,6 +15,8 @@ export interface TestPostgres {
   container: StartedPostgreSqlContainer;
   superuserUrl: string;
   appUrl: string;
+  // omnivo_worker — the outbox relay's role
+  workerUrl: string;
 }
 
 // docker-compose-এর মতোই: superuser দিয়ে role, migrator দিয়ে migration + permission sync
@@ -48,6 +50,7 @@ export async function startPostgres(): Promise<TestPostgres> {
     container,
     superuserUrl: container.getConnectionUri(),
     appUrl: urlFor('omnivo_app', 'app_dev_password'),
+    workerUrl: urlFor('omnivo_worker', 'worker_dev_password'),
   };
 }
 
```

- The role itself comes from `01-roles.sql`, which `startPostgres()` already runs. Only its URL is new.

**File: `apps/api/src/testing/mailpit.ts`** (new)

```ts
import { z } from 'zod';

// Mailpit-এর HTTP API — বাইরের ডেটা, তাই schema দিয়ে পড়া (cast না)
const mailboxSchema = z.object({
  messages: z.array(
    z.object({
      ID: z.string(),
      Subject: z.string(),
      To: z.array(z.object({ Address: z.string() })),
    }),
  ),
});
const messageSchema = z.object({ Text: z.string(), HTML: z.string() });

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

// The newest email to this address (Mailpit lists newest first). Throws when there is none yet —
// wrap it in eventually(): the worker sends a moment after the request has answered.
export async function lastMailTo(apiUrl: string, address: string): Promise<Mail> {
  const mailbox = mailboxSchema.parse(await (await fetch(`${apiUrl}/api/v1/messages`)).json());
  const found = mailbox.messages.find((message) => message.To.some((to) => to.Address === address));
  if (!found) throw new Error(`no mail to ${address}`);
  const message = messageSchema.parse(
    await (await fetch(`${apiUrl}/api/v1/message/${found.ID}`)).json(),
  );
  return { subject: found.Subject, text: message.Text, html: message.HTML };
}

export function invitationTokenOf(mail: Mail): string {
  const token = /http:\/\/localhost:5173\/invite#([\w-]+)/.exec(mail.text)?.[1];
  if (!token) throw new Error('no invitation link in the mail');
  return token;
}
```

- Moved out of the invitation test, because the setup test reads the welcome email too.
- `lastMailTo` throws when there is no email yet. Wrapped in `eventually`, that means "wait until it arrives".

### Invitations, with the worker

**File: `apps/api/src/invitations/invitations.int.spec.ts`** (whole file)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type Invitation,
  invitationListSchema,
  invitationPreviewSchema,
  invitationSchema,
  memberPageSchema,
  meResponseSchema,
  notificationPageSchema,
  problemSchema,
  type Role,
  roleSchema,
  settingsSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startMail,
  startPostgres,
  startRedis,
  type TestMail,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, refreshCookieOf, type SignedIn, sessionOf, signUp } from '../testing/http.js';
import { invitationTokenOf, lastMailTo } from '../testing/mailpit.js';
import { hashInvitationToken } from './invitation-token.js';

let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
let accountant: Role;
let merchandiser: Role;

function startWorker(mailUrl?: string): Promise<INestApplicationContext> {
  return createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      ...(mailUrl !== undefined && { mailUrl }),
    }),
  );
}

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  // The API does not send email any more — the worker does, from the outbox
  worker = await startWorker(mail.smtpUrl);
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  // বিদ্যমান অ্যাকাউন্ট: Karim-এর নিজের workspace আছে, পরে Rahman Garments-এ invite হবে
  await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });

  accountant = roleSchema.parse(
    (await send('POST', '/roles', { name: 'Accountant', description: '' })).json(),
  );
  merchandiser = roleSchema.parse(
    (await send('POST', '/roles', { name: 'Merchandiser', description: '' })).json(),
  );
  await send('PUT', '/permission-matrix', {
    roles: [{ id: accountant.id, version: accountant.version, permissions: ['core.user.read'] }],
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as: SignedIn | null = owner,
) {
  return app.inject({
    method,
    url,
    ...(as && { headers: bearer(as.accessToken) }),
    ...(payload && { payload }),
  });
}

async function invite(email: string, roleIds: string[]) {
  const res = await send('POST', '/invitations', { email, roleIds });
  expect(res.statusCode).toBe(201);
  return invitationSchema.parse(res.json());
}

async function openInvitation(email: string): Promise<Invitation> {
  const { items } = invitationListSchema.parse((await send('GET', '/invitations')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`no open invitation for ${email}`);
  return found;
}

// The newest link sent to this address, waiting for the worker to send it
async function tokenSentTo(address: string, notToken?: string): Promise<string> {
  return eventually(async () => {
    const token = invitationTokenOf(await lastMailTo(mail.apiUrl, address));
    if (token === notToken) throw new Error('still the old email');
    return token;
  });
}

function lookup(token: string) {
  return send('POST', '/invitations/lookup', { token }, null);
}

function accept(payload: object) {
  return send('POST', '/invitations/accept', payload, null);
}

describe('inviting', () => {
  it('answers at once with "sending", then the worker emails a one-time link', async () => {
    const invitation = await invite(' Tanvir@RahmanGarments.com ', [accountant.id]);
    expect(invitation).toMatchObject({
      email: 'tanvir@rahmangarments.com',
      roles: [{ id: accountant.id, name: 'Accountant' }],
      invitedBy: { fullName: 'Farhana Rahman' },
      delivery: 'sending',
    });

    const sent = await eventually(() => lastMailTo(mail.apiUrl, 'tanvir@rahmangarments.com'));
    expect(sent.subject).toBe('Farhana Rahman invited you to Rahman Garments Ltd. on Omnivo');
    await eventually(async () => {
      expect((await openInvitation('tanvir@rahmangarments.com')).delivery).toBe('sent');
    });

    // DB-তে token নিজে নেই, শুধু তার hash — and the outbox row holds ids only, never the token
    const token = invitationTokenOf(sent);
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    const [row] = await superuser<{ token_hash: string }[]>`
      SELECT token_hash FROM invitations WHERE email = 'tanvir@rahmangarments.com'`;
    const outbox = await superuser<{ payload: unknown }[]>`
      SELECT payload FROM outbox_events WHERE type = 'invitation.issued'`;
    await superuser.end();
    expect(row?.token_hash).toBe(hashInvitationToken(token));
    expect(JSON.stringify(outbox)).not.toContain(token);
    expect(JSON.stringify(outbox)).not.toContain('tanvir@');
  });

  it('escapes names in the HTML mail, so a company name cannot become a link', async () => {
    await send('PUT', '/settings', {
      ...(await currentSettings()),
      companyName: '<a href="https://evil.example">Rahman</a>',
    });
    await invite('rupa@rahmangarments.com', [merchandiser.id]);
    const sent = await eventually(() => lastMailTo(mail.apiUrl, 'rupa@rahmangarments.com'));
    expect(sent.html).not.toContain('<a href="https://evil.example">');
    expect(sent.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
    await send('PUT', '/settings', {
      ...(await currentSettings()),
      companyName: 'Rahman Garments Ltd.',
    });
  });

  it('refuses a second open invitation, and someone already in the workspace', async () => {
    const twice = await send('POST', '/invitations', {
      email: 'tanvir@rahmangarments.com',
      roleIds: [merchandiser.id],
    });
    expect(twice.statusCode).toBe(409);
    expect(problemSchema.parse(twice.json()).fieldErrors).toEqual({ email: ['already_invited'] });

    const member = await send('POST', '/invitations', {
      email: 'farhana@rahmangarments.com',
      roleIds: [merchandiser.id],
    });
    expect(member.statusCode).toBe(409);
    expect(problemSchema.parse(member.json()).fieldErrors).toEqual({ email: ['already_member'] });

    const noRole = await send('POST', '/invitations', {
      email: 'shafiq@rahmangarments.com',
      roleIds: [],
    });
    expect(problemSchema.parse(noRole.json()).fieldErrors).toEqual({ roleIds: ['role_required'] });
  });
});

describe('accepting', () => {
  it('shows who invited whom, then creates the account and signs in', async () => {
    const token = await tokenSentTo('tanvir@rahmangarments.com');
    const preview = invitationPreviewSchema.parse((await lookup(token)).json());
    expect(preview).toMatchObject({
      workspace: { name: 'Rahman Garments Ltd.', slug: 'rahman-garments' },
      email: 'tanvir@rahmangarments.com',
      invitedBy: 'Farhana Rahman',
      accountExists: false,
    });

    const res = await accept({
      account: 'new',
      token,
      fullName: 'Tanvir Hossain',
      password: 'Konabari-cut-2026',
    });
    expect(res.statusCode).toBe(200);
    // লগইনের মতোই: refresh token শুধু cookie-তে
    expect(refreshCookieOf(res)).toBeTruthy();
    const me = meResponseSchema.parse(
      (await send('GET', '/auth/me', undefined, sessionOf(res))).json(),
    );
    expect(me).toMatchObject({
      user: { fullName: 'Tanvir Hossain', email: 'tanvir@rahmangarments.com' },
      tenant: { slug: 'rahman-garments' },
      roles: ['Accountant'],
      permissions: ['core.user.read'],
    });

    const { items } = invitationListSchema.parse((await send('GET', '/invitations')).json());
    expect(items.map((item) => item.email)).not.toContain('tanvir@rahmangarments.com');
    const audit = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=member')).json(),
    );
    expect(audit.items[0]).toMatchObject({
      action: 'member.joined',
      actor: { fullName: 'Tanvir Hossain' },
      changes: { roles: { from: null, to: 'Accountant' } },
    });
  });

  it('tells the inviter in the bell', async () => {
    const page = await eventually(async () => {
      const list = notificationPageSchema.parse((await send('GET', '/notifications')).json());
      if (!list.items.some((item) => item.type === 'member.joined')) throw new Error('not yet');
      return list;
    });
    expect(page.items.find((item) => item.type === 'member.joined')).toMatchObject({
      params: { name: 'Tanvir Hossain' },
      readAt: null,
    });
  });

  it('works only once', async () => {
    const token = await tokenSentTo('tanvir@rahmangarments.com');
    const res = await lookup(token);
    expect(res.statusCode).toBe(404);
    expect(problemSchema.parse(res.json()).code).toBe('invitation_invalid');
  });

  it('adds an existing account only after checking its password', async () => {
    await invite('karim@karimpharma.com', [merchandiser.id]);
    const token = await tokenSentTo('karim@karimpharma.com');
    expect(invitationPreviewSchema.parse((await lookup(token)).json()).accountExists).toBe(true);

    const wrong = await accept({ account: 'existing', token, password: 'not-his-password' });
    expect(wrong.statusCode).toBe(401);
    expect(problemSchema.parse(wrong.json()).code).toBe('invalid_credentials');
    // "নতুন অ্যাকাউন্ট" দিয়ে অন্যের ইমেইল দখল করা যায় না
    const hijack = await accept({
      account: 'new',
      token,
      fullName: 'Someone Else',
      password: 'Takeover-2026',
    });
    expect(hijack.statusCode).toBe(409);
    expect(problemSchema.parse(hijack.json()).code).toBe('email_taken');

    const res = await accept({ account: 'existing', token, password: 'Batch-expiry-2026' });
    expect(res.statusCode).toBe(200);
    const me = meResponseSchema.parse(
      (await send('GET', '/auth/me', undefined, sessionOf(res))).json(),
    );
    expect(me.tenant.slug).toBe('rahman-garments');
    expect(me.memberships.map((membership) => membership.slug)).toEqual([
      'karim-pharma',
      'rahman-garments',
    ]);
  });

  it('brings a removed member back on the same membership, with only the new roles', async () => {
    const before = memberPageSchema
      .parse((await send('GET', '/members')).json())
      .items.find((member) => member.email === 'tanvir@rahmangarments.com');
    if (!before) throw new Error('setup: Tanvir missing');
    const removed = await send(
      'DELETE',
      `/members/${before.membershipId}?version=${String(before.version)}`,
    );
    expect(removed.statusCode).toBe(204);

    const used = await tokenSentTo('tanvir@rahmangarments.com');
    await invite('tanvir@rahmangarments.com', [merchandiser.id]);
    const token = await tokenSentTo('tanvir@rahmangarments.com', used);
    const res = await accept({ account: 'existing', token, password: 'Konabari-cut-2026' });
    expect(res.statusCode).toBe(200);

    const after = memberPageSchema
      .parse((await send('GET', '/members')).json())
      .items.find((member) => member.email === 'tanvir@rahmangarments.com');
    expect(after?.membershipId).toBe(before.membershipId);
    expect(after?.roles.map((role) => role.name)).toEqual(['Merchandiser']);
  });
});

describe('resending and revoking', () => {
  it('kills the old link at once on resend, then sends a fresh one', async () => {
    const first = await tokenSentTo('rupa@rahmangarments.com');
    const rupa = await openInvitation('rupa@rahmangarments.com');

    const res = await send('POST', `/invitations/${rupa.id}/resend`, { version: rupa.version });
    expect(res.statusCode).toBe(200);
    expect(invitationSchema.parse(res.json())).toMatchObject({
      version: rupa.version + 1,
      delivery: 'sending',
    });
    // Before the new email even exists: the old link is already dead (token_hash is NULL)
    expect((await lookup(first)).statusCode).toBe(404);

    const second = await tokenSentTo('rupa@rahmangarments.com', first);
    expect((await lookup(second)).statusCode).toBe(200);
  });

  it('closes the link on revoke', async () => {
    await eventually(async () => {
      expect((await openInvitation('rupa@rahmangarments.com')).delivery).toBe('sent');
    });
    const token = invitationTokenOf(await lastMailTo(mail.apiUrl, 'rupa@rahmangarments.com'));
    const rupa = await openInvitation('rupa@rahmangarments.com');
    const res = await send('DELETE', `/invitations/${rupa.id}?version=${String(rupa.version)}`);
    expect(res.statusCode).toBe(204);
    expect((await lookup(token)).statusCode).toBe(404);
    expect(
      invitationListSchema.parse((await send('GET', '/invitations')).json()).items,
    ).toHaveLength(0);
  });

  it('replaces an expired invitation instead of blocking a new one', async () => {
    await invite('mahbub@rahmangarments.com', [merchandiser.id]);
    const token = await tokenSentTo('mahbub@rahmangarments.com');
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    await superuser`
      UPDATE invitations SET expires_at = now() - interval '1 day'
      WHERE email = 'mahbub@rahmangarments.com'`;
    await superuser.end();
    expect((await lookup(token)).statusCode).toBe(404);

    const again = await invite('mahbub@rahmangarments.com', [merchandiser.id]);
    expect(again.delivery).toBe('sending');
  });
});

describe('when the mail server is down', () => {
  it('still creates the invitation, then says "failed" and tells the sender', async () => {
    // The same queues, but now served by a worker whose SMTP address is dead
    await worker.close();
    worker = await startWorker();

    const invitation = await invite('sharmin@rahmangarments.com', [merchandiser.id]);
    expect(invitation.delivery).toBe('sending');
    await eventually(async () => {
      expect((await openInvitation('sharmin@rahmangarments.com')).delivery).toBe('failed');
    });
    const { items } = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(items[0]).toMatchObject({
      type: 'invitation.failed',
      params: { email: 'sharmin@rahmangarments.com' },
    });
  });

  it('sends it on Resend once the mail server is back', async () => {
    await worker.close();
    worker = await startWorker(mail.smtpUrl);

    const failed = await openInvitation('sharmin@rahmangarments.com');
    const res = await send('POST', `/invitations/${failed.id}/resend`, {
      version: failed.version,
    });
    expect(invitationSchema.parse(res.json()).delivery).toBe('sending');
    await tokenSentTo('sharmin@rahmangarments.com');
    await eventually(async () => {
      expect((await openInvitation('sharmin@rahmangarments.com')).delivery).toBe('sent');
    });
  });
});

// PUT /settings-এর body = GET-এর উত্তর (version সহ); বাড়তি logo ঘর চুক্তির schema নিজেই ফেলে দেয়
async function currentSettings() {
  return settingsSchema.parse((await send('GET', '/settings')).json());
}
```

What changed, and why:

- The API and the worker run side by side, like `pnpm dev`. Every "the email is there" check waits with
  `eventually` or `tokenSentTo`: the email now arrives after the answer.
- **The first test checks the outbox as well**: the event's payload contains neither the token nor the email
  address (decision 8).
- **`tokenSentTo(address, notToken)`** waits for a **new** email. After a resend, Mailpit still has the old one,
  and without `notToken` the test could read the old link and pass or fail by timing.
- "Kills the old link at once": the old link is dead **before** the new email exists. That is the `tokenHash:
  null` in `resend`.
- **"Tells the inviter in the bell"** is new: the whole path `join` → `member.joined` → worker → notification.
- **The mail server down, for real.** The test closes the worker and starts one whose SMTP address is dead. After
  the two quick attempts the invitation turns `failed`, and the sender gets `invitation.failed`. Then a worker
  with a working SMTP, a Resend, and the email arrives. Two workers must never run at the same time here: both
  would take jobs from the same queues, and the test would not know which one sent.

### Setup: the whole lifecycle

**File: `apps/api/src/setup/setup.int.spec.ts`** (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  meResponseSchema,
  notificationPageSchema,
  problemSchema,
  roleListSchema,
  setupSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startMail,
  startPostgres,
  startRedis,
  type TestMail,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import { lastMailTo } from '../testing/mailpit.js';

let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

function send(method: 'GET' | 'POST', url: string, payload?: object, as: SignedIn = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function setup(as: SignedIn = owner) {
  return setupSchema.parse((await send('GET', '/setup', undefined, as)).json());
}

async function superuserSql(fn: (sql: postgres.Sql) => Promise<unknown>): Promise<void> {
  const sql = postgres(pg.superuserUrl, { max: 1 });
  try {
    await fn(sql);
  } finally {
    await sql.end();
  }
}

async function unpublished(expected: number): Promise<void> {
  await superuserSql(async (sql) => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`;
    expect(row?.n).toBe(expected);
  });
}

describe('sign-up', () => {
  it('leaves a new workspace pending, so the app opens the wizard', async () => {
    expect(await setup()).toEqual({ status: 'pending', industry: null });
    const me = meResponseSchema.parse((await send('GET', '/auth/me')).json());
    expect(me.tenant.setupStatus).toBe('pending');
  });

  it('sends the welcome email from the worker, with the workspace address', async () => {
    const welcome = await eventually(() => lastMailTo(mail.apiUrl, 'farhana@rahmangarments.com'));
    expect(welcome.subject).toBe('Welcome to Omnivo, Farhana Rahman');
    expect(welcome.text).toContain('rahman-garments.omnivo.app');
    expect(welcome.text).toContain('http://localhost:5173/login');
  });
});

describe('starting the setup', () => {
  it('answers with "provisioning" at once, then the worker makes the garments roles', async () => {
    const res = await send('POST', '/setup', { industry: 'garments' });
    expect(res.statusCode).toBe(200);
    expect(setupSchema.parse(res.json())).toEqual({ status: 'provisioning', industry: 'garments' });

    await eventually(async () => {
      expect((await setup()).status).toBe('ready');
    });
    const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
    expect(items.map((role) => [role.name, role.permissions])).toEqual([
      ['Owner', expect.any(Array)],
      ['Accountant', ['core.audit.read', 'core.user.read']],
      ['Merchandiser', ['core.user.read']],
      ['Store keeper', []],
    ]);
  });

  it('writes the audit log as the system, with the request that started it', async () => {
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace')).json(),
    );
    const [provisioned, started] = items;
    expect(started).toMatchObject({
      action: 'workspace.setup_started',
      actor: { fullName: 'Farhana Rahman' },
      changes: { industry: { from: null, to: 'garments' } },
    });
    expect(provisioned).toMatchObject({
      action: 'workspace.provisioned',
      actor: null,
      changes: { roles: { from: null, to: 'Accountant, Merchandiser, Store keeper' } },
    });
    // The worker ran in the context of the POST /setup request: one click, traced end to end
    expect(provisioned?.requestId).toBe(started?.requestId);
    expect(provisioned?.ipAddress).toBeNull();
  });

  it('puts "Workspace ready" in the owner\'s bell', async () => {
    const { items } = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(items.map((item) => item.type)).toContain('workspace.ready');
  });

  it('can be started only once', async () => {
    const again = await send('POST', '/setup', { industry: 'pharma' });
    expect(again.statusCode).toBe(409);
    expect(problemSchema.parse(again.json()).code).toBe('setup_started');
  });

  it('ignores the same event published twice, and a second run of the job', async () => {
    await superuserSql(async (sql) => {
      // 1) The relay crashed after Redis took the job but before it marked the row: the row is
      //    published again. The job id is the event id, so BullMQ ignores the second add.
      await sql`UPDATE outbox_events SET published_at = NULL
                WHERE type = 'workspace.setup_requested'`;
      // 2) A second event for the same workspace: the handler really runs again, finds 'ready'
      //    and stops — no second set of roles, no second notification
      await sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                SELECT gen_random_uuid(), tenant_id, type, payload FROM outbox_events
                WHERE type = 'workspace.setup_requested'`;
    });
    await eventually(() => unpublished(0));
    // The relay has handed both over; give the queue a moment to run what it will run
    await new Promise((resolve) => setTimeout(resolve, 500));

    const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
    expect(items).toHaveLength(4);
    const bell = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(bell.items.filter((item) => item.type === 'workspace.ready')).toHaveLength(1);
  });
});

describe('when the setup job fails', () => {
  let pharmaOwner: SignedIn;

  beforeAll(async () => {
    pharmaOwner = await signUp(app, {
      companyName: 'Karim Pharma',
      workspaceSlug: 'karim-pharma',
      fullName: 'Karim Uddin',
      email: 'karim@karimpharma.com',
      password: 'Batch-expiry-2026',
    });
  });

  it('marks it failed, and Retry finishes it once the cause is fixed', async () => {
    const me = meResponseSchema.parse(
      (await send('GET', '/auth/me', undefined, pharmaOwner)).json(),
    );
    // A role named like the template's "Depot manager", made by the owner before the job runs
    const own = await send(
      'POST',
      '/roles',
      { name: 'depot manager', description: 'Our own' },
      pharmaOwner,
    );
    expect(own.statusCode).toBe(201);

    // A broken start: an industry the code does not know. Running the job again cannot help, so
    // it gives up at once (PermanentJobError, no retries) and onGiveUp marks the setup failed.
    await superuserSql(async (sql) => {
      await sql`UPDATE tenants SET setup_status = 'provisioning', industry = 'shipping'
                WHERE slug = 'karim-pharma'`;
      await sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                SELECT gen_random_uuid(), id, 'workspace.setup_requested',
                       jsonb_build_object('userId', ${me.user.id}::text)
                FROM tenants WHERE slug = 'karim-pharma'`;
    });
    // Read from the table: while the industry is broken, GET /setup itself fails its response
    // contract ('shipping' is not an industry) — the API refuses to send data it cannot vouch for
    await eventually(() =>
      superuserSql(async (sql) => {
        const [row] = await sql<{ setup_status: string }[]>`
          SELECT setup_status FROM tenants WHERE slug = 'karim-pharma'`;
        expect(row?.setup_status).toBe('failed');
      }),
    );

    await superuserSql(
      (sql) => sql`UPDATE tenants SET industry = 'pharma' WHERE slug = 'karim-pharma'`,
    );
    const retried = await send('POST', '/setup/retry', undefined, pharmaOwner);
    expect(setupSchema.parse(retried.json())).toEqual({
      status: 'provisioning',
      industry: 'pharma',
    });
    await eventually(async () => {
      expect((await setup(pharmaOwner)).status).toBe('ready');
    });

    // The owner's own "depot manager" is kept as it was; the template's did not overwrite it
    const { items } = roleListSchema.parse(
      (await send('GET', '/roles', undefined, pharmaOwner)).json(),
    );
    // (the list is sorted by name as stored, so the lowercase name comes last)
    expect(items.map((role) => role.name)).toEqual([
      'Owner',
      'Accountant',
      'Sales representative',
      'depot manager',
    ]);
    expect(items.find((role) => role.name === 'depot manager')).toMatchObject({
      description: 'Our own',
      permissions: [],
    });
  });

  it('refuses a retry when nothing failed', async () => {
    const res = await send('POST', '/setup/retry', undefined, pharmaOwner);
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('setup_not_failed');
  });
});
```

- **The role list is checked in full**, names and permissions: the template reached the database exactly.
- **The audit test proves decision 11.** The job's row and the click's row have the same `requestId`; the job's
  row has no actor and no IP.
- **"Ignores the same event published twice, and a second run of the job"** simulates both ways a job can repeat.
  Setting `published_at` back to NULL makes the relay publish the same row again (the job id dedupes it). A copy
  of the event with a new id really runs the handler a second time (the status check stops it). Afterwards: still
  four roles and one "Workspace ready".
- **The failure test breaks the data on purpose.** `industry = 'shipping'` is not an industry, so the job throws
  `PermanentJobError`, skips its retries, and `onGiveUp` marks the setup `failed`. While the data is broken,
  `GET /setup` itself answers 500: the response contract refuses `'shipping'`. That is correct — the API never
  sends data its contract does not allow — so this test reads the status straight from the table.
- **The owner's own "depot manager" survives.** It was made before the job; the template's "Depot manager" is
  skipped (same name, different case), and the owner's role keeps its description and gets no permissions.
- The role list is sorted by name as stored, and Postgres sorts `'depot manager'` after `'Sales representative'`
  here — the test states that order rather than hiding it.

### Notifications: the API side

**File: `apps/api/src/notifications/notifications.int.spec.ts`** (new)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  meResponseSchema,
  notificationPageSchema,
  problemSchema,
  unreadCountSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// The API side only. Notifications are made by the worker (see the invitation and setup tests);
// here they are inserted directly, so every case is exact and quick.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let farhana: SignedIn;
let karim: SignedIn;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  farhana = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  // Karim is also a colleague of Farhana's, in the same workspace
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'karim@karimpharma.com',
    workspace: 'rahman-garments',
  });
  karim = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
    keepSignedIn: false,
  });

  // Three for Farhana, one second apart (oldest first), and one for Karim
  const farhanaId = await userId(farhana);
  const karimId = await userId(karim);
  const sql = postgres(pg.superuserUrl, { max: 1 });
  await sql`
    INSERT INTO notifications (id, tenant_id, user_id, type, params, created_at)
    SELECT gen_random_uuid(), t.id, n.user_id::uuid, n.type, n.params::jsonb,
           now() - (n.age || ' seconds')::interval
    FROM tenants t,
         (VALUES (${farhanaId}, 'workspace.ready', '{}', 3),
                 (${farhanaId}, 'member.joined', '{"name":"Tanvir Hossain"}', 2),
                 (${farhanaId}, 'invitation.failed', '{"email":"rupa@rahmangarments.com"}', 1),
                 (${karimId}, 'workspace.ready', '{}', 1))
           AS n(user_id, type, params, age)
    WHERE t.slug = 'rahman-garments'`;
  await sql.end();
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

async function userId(as: SignedIn): Promise<string> {
  return meResponseSchema.parse(
    (await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(as.accessToken) })).json(),
  ).user.id;
}

function send(method: 'GET' | 'POST', url: string, as: SignedIn = farhana) {
  return app.inject({ method, url, headers: bearer(as.accessToken) });
}

async function list(url = '/notifications', as: SignedIn = farhana) {
  return notificationPageSchema.parse((await send('GET', url, as)).json());
}

async function unread(as: SignedIn = farhana): Promise<number> {
  return unreadCountSchema.parse((await send('GET', '/notifications/unread-count', as)).json())
    .count;
}

describe('notifications', () => {
  it('lists only my own, newest first, a page at a time', async () => {
    const first = await list('/notifications?limit=2');
    expect(first.items.map((item) => item.type)).toEqual(['invitation.failed', 'member.joined']);
    expect(first.items[0]?.params).toEqual({ email: 'rupa@rahmangarments.com' });
    if (first.nextCursor === null) throw new Error('expected a second page');

    const second = await list(`/notifications?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((item) => item.type)).toEqual(['workspace.ready']);
    expect(second.nextCursor).toBeNull();

    // Karim's own list has only his one
    expect((await list('/notifications', karim)).items).toHaveLength(1);
  });

  it('counts the unread ones', async () => {
    expect(await unread()).toBe(3);
    expect(await unread(karim)).toBe(1);
  });

  it('marks one as read, and a second time changes nothing', async () => {
    const [newest] = (await list()).items;
    if (!newest) throw new Error('setup: no notification');
    expect((await send('POST', `/notifications/${newest.id}/read`)).statusCode).toBe(204);
    const readAt = (await list()).items[0]?.readAt;
    expect(readAt).not.toBeNull();

    expect((await send('POST', `/notifications/${newest.id}/read`)).statusCode).toBe(204);
    expect((await list()).items[0]?.readAt).toBe(readAt);
    expect(await unread()).toBe(2);
  });

  it("does not let a colleague read or clear mine — it looks like it isn't there", async () => {
    const [mine] = (await list()).items;
    if (!mine) throw new Error('setup: no notification');
    const res = await send('POST', `/notifications/${mine.id}/read`, karim);
    expect(res.statusCode).toBe(404);
    expect(problemSchema.parse(res.json()).code).toBe('not_found');

    // "Mark all as read" by Karim clears only Karim's
    expect((await send('POST', '/notifications/read-all', karim)).statusCode).toBe(204);
    expect(await unread(karim)).toBe(0);
    expect(await unread()).toBe(2);
  });

  it('marks all of mine as read', async () => {
    expect((await send('POST', '/notifications/read-all')).statusCode).toBe(204);
    expect(await unread()).toBe(0);
  });
});
```

- The rows are inserted with SQL, with fixed ages (3, 2 and 1 seconds ago). The order and the paging are then exact
  and fast, without waiting for a worker. The worker's side is tested in the invitation and setup tests.
- **Karim is a colleague** (same workspace, no roles, via `joinWithoutRoles`): the test that matters is between
  two people of one tenant, where RLS does not help.

### The relay on its own

**File: `apps/api/src/worker/outbox-relay.int.spec.ts`** (new)

```ts
import { createDb, type Db, tenants } from '@omnivo/db';
import { Queue } from 'bullmq';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { emit } from '../common/outbox/outbox.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
import { createWithTenant, type WithTenant } from '../common/tenant/with-tenant.js';
import type { WorkerConfig } from '../config.js';
import { testWorkerConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { OutboxRelay } from './outbox-relay.js';
import { Queues } from './queues.js';

// The relay on its own: no job runner takes the jobs, so the tests can look at exactly what
// landed on the queue
let pg: TestPostgres;
let redis: TestRedis;
let appDb: Db;
let relayDb: Db;
let withTenant: WithTenant;
let config: WorkerConfig;
let queues: Queues;
let tenantId: string;
const USER = '0192a000-0000-7000-8000-000000000001';

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  appDb = createDb(pg.appUrl, { max: 2 });
  relayDb = createDb(pg.workerUrl, { max: 4 });
  withTenant = createWithTenant(appDb);
  config = testWorkerConfig({
    databaseUrl: pg.appUrl,
    workerDatabaseUrl: pg.workerUrl,
    redisUrl: redis.url,
  });
  queues = new Queues(config);
  const [tenant] = await appDb.insert(tenants).values({ name: 'Acme', slug: 'acme' }).returning();
  if (!tenant) throw new Error('seed failed');
  tenantId = tenant.id;
}, 120_000);

afterAll(async () => {
  await queues.onApplicationShutdown();
  await appDb.$client.end();
  await relayDb.$client.end();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

// Start every test from an empty outbox and empty queues
beforeEach(async () => {
  const sql = postgres(pg.superuserUrl, { max: 1 });
  await sql`DELETE FROM outbox_events`;
  await sql.end();
  for (const name of ['email', 'jobs']) {
    const queue = new Queue(name, { connection: { url: redis.url } });
    await queue.obliterate({ force: true });
    await queue.close();
  }
});

function emitMany(count: number): Promise<void> {
  return runWithTenant(tenantId, () =>
    withTenant(async (tx) => {
      for (let i = 0; i < count; i += 1) {
        await emit(tx, 'workspace.setup_requested', { userId: USER });
      }
    }),
  );
}

async function jobIds(): Promise<string[]> {
  const queue = new Queue('jobs', { connection: { url: redis.url } });
  const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  await queue.close();
  return jobs.map((job) => job.id ?? '').sort();
}

async function unpublishedIds(): Promise<string[]> {
  const sql = postgres(pg.superuserUrl, { max: 1 });
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM outbox_events WHERE published_at IS NULL ORDER BY id`;
  await sql.end();
  return rows.map((row) => row.id);
}

describe('emit()', () => {
  it('leaves no event behind when the transaction rolls back', async () => {
    await expect(
      runWithTenant(tenantId, () =>
        withTenant(async (tx) => {
          await emit(tx, 'workspace.setup_requested', { userId: USER });
          throw new Error('the change itself failed');
        }),
      ),
    ).rejects.toThrow('the change itself failed');
    expect(await unpublishedIds()).toEqual([]);
  });

  it('stores only the fields of the schema', async () => {
    await runWithTenant(tenantId, () =>
      withTenant((tx) =>
        // A wider object (as a careless caller might pass): the extra field must not be stored.
        // The spread keeps TypeScript's excess-property check out of the way, like real code would.
        emit(tx, 'workspace.setup_requested', { ...{ userId: USER, email: 'x@example.com' } }),
      ),
    );
    const sql = postgres(pg.superuserUrl, { max: 1 });
    const [row] = await sql<{ payload: unknown }[]>`SELECT payload FROM outbox_events`;
    await sql.end();
    expect(row?.payload).toEqual({ userId: USER });
  });
});

describe('the relay', () => {
  it('puts each row on the queue once, with the row id as the job id, and marks it', async () => {
    await emitMany(3);
    const ids = await unpublishedIds();
    const relay = new OutboxRelay(relayDb, config, queues);
    expect(await relay.publishBatch()).toBe(3);
    expect(await unpublishedIds()).toEqual([]);
    expect(await jobIds()).toEqual(ids);
  });

  it('adds no second job when a row is published again (the relay died before marking it)', async () => {
    await emitMany(1);
    const relay = new OutboxRelay(relayDb, config, queues);
    await relay.publishBatch();
    const sql = postgres(pg.superuserUrl, { max: 1 });
    await sql`UPDATE outbox_events SET published_at = NULL`;
    await sql.end();
    expect(await relay.publishBatch()).toBe(1);
    // Still one job: the second add used the same job id (the row id), and BullMQ ignored it
    expect(await jobIds()).toHaveLength(1);
  });

  it('never publishes a row twice, even with two relays at the same moment', async () => {
    await emitMany(40);
    const ids = await unpublishedIds();
    // Small batches, so both relays really work at once
    const small = { ...config, relay: { ...config.relay, batchSize: 5 } };
    const one = new OutboxRelay(relayDb, small, queues);
    const two = new OutboxRelay(relayDb, small, queues);
    const drain = async (relay: OutboxRelay): Promise<number> => {
      let total = 0;
      for (let n = await relay.publishBatch(); n > 0; n = await relay.publishBatch()) total += n;
      return total;
    };
    const [a, b] = await Promise.all([drain(one), drain(two)]);
    // SKIP LOCKED: each relay took different rows, and together they took all of them
    expect(a + b).toBe(40);
    expect(await jobIds()).toEqual(ids);
  });

  it('keeps the rows when Redis is down, for the next round', async () => {
    await emitMany(2);
    const deadRedis = new Queues({ ...config, redisUrl: 'redis://127.0.0.1:1' });
    const relay = new OutboxRelay(relayDb, config, deadRedis);
    await expect(relay.publishBatch()).rejects.toThrow();
    await deadRedis.onApplicationShutdown();
    expect(await unpublishedIds()).toHaveLength(2);
  });

  it('deletes old published rows, never unpublished ones', async () => {
    await emitMany(3);
    const sql = postgres(pg.superuserUrl, { max: 1 });
    await sql`
      UPDATE outbox_events SET published_at = now() - interval '8 days'
      WHERE id = (SELECT id FROM outbox_events ORDER BY id LIMIT 1)`;
    await sql`
      UPDATE outbox_events SET created_at = now() - interval '30 days'
      WHERE published_at IS NULL`;
    await sql.end();
    const relay = new OutboxRelay(relayDb, config, queues);
    expect(await relay.deletePublished()).toBe(1);
    expect(await unpublishedIds()).toHaveLength(2);
  });
});
```

- **No job runner here.** The test builds `Queues` and `OutboxRelay` by hand, so no worker takes the jobs, and the
  test can look at exactly what landed in Redis.
- `beforeEach` empties the outbox and the queues (`obliterate`), so each test counts only its own rows and jobs.
- **"Stores only the fields of the schema"**: the spread `{ ...{ userId, email } }` gets past TypeScript's check
  for extra properties, as real code with a wider variable would. The stored payload has only `userId`.
- **Two relays at once**: batches of 5 and 40 rows make the two really overlap. Together they publish all 40, and
  the job ids are exactly the row ids — no row twice, none missing.
- **"Keeps the rows when Redis is down"** is the test that found the hanging publish (8.4). Without the time limit
  it hangs; with it, the round fails in 500 ms and both rows stay unpublished.

### Tenant leaks

**File: `apps/api/src/worker/outbox.tenant-leak.int.spec.ts`** (new)

```ts
import { createDb, type Db, tenants } from '@omnivo/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emit } from '../common/outbox/outbox.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
import { createWithTenant, type WithTenant } from '../common/tenant/with-tenant.js';
import { startPostgres, type TestPostgres } from '../testing/containers.js';

// Who may see the outbox. It holds the work of every tenant, so the rules are tight:
// omnivo_app (API and jobs) may only ADD events, for its own tenant; omnivo_worker (the relay)
// sees every tenant's events and nothing else in the database.
let pg: TestPostgres;
let appDb: Db;
let withTenant: WithTenant;
let tenantA: string;
let tenantB: string;
const USER = '0192a000-0000-7000-8000-000000000001';

beforeAll(async () => {
  pg = await startPostgres();
  appDb = createDb(pg.appUrl, { max: 1 });
  withTenant = createWithTenant(appDb);
  const rows = await appDb
    .insert(tenants)
    .values([
      { name: 'A', slug: 'tenant-a' },
      { name: 'B', slug: 'tenant-b' },
    ])
    .returning({ id: tenants.id });
  const [a, b] = rows;
  if (!a || !b) throw new Error('seed failed');
  [tenantA, tenantB] = [a.id, b.id];
  for (const tenantId of [tenantA, tenantB]) {
    await runWithTenant(tenantId, () =>
      withTenant((tx) => emit(tx, 'workspace.created', { userId: USER })),
    );
  }
}, 120_000);

afterAll(async () => {
  await appDb.$client.end();
  await pg.container.stop();
});

// Postgres error code of a statement run as the given role, or null when it worked
async function errorCodeAs(url: string, run: (sql: postgres.Sql) => Promise<unknown>) {
  const sql = postgres(url, { max: 1 });
  try {
    await run(sql);
    return null;
  } catch (error) {
    return error instanceof postgres.PostgresError ? error.code : String(error);
  } finally {
    await sql.end();
  }
}

// 42501 = insufficient_privilege
describe('the outbox as omnivo_app', () => {
  it('cannot read events, not even its own tenant’s', async () => {
    expect(
      await errorCodeAs(pg.appUrl, (sql) =>
        sql.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
          await tx`SELECT id FROM outbox_events`;
        }),
      ),
    ).toBe('42501');
  });

  it('cannot mark events published or delete them', async () => {
    expect(
      await errorCodeAs(pg.appUrl, (sql) => sql`UPDATE outbox_events SET published_at = now()`),
    ).toBe('42501');
    expect(await errorCodeAs(pg.appUrl, (sql) => sql`DELETE FROM outbox_events`)).toBe('42501');
  });

  it('cannot add an event for another tenant (RLS WITH CHECK)', async () => {
    // 42501 here too: a row that breaks the policy's WITH CHECK is refused as a privilege error
    expect(
      await errorCodeAs(pg.appUrl, (sql) =>
        sql.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
          await tx`INSERT INTO outbox_events (id, tenant_id, type, payload)
                   VALUES (gen_random_uuid(), ${tenantB}, 'workspace.created', '{}')`;
        }),
      ),
    ).toBe('42501');
  });
});

describe('omnivo_worker, the relay role', () => {
  it('sees the events of every tenant, without a tenant context', async () => {
    const sql = postgres(pg.workerUrl, { max: 1 });
    const rows = await sql<{ tenant_id: string }[]>`SELECT tenant_id FROM outbox_events`;
    await sql.end();
    expect(rows.map((row) => row.tenant_id).sort()).toEqual([tenantA, tenantB].sort());
  });

  it('can read no other table', async () => {
    for (const table of ['memberships', 'invitations', 'notifications', 'users', 'tenants']) {
      expect(
        await errorCodeAs(pg.workerUrl, (sql) => sql`SELECT 1 FROM ${sql(table)} LIMIT 1`),
      ).toBe('42501');
    }
  });

  it('cannot add events — only the API does that, inside its transactions', async () => {
    expect(
      await errorCodeAs(
        pg.workerUrl,
        (sql) =>
          sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
            VALUES (gen_random_uuid(), ${tenantA}, 'workspace.created', '{}')`,
      ),
    ).toBe('42501');
  });
});
```

- Plain SQL as each role, not the app's code: these tests check the **database's** rules, which must hold even
  when the code is wrong.
- `42501` (insufficient_privilege) for all refusals, including the RLS `WITH CHECK` refusal — Postgres reports a
  row that breaks a policy with the same code.
- **"Can read no other table"**: `users` and `tenants` have no RLS, so without this check a relay role with default
  privileges could read every user's email. It has none.

**File: `apps/api/src/notifications/notifications.tenant-leak.int.spec.ts`** (new)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { notificationPageSchema, unreadCountSchema } from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// Tenant A's notification must not exist for tenant B — not in the list, not in the count, and
// its id must not work, even for the same person signed in to B
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let ownerA: SignedIn;
let ownerB: SignedIn;
let notificationA: string;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  ownerA = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  ownerB = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  const sql = postgres(pg.superuserUrl, { max: 1 });
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO notifications (id, tenant_id, user_id, type)
    SELECT gen_random_uuid(), t.id, u.id, 'workspace.ready'
    FROM tenants t, users u
    WHERE t.slug = 'rahman-garments' AND u.email = 'farhana@rahmangarments.com'
    RETURNING id`;
  // The same id stored for B's owner too, in tenant A: RLS must hide it even if ids were guessed
  await sql`
    INSERT INTO notifications (id, tenant_id, user_id, type)
    SELECT gen_random_uuid(), t.id, u.id, 'member.joined'
    FROM tenants t, users u
    WHERE t.slug = 'rahman-garments' AND u.email = 'karim@karimpharma.com'`;
  await sql.end();
  if (!row) throw new Error('seed failed');
  notificationA = row.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function send(method: 'GET' | 'POST', url: string, as: SignedIn) {
  return app.inject({ method, url, headers: bearer(as.accessToken) });
}

describe('notifications across workspaces', () => {
  it("tenant B sees none of tenant A's, even rows addressed to B's own user", async () => {
    const page = notificationPageSchema.parse((await send('GET', '/notifications', ownerB)).json());
    expect(page.items).toEqual([]);
    const count = unreadCountSchema.parse(
      (await send('GET', '/notifications/unread-count', ownerB)).json(),
    );
    expect(count.count).toBe(0);
  });

  it("tenant B cannot mark tenant A's notification read (404, and it stays unread)", async () => {
    expect((await send('POST', `/notifications/${notificationA}/read`, ownerB)).statusCode).toBe(
      404,
    );
    expect((await send('POST', '/notifications/read-all', ownerB)).statusCode).toBe(204);
    const count = unreadCountSchema.parse(
      (await send('GET', '/notifications/unread-count', ownerA)).json(),
    );
    expect(count.count).toBe(1);
  });
});
```

- The second seeded row is addressed to **Karim's own user id**, but in tenant A. It must not show up in Karim's
  bell in tenant B: the user filter alone would let it through, and only RLS stops it.

### A unit test for the new email

**File: `apps/api/src/mail/welcome-email.spec.ts`** (new)

```ts
import { describe, expect, it } from 'vitest';

import { welcomeEmail } from './welcome-email.js';

const input = {
  to: 'farhana@rahmangarments.com',
  fullName: 'Farhana Rahman',
  workspaceName: 'Rahman Garments Ltd.',
  workspaceSlug: 'rahman-garments',
  signInLink: 'http://localhost:5173/login',
} as const;

describe('welcomeEmail', () => {
  it('names the workspace address, which sign-in asks for', () => {
    const mail = welcomeEmail({ ...input, language: 'en' });
    expect(mail.subject).toBe('Welcome to Omnivo, Farhana Rahman');
    expect(mail.text).toContain('rahman-garments.omnivo.app');
    expect(mail.text).toContain('Open Rahman Garments Ltd.: http://localhost:5173/login');
    expect(mail.html).toContain('href="http://localhost:5173/login"');
  });

  it('is written in the owner’s language', () => {
    const mail = welcomeEmail({ ...input, language: 'bn' });
    expect(mail.subject).toBe('Omnivo-তে স্বাগতম, Farhana Rahman');
    expect(mail.html).toContain('<html lang="bn">');
  });

  // The frame (layout.ts) escapes every text, so no template can forget it
  it('escapes a company name that looks like HTML', () => {
    const mail = welcomeEmail({
      ...input,
      workspaceName: '<a href="https://evil.example">Rahman</a>',
      language: 'en',
    });
    expect(mail.html).not.toContain('<a href="https://evil.example">');
    expect(mail.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
  });
});
```

- No containers: the email is a pure function. The escaping test runs against `layout.ts` through the welcome
  email, so both emails are covered by one frame.

---

## 8.9 — `packages/i18n`: the texts

**File: `packages/i18n/src/locales/en.ts`** (change)

```diff
@@ -28,6 +28,9 @@ export const en = {
       dark: 'Dark',
     },
     preferenceNotSaved: "Couldn't save this to your account. It applies on this device for now.",
+    notifications: 'Notifications',
+    notificationsUnread_one: 'Notifications, {{count}} unread',
+    notificationsUnread_other: 'Notifications, {{count}} unread',
   },
   nav: {
     overview: 'Overview',
@@ -209,6 +212,7 @@ export const en = {
       status: 'Status',
     },
     statuses: {
+      sending: 'Sending',
       sent: 'Sent',
       notSent: 'Email not sent',
       expired: 'Expired',
@@ -217,7 +221,7 @@ export const en = {
     actionsFor: 'Actions for {{email}}',
     resend: 'Resend',
     revoke: 'Cancel invitation',
-    resent: 'New link sent to {{email}}',
+    resent: 'Sending a new link to {{email}}',
     revoked: 'Invitation to {{email}} cancelled',
     inviteTitle: 'Invite people',
     inviteDescription: 'They get an email with a link to join {{workspace}}.',
@@ -228,9 +232,7 @@ export const en = {
     cantGrant: "Includes permissions you don't have",
     send: 'Send invitation',
     sending: 'Sending…',
-    invited: 'Invitation sent to {{email}}',
-    notSent:
-      "The invitation is saved, but the email didn't go out. Use Resend in the list to try again.",
+    invited: 'Sending the invitation to {{email}}',
     permissionCount_one: '{{count}} permission',
     permissionCount_other: '{{count}} permissions',
     allPermissions: 'Every permission',
@@ -342,7 +344,11 @@ export const en = {
     allowed: 'Allowed',
     notAllowed: 'Not allowed',
     actions: {
-      workspace: { created: 'Created the workspace' },
+      workspace: {
+        created: 'Created the workspace',
+        setup_started: 'Started the workspace setup',
+        provisioned: 'Added the starting roles',
+      },
       auth: { signed_in: 'Signed in', switched_in: 'Switched into this workspace' },
       settings: { updated: 'Changed the settings', logo_changed: 'Changed the logo' },
       branch: {
@@ -387,9 +393,73 @@ export const en = {
       padding: 'Digits',
       roles: 'Roles',
       description: 'Description',
+      industry: 'Business type',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
+  onboarding: {
+    title: 'Set up {{company}}',
+    stepsLabel: 'Setup steps',
+    steps: {
+      business: 'Business type',
+      company: 'Company details',
+      team: 'Invite team',
+    },
+    stepOf: 'Step {{current}} of {{total}}',
+    continue: 'Continue',
+    starting: 'Starting…',
+    skip: 'Skip for now',
+    business: {
+      title: 'What does {{company}} do?',
+      subtitle:
+        'We start you with the roles such a company usually needs. You can rename or change them any time.',
+      label: 'Business type',
+    },
+    industries: {
+      garments: { name: 'Garments & textiles', description: 'Buyer POs, LCs, cutting and sewing' },
+      pharma: { name: 'Pharmaceuticals', description: 'Batches, expiry dates and depots' },
+      distribution: { name: 'Distribution', description: 'Depots, deliveries and retailer credit' },
+      manufacturing: {
+        name: 'Manufacturing',
+        description: 'Production orders and raw material stock',
+      },
+      retail: { name: 'Retail', description: 'Shops, counters and daily cash' },
+      other: { name: 'Something else', description: 'A general start you can shape yourself' },
+    },
+    company: {
+      title: 'Company details',
+      subtitle: 'Printed on invoices and Mushak 6.3. You can change them later in Settings.',
+    },
+    team: {
+      title: 'Invite your team',
+      subtitle: 'Add your accountant and managers now, or later from the Team page.',
+      preparing: 'Preparing the roles for {{industry}}…',
+      ready: 'Roles ready: {{roles}}',
+      failed: "The setup didn't finish. Try again — nothing you entered is lost.",
+      retry: 'Try again',
+      invite: 'Invite people',
+      invited: 'Invited',
+      finish: 'Go to dashboard',
+    },
+  },
+  notifications: {
+    title: 'Notifications',
+    markAllRead: 'Mark all as read',
+    unread: 'Unread',
+    emptyTitle: 'No notifications yet',
+    emptyBody:
+      'You hear here when someone joins from your invitation, or when an email could not be sent.',
+    loadFailed: "Couldn't load your notifications. Try again in a moment.",
+    // type → text. The type's dot nests in i18next, so t(`notifications.types.${type}`) lands here;
+    // a type without text here does not type-check
+    types: {
+      workspace: { ready: 'Your workspace is set up. The starting roles are ready to use.' },
+      member: { joined: '{{name}} joined the workspace' },
+      invitation: {
+        failed: "The invitation email to {{email}} couldn't be sent. Resend it from the Team page.",
+      },
+    },
+  },
   // API-র error code → লেখা। satisfies: contracts-এর ERROR_CODES-এ নতুন code এলে এখানে না লেখা
   // পর্যন্ত compile error, আর তালিকায় নেই এমন key লিখলেও error
   errors: {
@@ -446,6 +516,8 @@ export const en = {
     own_membership: "You can't change your own roles or remove yourself. Ask another admin.",
     role_in_use:
       'Someone has this role or an open invitation gives it. Change their roles or cancel the invitation first.',
+    setup_started: 'The setup has already started. Reload the page to see how far it is.',
+    setup_not_failed: "The setup hasn't failed. Reload the page to see how far it is.",
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- **`notifications.types` mirrors the type names** (`workspace.ready` → `workspace: { ready }`). i18next reads the
  dot as nesting, so ``t(`notifications.types.${type}`)`` lands on the right text, and the key is type-checked: a
  new notification type without a text fails `pnpm typecheck`.
- `shell.notificationsUnread_one/_other`: the bell's accessible name says the count ("Notifications, 2 unread").
  The badge itself is hidden from screen readers, so this is how they hear it.
- `team.invited` / `team.resent` now say "Sending…", not "sent": the toast appears before the email goes out, and
  must not promise what the list may later contradict.
- `team.notSent` (the long toast) is removed: nothing shows it any more. `team.statuses.notSent` stays — it is the
  pill.
- `onboarding.industries.*.description` uses real work of each industry (buyer POs and LCs, batches and expiry),
  per CLAUDE.md → Content.
- The failure text says what to do and that nothing is lost ("Try again — nothing you entered is lost."): the
  owner may fear the company details they typed are gone.

**File: `packages/i18n/src/locales/bn.ts`** (change)

```diff
@@ -28,6 +28,9 @@ export const bn: Messages = {
       dark: 'ডার্ক',
     },
     preferenceNotSaved: 'আপনার অ্যাকাউন্টে সেভ করা যায়নি। আপাতত শুধু এই ডিভাইসে থাকবে।',
+    notifications: 'নোটিফিকেশন',
+    notificationsUnread_one: 'নোটিফিকেশন, {{count}}টা পড়া হয়নি',
+    notificationsUnread_other: 'নোটিফিকেশন, {{count}}টা পড়া হয়নি',
   },
   nav: {
     overview: 'সারসংক্ষেপ',
@@ -208,6 +211,7 @@ export const bn: Messages = {
       status: 'অবস্থা',
     },
     statuses: {
+      sending: 'পাঠানো হচ্ছে',
       sent: 'পাঠানো হয়েছে',
       notSent: 'ইমেইল যায়নি',
       expired: 'মেয়াদ শেষ',
@@ -216,7 +220,7 @@ export const bn: Messages = {
     actionsFor: '{{email}}-এর কাজ',
     resend: 'আবার পাঠান',
     revoke: 'আমন্ত্রণ বাতিল করুন',
-    resent: '{{email}}-এ নতুন লিংক পাঠানো হয়েছে',
+    resent: '{{email}}-এ নতুন লিংক পাঠানো হচ্ছে',
     revoked: '{{email}}-এর আমন্ত্রণ বাতিল হয়েছে',
     inviteTitle: 'আমন্ত্রণ পাঠান',
     inviteDescription: '{{workspace}}-এ যোগ দেওয়ার লিংকসহ একটা ইমেইল যাবে।',
@@ -227,8 +231,7 @@ export const bn: Messages = {
     cantGrant: 'এতে এমন অনুমতি আছে যা আপনার নেই',
     send: 'আমন্ত্রণ পাঠান',
     sending: 'পাঠানো হচ্ছে…',
-    invited: '{{email}}-এ আমন্ত্রণ পাঠানো হয়েছে',
-    notSent: 'আমন্ত্রণ সেভ হয়েছে, কিন্তু ইমেইল যায়নি। তালিকা থেকে আবার পাঠান।',
+    invited: '{{email}}-এ আমন্ত্রণ পাঠানো হচ্ছে',
     permissionCount_one: '{{count}}টা অনুমতি',
     permissionCount_other: '{{count}}টা অনুমতি',
     allPermissions: 'সব অনুমতি',
@@ -336,7 +339,11 @@ export const bn: Messages = {
     allowed: 'অনুমতি আছে',
     notAllowed: 'অনুমতি নেই',
     actions: {
-      workspace: { created: 'ওয়ার্কস্পেস তৈরি করেছেন' },
+      workspace: {
+        created: 'ওয়ার্কস্পেস তৈরি করেছেন',
+        setup_started: 'ওয়ার্কস্পেসের সেটআপ শুরু করেছেন',
+        provisioned: 'শুরুর রোলগুলো যোগ করেছে',
+      },
       auth: { signed_in: 'সাইন ইন করেছেন', switched_in: 'এই ওয়ার্কস্পেসে এসেছেন' },
       settings: { updated: 'সেটিংস বদলেছেন', logo_changed: 'লোগো বদলেছেন' },
       branch: {
@@ -380,9 +387,70 @@ export const bn: Messages = {
       padding: 'অঙ্ক',
       roles: 'রোল',
       description: 'বিবরণ',
+      industry: 'ব্যবসার ধরন',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  onboarding: {
+    title: '{{company}} সেটআপ করুন',
+    stepsLabel: 'সেটআপের ধাপ',
+    steps: {
+      business: 'ব্যবসার ধরন',
+      company: 'কোম্পানির তথ্য',
+      team: 'টিমকে ডাকুন',
+    },
+    stepOf: 'ধাপ {{current}} / {{total}}',
+    continue: 'এগিয়ে যান',
+    starting: 'শুরু হচ্ছে…',
+    skip: 'এখন না',
+    business: {
+      title: '{{company}} কী করে?',
+      subtitle:
+        'এমন কোম্পানিতে সাধারণত যে রোলগুলো লাগে, সেগুলো দিয়ে শুরু করা হবে। পরে যেকোনো সময় নাম বা অনুমতি বদলানো যায়।',
+      label: 'ব্যবসার ধরন',
+    },
+    industries: {
+      garments: { name: 'গার্মেন্টস ও টেক্সটাইল', description: 'বায়ার PO, LC, কাটিং আর সেলাই' },
+      pharma: { name: 'ফার্মাসিউটিক্যালস', description: 'ব্যাচ, মেয়াদ আর ডিপো' },
+      distribution: { name: 'ডিস্ট্রিবিউশন', description: 'ডিপো, ডেলিভারি আর দোকানের বাকি' },
+      manufacturing: {
+        name: 'ম্যানুফ্যাকচারিং',
+        description: 'প্রোডাকশন অর্ডার আর কাঁচামালের স্টক',
+      },
+      retail: { name: 'রিটেইল', description: 'দোকান, কাউন্টার আর দিনের ক্যাশ' },
+      other: { name: 'অন্য কিছু', description: 'সাধারণ শুরু, নিজের মতো সাজিয়ে নিন' },
+    },
+    company: {
+      title: 'কোম্পানির তথ্য',
+      subtitle: 'ইনভয়েস আর Mushak 6.3-এ ছাপা হয়। পরে Settings থেকে বদলানো যায়।',
+    },
+    team: {
+      title: 'টিমকে ডাকুন',
+      subtitle: 'আপনার অ্যাকাউন্ট্যান্ট আর ম্যানেজারদের এখনই যোগ করুন, অথবা পরে Team পেজ থেকে।',
+      preparing: '{{industry}}-এর রোলগুলো তৈরি হচ্ছে…',
+      ready: 'রোল তৈরি: {{roles}}',
+      failed: 'সেটআপ শেষ হয়নি। আবার চেষ্টা করুন — আপনার দেওয়া কোনো তথ্য হারায়নি।',
+      retry: 'আবার চেষ্টা করুন',
+      invite: 'আমন্ত্রণ পাঠান',
+      invited: 'আমন্ত্রিত',
+      finish: 'ড্যাশবোর্ডে যান',
+    },
+  },
+  notifications: {
+    title: 'নোটিফিকেশন',
+    markAllRead: 'সব পড়া হয়েছে',
+    unread: 'পড়া হয়নি',
+    emptyTitle: 'এখনো কোনো নোটিফিকেশন নেই',
+    emptyBody: 'আপনার আমন্ত্রণে কেউ যোগ দিলে, বা কোনো ইমেইল পাঠানো না গেলে এখানে জানতে পারবেন।',
+    loadFailed: 'নোটিফিকেশন আনা যায়নি। একটু পরে আবার চেষ্টা করুন।',
+    types: {
+      workspace: { ready: 'আপনার ওয়ার্কস্পেস সেটআপ হয়ে গেছে। শুরুর রোলগুলো ব্যবহার করা যাবে।' },
+      member: { joined: '{{name}} ওয়ার্কস্পেসে যোগ দিয়েছেন' },
+      invitation: {
+        failed: '{{email}}-এ আমন্ত্রণের ইমেইল পাঠানো যায়নি। Team পেজ থেকে আবার পাঠান।',
+      },
+    },
+  },
   errors: {
     invalid_input: 'চিহ্নিত ঘরগুলো ঠিক করে আবার চেষ্টা করুন।',
     required: 'এই ঘরটা পূরণ করুন।',
@@ -437,6 +505,8 @@ export const bn: Messages = {
     own_membership: 'নিজের রোল বদলানো বা নিজেকে সরানো যায় না। আরেকজন অ্যাডমিনকে বলুন।',
     role_in_use:
       'এই রোল কারো আছে, বা কোনো খোলা আমন্ত্রণে আছে। আগে তাঁদের রোল বদলান বা আমন্ত্রণ বাতিল করুন।',
+    setup_started: 'সেটআপ আগেই শুরু হয়েছে। কতদূর হলো দেখতে পেজটা রিলোড করুন।',
+    setup_not_failed: 'সেটআপ ব্যর্থ হয়নি। কতদূর হলো দেখতে পেজটা রিলোড করুন।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

- `Messages` is `en`'s type, so every key above must exist here too, or the build fails. Office words stay in
  English inside the Bangla (PO, LC, Team page, setup wizard), as CLAUDE.md asks.

---

## 8.10 — `packages/ui`: two wizard parts and a slot for the bell

**File: `packages/ui/src/components/selectable-card.tsx`** (new)

```tsx
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { useId } from 'react';

import { cn } from '../lib/cn.js';

export interface SelectableCardOption<TValue extends string> {
  value: TValue;
  icon: IconSvgElement;
  title: string;
  description: string;
}

interface SelectableCardGroupProps<TValue extends string> {
  // Read by screen readers before each card ("Business type, Garments & textiles, radio, 1 of 6").
  // Hidden on screen: the page title above already says what is being picked.
  legend: string;
  options: readonly SelectableCardOption<TValue>[];
  // null = nothing picked yet
  value: TValue | null;
  onChange: (value: TValue) => void;
}

// CLAUDE.md → Selectable card: pick one of a few big choices (the business type). Same idea as
// SegmentedControl: a real radio input inside each label, so arrow keys, form semantics and "1 of
// 6" come from the browser. TValue: the picked option's own type comes back, not a plain string.
export function SelectableCardGroup<TValue extends string>({
  legend,
  options,
  value,
  onChange,
}: SelectableCardGroupProps<TValue>) {
  const name = useId();
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <label
            key={option.value}
            className={cn(
              // relative: keeps the sr-only radio inside this box (see Checkbox for the phone bug
              // an escaped sr-only element once caused). cursor-pointer: a label without htmlFor
              // is not covered by the global pointer rule.
              'relative flex cursor-pointer items-start gap-3 rounded-control border p-3.5 shadow-sm transition-colors duration-150 has-[:focus-visible]:shadow-ring',
              selected
                ? 'border-brand bg-brand-soft'
                : 'border-line-strong bg-surface hover:bg-subtle',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => {
                onChange(option.value);
              }}
              className="sr-only"
            />
            <span
              className={cn(
                'grid size-9 shrink-0 place-items-center rounded-lg transition-colors duration-150',
                selected ? 'bg-brand text-brand-ink' : 'bg-subtle text-ink-3',
              )}
            >
              <HugeiconsIcon icon={option.icon} size={18} strokeWidth={1.5} />
            </span>
            <span className="min-w-0">
              <span className="block text-body-sm font-medium text-ink">{option.title}</span>
              <span className="block text-label text-ink-3">{option.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
```

- **A real radio input in each card**, the same idea as `SegmentedControl`. Arrow keys move the choice, Space
  picks, and a screen reader says "Garments & textiles, radio, 1 of 6". A clickable `<div>` would need all of that
  written by hand.
- **`relative` on the label.** The radio is `sr-only` (position absolute). Without a positioned parent it would be
  placed against some distant ancestor — step 7's phone-width bug (390 → 661 px) came from exactly this.
- **`cursor-pointer` on the label.** The global rule covers `label[for]`; this label wraps its input instead.
- `has-[:focus-visible]:shadow-ring`: the input is invisible, so the card shows the keyboard focus for it.
- Selected = `brand` border, `brand-soft` background and a filled `brand` icon tile, as the design system's
  "Selectable card" says.
- `TValue` generic: `onChange` gives back the option's own type (`Industry`), not a plain `string`, so the wizard
  needs no cast.

**File: `packages/ui/src/components/stepper.tsx`** (new)

```tsx
import { Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { cn } from '../lib/cn.js';

interface StepperProps {
  // The list's name for screen readers ("Setup steps")
  label: string;
  steps: readonly string[];
  // 0-based index of the step on screen
  current: number;
}

// CLAUDE.md → Stepper: numbered 26px circles (valid here: the steps are a real sequence). Current
// = brand border and ring; done = filled brand with a tick. It only shows where you are — moving
// between steps is the wizard's job, so nothing here is clickable.
export function Stepper({ label, steps, current }: StepperProps) {
  return (
    <ol aria-label={label} className="flex items-center gap-2">
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'todo';
        return (
          <li
            key={step}
            // "step" is the ARIA value for the current item of a process
            aria-current={state === 'current' ? 'step' : undefined}
            // relative: the phone's sr-only step names stay inside this item (see Checkbox)
            className="relative flex min-w-0 items-center gap-2"
          >
            <span
              className={cn(
                'grid size-[26px] shrink-0 place-items-center rounded-full border text-caption font-semibold tabular-nums',
                state === 'done' && 'border-brand bg-brand text-brand-ink',
                state === 'current' && 'border-brand bg-surface text-brand shadow-ring',
                state === 'todo' && 'border-line-strong bg-surface text-ink-3',
              )}
            >
              {state === 'done' ? (
                <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={1.5} />
              ) : (
                index + 1
              )}
            </span>
            <span
              className={cn(
                'truncate text-body-sm font-medium',
                state === 'todo' ? 'text-ink-3' : 'text-ink',
                // On phones only the current step keeps its name; three names do not fit in 358px
                state !== 'current' && 'max-sm:sr-only',
              )}
            >
              {step}
            </span>
            {index < steps.length - 1 && (
              <span aria-hidden="true" className="h-px w-5 shrink-0 bg-line sm:w-8" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
```

- `<ol>`: the steps are an ordered sequence, and a screen reader says "list, 3 items".
- `aria-current="step"`: the ARIA value for "you are here" in a process.
- **Not clickable.** Going back to step 1 is not allowed (decision 13); a clickable stepper would suggest it is.
- **On phones only the current step keeps its name.** Three names do not fit in 358 px. The others are `sr-only`,
  so a screen reader still hears all three — and so the `li` gets `relative` too, for the same reason as the card.

**File: `packages/ui/src/components/app-shell.tsx`** (change)

```diff
@@ -6,6 +6,8 @@ import { cn } from '../lib/cn.js';
 interface AppShellProps {
   // সাইডবারের মাথায় (ডেস্কটপ) / টপ বারের বাঁয়ে (ফোন) — সাধারণত <Logo />
   brand: ReactNode;
+  // Next to the logo on every screen size — the notification bell
+  actions?: ReactNode;
   // শুধু ফোনে, টপ বারের ডানে (যেমন user menu) — ডেস্কটপে সেই কাজ sidebarFooter-এর
   topBarActions?: ReactNode;
   // workspace switcher
@@ -20,6 +22,7 @@ interface AppShellProps {
 // যায় আর nav আড়াআড়ি। ui রাউটার চেনে না — লিংক, ইউজার, টেন্যান্ট সব app slot-এ পাঠায়
 export function AppShell({
   brand,
+  actions,
   topBarActions,
   sidebarHeader,
   nav,
@@ -31,7 +34,10 @@ export function AppShell({
       <aside className="flex flex-col gap-3 border-b border-line bg-surface px-4 pt-3 min-[860px]:sticky min-[860px]:top-0 min-[860px]:h-dvh min-[860px]:gap-5 min-[860px]:border-r min-[860px]:border-b-0 min-[860px]:px-3 min-[860px]:py-5">
         <div className="flex items-center justify-between gap-3 px-2">
           {brand}
-          {topBarActions && <div className="min-[860px]:hidden">{topBarActions}</div>}
+          <div className="flex items-center gap-1">
+            {actions}
+            {topBarActions && <div className="min-[860px]:hidden">{topBarActions}</div>}
+          </div>
         </div>
         {sidebarHeader}
         {nav}
```

- `topBarActions` shows only on phones (the user menu lives in the sidebar footer on desktop). The bell is needed
  at every size, so it gets its own slot, `actions`, next to the logo.

**File: `packages/ui/src/index.ts`** (change)

```diff
@@ -46,4 +46,6 @@ export { PageHeader, SectionHeader } from './components/page-header.js';
 export { Pill, type PillTone } from './components/pill.js';
 export { Popover, PopoverContent, PopoverTrigger } from './components/popover.js';
 export { SegmentedControl } from './components/segmented-control.js';
+export { SelectableCardGroup, type SelectableCardOption } from './components/selectable-card.js';
+export { Stepper } from './components/stepper.js';
 export { Toaster, toast } from './components/toast.js';
```

**File: `apps/app/src/routes/kitchen-sink.tsx`** (change)

```diff
@@ -1,7 +1,9 @@
 import {
   CheckmarkCircle02Icon,
   Clock01Icon,
+  DeliveryTruck01Icon,
   InboxIcon,
+  Medicine02Icon,
   PauseCircleIcon,
   PlusSignIcon,
   ScissorIcon,
@@ -30,6 +32,8 @@ import {
   type PillTone,
   SectionHeader,
   SegmentedControl,
+  SelectableCardGroup,
+  Stepper,
   TextField,
   toast,
   toIsoDate,
@@ -248,6 +252,59 @@ function LetterOfCreditForm() {
   );
 }
 
+// The wizard's pieces, with the same kind of content as onboarding.tsx (English: the kitchen sink
+// is a dev tool and stays English)
+const WIZARD_STEPS = ['Business type', 'Company details', 'Invite team'];
+const INDUSTRY_OPTIONS = [
+  {
+    value: 'garments',
+    icon: TShirtIcon,
+    title: 'Garments & textiles',
+    description: 'Buyer POs, LCs, cutting and sewing',
+  },
+  {
+    value: 'pharma',
+    icon: Medicine02Icon,
+    title: 'Pharmaceuticals',
+    description: 'Batches, expiry dates and depots',
+  },
+  {
+    value: 'distribution',
+    icon: DeliveryTruck01Icon,
+    title: 'Distribution',
+    description: 'Depots, deliveries and retailer credit',
+  },
+] as const;
+
+function WizardParts() {
+  const [step, setStep] = useState(1);
+  const [industry, setIndustry] = useState<(typeof INDUSTRY_OPTIONS)[number]['value'] | null>(
+    'garments',
+  );
+  return (
+    <div className="grid gap-5 p-5">
+      <div className="flex flex-wrap items-center justify-between gap-3">
+        <Stepper label="Setup steps" steps={WIZARD_STEPS} current={step} />
+        <Button
+          variant="secondary"
+          size="sm"
+          onClick={() => {
+            setStep((step + 1) % WIZARD_STEPS.length);
+          }}
+        >
+          Next step
+        </Button>
+      </div>
+      <SelectableCardGroup
+        legend="Business type"
+        options={INDUSTRY_OPTIONS}
+        value={industry}
+        onChange={setIndustry}
+      />
+    </div>
+  );
+}
+
 const THEME_OPTIONS = [
   { value: 'system', label: 'System' },
   { value: 'light', label: 'Light' },
@@ -342,6 +399,11 @@ export function KitchenSinkPage() {
         <LetterOfCreditForm />
       </Card>
 
+      <Card>
+        <CardHeader title="Wizard" subtitle="Stepper and selectable cards, from onboarding" />
+        <WizardParts />
+      </Card>
+
       <Card>
         <CardHeader title="Empty state" />
         <EmptyState
```

- Every shared component is shown in the kitchen sink. "Next step" walks the stepper through its three states, in
  both themes and at 390 px.

---

## 8.11 — `apps/app`: the screens

### Queries that poll

**File: `apps/app/src/lib/queries.ts`** (change)

```diff
@@ -26,6 +26,43 @@ export function invitationsQuery(tenantId: string) {
   return queryOptions({
     queryKey: ['invitations', tenantId],
     queryFn: async () => (await call(routes.invitations.list)).items,
+    // The worker sends the email a moment after the API answers. While any invitation is still
+    // "sending", ask again every 2 seconds, so "Sending" turns into "Sent" (or "Email not sent")
+    // by itself. When none is sending, stop: false turns the polling off.
+    refetchInterval: (query) =>
+      query.state.data?.some((invitation) => invitation.delivery === 'sending') ? 2_000 : false,
+  });
+}
+
+// The wizard's view of the background setup job. Polls every 1.5 seconds while the job runs, and
+// stops as soon as the status is final (ready or failed).
+export function setupQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['setup', tenantId],
+    queryFn: () => call(routes.setup.get),
+    refetchInterval: (query) => (query.state.data?.status === 'provisioning' ? 1_500 : false),
+  });
+}
+
+// The bell's badge. Polled every 30 seconds — only while the tab is visible (TanStack's default:
+// refetchIntervalInBackground is false), so a tab left open overnight sends nothing. Coming back
+// to the tab refetches at once (refetchOnWindowFocus).
+export function unreadCountQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['notifications', tenantId, 'unread-count'],
+    queryFn: async () => (await call(routes.notifications.unreadCount)).count,
+    refetchInterval: 30_000,
+    // Fresh on every poll; the global 30-second staleTime would otherwise skip the focus refetch
+    staleTime: 0,
+  });
+}
+
+// The newest 20, for the bell's panel. Same key prefix as the count: one invalidate refreshes both.
+export function notificationsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['notifications', tenantId, 'latest'],
+    queryFn: async () => (await call(routes.notifications.list, { query: { limit: 20 } })).items,
+    staleTime: 0,
   });
 }
 
```

- **`refetchInterval` as a function** decides from the data itself. The invitation list polls every 2 seconds only
  while at least one row is `sending`, and stops by itself when all are final. The setup query polls every 1.5
  seconds only while `provisioning`.
- **The bell's count: 30 seconds, only while the tab is visible.** TanStack's default for
  `refetchIntervalInBackground` is `false`, so a tab left open overnight sends nothing. `refetchOnWindowFocus`
  (on by default) fetches at once when you come back.
- `staleTime: 0` on both notification queries: the app's global 30-second `staleTime` would otherwise skip the
  refetch on focus and on opening the panel.
- **One key prefix, `['notifications', tenantId]`.** A single `invalidateQueries` after "mark as read" refreshes the
  count and the list. `tenantId` in the key keeps a switched workspace from showing the other one's bell.

### Shared pieces, moved out of routes

**File: `apps/app/src/lib/settings-form.ts`** (new — moved from `routes/settings.tsx`)

```ts
import type { Settings, updateSettingsInputSchema } from '@omnivo/contracts';
import type { z } from 'zod';

// Shared by the settings page and the onboarding wizard's company step (moved from
// routes/settings.tsx in step 8)
// ফর্মে যা থাকে: parse-এর আগের মান (z.input) — ফাঁকা ঘর '' (null না, <input>-এ null বসানো যায় না)
export type SettingsFormValues = z.input<typeof updateSettingsInputSchema>;

// version ফর্মের লুকানো মান: ফর্ম যে version দেখে খোলা হয়েছিল, সেভে সেটাই যায়। সেভের মুহূর্তে ক্যাশ
// থেকে সর্বশেষ version নিলে optimistic locking-এর মানেই থাকত না — ব্যাকগ্রাউন্ডে refetch হয়ে নতুন
// version এলে অন্যের বদল চুপচাপ মুছে যেত
export function settingsToForm(settings: Settings): SettingsFormValues {
  return {
    version: settings.version,
    companyName: settings.companyName,
    legalName: settings.legalName ?? '',
    bin: settings.bin ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    address: settings.address ?? '',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
  };
}
```

**File: `apps/app/src/routes/settings.tsx`** (change)

```diff
@@ -36,36 +36,15 @@ import {
 import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { type ChangeEvent, useMemo, useRef } from 'react';
 import { useForm } from 'react-hook-form';
-import type { z } from 'zod';
 
 import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { settingsQuery } from '../lib/queries';
+import { settingsToForm } from '../lib/settings-form';
 import { refreshMe } from '../lib/session';
 import { useCan } from '../lib/permissions';
 import { useSession } from '../lib/session-store';
 
-// ফর্মে যা থাকে: parse-এর আগের মান (z.input) — ফাঁকা ঘর '' (null না, <input>-এ null বসানো যায় না)
-type FormValues = z.input<typeof updateSettingsInputSchema>;
-
-// version ফর্মের লুকানো মান: ফর্ম যে version দেখে খোলা হয়েছিল, সেভে সেটাই যায়। সেভের মুহূর্তে ক্যাশ
-// থেকে সর্বশেষ version নিলে optimistic locking-এর মানেই থাকত না — ব্যাকগ্রাউন্ডে refetch হয়ে নতুন
-// version এলে অন্যের বদল চুপচাপ মুছে যেত
-function toForm(settings: Settings): FormValues {
-  return {
-    version: settings.version,
-    companyName: settings.companyName,
-    legalName: settings.legalName ?? '',
-    bin: settings.bin ?? '',
-    phone: settings.phone ?? '',
-    email: settings.email ?? '',
-    address: settings.address ?? '',
-    baseCurrency: settings.baseCurrency,
-    fiscalYearStartMonth: settings.fiscalYearStartMonth,
-    timezone: settings.timezone,
-  };
-}
-
 const FIELD_NAMES = updateSettingsInputSchema.keyof().options;
 const CURRENCY_OPTIONS = CURRENCIES.map((currency) => ({ value: currency, label: currency }));
 const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);
@@ -92,7 +71,7 @@ function SettingsForm({ settings, canManage }: { settings: Settings; canManage:
     formState: { errors, isSubmitting, isDirty },
   } = useForm({
     resolver: zodResolver(updateSettingsInputSchema, { error: contractErrorMap }),
-    defaultValues: toForm(settings),
+    defaultValues: settingsToForm(settings),
   });
 
   const monthOptions = useMemo(
@@ -106,7 +85,7 @@ function SettingsForm({ settings, canManage }: { settings: Settings; canManage:
       const saved = await call(routes.settings.update, { body: values });
       queryClient.setQueryData(settingsQuery(tenantId).queryKey, saved);
       // নতুন version সহ ফর্ম নতুন করে — পরের সেভ এই version থেকে
-      reset(toForm(saved));
+      reset(settingsToForm(saved));
       toast(t('settings.saved'));
       // কোম্পানির নাম বদলালে switcher-এও নতুন নাম
       await refreshMe();
@@ -119,7 +98,7 @@ function SettingsForm({ settings, canManage }: { settings: Settings; canManage:
   // query(): TanStack v5.104-এ fetchQuery-র নতুন নাম (পুরনোটা deprecated)
   const reload = async () => {
     const fresh = await queryClient.query({ ...settingsQuery(tenantId), staleTime: 0 });
-    reset(toForm(fresh));
+    reset(settingsToForm(fresh));
   };
 
   const serverError = errors.root?.server?.message;
```

- A route file is its own lazy chunk. If the wizard imported `toForm` from `routes/settings.tsx`, opening the wizard
  would download the whole settings page. A small `lib/` file avoids that.

**File: `apps/app/src/components/invite-form.tsx`** (new — moved from `routes/team.tsx`)

```tsx
import { Mail01Icon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createInvitationInputSchema,
  type Invitation,
  type MeResponse,
  type Role,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  CheckboxGroup,
  type CheckboxOption,
  DialogClose,
  DialogContent,
  FormAlert,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rolesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// The invite dialog and its role list — shared by the team page and the onboarding wizard's last
// step (moved out of routes/team.tsx in step 8, unchanged apart from the toast and onInvited)
const INVITE_FIELDS = createInvitationInputSchema.keyof().options;

// এই রোল আমি দিতে (বা কেড়ে নিতে) পারি কি না — API-র grants.ts-এর একই নিয়ম, শুধু আগেভাগে বাক্সটা বন্ধ
// রাখার জন্য। owner-কে owner চেনা যায় me.roles-এ owner রোলের নাম দেখে (সেই নাম বদলানো যায় না)
function useGrantable(roles: readonly Role[] | undefined, me: MeResponse | null) {
  return useCallback(
    (role: Role): 'ok' | 'ownerOnly' | 'cantGrant' => {
      if (!me || !roles) return 'cantGrant';
      const ownerName = roles.find((candidate) => candidate.kind === 'owner')?.name;
      if (ownerName !== undefined && me.roles.includes(ownerName)) return 'ok';
      if (role.kind === 'owner') return 'ownerOnly';
      return role.permissions.every((key) => me.permissions.includes(key)) ? 'ok' : 'cantGrant';
    },
    [roles, me],
  );
}

// invite আর সদস্যের ফর্ম — দুটোতেই একই রোলের তালিকা: নাম, নিচে কী দেয়, আর দিতে না পারলে কেন
export function useRoleOptions(roles: readonly Role[] | undefined): CheckboxOption[] {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const grantable = useGrantable(roles, me);
  return useMemo(
    () =>
      (roles ?? []).map((role) => {
        const verdict = grantable(role);
        const detail =
          verdict === 'ownerOnly'
            ? t('team.ownerOnly')
            : verdict === 'cantGrant'
              ? t('team.cantGrant')
              : role.kind === 'owner'
                ? t('team.allPermissions')
                : t('team.permissionCount', { count: role.permissions.length });
        return {
          value: role.id,
          disabled: verdict !== 'ok',
          label: (
            <span className="grid">
              <span className="font-medium text-ink">{role.name}</span>
              <span className="text-caption text-ink-3">{detail}</span>
            </span>
          ),
        };
      }),
    [roles, grantable, t],
  );
}

interface InviteFormProps {
  onDone: () => void;
  // Called with the new invitation — the wizard lists who it has invited so far
  onInvited?: (invitation: Invitation) => void;
}

export function InviteForm({ onDone, onInvited }: InviteFormProps) {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const queryClient = useQueryClient();
  const { data: roles } = useQuery(rolesQuery(tenantId));
  const options = useRoleOptions(roles);
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(createInvitationInputSchema, { error: contractErrorMap }),
    defaultValues: { email: '', roleIds: [] },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const invitation = await call(routes.invitations.create, { body: values });
      await queryClient.invalidateQueries({ queryKey: ['invitations', tenantId] });
      // "Sending", not "sent": the worker sends it a moment later. The list shows how it ends.
      toast(t('team.invited', { email: invitation.email }));
      onInvited?.(invitation);
      onDone();
    } catch (error) {
      applyApiError(error, INVITE_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('team.inviteTitle')}
      description={t('team.inviteDescription', { workspace: me?.tenant.name ?? '' })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="invite-form" disabled={isSubmitting}>
            {isSubmitting ? t('team.sending') : t('team.send')}
          </Button>
        </>
      }
    >
      <form
        id="invite-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <TextField
          label={t('team.email')}
          icon={Mail01Icon}
          type="email"
          autoComplete="off"
          placeholder="tanvir@rahmangarments.com"
          {...register('email')}
          error={errors.email?.message}
        />
        {/* Radix Checkbox আসল <input> না, তাই register চলে না — Controller মান আর onChange জোড়ে */}
        <Controller
          control={control}
          name="roleIds"
          render={({ field }) => (
            <CheckboxGroup
              legend={t('team.roles')}
              hint={t('team.rolesHint')}
              options={options}
              value={field.value}
              onChange={field.onChange}
              error={errors.roleIds?.message}
            />
          )}
        />
      </form>
    </DialogContent>
  );
}
```

- Moved for the same reason: the wizard's last step opens this exact dialog.
- **The toast says "Sending the invitation to …"**, with no "not sent" branch any more: the answer always says
  `sending`. The list shows the end result.
- `onInvited` is optional: the team page does not need it; the wizard lists who it has invited so far.

**File: `apps/app/src/routes/team.tsx`** (change)

```diff
@@ -7,22 +7,11 @@ import {
   UserMultipleIcon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
-import { zodResolver } from '@hookform/resolvers/zod';
-import {
-  contractErrorMap,
-  createInvitationInputSchema,
-  type Invitation,
-  type Member,
-  type MemberSort,
-  type MeResponse,
-  type Role,
-  routes,
-} from '@omnivo/contracts';
+import { type Invitation, type Member, type MemberSort, routes } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import {
   Button,
   CheckboxGroup,
-  type CheckboxOption,
   DataTable,
   dataTableColumns,
   Dialog,
@@ -33,22 +22,19 @@ import {
   Pill,
   SectionHeader,
   type SortingState,
-  TextField,
   toast,
 } from '@omnivo/ui';
 import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { useCallback, useMemo, useState } from 'react';
-import { Controller, useForm } from 'react-hook-form';
 
+import { InviteForm, useRoleOptions } from '../components/invite-form';
 import { ApiRequestError, call } from '../lib/api';
-import { applyApiError } from '../lib/field-errors';
 import { useCan } from '../lib/permissions';
 import { invitationsQuery, membersQuery, rolesQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 
 const memberColumn = dataTableColumns<Member>();
 const invitationColumn = dataTableColumns<Invitation>();
-const INVITE_FIELDS = createInvitationInputSchema.keyof().options;
 
 function initials(name: string): string {
   return name
@@ -65,138 +51,6 @@ function failureOf(error: Error | null): string | undefined {
   return error instanceof ApiRequestError ? error.code : 'unknown_error';
 }
 
-// এই রোল আমি দিতে (বা কেড়ে নিতে) পারি কি না — API-র grants.ts-এর একই নিয়ম, শুধু আগেভাগে বাক্সটা বন্ধ
-// রাখার জন্য। owner-কে owner চেনা যায় me.roles-এ owner রোলের নাম দেখে (সেই নাম বদলানো যায় না)
-function useGrantable(roles: readonly Role[] | undefined, me: MeResponse | null) {
-  return useCallback(
-    (role: Role): 'ok' | 'ownerOnly' | 'cantGrant' => {
-      if (!me || !roles) return 'cantGrant';
-      const ownerName = roles.find((candidate) => candidate.kind === 'owner')?.name;
-      if (ownerName !== undefined && me.roles.includes(ownerName)) return 'ok';
-      if (role.kind === 'owner') return 'ownerOnly';
-      return role.permissions.every((key) => me.permissions.includes(key)) ? 'ok' : 'cantGrant';
-    },
-    [roles, me],
-  );
-}
-
-// invite আর সদস্যের ফর্ম — দুটোতেই একই রোলের তালিকা: নাম, নিচে কী দেয়, আর দিতে না পারলে কেন
-function useRoleOptions(roles: readonly Role[] | undefined): CheckboxOption[] {
-  const { t } = useLocale();
-  const me = useSession((state) => state.me);
-  const grantable = useGrantable(roles, me);
-  return useMemo(
-    () =>
-      (roles ?? []).map((role) => {
-        const verdict = grantable(role);
-        const detail =
-          verdict === 'ownerOnly'
-            ? t('team.ownerOnly')
-            : verdict === 'cantGrant'
-              ? t('team.cantGrant')
-              : role.kind === 'owner'
-                ? t('team.allPermissions')
-                : t('team.permissionCount', { count: role.permissions.length });
-        return {
-          value: role.id,
-          disabled: verdict !== 'ok',
-          label: (
-            <span className="grid">
-              <span className="font-medium text-ink">{role.name}</span>
-              <span className="text-caption text-ink-3">{detail}</span>
-            </span>
-          ),
-        };
-      }),
-    [roles, grantable, t],
-  );
-}
-
-function InviteForm({ onDone }: { onDone: () => void }) {
-  const { t } = useLocale();
-  const me = useSession((state) => state.me);
-  const tenantId = me?.tenant.id ?? '';
-  const queryClient = useQueryClient();
-  const { data: roles } = useQuery(rolesQuery(tenantId));
-  const options = useRoleOptions(roles);
-  const {
-    register,
-    control,
-    handleSubmit,
-    setError,
-    formState: { errors, isSubmitting },
-  } = useForm({
-    resolver: zodResolver(createInvitationInputSchema, { error: contractErrorMap }),
-    defaultValues: { email: '', roleIds: [] },
-  });
-
-  const onSubmit = handleSubmit(async (values) => {
-    try {
-      const invitation = await call(routes.invitations.create, { body: values });
-      await queryClient.invalidateQueries({ queryKey: ['invitations', tenantId] });
-      // চিঠি না গেলেও invitation তৈরি — সেটা স্পষ্ট করে বলা, "পাঠানো হয়েছে" বলে ভুল ধারণা না দেওয়া
-      toast(
-        invitation.sentAt === null
-          ? t('team.notSent')
-          : t('team.invited', { email: invitation.email }),
-      );
-      onDone();
-    } catch (error) {
-      applyApiError(error, INVITE_FIELDS, setError);
-    }
-  });
-
-  return (
-    <DialogContent
-      title={t('team.inviteTitle')}
-      description={t('team.inviteDescription', { workspace: me?.tenant.name ?? '' })}
-      footer={
-        <>
-          <DialogClose asChild>
-            <Button variant="secondary">{t('common.cancel')}</Button>
-          </DialogClose>
-          <Button type="submit" form="invite-form" disabled={isSubmitting}>
-            {isSubmitting ? t('team.sending') : t('team.send')}
-          </Button>
-        </>
-      }
-    >
-      <form
-        id="invite-form"
-        noValidate
-        onSubmit={(event) => void onSubmit(event)}
-        className="grid gap-5"
-      >
-        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
-        <TextField
-          label={t('team.email')}
-          icon={Mail01Icon}
-          type="email"
-          autoComplete="off"
-          placeholder="tanvir@rahmangarments.com"
-          {...register('email')}
-          error={errors.email?.message}
-        />
-        {/* Radix Checkbox আসল <input> না, তাই register চলে না — Controller মান আর onChange জোড়ে */}
-        <Controller
-          control={control}
-          name="roleIds"
-          render={({ field }) => (
-            <CheckboxGroup
-              legend={t('team.roles')}
-              hint={t('team.rolesHint')}
-              options={options}
-              value={field.value}
-              onChange={field.onChange}
-              error={errors.roleIds?.message}
-            />
-          )}
-        />
-      </form>
-    </DialogContent>
-  );
-}
-
 function InvitationPanel({ invitation, onDone }: { invitation: Invitation; onDone: () => void }) {
   const { t, format } = useLocale();
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
@@ -211,7 +65,7 @@ function InvitationPanel({ invitation, onDone }: { invitation: Invitation; onDon
       }),
     onSuccess: async (saved) => {
       await refresh();
-      toast(saved.sentAt === null ? t('team.notSent') : t('team.resent', { email: saved.email }));
+      toast(t('team.resent', { email: saved.email }));
       onDone();
     },
   });
@@ -287,18 +141,27 @@ function InvitationStatus({ invitation }: { invitation: Invitation }) {
       </Pill>
     );
   }
-  if (invitation.sentAt === null) {
-    return (
-      <Pill tone="warn" icon={Alert02Icon}>
-        {t('team.statuses.notSent')}
-      </Pill>
-    );
+  // The worker's result: still being sent (or retried), gone out, or given up
+  switch (invitation.delivery) {
+    case 'sending':
+      return (
+        <Pill tone="neutral" icon={Mail01Icon}>
+          {t('team.statuses.sending')}
+        </Pill>
+      );
+    case 'failed':
+      return (
+        <Pill tone="warn" icon={Alert02Icon}>
+          {t('team.statuses.notSent')}
+        </Pill>
+      );
+    case 'sent':
+      return (
+        <Pill tone="brand" icon={MailSend01Icon}>
+          {t('team.statuses.sent')}
+        </Pill>
+      );
   }
-  return (
-    <Pill tone="brand" icon={MailSend01Icon}>
-      {t('team.statuses.sent')}
-    </Pill>
-  );
 }
 
 function MemberForm({ member, onDone }: { member: Member; onDone: () => void }) {
```

- **A `switch` over `delivery`**, one pill per state, each with an icon and a label (status colour is never used
  alone). "Sending" is neutral: nothing to do yet. "Email not sent" is `warn`: someone should press Resend.
- The list polls on its own now (the query above), so after an invite the row turns from "Sending" to "Sent"
  without any code on this page.

### The bell

**File: `apps/app/src/components/notification-bell.tsx`** (new)

```tsx
import { Notification03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  DEFAULT_SETTINGS,
  isNotificationType,
  type Notification,
  type NotificationType,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { cn, EmptyState, Popover, PopoverContent, PopoverTrigger } from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { call } from '../lib/api';
import { notificationsQuery, settingsQuery, unreadCountQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// Where a click on each kind of notification takes you. satisfies: a new type without a page does
// not compile, and the values are checked against the router's real paths by navigate() below.
const TARGET = {
  'workspace.ready': '/roles',
  'member.joined': '/team',
  'invitation.failed': '/team',
} as const satisfies Record<NotificationType, string>;

// The badge stops at 9+: a two-digit count would not fit the 18px circle, and past nine the exact
// number no longer changes what you do
function badgeText(count: number): string {
  return count > 9 ? '9+' : String(count);
}

function Item({
  notification,
  timeZone,
  onOpen,
}: {
  notification: Notification & { type: NotificationType };
  timeZone: string;
  onOpen: () => void;
}) {
  const { t, format } = useLocale();
  const unread = notification.readAt === null;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-subtle"
      >
        {/* Unread = a brand dot, plus hidden text: the dot alone says nothing to a screen reader */}
        <span
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            unread ? 'bg-brand' : 'bg-transparent',
          )}
        />
        <span className="min-w-0">
          {unread && <span className="sr-only">{t('notifications.unread')}: </span>}
          <span className={cn('block text-body-sm', unread ? 'text-ink' : 'text-ink-2')}>
            {t(`notifications.types.${notification.type}`, notification.params)}
          </span>
          <span className="block text-caption text-ink-3 tabular-nums">
            {format.dateTime(new Date(notification.createdAt), timeZone)}
          </span>
        </span>
      </button>
    </li>
  );
}

// The bell next to the logo. The badge polls a tiny endpoint every 30 seconds (unreadCountQuery);
// the list itself is only fetched while the panel is open.
export function NotificationBell() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const [open, setOpen] = useState(false);

  const { data: unread = 0 } = useQuery(unreadCountQuery(tenantId));
  const list = useQuery({ ...notificationsQuery(tenantId), enabled: open });
  // Times in the workspace's time zone, like the audit log
  const { data: settings } = useQuery({ ...settingsQuery(tenantId), enabled: open });
  const timeZone = settings?.timezone ?? DEFAULT_SETTINGS.timezone;

  // One prefix for the count and the list, so a single invalidate refreshes both
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications', tenantId] });
  const markRead = useMutation({
    mutationFn: (id: string) => call(routes.notifications.markRead, { params: { id } }),
    onSettled: refresh,
  });
  const markAllRead = useMutation({
    mutationFn: () => call(routes.notifications.markAllRead),
    onSettled: refresh,
  });

  // A newer server may send a type this app does not know yet: skip it instead of showing a key
  const items = (list.data ?? []).filter(
    (item): item is Notification & { type: NotificationType } => isNotificationType(item.type),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            unread > 0
              ? t('shell.notificationsUnread', { count: unread })
              : t('shell.notifications')
          }
          className="relative grid place-items-center rounded-lg p-2 text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink"
        >
          <HugeiconsIcon icon={Notification03Icon} size={18} strokeWidth={1.5} />
          {unread > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-1 text-caption leading-none font-medium text-brand-ink tabular-nums"
            >
              {badgeText(unread)}
            </span>
          )}
        </button>
      </PopoverTrigger>
      {/* 340px, but never wider than the screen minus the 16px gutters on a phone */}
      <PopoverContent align="end" className="w-[340px] max-w-[calc(100vw-32px)]">
        <div className="flex items-center justify-between gap-3 px-2 pb-2">
          <h2 className="text-h3">{t('notifications.title')}</h2>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => {
                markAllRead.mutate();
              }}
              className="text-label font-medium text-brand underline-offset-[3px] hover:underline"
            >
              {t('notifications.markAllRead')}
            </button>
          )}
        </div>
        {list.isError ? (
          <p className="px-2 py-4 text-body-sm text-crit">{t('notifications.loadFailed')}</p>
        ) : list.data && items.length === 0 ? (
          <EmptyState
            icon={Notification03Icon}
            title={t('notifications.emptyTitle')}
            description={t('notifications.emptyBody')}
          />
        ) : (
          // Scrolls inside the panel: 20 items would run off a phone screen
          <ul className="grid max-h-[min(420px,60dvh)] gap-px overflow-y-auto">
            {items.map((notification) => (
              <Item
                key={notification.id}
                notification={notification}
                timeZone={timeZone}
                onOpen={() => {
                  if (notification.readAt === null) markRead.mutate(notification.id);
                  setOpen(false);
                  void navigate({ to: TARGET[notification.type] });
                }}
              />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- **Two queries with different costs.** The count is tiny and always on. The list (20 rows) and the settings (for
  the time zone) are fetched only while the panel is open (`enabled: open`).
- **The badge is `aria-hidden`**; the button's own label carries the count. A screen reader hears "Notifications,
  2 unread", not "Notifications 2".
- **`9+`**: a two-digit number does not fit the 18 px circle, and past nine the exact count does not change what
  you do.
- **Unknown types are skipped** (`isNotificationType`), not shown as raw keys. The type guard also narrows the
  item, so `TARGET[notification.type]` and the `t()` key are type-checked.
- `TARGET` sends each type to the page it is about. `satisfies Record<NotificationType, string>` makes a new type
  without a page a compile error, and `navigate({ to })` checks the path against the router.
- **Click = mark read, close, navigate** — one action, because that is what people do with a notification.
- The unread dot has hidden text ("Unread:"). A dot alone says nothing to a screen reader, and colour alone is not
  allowed by the design system.
- The list scrolls inside the panel (`max-h-[min(420px,60dvh)]`); 20 rows would run off a phone screen. The panel
  is `max-w-[calc(100vw-32px)]` so it keeps the 16 px gutters on a phone.
- `cn()` merges the conditional classes, never a template string (CLAUDE.md → Class names).

### The onboarding wizard

**File: `apps/app/src/routes/onboarding.tsx`** (new)

```tsx
import {
  Building03Icon,
  Call02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  DeliveryTruck01Icon,
  Factory01Icon,
  IdentityCardIcon,
  Mail01Icon,
  Medicine02Icon,
  Store01Icon,
  TShirtIcon,
  UserAdd01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Industry,
  INDUSTRIES,
  type Invitation,
  routes,
  type Settings,
  updateSettingsInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Dialog,
  FormAlert,
  Logo,
  Pill,
  SelectableCardGroup,
  Stepper,
  TextAreaField,
  TextField,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { InviteForm } from '../components/invite-form';
import { LanguageSwitch } from '../components/language-switch';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rolesQuery, settingsQuery, setupQuery } from '../lib/queries';
import { refreshMe } from '../lib/session';
import { useSession } from '../lib/session-store';
import { settingsToForm } from '../lib/settings-form';

// One icon per business type. satisfies: a new industry in contracts does not compile without one.
const INDUSTRY_ICON = {
  garments: TShirtIcon,
  pharma: Medicine02Icon,
  distribution: DeliveryTruck01Icon,
  manufacturing: Factory01Icon,
  retail: Store01Icon,
  other: Building03Icon,
} satisfies Record<Industry, IconSvgElement>;

const STEPS = ['business', 'company', 'team'] as const;
type Step = 0 | 1 | 2;
const SETTINGS_FIELDS = updateSettingsInputSchema.keyof().options;

// The wizard's white panel: title, text, content and a button row under a rule, like sign-up
function Panel({
  step,
  title,
  subtitle,
  children,
  footer,
}: {
  step: Step;
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <div className="rounded-card border border-line bg-surface px-[18px] py-[22px] shadow-md sm:p-8">
      <p className="text-caption text-ink-3">
        {t('onboarding.stepOf', { current: step + 1, total: STEPS.length })}
      </p>
      <h1 className="mt-1 text-h2">{title}</h1>
      <p className="mt-1.5 text-ink-2">{subtitle}</p>
      <div className="mt-7">{children}</div>
      <div className="mt-8 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-6">
        {footer}
      </div>
    </div>
  );
}

function BusinessStep({ onDone }: { onDone: () => void }) {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const queryClient = useQueryClient();
  const [industry, setIndustry] = useState<Industry | null>(null);

  const options = useMemo(
    () =>
      INDUSTRIES.map((value) => ({
        value,
        icon: INDUSTRY_ICON[value],
        title: t(`onboarding.industries.${value}.name`),
        description: t(`onboarding.industries.${value}.description`),
      })),
    [t],
  );

  const start = useMutation({
    mutationFn: (picked: Industry) => call(routes.setup.start, { body: { industry: picked } }),
    onSuccess: async (setup) => {
      // The answer is the new status ('provisioning'): put it in the cache so the last step starts
      // polling from here, without a first request of its own
      queryClient.setQueryData(setupQuery(tenantId).queryKey, setup);
      // me.tenant.setupStatus is no longer 'pending' — otherwise the router would send us back here
      await refreshMe();
      onDone();
    },
  });

  return (
    <Panel
      step={0}
      title={t('onboarding.business.title', { company: me?.tenant.name ?? '' })}
      subtitle={t('onboarding.business.subtitle')}
      footer={
        <Button
          disabled={industry === null || start.isPending}
          onClick={() => {
            if (industry !== null) start.mutate(industry);
          }}
          className="w-full sm:w-auto sm:min-w-40"
        >
          {start.isPending ? t('onboarding.starting') : t('onboarding.continue')}
        </Button>
      }
    >
      <div className="grid gap-5">
        {start.error && (
          <FormAlert
            message={start.error instanceof ApiRequestError ? start.error.code : 'unknown_error'}
          />
        )}
        <SelectableCardGroup
          legend={t('onboarding.business.label')}
          options={options}
          value={industry}
          onChange={setIndustry}
        />
      </div>
    </Panel>
  );
}

function CompanyForm({ settings, onDone }: { settings: Settings; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  // The full settings form, showing four of its fields: the rest (currency, fiscal year…) ride
  // along from settingsToForm unchanged, because PUT /settings takes the whole profile
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateSettingsInputSchema, { error: contractErrorMap }),
    defaultValues: settingsToForm(settings),
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.settings.update, { body: values });
      queryClient.setQueryData(settingsQuery(tenantId).queryKey, saved);
      onDone();
    } catch (error) {
      applyApiError(error, SETTINGS_FIELDS, setError);
    }
  });

  return (
    <Panel
      step={1}
      title={t('onboarding.company.title')}
      subtitle={t('onboarding.company.subtitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onDone}>
            {t('onboarding.skip')}
          </Button>
          <Button
            type="submit"
            form="company-form"
            disabled={isSubmitting}
            className="w-full sm:w-auto sm:min-w-40"
          >
            {isSubmitting ? t('common.saving') : t('onboarding.continue')}
          </Button>
        </>
      }
    >
      <form
        id="company-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5 sm:grid-cols-2 sm:gap-x-4"
      >
        {errors.root?.server?.message && (
          <div className="sm:col-span-2">
            <FormAlert message={errors.root.server.message} />
          </div>
        )}
        <TextField
          label={t('settings.legalName')}
          optional
          hint={t('settings.legalNameHint')}
          placeholder="Rahman Knit Garments Limited"
          {...register('legalName')}
          error={errors.legalName?.message}
        />
        <TextField
          label={t('settings.bin')}
          icon={IdentityCardIcon}
          optional
          inputMode="numeric"
          hint={t('settings.binHint')}
          placeholder="000123456-0101"
          {...register('bin')}
          error={errors.bin?.message}
        />
        <TextField
          label={t('settings.phone')}
          icon={Call02Icon}
          optional
          type="tel"
          placeholder="+880 1711-000000"
          {...register('phone')}
          error={errors.phone?.message}
        />
        <div className="sm:col-span-2">
          <TextAreaField
            label={t('settings.address')}
            optional
            placeholder="Plot 12, BSCIC Industrial Area, Konabari, Gazipur 1751"
            {...register('address')}
            error={errors.address?.message}
          />
        </div>
      </form>
    </Panel>
  );
}

function CompanyStep({ onDone }: { onDone: () => void }) {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const { data: settings } = useQuery(settingsQuery(tenantId));
  // The form needs the settings' version (optimistic locking), so it waits for them. The key
  // makes a fresh form if another version ever arrives.
  if (!settings) return null;
  return <CompanyForm key={settings.version} settings={settings} onDone={onDone} />;
}

// Where the background job is, in words and a pill — the build plan's "job status"
function SetupProgress() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const { data: setup } = useQuery(setupQuery(tenantId));
  const ready = setup?.status === 'ready';
  const { data: roles } = useQuery({ ...rolesQuery(tenantId), enabled: ready });

  const retry = useMutation({
    mutationFn: () => call(routes.setup.retry),
    onSuccess: (next) => {
      queryClient.setQueryData(setupQuery(tenantId).queryKey, next);
    },
  });

  if (!setup) return null;
  const industry = setup.industry === null ? '' : t(`onboarding.industries.${setup.industry}.name`);

  if (setup.status === 'failed') {
    return (
      <div className="grid gap-3">
        <FormAlert message={t('onboarding.team.failed')} />
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={retry.isPending}
            onClick={() => {
              retry.mutate();
            }}
          >
            {t('onboarding.team.retry')}
          </Button>
        </div>
      </div>
    );
  }
  // role="status": a screen reader announces the change from "Preparing…" to "Roles ready"
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
      {ready ? (
        <>
          <Pill tone="good" icon={CheckmarkCircle02Icon}>
            {industry}
          </Pill>
          {t('onboarding.team.ready', {
            roles: (roles ?? [])
              .filter((role) => role.kind === 'custom')
              .map((role) => role.name)
              .join(', '),
          })}
        </>
      ) : (
        <>
          <Pill tone="neutral" icon={Clock01Icon}>
            {industry}
          </Pill>
          {t('onboarding.team.preparing', { industry })}
        </>
      )}
    </p>
  );
}

function TeamStep() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const { data: setup } = useQuery(setupQuery(tenantId));
  const [inviting, setInviting] = useState(false);
  const [invited, setInvited] = useState<Invitation[]>([]);

  return (
    <Panel
      step={2}
      title={t('onboarding.team.title')}
      subtitle={t('onboarding.team.subtitle')}
      footer={
        <Button onClick={() => void navigate({ to: '/' })} className="w-full sm:w-auto sm:min-w-40">
          {t('onboarding.team.finish')}
        </Button>
      }
    >
      <div className="grid gap-5">
        <SetupProgress />
        <div>
          {/* The template's roles are what people get invited to: wait until they exist */}
          <Button
            variant="secondary"
            disabled={setup?.status !== 'ready'}
            onClick={() => {
              setInviting(true);
            }}
          >
            <HugeiconsIcon icon={UserAdd01Icon} size={17} strokeWidth={1.5} />
            {t('onboarding.team.invite')}
          </Button>
        </div>
        {invited.length > 0 && (
          <section className="grid gap-2">
            <h2 className="text-label font-medium text-ink">{t('onboarding.team.invited')}</h2>
            <ul className="grid gap-1.5">
              {invited.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex min-w-0 items-center gap-2 text-body-sm text-ink-2"
                >
                  <HugeiconsIcon
                    icon={Mail01Icon}
                    size={16}
                    strokeWidth={1.5}
                    className="shrink-0 text-ink-3"
                  />
                  <span className="truncate">{invitation.email}</span>
                  <span className="shrink-0 text-ink-3">
                    · {invitation.roles.map((role) => role.name).join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <Dialog open={inviting} onOpenChange={setInviting}>
        {inviting && (
          <InviteForm
            onDone={() => {
              setInviting(false);
            }}
            onInvited={(invitation) => {
              setInvited((list) => [...list, invitation]);
            }}
          />
        )}
      </Dialog>
    </Panel>
  );
}

// Full page, outside the app shell: nothing else to click until the business type is chosen.
// The router sends an owner here while the setup is 'pending' (router.tsx).
export function OnboardingPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  // Coming back after step 1 (a reload, or a later visit): start at the company step. The type
  // is picked once, so step 1 is never shown again.
  const [step, setStep] = useState<Step>(() => (me?.tenant.setupStatus === 'pending' ? 0 : 1));
  if (!me) return null;

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface px-4 py-5 sm:px-10">
        <Logo />
        <LanguageSwitch />
      </header>
      <main className="mx-auto grid max-w-[720px] gap-6 px-4 pt-10 pb-16">
        <Stepper
          label={t('onboarding.stepsLabel')}
          steps={STEPS.map((name) => t(`onboarding.steps.${name}`))}
          current={step}
        />
        {step === 0 && (
          <BusinessStep
            onDone={() => {
              setStep(1);
            }}
          />
        )}
        {step === 1 && (
          <CompanyStep
            onDone={() => {
              setStep(2);
            }}
          />
        )}
        {/* A failed job shows up here, with its Retry button (SetupProgress) */}
        {step === 2 && <TeamStep />}
      </main>
    </div>
  );
}
```

- **Outside the app shell**, like sign-up. Until the business type is chosen there is nowhere else to go, so a
  sidebar would only offer dead ends.
- **The starting step comes from `me`**: `pending` → step 1, anything else → step 2. A reload in the middle of the
  wizard does not show step 1 again (it could not be submitted twice anyway).
- **BusinessStep.** Continue stays disabled until a card is picked. After `POST /setup` the answer goes straight
  into the setup query's cache (`setQueryData`), so step 3 starts polling from `provisioning` without an extra
  request. `refreshMe()` matters: `me.tenant.setupStatus` must stop being `pending`, or the router would send the
  owner back to step 1 as soon as they left.
- **CompanyStep uses the full settings form** but shows four fields. The rest (currency, fiscal year, time zone)
  ride along unchanged from `settingsToForm`, because `PUT /settings` takes the whole profile with its `version`.
  `key={settings.version}` gives a fresh form if a newer version ever arrives. "Skip for now" is a real choice:
  nothing here is required.
- **TeamStep waits for the job.** "Invite people" stays disabled until the status is `ready`, because the roles
  people are invited to do not exist before that. `SetupProgress` is the build plan's "job status": a pill with the
  industry, "Preparing the roles…", then "Roles ready: Accountant, Merchandiser, Store keeper" (read from the real
  role list, not from the template). On failure: an alert and "Try again", which calls `/setup/retry`.
- `role="status"` on the progress line: a screen reader announces when "Preparing…" turns into "Roles ready".
- The invited list has its own `<h2>`. The page's `<h1>` is the step title, as on every page.

### Routing: the wizard comes first

**File: `apps/app/src/router.tsx`** (change)

```diff
@@ -46,6 +46,27 @@ const signUpRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/sign-up'), 'SignUpPage'),
 });
 
+// Only someone who can change the settings runs the setup. Others use the app as it is; the
+// owner finishes the setup when they sign in next.
+function mustRunSetup(): boolean {
+  const me = sessionStore.getState().me;
+  return me?.tenant.setupStatus === 'pending' && me.permissions.includes('core.settings.manage');
+}
+
+// The setup wizard: signed in, but outside the AppShell — until the business type is picked,
+// there is nothing else to go to
+const onboardingRoute = createRoute({
+  getParentRoute: () => rootRoute,
+  path: '/onboarding',
+  beforeLoad: async () => {
+    await restoreSession();
+    const { status, me } = sessionStore.getState();
+    if (status !== 'signed-in') throw redirect({ to: '/login' });
+    if (!me?.permissions.includes('core.settings.manage')) throw redirect({ to: '/' });
+  },
+  component: lazyRouteComponent(() => import('./routes/onboarding'), 'OnboardingPage'),
+});
+
 // pathless layout route: এর নিচের সব পেজ protected, আর সবগুলো AppShell-এর ভেতরে
 const appRoute = createRoute({
   getParentRoute: () => rootRoute,
@@ -55,6 +76,9 @@ const appRoute = createRoute({
     if (sessionStore.getState().status !== 'signed-in') {
       throw redirect({ to: '/login' });
     }
+    // A new workspace goes through the wizard first — right after sign-up, and on any later
+    // visit until a business type is picked
+    if (mustRunSetup()) throw redirect({ to: '/onboarding' });
   },
   // layout-ও lazy: সাইডবারের Radix মেনু (~৩০ KB gz) লগইনের আগে লাগে না
   component: lazyRouteComponent(() => import('./routes/app-shell'), 'AppShell'),
@@ -118,6 +142,7 @@ const routeTree = rootRoute.addChildren([
   loginRoute,
   signUpRoute,
   inviteRoute,
+  onboardingRoute,
   appRoute.addChildren([
     dashboardRoute,
     settingsRoute,
```

- **The redirect is in the app layout's `beforeLoad`**, so every protected page — the dashboard after sign-up, a
  bookmark, a refresh — sends a `pending` owner to the wizard first.
- **Only people who can change settings are sent there.** An accountant who joins before the owner has finished
  uses the app as it is; the owner runs the setup on their next visit. Otherwise invited people would be locked
  out by a wizard they cannot submit.
- `/onboarding` has its own guard: signed in, and allowed to change settings. Everyone else goes to `/`.
- `mustRunSetup()` reads `sessionStore` directly. It runs before React renders, where hooks do not work.

**File: `apps/app/src/routes/app-shell.tsx`** (change)

```diff
@@ -34,6 +34,7 @@ import {
 import { createLink, Outlet, useNavigate } from '@tanstack/react-router';
 import { useEffect, useState } from 'react';
 
+import { NotificationBell } from '../components/notification-bell';
 import { savePreference } from '../lib/preferences';
 import { logout, switchTenant } from '../lib/session';
 import { useCan } from '../lib/permissions';
@@ -205,6 +206,7 @@ export function AppShell() {
   return (
     <Shell
       brand={<Logo />}
+      actions={<NotificationBell />}
       topBarActions={
         <DropdownMenu>
           <DropdownMenuTrigger asChild>
```

---

## 8.12 — MSW: a pretend worker in the mocks

`pnpm dev:mock` has no worker. The mocks imitate one by time: a state changes on the first read after a delay.

**File: `apps/app/src/mocks/people-data.ts`** (change)

```diff
@@ -23,12 +23,19 @@ export interface MockRole {
   updatedAt: string;
 }
 
-export interface MockInvitation extends Invitation {
+// delivery is not stored: it is worked out from sendsAt, the way the real worker would move it
+// along a moment after the request (see toInvitation)
+export interface MockInvitation extends Omit<Invitation, 'delivery'> {
   token: string;
   acceptedAt: string | null;
   revokedAt: string | null;
+  // When the pretend worker "sends" it (ms since epoch)
+  sendsAt: number;
 }
 
+// How long the pretend worker takes — long enough to see "Sending" in the list
+export const MOCK_SEND_DELAY_MS = 1_500;
+
 export interface People {
   roles: MockRole[];
   members: Member[];
@@ -172,7 +179,13 @@ export function toInvitation(invitation: MockInvitation): Invitation {
     email: invitation.email,
     roles: invitation.roles,
     invitedBy: invitation.invitedBy,
-    sentAt: invitation.sentAt,
+    // Addresses with "bounce" in them never arrive — the UI's "Email not sent" path
+    delivery:
+      Date.now() < invitation.sendsAt
+        ? 'sending'
+        : invitation.email.includes('bounce')
+          ? 'failed'
+          : 'sent',
     expiresAt: invitation.expiresAt,
     createdAt: invitation.createdAt,
     version: invitation.version,
```

- `delivery` is not stored; `toInvitation` works it out from `sendsAt`. So the list really goes from "Sending" to
  "Sent" while the page polls, like against the real API.
- An address with `bounce` in it ends in "Email not sent" — the same trick as before, now on the new field.

**File: `apps/app/src/mocks/workspace-data.ts`** (change)

```diff
@@ -10,10 +10,12 @@ import {
   DOCUMENT_TYPES,
   type DocumentType,
   formatDocumentNumber,
+  type Notification,
   type NumberFormat,
   type NumberSeries,
   periodOf,
   type Settings,
+  type Setup,
   todayIn,
 } from '@omnivo/contracts';
 
@@ -29,6 +31,10 @@ export interface WorkspaceData {
   series: Map<DocumentType, NumberFormat & { version: number }>;
   audit: AuditEntry[];
   people: People;
+  setup: Setup;
+  // When a started setup "finishes" (ms since epoch) — the pretend worker, see setup-data.ts
+  setupReadyAt: number | null;
+  notifications: Notification[];
 }
 
 function now(): string {
@@ -74,6 +80,10 @@ function seed(workspace: Workspace): WorkspaceData {
     series: new Map(),
     audit: [],
     people: seedPeople(workspace),
+    // The fixture workspaces were set up long ago; a signed-up one starts at 'pending'
+    setup: { status: 'ready', industry: garments ? 'garments' : 'pharma' },
+    setupReadyAt: null,
+    notifications: garments ? seedNotifications() : [],
   };
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
@@ -81,8 +91,55 @@ function seed(workspace: Workspace): WorkspaceData {
   return data;
 }
 
+function ago(minutes: number): string {
+  return new Date(Date.now() - minutes * 60_000).toISOString();
+}
+
+// One of each type, two unread — the bell has something to show from the first page load
+function seedNotifications(): Notification[] {
+  return [
+    {
+      id: crypto.randomUUID(),
+      type: 'member.joined',
+      params: { name: 'Nasrin Akter' },
+      readAt: null,
+      createdAt: ago(12),
+    },
+    {
+      id: crypto.randomUUID(),
+      type: 'invitation.failed',
+      params: { email: 'rupa@rahmangarments.bounce' },
+      readAt: null,
+      createdAt: ago(95),
+    },
+    {
+      id: crypto.randomUUID(),
+      type: 'workspace.ready',
+      params: {},
+      readAt: ago(60 * 24),
+      createdAt: ago(60 * 26),
+    },
+  ];
+}
+
 const store = new Map<string, WorkspaceData>();
 
+// Mock sign-up: the first fixture workspace starts over as a brand-new one — the owner alone, the
+// Owner role only, setup 'pending' — so `pnpm dev:mock` shows the onboarding wizard after sign-up
+export function startFresh(workspace: Workspace, companyName: string): void {
+  const data = seed(workspace);
+  data.settings = { ...data.settings, companyName, bin: null };
+  data.branches = data.branches.slice(0, 1);
+  data.people = {
+    roles: data.people.roles.filter((role) => role.kind === 'owner'),
+    members: data.people.members.filter((member) => member.userId === OWNER.id),
+    invitations: [],
+  };
+  data.setup = { status: 'pending', industry: null };
+  data.notifications = [];
+  store.set(workspace.tenantId, data);
+}
+
 export function dataOf(workspace: Workspace): WorkspaceData {
   let data = store.get(workspace.tenantId);
   if (!data) {
```

- The two fixture workspaces are `ready` (set up long ago). Rahman Garments has three seeded notifications, two of
  them unread, so the bell has something to show on the first page load.
- **`startFresh`** makes mock sign-up start a real new workspace: the owner alone, only the Owner role, setup
  `pending`. Without it, `pnpm dev:mock` could never show the wizard.

**File: `apps/app/src/mocks/setup-data.ts`** (new)

```ts
import type { Industry, Setup } from '@omnivo/contracts';

import { MockProblem } from './mock';
import { record, type WorkspaceData } from './workspace-data';

// How long the pretend setup job takes — long enough to see "Preparing the roles…"
const SETUP_DELAY_MS = 2_000;

// The same role names as the API's setup/templates.ts (the mock cannot import server code). Only
// names: the mock's new roles start with no permissions.
const TEMPLATE_ROLES = {
  garments: ['Accountant', 'Merchandiser', 'Store keeper'],
  pharma: ['Accountant', 'Depot manager', 'Sales representative'],
  distribution: ['Accountant', 'Depot manager', 'Sales officer'],
  manufacturing: ['Accountant', 'Production manager', 'Store keeper'],
  retail: ['Accountant', 'Shop manager', 'Cashier'],
  other: ['Accountant', 'Manager'],
} satisfies Record<Industry, string[]>;

export function startSetup(data: WorkspaceData, industry: Industry): Setup {
  if (data.setup.status !== 'pending') throw new MockProblem(409, 'setup_started');
  data.setup = { status: 'provisioning', industry };
  data.setupReadyAt = Date.now() + SETUP_DELAY_MS;
  record(data, 'workspace.setup_started', 'workspace', crypto.randomUUID(), {
    industry: { from: null, to: industry },
  });
  return data.setup;
}

// Called on every read: once the delay has passed, do what the worker would have done — roles,
// status, audit and a notification
export function settleSetup(data: WorkspaceData): void {
  const { industry } = data.setup;
  if (
    data.setup.status !== 'provisioning' ||
    industry === null ||
    data.setupReadyAt === null ||
    Date.now() < data.setupReadyAt
  ) {
    return;
  }
  const taken = new Set(data.people.roles.map((role) => role.name.toLowerCase()));
  const added = TEMPLATE_ROLES[industry].filter((name) => !taken.has(name.toLowerCase()));
  for (const name of added) {
    data.people.roles.push({
      id: crypto.randomUUID(),
      name,
      description: null,
      kind: 'custom',
      permissions: [],
      version: 1,
      updatedAt: new Date().toISOString(),
    });
  }
  data.setup = { status: 'ready', industry };
  data.setupReadyAt = null;
  record(data, 'workspace.provisioned', 'workspace', crypto.randomUUID(), {
    industry: { from: null, to: industry },
    roles: { from: null, to: added.join(', ') || null },
  });
  data.notifications.unshift({
    id: crypto.randomUUID(),
    type: 'workspace.ready',
    params: {},
    readAt: null,
    createdAt: new Date().toISOString(),
  });
}
```

- A separate file, because `workspace-data.ts` is imported by it — the other way round would be a circular import,
  which `pnpm boundaries` refuses (step 7 had the same problem with `MockProblem`).
- The role names are copied from the API's `templates.ts`: the browser cannot import server code. The mock's roles
  get no permissions; the real ones do.
- `settleSetup` does what the worker does, in the same order: roles, status, audit row, notification.

**File: `apps/app/src/mocks/fixtures.ts`** (change)

```diff
@@ -1,4 +1,9 @@
-import { type MeResponse, PERMISSION_KEYS, type Preferences } from '@omnivo/contracts';
+import {
+  type MeResponse,
+  PERMISSION_KEYS,
+  type Preferences,
+  type SetupStatus,
+} from '@omnivo/contracts';
 
 // আসল ইন্ডাস্ট্রির উদাহরণ (CLAUDE.md → Content): এক গার্মেন্টস আর এক ফার্মা, একই মালিক দুটোতে
 export const WORKSPACES = [
@@ -23,10 +28,11 @@ export function meIn(
   workspace: Workspace,
   companyName: string,
   preferences: Preferences,
+  setupStatus: SetupStatus,
 ): MeResponse {
   return {
     user: owner,
-    tenant: { id: workspace.tenantId, name: companyName, slug: workspace.slug },
+    tenant: { id: workspace.tenantId, name: companyName, slug: workspace.slug, setupStatus },
     roles: ['Owner'],
     permissions: OWNER_PERMISSIONS,
     memberships: [...WORKSPACES],
```

**File: `apps/app/src/mocks/handlers.ts`** (change)

```diff
@@ -12,11 +12,13 @@ import {
   findMember,
   findRole,
   isOpen,
+  MOCK_SEND_DELAY_MS,
   newToken,
   roleList,
   toInvitation,
   toRole,
 } from './people-data';
+import { settleSetup, startSetup } from './setup-data';
 import {
   assertCodeFree,
   checkVersion,
@@ -25,6 +27,7 @@ import {
   findBranch,
   record,
   seriesList,
+  startFresh,
 } from './workspace-data';
 
 // mock সার্ভারের অবস্থা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে
@@ -36,12 +39,16 @@ let preferences: Preferences = { language: null, theme: 'system' };
 const uploads = new Map<string, { contentType: string; sizeBytes: number; url?: string }>();
 const MOCK_STORAGE = `${API_URL}/mock-storage`;
 
+// settleSetup: a started setup "finishes" on the first read after its delay, like the worker would
 function current() {
-  return dataOf(workspace);
+  const data = dataOf(workspace);
+  settleSetup(data);
+  return data;
 }
 
 function me() {
-  return meIn(workspace, current().settings.companyName, preferences);
+  const data = current();
+  return meIn(workspace, data.settings.companyName, preferences, data.setup.status);
 }
 
 // handler-এর ভেতরে MockProblem ছুড়লেই আসল API-র মতো problem response — প্রতিটা নিয়মে আলাদা
@@ -113,6 +120,9 @@ export const handlers = [
     if (body.workspaceSlug === WORKSPACES[0].slug) {
       return problem(409, 'slug_taken', { workspaceSlug: ['slug_taken'] });
     }
+    // A new workspace: setup 'pending', so the app goes on to the onboarding wizard
+    workspace = WORKSPACES[0];
+    startFresh(workspace, body.companyName);
     signedIn = true;
     return reply(routes.auth.signUp, session());
   }),
@@ -304,8 +314,7 @@ export const handlers = [
           return { id: held.id, name: held.name };
         }),
         invitedBy: { id: OWNER.id, fullName: OWNER.fullName },
-        // "bounce" থাকা ঠিকানায় চিঠি "যায় না" — UI-র "Email not sent" পথ দেখার জন্য
-        sentAt: body.email.includes('bounce') ? null : new Date().toISOString(),
+        sendsAt: Date.now() + MOCK_SEND_DELAY_MS,
         expiresAt: expiry(),
         createdAt: new Date().toISOString(),
         version: 1,
@@ -337,7 +346,7 @@ export const handlers = [
       Object.assign(invitation, {
         token: newToken(),
         expiresAt: expiry(),
-        sentAt: new Date().toISOString(),
+        sendsAt: Date.now() + MOCK_SEND_DELAY_MS,
         version: version + 1,
       });
       console.info(`[mock] invitation link: ${window.location.origin}/invite#${invitation.token}`);
@@ -546,6 +555,62 @@ export const handlers = [
     return reply(routes.audit.list, { items, nextCursor: end < all.length ? String(end) : null });
   }),
 
+  mock(routes.setup.get, () => reply(routes.setup.get, current().setup)),
+
+  mock(
+    routes.setup.start,
+    guarded(async ({ request }) => {
+      const { industry } = await readBody(routes.setup.start.body, request);
+      await delay();
+      return reply(routes.setup.start, startSetup(current(), industry));
+    }),
+  ),
+
+  mock(
+    routes.setup.retry,
+    guarded(() => {
+      const data = current();
+      if (data.setup.status !== 'failed') throw new MockProblem(409, 'setup_not_failed');
+      return reply(routes.setup.retry, data.setup);
+    }),
+  ),
+
+  mock(routes.notifications.list, ({ request }) => {
+    const query = readQuery(routes.notifications.list.query, request);
+    // mock-এ cursor শুধু offset (members-এর মতো)
+    const start = query.cursor === undefined ? 0 : Number(query.cursor);
+    const all = current().notifications;
+    const items = all.slice(start, start + query.limit);
+    const end = start + items.length;
+    return reply(routes.notifications.list, {
+      items,
+      nextCursor: end < all.length ? String(end) : null,
+    });
+  }),
+
+  mock(routes.notifications.unreadCount, () =>
+    reply(routes.notifications.unreadCount, {
+      count: current().notifications.filter((item) => item.readAt === null).length,
+    }),
+  ),
+
+  mock(
+    routes.notifications.markRead,
+    guarded(({ params }) => {
+      const { id } = routes.notifications.markRead.params.parse(params);
+      const found = current().notifications.find((item) => item.id === id);
+      if (!found) throw new MockProblem(404, 'not_found');
+      found.readAt ??= new Date().toISOString();
+      return reply(routes.notifications.markRead, undefined);
+    }),
+  ),
+
+  mock(routes.notifications.markAllRead, () => {
+    const readAt = new Date().toISOString();
+    for (const item of current().notifications) item.readAt ??= readAt;
+    return reply(routes.notifications.markAllRead, undefined);
+  }),
+
   mock(routes.attachments.createUpload, async ({ request }) => {
     const body = await readBody(routes.attachments.createUpload.body, request);
     const id = crypto.randomUUID();
```

- `current()` now calls `settleSetup` on every read, so any request after the delay sees the finished setup —
  `/setup`, `/auth/me`, `/roles` alike.
- Mock sign-up switches to the first fixture workspace and resets it. The slug `rahman-garments` still gives
  `slug_taken`, as before.

---

## 8.13 — Playwright

**File: `apps/app/e2e/team.e2e.ts`** (change)

```diff
@@ -19,7 +19,11 @@ test('invites someone, refuses a second invitation, then cancels it', async ({ p
   await expect(dialog.getByRole('checkbox', { name: /Owner/ })).toBeEnabled();
   await dialog.getByRole('button', { name: 'Send invitation' }).click();
   await expect(dialog).toBeHidden();
-  await expect(page.getByText('Invitation sent to tanvir@rahmangarments.com')).toBeVisible();
+  await expect(page.getByText('Sending the invitation to tanvir@rahmangarments.com')).toBeVisible();
+  // The (pretend) worker sends it a moment later; the list polls until the pill says so. Only the
+  // end state is checked: "Sending" lasts 1.5 s in the mock, and a slow machine can miss it
+  // (the API integration test checks the "sending" answer itself)
+  await expect(listItem(page, /tanvir@rahmangarments.com.*Sent/)).toBeVisible();
 
   await page.getByRole('button', { name: 'Invite people' }).click();
   await dialog.getByLabel('Email').fill('tanvir@rahmangarments.com');
```

**File: `apps/app/e2e/onboarding.e2e.ts`** (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll } from './helpers.js';

// The mock starts signed in (as the Rahman Garments owner). Sign out through the menu — client-side,
// so the mock keeps its state — then create a new workspace from the sign-up page.
async function signUpNewWorkspace(page: Page): Promise<void> {
  await page.goto('/');
  // Desktop: the account button at the bottom of the sidebar; phone: the icon in the top bar.
  // Only one of them is visible at a time.
  await page
    .getByRole('button', { name: /Farhana Rahman/ })
    .or(page.getByRole('button', { name: 'Account' }))
    .filter({ visible: true })
    .click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('link', { name: 'Create a workspace' }).click();

  await page.getByLabel('Company name').fill('Karim Knitwear Ltd.');
  await page.getByLabel('Full name').fill('Karim Uddin');
  await page.getByLabel('Work email').fill('karim@karimknitwear.com');
  await page.getByLabel('Password').fill('Ashulia-knit-2026');
  await page.getByRole('button', { name: 'Create workspace' }).click();
}

test('a new workspace goes through the setup wizard', async ({ page }) => {
  await signUpNewWorkspace(page);

  // 1) Business type — the router sent us here, not to the dashboard
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'What does Karim Knitwear Ltd. do?' }),
  ).toBeVisible();
  const next = page.getByRole('button', { name: 'Continue' });
  await expect(next).toBeDisabled();
  // Click the card, as a person would: the radio inside is visually hidden (sr-only)
  await page.getByText('Garments & textiles').click();
  await expect(page.getByRole('radio', { name: /Garments & textiles/ })).toBeChecked();
  await expectNoSideScroll(page);
  await next.click();

  // 2) Company details — the form's own check, then skip
  await expect(page.getByRole('heading', { level: 1, name: 'Company details' })).toBeVisible();
  await page.getByLabel('BIN').fill('12345');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Enter the 13-digit BIN')).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  // 3) Invite team — waits for the background job, then offers its roles. Not asserting the
  // short "Preparing the roles…" state: on a slow machine the 2-second job is done before we look
  await expect(page.getByRole('heading', { level: 1, name: 'Invite your team' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    /Roles ready: Accountant, Merchandiser, Store keeper/,
  );
  await page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite people' });
  await dialog.getByLabel('Email').fill('nasrin@karimknitwear.com');
  await dialog.getByRole('checkbox', { name: /Accountant/ }).click();
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(dialog).toBeHidden();
  // In the page's "Invited" list — the toast is a list item too, outside <main>
  await expect(
    page.getByRole('main').getByRole('listitem').filter({ hasText: 'nasrin@karimknitwear.com' }),
  ).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Go to dashboard' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  // The bell has the job's "workspace is set up" notification
  await expect(page.getByRole('button', { name: 'Notifications, 1 unread' })).toBeVisible();
});
```

**File: `apps/app/e2e/notifications.e2e.ts`** (new)

```ts
import { expect, test } from '@playwright/test';

import { expectNoSideScroll } from './helpers.js';

// The mock's Rahman Garments owner has two unread notifications and one read one
test('reads notifications from the bell', async ({ page }) => {
  await page.goto('/');
  const bell = page.getByRole('button', { name: 'Notifications, 2 unread' });
  await bell.click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(
    panel.getByText("The invitation email to rupa@rahmangarments.bounce couldn't be sent.", {
      exact: false,
    }),
  ).toBeVisible();
  await expectNoSideScroll(page);

  // A click marks it read and opens the page it is about
  await panel.getByRole('button', { name: /Nasrin Akter joined the workspace/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications, 1 unread' })).toBeVisible();

  await page.getByRole('button', { name: 'Notifications, 1 unread' }).click();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
});
```

- **Signing out through the menu, not `page.goto('/sign-up')`.** The mock starts signed in, and a reload would
  reset the mock's state (helpers.ts explains this). `.filter({ visible: true })` picks whichever account button
  this screen size shows.
- **The card is clicked by its text**, as a person would. The radio inside is `sr-only`; Playwright's `check()` on
  it failed because the label "intercepts pointer events". The next line then asserts the radio is checked.
- **Only final states are asserted** ("Sent", "Roles ready"). A first version also checked "Sending" and
  "Preparing the roles…". Those last 1.5 and 2 seconds in the mock, and one full run on a busy machine missed the
  window. The API integration tests already prove the `sending` / `provisioning` answers exactly.
- The invited e-mail is looked for inside `main`: the toast is a list item with the same text, outside `main`.

---

## 8.14 — Root files

**File: `.env.example`** (change)

```diff
@@ -4,7 +4,11 @@ DATABASE_URL=postgres://omnivo_app:app_dev_password@localhost:5432/omnivo
 # Migration/seed শুধু — DDL চালায়; FORCE RLS-এর কারণে ডেটা লিখতে tenant context লাগে
 MIGRATOR_DATABASE_URL=postgres://omnivo_migrator:migrator_dev_password@localhost:5432/omnivo
 
-# Valkey (Redis-compatible) — permission cache
+# Worker only: the outbox relay's role (omnivo_worker). It reads the outbox of every tenant and
+# nothing else; the worker's jobs use DATABASE_URL like the API does
+WORKER_DATABASE_URL=postgres://omnivo_worker:worker_dev_password@localhost:5432/omnivo
+
+# Valkey (Redis-compatible) — permission cache (API) and BullMQ queues (worker)
 REDIS_URL=redis://localhost:6379
 
 # JWT-এর `iss` আর Better Auth-এর baseURL — API নিজের ঠিকানা
@@ -23,6 +27,7 @@ S3_BUCKET=omnivo
 S3_ACCESS_KEY_ID=omnivo
 S3_SECRET_ACCESS_KEY=omnivo-dev-secret
 
-# ইমেইল (invite) — dev-এ docker-compose-এর Mailpit; পাঠানো সব চিঠি http://localhost:8025-এ
+# Email — only the worker sends it (invitations, welcome). Dev: docker-compose's Mailpit; every
+# email lands at http://localhost:8025
 SMTP_URL=smtp://localhost:1025
 MAIL_FROM=Omnivo <no-reply@omnivo.app>
```

**File: `.gitignore`** — add `dist-worker/` under `dist/`.

**File: `packages/config/eslint/index.js`** — add `'**/dist-worker/**'` to `ignores`, under `'**/dist/**'`.

- Without these two, the worker's dev build would be committed and linted.

```bash
pnpm gen:openapi     # openapi.json — 37 paths (31 before); commit it
```

---

## 8.15 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Components", after "Icon button":

> - **Notification bell:** an icon button (`Notification03Icon`) next to the logo on every screen size, with an
>   unread badge: 18px `brand` circle, `brand-ink` 12px/500 `tabular-nums`, top-right, "9+" above nine, hidden
>   from screen readers (the button's label says the count). The panel is a popover, 340px (never wider than the
>   screen minus the gutters), a 15px/600 title with a "Mark all as read" text link, and rows with a `brand`
>   unread dot, 13.5px text (`ink` unread, `ink-2` read) and a 12px `ink-3` time. Clicking a row marks it read and
>   opens its page.

And under "Selectable card": "A group of them is `SelectableCardGroup`: real radio inputs, one choice."

**build-plan.bn.md** — in Phase 2's table, step 8's backend cell: `apps/api-র দ্বিতীয় entrypoint (worker.ts),
BullMQ (email, jobs), transactional outbox + relay (SKIP LOCKED, omnivo_worker), idempotent provisioning job
(industry template), welcome ও invitation ইমেইল worker থেকে, notifications`; frontend cell: `Onboarding wizard
(ব্যবসার ধরন → কোম্পানির তথ্য → টিম), notification bell, job status (sending/provisioning)`. And in "অগ্রগতি":
`- [x] **ধাপ ৬–৮** — Core Platform`.

**COMMANDS.md** — in "Run the full stack", after the list of URLs:

```markdown
`pnpm dev` also starts the worker (`@omnivo/api:dev:worker` in the log): it sends the emails and runs the
background jobs. To run it alone: `pnpm --filter @omnivo/api dev:worker`.
```

and a new section:

````markdown
## Worker and queues (Valkey)

```sh
# waiting outbox rows (should be 0 a second after any click)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT type, created_at FROM outbox_events WHERE published_at IS NULL"
# BullMQ's keys: bull:<queue>:completed / :failed (sorted sets), bull:<queue>:<job-id> (one job)
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli zcard bull:email:failed
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli hget bull:email:<job-id> failedReason
```
````

**README.md** — under Getting started: "`.env` needs the `WORKER_DATABASE_URL` line from `.env.example`, and an
existing dev database needs the `omnivo_worker` role once (step 8 → 8.16)."

---

## 8.16 — Run it

**1) Create the new role in your existing dev database.** The init script (`01-roles.sql`) runs only when the
Postgres volume is created, and yours already exists. Once, with the containers running (`pnpm db:up`):

```bash
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "
  CREATE ROLE omnivo_worker WITH LOGIN PASSWORD 'worker_dev_password' NOSUPERUSER NOBYPASSRLS;
  GRANT CONNECT ON DATABASE omnivo TO omnivo_worker;
  GRANT USAGE ON SCHEMA public TO omnivo_worker;"
```

(`pnpm db:psql` opens the same shell, if you prefer to paste the three lines there.) If you ever run
`pnpm db:down -v` and start fresh, the init script creates it for you, and this command would then say "role
already exists" — harmless.

**2) Add one line to `.env`** (from `.env.example`; open the file in the editor and add it at the end, so the last
line keeps its newline — the warning from step 6):

```sh
WORKER_DATABASE_URL=postgres://omnivo_worker:worker_dev_password@localhost:5432/omnivo
```

**3) The rest:**

```bash
pnpm install                                  # bullmq
pnpm db:migrate                               # 0011 + 0012
pnpm gen:openapi                              # commit it
pnpm dev                                      # API + app + worker; stop and start again if it was running
```

After `pnpm db:migrate`, in `pnpm db:psql`:

```sql
SELECT slug, setup_status FROM tenants;                         -- your old workspaces: ready
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('outbox_events', 'notifications');           -- t, t
SELECT polname, polroles::regrole[] FROM pg_policy
 WHERE polrelid = 'outbox_events'::regclass;                    -- two: tenant_isolation (everyone), outbox_relay (omnivo_worker)
```

### What you will see

1. The terminal shows a third process, `@omnivo/api:dev:worker`, with `WorkerModule dependencies initialized`
   and `outbox cleanup: 0 old rows deleted` (the hourly job runs once at start).
2. **Sign up a new workspace** (sign out first, or use a private window). After "Create workspace" you land on
   **Set up** — "What does … do?", six cards. Continue stays grey until you pick one.
3. `http://localhost:8025` (Mailpit): **"Welcome to Omnivo, …"** with your workspace address. It arrived a moment
   after sign-up, from the worker — the API did not wait for it.
4. Pick **Garments & textiles** → Continue → **Company details**. Type `12345` as BIN → Continue → "Enter the
   13-digit BIN…". Fix it or press **Skip for now**.
5. **Invite your team**: "Roles ready: Accountant, Merchandiser, Store keeper" (you may catch "Preparing the
   roles…" for a moment). **Invite people** → an email, role Accountant → the toast says "Sending the invitation
   to …", and the address appears under "Invited".
6. **Go to dashboard.** The bell next to the logo has a badge **1**: "Your workspace is set up…". Click it → the
   Roles page. The badge is gone.
7. **Team**: the invitation shows **Sending**, then **Sent** within a couple of seconds, without a reload. Mailpit
   has the invitation email.
8. **Stop Mailpit** (`docker compose -f infra/docker/docker-compose.yml stop mail`) and invite someone else. The
   row stays **Sending** for about 30 seconds (the worker log shows `failed (attempt 1)` … `attempt 5`), then turns
   **Email not sent**, and the bell shows "The invitation email to … couldn't be sent". Start Mailpit again
   (`… start mail`), open the row → **Resend** → **Sent**.
9. **Run without the worker.** Stop `pnpm dev` and start only the API and the app: `pnpm exec turbo run dev`.
   Invite someone: the API still answers at once with "Sending". In `pnpm db:psql`:
   `SELECT type, published_at FROM outbox_events ORDER BY created_at DESC LIMIT 3;` — the newest row has
   `published_at` empty. Now start the worker in a second terminal: `pnpm --filter @omnivo/api dev:worker`.
   Within a second the row is published and the email is in Mailpit. **This is the outbox at work: nothing was
   lost while the worker was down.**
10. Open the invitation link in a private window and join. Back in the first window, the bell gets "… joined the
    workspace" within 30 seconds (or at once when you switch back to the tab).
11. **Audit log** → "Workspace and settings": "Started the workspace setup" by you, and "Added the starting roles"
    by **System**. Both came from one click: `SELECT action, request_id FROM audit_logs WHERE action LIKE
    'workspace.%' ORDER BY created_at DESC LIMIT 2;` shows the same request id twice.
12. DevTools at 390 px: the stepper shows only the current step's name; the bell's panel fits the screen with
    16 px on each side; the page never scrolls sideways.
13. An **old** workspace (created before this step) goes straight to the dashboard, not the wizard.
14. `pnpm test:e2e` → "34 passed".

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 98: contracts 33 + api 21 + ui 16 + i18n 11 + app 10 + auth 7
pnpm test:integration        # 101 — 23 new
pnpm test:tenant-leak        # 26 — 8 new
pnpm test:e2e                # 34: 17 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 171.4 KB gz; onboarding 55.8, app-shell 52.3, team 70.8
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **`addBulk` hangs while Redis is down**, even with `enableOfflineQueue: false`: BullMQ waits for the connection
  first. The relay's transaction then held its row locks forever. Found by the "Redis is down" test; fixed with a
  time limit on the publish (8.4).
- **dependency-cruiser never saw a package.** `exclude` removed `node_modules` from the graph, and `(^|/)dist/`
  removed most packages' code as well, so the new BullMQ rule — and step 5's `contracts-only-zod` — could never
  fire (8.7).
- **A generic `dispatch<T>`** first failed to type-check (`z.output` of a generic index collapses to `unknown`), and
  then failed ESLint (`no-unnecessary-type-parameters`). The simple, non-generic version is correct because the
  handler map is typed (8.4).
- **`eventually` longer than the test timeout** hid the real assertion behind a timeout and left a loop running
  (8.8).
- **`GET /setup` answers 500 while the industry is broken on purpose** — correct (the response contract refuses
  it), so the failure test reads the table directly (8.8).
- **Role order** — `'depot manager'` sorts after `'Sales representative'` in this database's collation (8.8).
- **`msgpackr-extract` blocked `pnpm install`** until `allowBuilds` had an answer for it (8.4).
- **Playwright could not `check()` an `sr-only` radio** ("label intercepts pointer events"); the test clicks the
  card (8.13).
- **Two e2e assertions on short-lived states** failed once on a busy machine; the tests now wait for final
  states (8.13).
- **The toast is a list item too** — a strict-mode clash with the wizard's "Invited" list; scoped to `main` (8.13).
- **The cleanup job runs at start**, not only after an hour — BullMQ's `every` fires at once. Harmless, now expected
  (8.4).

---

## Notes left for later steps

**Every new side effect (from now on, always):** an email, a PDF, a call to a courier or a payment gateway — never
inside a request. Add an event type to `OUTBOX_EVENT_TYPES` (db), its schema to `outboxPayloadSchemas`, its queue
to `QUEUE_OF` and its handler to `HandlerMap` — the compiler walks you through all four. Call `emit(tx, …)` in the
same transaction as the change. Make the handler idempotent (a status check, a unique key, `ON CONFLICT`), and give
it an `onGiveUp` if a person must hear about a failure.

**Payloads carry ids, never data.** No email addresses, names, amounts or tokens in the outbox.

**Step 9 (chart of accounts):**

- Add `accounts` to `IndustryTemplate` and seed them in `ProvisioningHandler`, in the same transaction as the
  roles, with `ON CONFLICT DO NOTHING` on `(tenant_id, code)`.
- Workspaces that are already `ready` will not get a chart of accounts from the job (it stops at the check). Give
  step 9 a one-off: a migration or a script that emits `workspace.setup_requested` for them with the check relaxed
  to "accounts missing", or a small separate event (`workspace.accounts_requested`) with its own idempotent handler.
- Opening balances are data the owner types. They belong in the wizard's company step or a later step, not in the
  template.

**Step 11 / 12 (reports, imports):**

- Heavy jobs get their own queue (`reports`, `imports`) and their own concurrency, so a big import never delays an
  invitation email. Per-tenant limits (system-design §4.6): BullMQ's group feature is in BullMQ Pro; without it, a
  per-tenant counter in Redis checked by the handler.
- A job's progress for the UI: `job.updateProgress()` in the handler, and a status column on the domain row (like
  `setup_status`), not the queue's own state — the queue forgets finished jobs after a day.

**Step 15 (invoices):** the invoice PDF and its email are outbox events (`invoice.posted`). The journal posting is
**not**: it is part of the same transaction as the invoice (build plan, step 14).

**Step 25 (before launch):**

- A real mail provider (SPF, DKIM, DMARC), and a `limiter` on the `email` worker for its rate limit.
- A queue dashboard behind the admin login (Bull Board or Taskforce), and alerts on the size of `bull:*:failed` and
  on outbox rows older than a minute (`published_at IS NULL AND created_at < now() - interval '1 minute'` — that
  means the relay is down).
- The worker in its own container with the same image (`node dist/worker.js`), its own secrets (no JWT or S3 keys),
  and a liveness check.
- `omnivo_worker`'s password from the secrets manager, like the other roles.

**dependency-cruiser's remaining gap:** workspace packages resolve to their `dist/`, which is excluded, so
`packages/ui → @omnivo/db` is caught only by the type check today. When a package gets a real dependency on another
one, give the cruiser `tsConfig` (or `enhancedResolveOptions`) so it resolves `@omnivo/*` to `src/`.

**Warnings:**

- Never put a secret into an outbox payload or a job's data. The outbox table is in every backup; Redis may be
  dumped to disk.
- Never give `omnivo_worker` rights on another table "just for this one job". Jobs run as `omnivo_app` with a tenant
  context; only the relay needs the wider view, and only of `outbox_events`.
- Never call `queue.add()` from API code — `pnpm boundaries` will stop you, and it is right.
