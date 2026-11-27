# Step 3b: Sign in with an email and a password only

This step changes the sign-in from step 3. Today the sign-in page asks for three things: the
workspace address, the email and the password. After this step it asks for two: the email and
the password. The server finds the workspace by itself.

The step 3 guide (`step-03-auth-rbac.bn.md`) stays as it is. It is the history of how sign-in was
first built. This guide says what changes and why.

## Why

- **The workspace box gave no security.** A workspace address (`rahman-garments`) is not a secret.
  The password is checked on the person's account, and an account is the same in every workspace
  (one email = one row in `users`). The workspace only chose *which* workspace's token to give.
- **People forget the address.** An accountant or a cashier does not remember if it was
  `rahman-garments` or `rahmangarments`. They get "We couldn't find this workspace", and they call
  support.
- **The `.omnivo.app` suffix is not real.** Production runs on one address,
  `app.omnivosoft.com`. No workspace has its own subdomain. The box suggested an address that does
  not exist.
- **It leaks less.** Today the server looks up the workspace *before* it checks the password, so
  anyone can test which addresses exist. After this step the password is checked first, and the
  server says nothing about workspaces to someone who has not proved who they are.

## Decisions

1. **The password is checked first.** Then the server reads the person's workspaces.
2. **The workspace in the request becomes an optional hint.** `workspace` stays in
   `loginInputSchema`, but optional. When it names a workspace the person belongs to, sign-in goes
   there. When it does not (a typo, an old value, a workspace they left), the server ignores it
   with no error. A hint never makes a sign-in fail.
3. **With no usable hint, sign-in goes to the workspace the person used last.** A new column,
   `users.last_tenant_id`, is set at every sign-in, sign-up, invitation accept and workspace
   switch. If it is empty or no longer valid, sign-in goes to the first workspace by name.
4. **No workspace picker screen.** A person in two workspaces who lands in the wrong one uses the
   workspace switcher, which already exists (`POST /auth/switch-tenant`). A picker would need a
   half-signed-in state between two requests. That is more code and more ways to go wrong, for a
   case the switcher already covers.
5. **The browser sends the workspace it used last as the hint.** It is kept in `localStorage`
   under `omnivo.workspace`, and it stays after a sign-out (unlike the remembered `me`). So after
   "Forgot PIN?" or a revoked session, the password sign-in lands in the same workspace as the
   copy of the data on this device.
6. **An account with no workspace gets `403 not_a_member`** with new words, and its new session
   is ended at once (as before).
7. **The welcome email stops saying "You need the address to sign in."** It says to sign in with
   this email address and the password.

## What changes, file by file

| Part | File | Change |
|---|---|---|
| A | `packages/contracts/src/auth.ts` | Export the slug format; `workspace` becomes optional |
| A | `packages/contracts/src/errors.ts` | Remove `workspace_not_found` |
| B | `packages/db/src/schema/users.ts` | New column `last_tenant_id` |
| B | `packages/db/migrations/0084_sign-in-last-workspace.sql` | Made by `drizzle-kit generate` |
| C | `apps/api/src/auth/pick-workspace.ts` (new) | The rule that picks the workspace |
| C | `apps/api/src/auth/pick-workspace.spec.ts` (new) | Unit tests of the rule |
| C | `apps/api/src/auth/auth.service.ts` | New `login`, remember the workspace, shared workspace list |
| D | `apps/api/src/mail/welcome-email.ts`, its spec, `apps/api/src/setup/welcome-email.handler.ts` | No address line |
| E | `apps/app/src/lib/remembered-session.ts` | Keep the last workspace |
| E | `apps/app/src/lib/session-store.ts` | Save it at every `me` |
| E | `apps/app/src/routes/login.tsx` | No workspace box; send the hint |
| F | `packages/i18n/src/locales/en.ts`, `bn.ts` | Remove two keys, change one |
| G | `apps/api/src/auth/auth.int.spec.ts` | New login tests |
| G | `apps/app/e2e/device-pin.e2e.ts`, `apps/app/e2e/devices.e2e.ts` | Stop filling the box |

Work in this order: A, B, C, then type check, then D to G. Contracts and the schema come first,
because the API and the app get their types from them.

---

## Part A: Contracts

### `packages/contracts/src/auth.ts`

Export the slug format, so the app can check a hint before it sends one:

```ts
// The workspace address. Exported (step 3b): the sign-in page checks the remembered workspace
// with it before sending it as a hint.
export const workspaceSlugFormat = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, errorCode('slug_too_short'))
  .max(32, errorCode('slug_too_long'))
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, errorCode('slug_format'));
```

Only `export` is new. The rules stay the same. Do not export `newWorkspaceSlugSchema` for this: it
also refuses reserved names. That check is only for making a new workspace.

Then the login input:

```ts
export const loginInputSchema = z.object({
  // Step 3b: a hint, not a demand. The server opens this workspace when the person belongs to
  // it, and ignores it otherwise. The sign-in page sends the workspace this browser used last.
  workspace: workspaceSlugFormat.optional(),
  email: emailSchema,
  password: z.string().min(1, errorCode('password_required')).max(128),
  keepSignedIn: z.boolean(),
});
export type LoginInput = z.infer<typeof loginInputSchema>;
```

- **Why optional and not removed.** Three groups still send it: browser tabs that were open
  before the deploy (they run the old code until they reload), every API integration test (they
  call `logIn` with `workspace`), and the shop's seed script (`apps/shop/scripts/seed-client.ts`).
  With `.optional()` they all keep working with no change, and the value simply works as a hint.
- **The inferred type** of `LoginInput['workspace']` is `string | undefined`. The project has
  `exactOptionalPropertyTypes` on, so code that builds a `LoginInput` must leave the key out
  rather than write `workspace: undefined`. Part E shows how.
- **A badly formed hint is still refused** with `400 invalid_input` (for example `"A B"`). That
  is on purpose: the contract stays strict. The sign-in page never sends such a value, because it
  checks the hint with the same schema first (Part E).

Change the route's summary, because it is shown in the API docs:

```ts
  login: defineRoute({
    method: 'POST',
    path: '/auth/login',
    summary: 'Sign in with an email and a password, into the hinted or the last-used workspace',
    // the rest stays the same
  }),
```

### `packages/contracts/src/errors.ts`

Remove `'workspace_not_found'` from `ERROR_CODES`. After Part C nothing sends it. A code that
nothing sends is a trap: someone later writes a screen that handles it and never sees it happen.
Removing it here makes the type check point at every place that still uses it (Part F).

Keep `not_a_member`. It still means the same thing ("you are not in a workspace you can open").
Only its words change.

---

## Part B: The column and the migration

### `packages/db/src/schema/users.ts`

```ts
import { boolean, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

export const users = pgTable(
  'users',
  {
    ...baseColumns(),
    email: text('email').notNull(),
    // ... the other columns stay as they are ...
    theme: text('theme', { enum: THEMES }).notNull().default('system'),
    // Step 3b: the workspace this person signed in to, or switched to, last. Sign-in opens it
    // when the browser sends no usable hint. A pointer, not a grant: sign-in checks the
    // membership again every time, so a stale value can never let anyone in.
    lastTenantId: uuid('last_tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);
```

- **Why on `users` and not on `memberships`.** The value belongs to the person, not to one
  workspace. `users` has no row level security (RLS), so the API can read and write it with no
  tenant context, like `updatePreferences` does. On `memberships` it would be harder in two ways:
  - The `own_memberships` policy (migration 0004) allows only `SELECT` without a tenant context,
    so every write would need `runWithTenant`.
  - `memberships.version` is the members page's optimistic lock. If every sign-in changed that
    row, an owner editing a member's roles would get a "changed by someone else" refusal each time
    that member signed in.
- **Why nullable.** Every account that exists today has no value. The migration must not need to
  guess one, and the sign-in rule (Part C) treats `null` as "no preference".
- **Why `onDelete: 'set null'`.** Workspaces are soft-deleted (`deleted_at`), so the foreign key
  is rarely tested. If a tenant row is ever really deleted (a demo reset, a support script), a
  plain foreign key would block the delete because some user points at it. `set null` just
  forgets the preference.
- **Import cycle check:** `tenants.ts` imports nothing from `users.ts`, so this import is safe.

### The migration

```sh
pnpm --filter @omnivo/db generate --name sign-in-last-workspace
```

drizzle-kit writes `packages/db/migrations/0084_sign-in-last-workspace.sql` and the snapshot in
`meta/`. Check that the SQL is only this:

```sql
ALTER TABLE "users" ADD COLUMN "last_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_tenant_id_tenants_id_fk" FOREIGN KEY ("last_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
```

- **It is safe on production's real data, with the old API still running.** Adding a nullable
  column with no default does not rewrite the table. The foreign key check is quick because every
  value is `NULL`. The old API never reads or writes the column, so it keeps working while the
  migration runs, as the deploy rules require.
- **No grant is needed.** The database roles get their rights on tables by default privileges
  (`infra/staging/postgres-init/01-roles.sh`). Those rights are per table, so a new column on
  `users` is covered.
- **No index is needed.** The API only reads the column by the user's primary key.

---

## Part C: The API

### New file: `apps/api/src/auth/pick-workspace.ts`

The rule that chooses the workspace is a pure function. A pure function can be unit tested
without a database, and the rule is the part most likely to get small changes later.

```ts
import type { MeResponse } from '@omnivo/contracts';

// One of the person's workspaces, as the workspace switcher lists it. Taken from the contract,
// so this type can never drift from what `me` sends.
export type WorkspaceOption = MeResponse['memberships'][number];

// Step 3b: which workspace a sign-in opens.
// 1. The hint, when the person belongs to it (the workspace this browser used last).
// 2. Else the workspace they used last on any device (users.last_tenant_id).
// 3. Else the first one by name, so the answer is the same every time.
// undefined only when the person belongs to no workspace at all.
export function pickWorkspace(
  workspaces: readonly WorkspaceOption[],
  hint: string | undefined,
  lastTenantId: string | null,
): WorkspaceOption | undefined {
  return (
    workspaces.find((workspace) => workspace.slug === hint) ??
    workspaces.find((workspace) => workspace.tenantId === lastTenantId) ??
    workspaces[0]
  );
}
```

- **`WorkspaceOption` comes from `MeResponse`.** The switcher list and the sign-in choice are the
  same rows (`tenantId`, `name`, `slug`). Taking the type from the contract follows rule 2 of
  `CLAUDE.md` (types from the source of truth).
- **The hint is compared only with the person's own workspaces.** A hint for a workspace they are
  not in finds nothing and falls through to step 2. That is what makes it a hint: it can choose
  between the person's workspaces, never add one.
- **`slug === hint` with `hint === undefined`** is always false, because every slug is a string.
  No separate `if (hint)` check is needed. The same is true for `tenantId === null`.
- **`workspaces[0]`** has the type `WorkspaceOption | undefined` (the project has
  `noUncheckedIndexedAccess` on), which is exactly the return type. An empty list returns
  `undefined`, and the caller turns that into `not_a_member`.
- **"First by name" depends on the order of the list.** `listWorkspaces` (below) sorts by
  `tenants.name`. Keep that sort, or the fallback would change from one sign-in to the next.

### New file: `apps/api/src/auth/pick-workspace.spec.ts`

```ts
import { describe, expect, it } from 'vitest';

import { pickWorkspace, type WorkspaceOption } from './pick-workspace.js';

const karim: WorkspaceOption = {
  tenantId: '0190a000-0000-7000-8000-000000000001',
  name: 'Karim Pharma',
  slug: 'karim-pharma',
};
const nabil: WorkspaceOption = {
  tenantId: '0190a000-0000-7000-8000-000000000002',
  name: 'Nabil Distribution',
  slug: 'nabil-distribution',
};
// Sorted by name, as listWorkspaces gives them
const both = [karim, nabil];

describe('pickWorkspace', () => {
  it('opens the hinted workspace when the person belongs to it', () => {
    expect(pickWorkspace(both, 'nabil-distribution', karim.tenantId)).toBe(nabil);
  });

  it('ignores a hint the person does not belong to, and uses the last workspace', () => {
    expect(pickWorkspace(both, 'rahman-garments', nabil.tenantId)).toBe(nabil);
  });

  it('uses the last workspace when there is no hint', () => {
    expect(pickWorkspace(both, undefined, nabil.tenantId)).toBe(nabil);
  });

  it('falls back to the first by name when the last workspace is gone', () => {
    expect(pickWorkspace(both, undefined, '0190a000-0000-7000-8000-00000000dead')).toBe(karim);
    expect(pickWorkspace(both, undefined, null)).toBe(karim);
  });

  it('finds nothing for a person in no workspace', () => {
    expect(pickWorkspace([], 'karim-pharma', karim.tenantId)).toBeUndefined();
  });
});
```

Each test covers one step of the rule, plus the empty case. The "last workspace is gone" test
matters most: it is what happens after someone is removed from the workspace they used last.

### `apps/api/src/auth/auth.service.ts`

**1. Imports and a new error helper.** Add `sql` to the `drizzle-orm` import, and import the new
function:

```ts
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
// ...
import { pickWorkspace, type WorkspaceOption } from './pick-workspace.js';
```

Next to `sessionEnded()` at the top of the file:

```ts
// Step 3b: the password was right, but there is no workspace to open
function notAMember(): AppError {
  return new AppError(403, 'not_a_member', "This account isn't a member of any workspace.");
}
```

`403` and not `401`: the person proved who they are (the password was right), but has no access.
That is the meaning of 403, and the app already shows `not_a_member` at the top of the form.

**2. The new `login`.** Replace the whole method:

```ts
  async login(input: LoginInput): Promise<IssuedTokens> {
    // Step 3b: the password first. Until the person has proved who they are, nothing about
    // workspaces is read, so a stranger cannot learn which addresses exist.
    const identity = await this.verifyPassword({
      email: input.email,
      password: input.password,
      keepSignedIn: input.keepSignedIn,
    });

    const workspace = pickWorkspace(
      await this.listWorkspaces(identity.userId),
      input.workspace,
      await this.lastTenantOf(identity.userId),
    );
    // The roles, read inside that workspace. null also when the membership was removed between
    // the two reads: rare, and it gets the same answer as no workspace at all.
    const membership = workspace
      ? await this.findMembership(workspace.tenantId, identity.userId)
      : null;
    if (!workspace || !membership) {
      // Better Auth already made a session for the right password; nothing may use it
      await this.auth.revokeSession(identity.sessionId);
      throw notAMember();
    }

    await this.recordInTenant(workspace.tenantId, {
      action: 'auth.signed_in',
      entityType: 'user',
      entityId: identity.userId,
      actorUserId: identity.userId,
    });
    await this.rememberWorkspace(identity.userId, workspace.tenantId);

    return this.auth.issueTokens({
      sessionId: identity.sessionId,
      sessionExpiresAt: identity.sessionExpiresAt,
      claims: { userId: identity.userId, tenantId: workspace.tenantId, ...membership },
    });
  }
```

Line by line:

- **`verifyPassword` first.** A wrong password or an unknown email gives the same
  `401 invalid_credentials` as before. Nothing in the answer depends on workspaces, so the answer
  does not tell a stranger whether an email has an account or which workspaces exist.
- **`listWorkspaces` and `lastTenantOf`** are two small reads. Doing them one after the other
  inside the function call keeps the code short. A sign-in happens a few times a day per person,
  so one extra round trip to the database costs nothing that matters.
- **Why `findMembership` is still called.** `listWorkspaces` says *which* workspaces the person is
  in, but not their roles. The token needs the roles (`claims.roles`), and `findMembership`
  already reads them inside the tenant's own context (RLS). Reusing it keeps one place that builds
  a token's claims, the same as `refresh`, `switchTenant` and `startSessionIn`.
- **`if (!workspace || !membership)`.** One check covers both "no workspace" and "removed a moment
  ago". After it, TypeScript narrows both values to non-null, so `workspace.tenantId` and
  `...membership` need no `!` and no cast.
- **`revokeSession` before the throw.** Better Auth makes a session the moment the password is
  right. Without this line, a person in no workspace would leave a live session in the database
  that nothing can use or end. The old code did the same for `not_a_member`.
- **The audit goes to the workspace that was opened.** That company's owner sees in their audit
  log who signed in and when, as before.
- **`rememberWorkspace` before the tokens.** If it fails, the database is down, and issuing tokens
  would fail too. So the order does not risk a sign-in that "half worked".

**3. Remember the workspace in the other three places.** The column must mean "the workspace
used last", so every way into a workspace sets it:

```ts
  // signUp: after provisionWorkspace succeeded, before issueTokens
    await this.rememberWorkspace(identity.userId, workspace.tenantId);
```

```ts
  // startSessionIn (an invitation accepted by an existing account): after the membership check
    await this.rememberWorkspace(identity.userId, tenantId);
```

```ts
  // switchTenant: after recordInTenant, before reissue
    await this.rememberWorkspace(principal.userId, tenantId);
```

- **Why sign-up.** A new owner's next sign-in should open the company they just created, not an
  older workspace where they were invited as a clerk.
- **Why the invitation.** Someone who accepts an invitation wants to work in that workspace. On
  their next sign-in on a new device they should land there.
- **Why the switch.** Someone who switches to the Chattogram company on their office PC should
  land in Chattogram when they sign in on their phone. A switch is the clearest signal of where
  the person works now.
- **`refresh` does not set it.** A refresh keeps the same workspace, so the value is already
  right. Writing on every refresh (every 15 minutes, in every open tab) would only add load.

**4. Two private helpers.** Put them next to `findMembership`:

```ts
  // The person's workspaces across every tenant, sorted by name: the workspace switcher's list
  // (me) and the sign-in's choices (login). withUser, not withTenant: there is no tenant yet,
  // and the own_memberships policy shows a person their own memberships only.
  private listWorkspaces(userId: string): Promise<WorkspaceOption[]> {
    return this.withUser(userId, (tx) =>
      tx
        .select({ tenantId: tenants.id, name: tenants.name, slug: tenants.slug })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(
          and(
            eq(memberships.userId, userId),
            isNull(memberships.deletedAt),
            isNull(tenants.deletedAt),
          ),
        )
        .orderBy(asc(tenants.name)),
    );
  }

  // users has no RLS (a global table), so the plain connection reads it
  private async lastTenantOf(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ lastTenantId: users.lastTenantId })
      .from(users)
      .where(eq(users.id, userId));
    return row?.lastTenantId ?? null;
  }

  // Step 3b: where the next sign-in goes when the browser gives no hint. updated_at is kept as
  // it was: it means "the profile changed", and a sign-in changes nothing the person typed.
  private async rememberWorkspace(userId: string, tenantId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ lastTenantId: tenantId, updatedAt: sql`${users.updatedAt}` })
      .where(eq(users.id, userId));
  }
```

- **`listWorkspaces` is the query that is in `me()` today**, moved out so that `login` and `me`
  use the same one. If they had two copies, one day one copy would learn a new rule (for example,
  "skip closed workspaces") and the other would not. Then sign-in would open a workspace the
  switcher does not list.
- **Both filters on `deletedAt` matter.** `memberships.deletedAt` drops someone removed from a
  team. `tenants.deletedAt` drops a deleted company. Without them, sign-in could pick a workspace
  that `findMembership` or the rest of the app would then refuse.
- **The type** of the select is `{ tenantId: string; name: string; slug: string }[]`, which fits
  `WorkspaceOption[]` exactly, so the return type needs no cast.
- **`row?.lastTenantId ?? null`.** `row` can be `undefined` (the array may be empty), and the
  column can be `null`. Both mean "no preference".
- **`updatedAt: sql\`${users.updatedAt}\``.** `baseColumns()` gives `updatedAt` an `$onUpdate`,
  so drizzle would set it to now on every update. Setting it to its own value keeps it unchanged.
  A sign-in is not an edit of the person's profile, and a moving `updated_at` would make "last
  changed" mean nothing. `version` is not touched, for the same reason.

**5. Use the helper in `me()`.** Replace the inline query:

```ts
    // tenant switcher-এর তালিকা: সব টেন্যান্ট জুড়ে নিজের membership
    const workspaces = await this.listWorkspaces(principal.userId);
```

**6. Remove what is no longer used.** `findTenantBySlug` is still used by `signUp` (the
"address taken" check), so it stays. The `workspace_not_found` `AppError` in the old `login` is
gone with the old method.

---

## Part D: The welcome email

The email says "Your workspace address is rahman-garments.omnivo.app. You need it to sign in."
After this step that is wrong twice: the address does not exist, and sign-in does not need it.

### `apps/api/src/mail/welcome-email.ts`

- Remove `workspaceSlug` from `WelcomeEmailInput`.
- In `Copy`, rename `address` to `signIn`.
- Change the comment above `copy()`: the line now tells the owner how to sign in.

```ts
    en: {
      // ...
      signIn: 'Sign in with this email address and your password.',
      // ...
    },
    bn: {
      // ...
      signIn: 'এই ইমেইল ঠিকানা আর আপনার পাসওয়ার্ড দিয়ে লগইন করুন।',
      // ...
    },
```

and in `welcomeEmail()`: `footer: [text.signIn, text.reason]`.

The line stays in the email on purpose. A new owner does not know yet that there is no address to
remember, and one sentence saves a support call.

### `apps/api/src/setup/welcome-email.handler.ts`

Remove `workspaceSlug: tenant.slug` from the `welcomeEmail({ ... })` call, and `slug: tenants.slug`
from the tenant select. A select of a column that nothing reads only confuses the next reader.

### `apps/api/src/mail/welcome-email.spec.ts`

Remove `workspaceSlug` from `input`, and change the first test:

```ts
  it('says how to sign in, with no workspace address', () => {
    const mail = welcomeEmail({ ...input, language: 'en' });
    expect(mail.subject).toBe('Welcome to Omnivo, Farhana Rahman');
    expect(mail.text).toContain('Sign in with this email address and your password.');
    expect(mail.text).not.toContain('omnivo.app');
    expect(mail.text).toContain('Open Rahman Garments Ltd.: http://localhost:5173/login');
    expect(mail.html).toContain('href="http://localhost:5173/login"');
  });
```

`not.toContain('omnivo.app')` stops the old line from coming back by a careless merge.

---

## Part E: The app

### `apps/app/src/lib/remembered-session.ts`

Add the import and a new key next to the others:

```ts
import { type MeResponse, meResponseSchema, workspaceSlugFormat } from '@omnivo/contracts';

const ME_KEY = 'omnivo.me';
const SIGN_OUT_KEY = 'omnivo.signOutPending';
// Step 3b: the workspace this browser was in last, sent as the sign-in's hint
const WORKSPACE_KEY = 'omnivo.workspace';
```

And two functions, after `rememberedMe()`:

```ts
// Step 3b: the workspace of every `me` (session-store.ts). Kept after a sign-out on purpose,
// unlike `me`: the next sign-in on this browser, after "Forgot PIN?" or a refused session, must
// land in the workspace whose copy is on this device. It is only an address, not a secret: the
// server opens it only for someone who belongs to it.
export function rememberWorkspace(slug: string): void {
  try {
    storage()?.setItem(WORKSPACE_KEY, slug);
  } catch {
    // A storage that refuses: the server uses the workspace the person used last instead
  }
}

// Checked, not trusted, like rememberedMe: a value the API would refuse (a hand-edited one) is
// no hint. Sending it would fail the sign-in on a box that is not on the page.
export function rememberedWorkspace(): string | null {
  try {
    const parsed = workspaceSlugFormat.safeParse(storage()?.getItem(WORKSPACE_KEY));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
```

- **Why it survives a sign-out.** `forgetMe()` runs at every sign-out (except `no_pin`), but the
  device's copy of the data stays after `session_ended` and `pin_reset` (step 19a, decision 19;
  step 19b, decision 31). The copy belongs to one workspace. If the person is in two workspaces
  and the next sign-in opened the other one, the app would show a different workspace and start
  a new copy, while the one with their unsynced work waits unseen. Keeping the slug avoids that.
- **Why this is not a privacy problem.** The slug is a company's address, which the person's
  colleagues and invitation emails already know. It is not shown on the page. If another person
  signs in on the same browser, the server ignores a slug they do not belong to (Part C), and
  their answer does not tell them anything about it.
- **`safeParse(storage()?.getItem(...))`.** `getItem` gives `string | null`, and `storage()` may
  be `null`, so the value can be `string | null | undefined`. `safeParse` accepts `unknown`, so
  no narrowing is needed first: `null` and `undefined` simply fail the parse and give `null`.
- **Why the check matters.** The contract refuses a badly formed hint with `400`, and its field
  error would name `workspace`, a box the page no longer has. Checking with the same schema here
  means the page never sends a value the API would refuse.
- **`parsed.data`** is the trimmed, lower-case slug, typed `string`.

### `apps/app/src/lib/session-store.ts`

Import `rememberWorkspace` with `forgetMe` and `rememberMe`, and call it in the two places that
already call `rememberMe`:

```ts
  signIn: (me) => {
    rememberMe(me);
    rememberWorkspace(me.tenant.slug);
    set({ status: 'signed-in', me, openedOffline: false, notice: null });
  },
  // ...
  setMe: (me) => {
    rememberMe(me);
    rememberWorkspace(me.tenant.slug);
    set({ me });
  },
```

- **`signIn`** runs after every sign-in, sign-up, invitation accept and workspace switch
  (`startSession` in `session.ts`), so the browser's value follows the server's
  `last_tenant_id`.
- **`setMe`** runs after the company's settings change (`refreshMe`). The slug does not change
  today, but if it ever can, the hint then stays right.
- **Not in `openOffline`.** The app opened offline from the remembered `me`, so the slug is the
  one already saved.

### `apps/app/src/routes/login.tsx`

**1. Imports.** Remove `Building03Icon` from the HugeIcons import. Add `rememberedWorkspace`:

```ts
import { rememberedWorkspace } from '../lib/remembered-session';
```

**2. The form's own schema,** at module level, above `LoginPage`:

```ts
// Step 3b: the form checks only the boxes it shows. The workspace is a hint added at submit
// (rememberedWorkspace), never typed.
const loginFormSchema = loginInputSchema.omit({ workspace: true });
```

- **Why a schema of its own.** If the form kept `loginInputSchema`, its value type would still
  have `workspace`, and `applyApiError` would accept `workspace` as a field name. A server error
  on `workspace` would then be set on a box that does not exist, and the person would see
  nothing at all. With `.omit`, the field name list has no `workspace`, so such an error falls
  to the form's top message (`root.server`), where it is visible.
- **Why at module level.** Inside the component, `.omit` would build a new schema on every
  render, and `zodResolver` would get a new object each time.
- **The inferred type** of the form values is `{ email: string; password: string; keepSignedIn:
  boolean }`.

**3. The form setup:**

```ts
  } = useForm({
    resolver: zodResolver(loginFormSchema, { error: contractErrorMap }),
    defaultValues: { email: '', password: '', keepSignedIn: true },
  });
```

**4. Submit:**

```ts
  const onSubmit = handleSubmit(async (values) => {
    const hint = rememberedWorkspace();
    try {
      // exactOptionalPropertyTypes: no hint = no `workspace` key, never `workspace: undefined`
      await login({ ...values, ...(hint !== null && { workspace: hint }) });
      await navigate({ to: '/' });
    } catch (error) {
      applyApiError(error, loginFormSchema.keyof().options, setError);
    }
  });
```

- **`...(hint !== null && { workspace: hint })`.** When there is no hint, the expression is
  `false`, and spreading `false` adds nothing. This is the same pattern as `updatePreferences` in
  `auth.service.ts`. Writing `workspace: hint ?? undefined` would not type check, because of
  `exactOptionalPropertyTypes`.
- **The hint is read at submit, not at render.** Another tab may have switched workspace while
  this page was open. Reading at submit uses the newest value.
- **`loginFormSchema.keyof().options`** is `['email', 'password', 'keepSignedIn']`, as explained
  above.

**5. Remove the workspace box.** Delete the whole first `<TextField>` (label `auth.workspace`,
the `Building03Icon`, the `.omnivo.app` suffix and the `rahman-garments` placeholder). Email is
now the first box. Add `autoFocus` to it only if the design team wants it; the page did not have
it before, so leave it out in this step.

### The mock (`apps/app/src/mocks/handlers.ts`)

No change. The mock login reads the body with `routes.auth.login.body`, where `workspace` is now
optional, and it already ignores the workspace.

---

## Part F: The words

### `packages/i18n/src/locales/en.ts` and `bn.ts`

- Remove `auth.workspace` (`'Workspace'`, `'ওয়ার্কস্পেস'`). Only the login box used it. The
  sign-up page has its own key (`auth.signUp.workspaceAddress`).
- Remove `errors.workspace_not_found` from both files. It must go together with the
  `ERROR_CODES` entry, or the type check fails (the error texts are typed by the codes).
- Change `errors.not_a_member`, because the person did not name a workspace any more:

```ts
    // en.ts
    not_a_member:
      "This account isn't in any workspace yet. Ask a workspace owner to invite you, or create a workspace.",
```

```ts
    // bn.ts
    not_a_member:
      'এই অ্যাকাউন্ট এখনো কোনো workspace-এ নেই। workspace-এর owner-কে invite করতে বলুন, অথবা নতুন workspace তৈরি করুন।',
```

The words say what to do (ask for an invitation, or make a workspace), as the copy rules ask. The
page already has a "Create a workspace" link under the form.

---

## Part G: Tests

### `apps/api/src/auth/auth.int.spec.ts`

Make the helper's workspace optional:

```ts
function login(input: { workspace?: string; email: string; password: string }) {
```

With `exactOptionalPropertyTypes`, a caller leaves the key out. `{ ...input, keepSignedIn: true }`
then sends no `workspace`, which is what the new tests need.

Add a small helper next to `refresh`, because the new tests check where a sign-in landed:

```ts
async function workspaceOf(res: Awaited<ReturnType<typeof login>>): Promise<string> {
  const me = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: bearer(sessionOf(res).accessToken),
  });
  return meResponseSchema.parse(me.json()).tenant.slug;
}
```

Replace the `login` describe block:

```ts
describe('login', () => {
  it('signs in with an email and a password only, into the only workspace', async () => {
    const res = await login({ email: rahman.email, password: rahman.password });
    expect(res.statusCode).toBe(200);
    expect(refreshCookieOf(res)).toBeTruthy();
    expect(await workspaceOf(res)).toBe(rahman.workspaceSlug);
  });

  it('rejects a wrong password with 401', async () => {
    const res = await login({ email: rahman.email, password: 'wrong-password' });
    expect(res.statusCode).toBe(401);
    expect(problemSchema.parse(res.json()).code).toBe('invalid_credentials');
  });

  it('ignores a hint for a workspace that does not exist', async () => {
    const res = await login({
      workspace: 'nobody-here',
      email: rahman.email,
      password: rahman.password,
    });
    expect(res.statusCode).toBe(200);
    expect(await workspaceOf(res)).toBe(rahman.workspaceSlug);
  });

  it('ignores a hint for a workspace the person is not in', async () => {
    await signUp(app, karim);
    const res = await login({
      workspace: rahman.workspaceSlug,
      email: karim.email,
      password: karim.password,
    });
    expect(res.statusCode).toBe(200);
    expect(await workspaceOf(res)).toBe(karim.workspaceSlug);
  });

  it('refuses an account in no workspace with 403, and ends its session', async () => {
    const alone: SignUpInput = {
      companyName: 'Sylhet Pharmacy',
      workspaceSlug: 'sylhet-pharmacy',
      fullName: 'Ruma Begum',
      email: 'ruma@sylhetpharmacy.com',
      password: 'Zindabazar-2026',
    };
    await signUp(app, alone);
    // Removed from the only workspace (step 7 does it with a soft delete)
    await superuser`
      UPDATE memberships SET deleted_at = now()
      WHERE user_id = (SELECT id FROM users WHERE email = ${alone.email})`;

    const res = await login({ email: alone.email, password: alone.password });
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json()).code).toBe('not_a_member');
    expect(res.cookies.find((c) => c.name === 'omnivo_rt')).toBeUndefined();
  });
});
```

- **The two "ignores a hint" tests replace** the old 404 and 403 tests. They check the new
  promise: a hint never makes a sign-in fail.
- **The 403 test uses its own account** (`Sylhet Pharmacy`), so removing its membership does not
  change any other test.
- **`omnivo_rt` is undefined** proves the server gave no session to a person with no workspace.

Add one test at the end of the `tenant switcher` block, after the existing switch test. By then
Nabil is in two workspaces and has just switched to Rahman Garments:

```ts
  it('signs in to the hinted workspace, else to the one used last', async () => {
    const nabil = { email: 'nabil@example.com', password: 'Depot-route-2026' };

    // The switch in the test above made Rahman Garments the last one
    expect(await workspaceOf(await login(nabil))).toBe(rahman.workspaceSlug);

    // A hint wins, and a sign-in by hint becomes the last one too
    const hinted = await login({ ...nabil, workspace: 'nabil-distribution' });
    expect(await workspaceOf(hinted)).toBe('nabil-distribution');
    expect(await workspaceOf(await login(nabil))).toBe('nabil-distribution');
  });
```

This test depends on the order of the tests in the block, like the other tests in this file do
(the `login` tests use the accounts that `sign-up` made). Vitest runs tests in a file one after
the other, so that is safe here.

The other integration tests (`accounts.int.spec.ts` and the rest) call `logIn` with `workspace`.
They need no change: the hint names a workspace the person is in, so they land where they did.

### `apps/app/e2e/device-pin.e2e.ts` and `apps/app/e2e/devices.e2e.ts`

Remove the line that fills the box. It would fail now, because the box is gone:

```ts
  // device-pin.e2e.ts:56 and devices.e2e.ts:148, remove:
  await page.getByLabel('Workspace').fill('rahman-garments');
```

In `devices.e2e.ts`, the line under it fills `Email` with `{ exact: true }`. It stays.

---

## Deploying

- **Demo first.** Push to `dev`; the demo stack runs the migration and the new code. Try the
  sign-in there with an account in two workspaces before merging to `main`.
- **Production.** The migration runs on real data at the `main` deploy. It is safe with the old
  API still running (Part B).
- **Open tabs.** A tab opened before the deploy still shows the workspace box until it reloads
  (the update notice asks for that). It sends `workspace`, and the new API takes it as a hint, so
  it keeps working.
- **A short window to know about.** If the new web build is served before the new API starts, a
  sign-in with no hint gets `400 invalid_input` from the old API, shown at the top of the form.
  It lasts only until the API restarts, a few seconds within one deploy.
- **No data step.** `last_tenant_id` starts empty for everyone. Each person's first sign-in after
  the deploy fills it. Until then, a person in two workspaces lands in the one their browser used
  last (the browser saves it at their next `me`, so from the second sign-in on) or the first by
  name.

## Checks before calling it done

```sh
pnpm typecheck
pnpm --filter @omnivo/api test                 # unit tests, with pick-workspace.spec.ts
pnpm --filter @omnivo/api test:integration     # auth.int.spec.ts and the rest
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app test:e2e             # device-pin and devices go through sign-in
pnpm lint
```

Then by hand, on the demo:

1. An account in one workspace signs in with only the email and the password.
2. An account in two workspaces signs in, switches, signs out, and signs in again: it lands in the
   workspace it switched to.
3. The same account on another browser (no hint) lands in that workspace too.
4. A wrong password still says "Email or password is incorrect".

## Not in this step

- **Rate limiting the sign-in by email.** The workspace box was never a defence against password
  guessing, so removing it does not make guessing easier. A limit per email and per address is
  still worth adding, as its own step.
- **A workspace picker after sign-in.** Decision 4 explains why the switcher is enough today.
- **`/login?workspace=<slug>` links.** Nothing links to the sign-in page with a workspace today
  (invitations have their own page). If something needs it later, the login route can read the
  search value and send it as the hint, checked with `workspaceSlugFormat` like the remembered one.
- **Per-workspace sign-in rules (SSO, "only Google accounts").** Those would bring back a
  "which company?" question before the password. That is a decision for when a customer asks.
