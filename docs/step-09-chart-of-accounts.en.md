# Step 9: Chart of accounts — the account tree, industry templates, and a chart for every workspace

> The implementation guide for "Phase 3 → Step 9" of [build-plan.bn.md](build-plan.bn.md): which file gets what
> code, and which command runs where.
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `ed259cf`, the end of
> step 8 with your onboarding changes) and checked on 2026-09-30: `pnpm dedupe --check`, `pnpm lint`,
> `pnpm format`, `pnpm typecheck`, `pnpm test` (130 — 32 new), `pnpm test:integration` (113 — 12 new),
> `pnpm test:tenant-leak` (29 — 3 new), `pnpm build`, `pnpm test:bundle-size` (first load 175.0 KB gz, budget
> 200; the new page 53.6 KB), `pnpm gen:openapi` (41 paths), `pnpm test:openapi`, `pnpm boundaries` and
> `pnpm test:e2e` (Playwright, 42 — 8 new, desktop and 390px, three runs in a row) — all pass, with the turbo
> cache cleared.
>
> Also checked by hand:
>
> - **The upgrade of an existing database.** A fresh Postgres container on another port, migrated to the end
>   of step 8 (0000–0012), with four workspaces: set up as garments, set up before step 8 (no business type),
>   still `pending`, and `failed` as pharma. Then `pnpm db:migrate` (0013 + 0014): three outbox rows, none for
>   the pending one. Then `node dist/worker.js`: within a second the garments workspace had 74 accounts, the
>   pharma one 70, the old one the general chart (61), each with the 10 system accounts, and an audit row by
>   "System". The pending one had none. The worker stopped on SIGTERM.
> - **The screens.** Screenshots at 1280px and 390px: the tree, the add and edit dialogs, no sideways scroll.
>   They found two layout bugs, both fixed in this guide ("What we found on the way").
> - **Every guard test broken on purpose.** Remove the chart lock → the "two moves at the same time" test fails
>   (a deadlock, answered with 500). Remove the "already has a chart" check from `seedChart` → the setup retry
>   test fails. Remove the loop check → two tests fail. Remove the delete guard for system accounts → the
>   "protects" test fails. Remove `FORCE ROW LEVEL SECURITY` from 0014 → the RLS coverage test names
>   `ledger_accounts`.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database — but nothing new is needed
> there: no new role, no new env line, no new package. (2) The new tests on GitHub Actions. (3) **The template
> charts have not been reviewed by an accountant.** The build plan asks for sessions with one before phase 3.
> Show them `apps/api/src/setup/templates.ts` (9.3) before real companies use it — changing it later does not
> change charts that already exist. (4) The Bangla texts were written by me, not by a native speaker's review.

## Goal

📒 **The first piece of real accounting.** Every amount the ERP will ever record — an invoice, a salary, a bKash
payment — lands in an account. This step makes the list of those accounts: the chart of accounts.

After this step:

- **A tree of accounts per workspace.** Five top-level groups — Assets, Liabilities, Equity, Income, Expenses —
  and under them groups ("Current assets", "Bank accounts") and ledgers ("Cash in hand", "Office rent"). Each
  account has a code (`1110`), a name and a type. The type comes from its top-level group and never changes.
- **An industry template.** The setup job of step 8 now also creates a chart that fits the business type: a
  garments factory gets "Fabrics and yarn", "Back-to-back LC payable" and "Export sales"; a pharma company
  "Medical promotion and samples"; a distributor "Claims receivable from principals".
- **System accounts.** Ten accounts that later steps will post to by themselves (cash, receivable, payable,
  input and output VAT, inventory, sales, cost of goods sold, retained earnings, opening balance equity). They
  carry a `purpose`. They can be renamed and moved, never archived or deleted.
- **A chart for workspaces that already exist.** A migration queues one job per set-up workspace; the worker
  makes its chart with the same code.
- **The Chart of accounts page.** The tree with open/close per group, search by code or name, "Show archived",
  add (with a suggested code), edit, move to another group, archive and delete — on desktop and on a phone.

## The whole picture

```
packages/contracts   accounts.ts: ACCOUNT_TYPES, NORMAL_BALANCE, ACCOUNT_PURPOSES, the schemas, 7 routes
      │               permission accounting.account.manage (new group "accounting")
      │               5 audit actions + workspace.chart_created · entity 'account' · 10 error codes
      ▼
packages/db          ledger_accounts (tree: parent FK on (tenant, parent, type) → the type is kept by the DB)
                     migration 0013 (drizzle, one line moved) + 0014 (RLS, one outbox row per set-up workspace)
                     outbox event type workspace.chart_requested
      │
      ▼
apps/api (worker)    setup/templates.ts: one standard chart + industry parts → INDUSTRY_TEMPLATES[x].chart
                     setup/seed-chart.ts: seedChart() — whole chart or nothing, level by level
                     ProvisioningHandler: roles + chart in one transaction
                     ChartHandler (new event): the chart for workspaces from before this step
apps/api (API)       AccountsModule: /accounts — list, get, create, update (rename/recode/move),
                     archive, restore, delete. Every change takes the tenant's "chart lock" first.
      │
      ▼
packages/ui          TreeList (nested lists, one show/hide button per group) + buildTree/filterTree
                     Field fix: a field never grows wider than its grid column
apps/app             /accounts page (nav group "Accounting") · the wizard says "Chart of accounts: 74 accounts"
                     MSW: a shorter copy of the templates and the same rules

one account, from click to tree:
  accountant ──POST /accounts {parentId, code, name, isGroup}──► API tx: chart lock → parent is an active
    group? → INSERT (type = parent's type) → audit → commit → 201
  the page invalidates ['accounts', tenant] → the tree shows it under its group
```

## The decisions behind this step

1. **Opening balances are not in this step.** (You chose this, 2026-09-30.) The build plan lists them here, but
   a balance without a journal would be a second source of truth: the reports of step 11 would have to add an
   `opening_balance` column to the journal lines, and the two drift apart. Step 10 enters opening balances as
   the first journal entry, dated the day before the company starts on Omnivo. This step only creates its other
   side: the "Opening balance equity" account (purpose `opening_balance_equity`).
2. **Old workspaces get their chart from a job that a migration queues.** (You chose this.) The templates are
   TypeScript, so SQL cannot write them. Migration 0014 inserts one `workspace.chart_requested` outbox row per
   workspace whose setup has started, and the worker runs the same `seedChart()` as the setup job. Nothing to
   run by hand; every workspace ends up with the system accounts that step 10 needs.
3. **The table is `ledger_accounts`, not `accounts`.** `accounts` is already Better Auth's table of sign-in
   accounts (`packages/db/src/schema/accounts.ts`, step 3). Renaming Better Auth's table would mean changing
   its config and a risky migration for no gain. Only the database says "ledger"; the contracts, the API
   (`/accounts`) and the UI say "account", as people do.
4. **The type belongs to the tree, and the database enforces it.** An account's type is copied from its
   parent, and the parent foreign key is on `(tenant_id, parent_id, type)` → `(tenant_id, id, type)`. So the
   database itself refuses an expense account under an asset group, whatever a future bug in the code does.
   The type is not in any input: a new account takes its group's type, and a move is only allowed within the
   same type.
5. **Groups and ledgers, fixed at creation.** The Tally words that every Bangladeshi accountant knows. A group
   only holds accounts; entries post to ledgers only (step 10). Turning one into the other would need rules
   about entries and children; delete and re-create is simpler, and nothing uses an account yet.
6. **Codes are digits, unique per workspace, and suggested.** `1110`, or `1-1-10` if the company likes. The
   template uses four digits: type, group, account. The add form suggests the next free code in the chosen
   group (after `1110, 1120` comes `1130`). An archived account keeps its code, so a code in an old report
   always means one account.
7. **Ten system accounts by `purpose`, not by name or code.** A sales invoice (step 15) must find "the receivable
   account" without asking. Names and codes belong to the company and can change; a `purpose` column with a
   unique index per workspace does not. System accounts can be renamed and moved, not archived or deleted.
8. **Delete only what nothing uses; archive the rest.** The parent foreign key already refuses to delete a group
   with accounts under it; from step 10 the journal lines' foreign key refuses an account with entries, in the
   same way. Archive hides an account from new entries and keeps it in old reports, like a branch.
9. **One lock per chart for every change.** Every change takes a transaction-level advisory lock on "this
   tenant's chart". Chart edits are rare, so the wait costs nothing, and two races disappear: two opposite moves
   deadlocking, and a new account landing under a group that is being archived (9.4 explains both). This is
   simpler to reason about than a separate lock plan for each operation.
10. **English account names.** Books in Bangladesh are kept in English, and auditors, banks and NBR read them in
    English. The names are data, not UI text: the template writes English, and each company renames what it
    wants. The UI around them (buttons, hints) is in both languages as always.
11. **A tree of nested lists, not a table and not `role="tree"`.** `DataTable` has no tree mode, and a real ARIA
    tree needs hand-written arrow-key focus handling. Nested `<ul>`s with one show/hide button per group (the
    WAI-ARIA "disclosure" pattern) work with Tab, Enter and every screen reader as they are, and look the same
    on a phone. The component goes into `packages/ui`, because step 12's product categories are a tree too.
12. **One common chart plus industry parts.** Cash, banks, VAT, payables, capital and the usual expenses are the
    same for every company in Bangladesh. Each industry adds its stock accounts, its revenue lines, its cost of
    sales and a few special accounts. So a fix to "Output VAT" is made once, not six times.

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Opening balances | Decision 1: step 10, as the first journal entry |
| Balances in the tree | There are no entries yet. Step 11 (trial balance) adds a balance column |
| Posting to accounts, "account in use" | Step 10. Its journal lines get a composite FK to `ledger_accounts (tenant_id, id)` (the index is made now) |
| Changing a group into a ledger or back | Decision 5 |
| Import of a chart from Excel/Tally | With the first imports (step 12). Most companies start from the template |
| Multi-currency accounts | Phase 2 (build plan §5). The base currency is in settings |
| Cost centres, departments, projects | Later, as tags on journal lines, not as more accounts |
| Per-account permissions | One permission for the whole chart. Nobody has asked for more |
| Bangla account names | Decision 10. A company can type Bangla names; the template stays English |

## What changes in the code you already have

- **Nothing to create by hand.** No new database role, no new `.env` line, no new package. `pnpm db:migrate`
  and a running worker are enough; your existing workspaces get their chart a second after the worker starts.
- `setup/templates.ts`: every industry gets a `chart`, and the Accountant role gets `accounting.account.manage`.
  Existing workspaces keep their roles as they are (templates never touch existing data).
- `ProvisioningHandler` creates the chart in the same transaction as the roles, and its audit row gets an
  `accounts` count.
- A new outbox event type, `workspace.chart_requested`: the compiler walks you through its four places (payload
  schema, queue, handler map, worker module) — the rule from step 8's notes.
- The wizard's texts: "Preparing the roles and chart of accounts…", and "Roles ready: …. Chart of accounts: 74
  accounts." The `onboarding.team.ready` key becomes `ready_one` / `ready_other` (it has a count now).
- The notification "Your workspace is set up" mentions the chart.
- `packages/ui`'s `Field` gets `grid-cols-1`: a field in a narrow grid column (the 140px "Code") no longer runs
  under its neighbour. The branch form had the same bug (9.7).
- The sidebar gets a group "Accounting" with "Chart of accounts".

---

## 9.1 — `packages/contracts`: the contract

### Accounts

**File: `packages/contracts/src/accounts.ts`** (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// The five classes of account. The class decides where an account shows up in the reports (asset,
// liability, equity → balance sheet; income, expense → profit and loss), so it never changes. Each
// class is one top-level group, and every account below it inherits the class from there.
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// Which side makes the balance grow. Double entry in one line: assets and expenses grow with a
// debit, the other three with a credit. Step 10's journal and step 11's reports read it from here.
export const NORMAL_BALANCE = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
} as const satisfies Record<AccountType, 'debit' | 'credit'>;

// Accounts the system itself will post to: a sales invoice (step 15) debits the receivable and
// credits sales and output VAT without asking which accounts. The template marks one account per
// purpose; the owner may rename or move it, but not delete or archive it. A later step that needs a
// new one adds it here and to the templates.
export const ACCOUNT_PURPOSES = [
  'cash',
  'accounts_receivable',
  'inventory',
  'vat_input',
  'accounts_payable',
  'vat_output',
  'opening_balance_equity',
  'retained_earnings',
  'sales',
  'cost_of_goods_sold',
] as const;
export type AccountPurpose = (typeof ACCOUNT_PURPOSES)[number];

export function isAccountPurpose(value: string): value is AccountPurpose {
  return ACCOUNT_PURPOSES.some((purpose) => purpose === value);
}

export const accountSchema = z.object({
  id: z.uuid(),
  // null = one of the five top-level groups
  parentId: z.uuid().nullable(),
  code: z.string(),
  name: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  // true = a group: it only holds other accounts, and entries never post to it. Fixed at creation.
  isGroup: z.boolean(),
  // z.string(), not an enum: a newer server's new purpose must not break an older offline client
  // (the same rule as error codes). The app narrows it with isAccountPurpose().
  purpose: z.string().nullable(),
  description: z.string().nullable(),
  // null = active. An archived account is hidden from pickers but stays in old reports.
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Account = z.infer<typeof accountSchema>;

// Digits, optionally split into parts by dots or hyphens: 1110, 1-1-10, 11.10. No letters: codes
// sort and group by their digits, and every accountant in Bangladesh reads them that way.
const accountCodeSchema = z
  .string()
  .trim()
  .max(20, errorCode('account_code_format'))
  .regex(/^\d+(?:[.-]\d+)*$/, errorCode('account_code_format'));

const accountNameSchema = z.string().trim().min(2, errorCode('account_name_required')).max(120);

// A form's empty "Parent group" select sends '' — that is "not chosen", not a broken id
const parentIdSchema = z.uuid(errorCode('account_parent_required'));

export const createAccountInputSchema = z.object({
  // Every new account goes under a group, and takes its type from there. The five top-level
  // groups come from the template only.
  parentId: parentIdSchema,
  code: accountCodeSchema,
  name: accountNameSchema,
  isGroup: z.boolean(),
  description: optionalText(300),
});
export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;

// The same fields minus isGroup (fixed at creation), plus the version. A new parentId moves the
// account. A top-level group sends null and stays at the top.
export const updateAccountInputSchema = z.object({
  parentId: parentIdSchema.nullable(),
  code: accountCodeSchema,
  name: accountNameSchema,
  description: optionalText(300),
  version: versionSchema,
});
export type UpdateAccountInput = z.infer<typeof updateAccountInputSchema>;

export const accountVersionInputSchema = z.object({ version: versionSchema });

// DELETE has no body, so the version travels in the query string (like DELETE /roles/:id)
export const deleteAccountQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// A chart has tens to a few hundred accounts, so the whole list comes at once (the rule from
// branches: small master lists in one piece, endless lists in pages). Archived accounts are
// included: the tree shows them in place when asked to.
export const accountListSchema = z.object({ items: z.array(accountSchema) });

const accountParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like branches: from step 10 on, every journal line, invoice and
// bill picks an account from this list.
export const accountRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/accounts',
    summary: 'The chart of accounts of the active workspace, archived accounts included',
    auth: 'bearer',
    status: 200,
    response: accountListSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/accounts/:id',
    summary: 'One account',
    auth: 'bearer',
    status: 200,
    params: accountParamsSchema,
    response: accountSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/accounts',
    summary: 'Add an account or a group under a group',
    auth: 'bearer',
    permission: 'accounting.account.manage',
    status: 201,
    body: createAccountInputSchema,
    response: accountSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/accounts/:id',
    summary: 'Rename, recode or move an account to another group of the same type',
    auth: 'bearer',
    permission: 'accounting.account.manage',
    status: 200,
    params: accountParamsSchema,
    body: updateAccountInputSchema,
    response: accountSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/accounts/:id/archive',
    summary: 'Hide an account from new entries; its history stays',
    auth: 'bearer',
    permission: 'accounting.account.manage',
    status: 200,
    params: accountParamsSchema,
    body: accountVersionInputSchema,
    response: accountSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/accounts/:id/restore',
    summary: 'Bring an archived account back',
    auth: 'bearer',
    permission: 'accounting.account.manage',
    status: 200,
    params: accountParamsSchema,
    body: accountVersionInputSchema,
    response: accountSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/accounts/:id',
    summary: 'Delete an account that nothing uses and nothing sits under',
    auth: 'bearer',
    permission: 'accounting.account.manage',
    status: 204,
    params: accountParamsSchema,
    query: deleteAccountQuerySchema,
    response: z.void(),
  }),
};
```

- **`ACCOUNT_TYPES`** — the five classes of double entry. They are never extended, so they are a real `z.enum` in
  the response, unlike `purpose`.
- **`NORMAL_BALANCE`** — the one line of double-entry theory every later step needs: an asset or expense grows
  with a debit, the others with a credit. Step 10's journal shows it, step 11's reports use it to put the sign
  right. `as const satisfies Record<…>` keeps the literal values (`'debit'`, not `string`) and fails the build if
  a type is missing.
- **`ACCOUNT_PURPOSES`** — the accounts the system will post to on its own. The list covers what steps 10–16
  need: opening balances, year close, sales invoices, bills, stock valuation. Adding one later is a line here
  plus a line in each template (and a migration or job for existing charts — see "Notes left for later").
- **`purpose: z.string().nullable()`** in the response, not `z.enum`. The same rule as error codes and audit
  actions: an offline PWA from last month must not fail to parse a chart because a newer server added a
  purpose. The app narrows it with `isAccountPurpose()`.
- **The code schema.** `trim()` first, then `max(20)` and the regex. The regex `^\d+(?:[.-]\d+)*$` means: digits,
  optionally more groups of digits after a dot or hyphen. It refuses `1121-` (a trailing separator), `11 21`
  and letters. Both checks send the same code (`account_code_format`), so the form shows one clear message.
- **`parentIdSchema = z.uuid(errorCode('account_parent_required'))`.** The add form's "Group" select starts with
  an empty option whose value is `''`. `''` is not a UUID, so it fails here — with the message "Pick the group
  this account goes under", instead of the general "invalid format".
- **`createAccountInputSchema` has no `type` and no `purpose`.** The type comes from the parent (decision 4). A
  purpose is only ever set by a template; letting a user send one would let them take over "the receivable
  account" of the workspace.
- **`updateAccountInputSchema`** has `parentId: …nullable()`. A top-level group has no parent and must send
  `null`; every other account sends its (maybe new) group. A new `parentId` is a move. `isGroup` is not there:
  it is fixed (decision 5).
- **`deleteAccountQuerySchema`** — the version in the query, because a `DELETE` has no body. `z.coerce.number<number>()`
  turns the query string `"3"` into `3`; the `<number>` type argument keeps the input type a `number` for the
  client's `call()` (the same as `DELETE /roles/:id`).
- **The list is not paged.** A chart has 60–300 accounts. The rule from step 6: small master lists in one piece.
  Archived accounts are included, so "Show archived" needs no second request.
- **Reading has no permission.** From step 10 on, the journal form, the invoice form and the bill form all pick
  accounts. Only changing the chart needs `accounting.account.manage`.

### A new permission, in a new group

**File: `packages/contracts/src/permissions.ts`** (change)

```diff
@@ -9,6 +9,7 @@ export const PERMISSION_KEYS = [
   'core.settings.manage',
   'core.branch.manage',
   'core.audit.read',
+  'accounting.account.manage',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -21,7 +22,7 @@ export function isPermissionKey(value: string): value is PermissionKey {
 
 // matrix-এর সারি কোন দলে: key-র মাঝের অংশ (resource) দিয়ে না, হাতে বাছা — "Team" দলে user আর role
 // দুটোই থাকে, কারণ মানুষ দুটোকে একই কাজ ভাবে। Record<PermissionKey, …>: নতুন key দল ছাড়া থাকতে পারে না
-export const PERMISSION_GROUPS = ['team', 'workspace'] as const;
+export const PERMISSION_GROUPS = ['team', 'workspace', 'accounting'] as const;
 export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];
 
 export const PERMISSION_GROUP_OF = {
@@ -32,4 +33,5 @@ export const PERMISSION_GROUP_OF = {
   'core.settings.manage': 'workspace',
   'core.branch.manage': 'workspace',
   'core.audit.read': 'workspace',
+  'accounting.account.manage': 'accounting',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

- The key follows `module.resource.action` (system-design §3.10). The module is `accounting`, not `core`: the
  roles page groups permissions by `PERMISSION_GROUP_OF`, and all of step 10–11's permissions (journal, period
  close, reports) will join this group.
- After this change the build fails until the new key has an English and Bangla text (9.6) and a description in
  `packages/db` (9.2). That is the point of the `satisfies Record<PermissionKey, …>` checks.

### Error codes and audit actions

**File: `packages/contracts/src/errors.ts`** (change)

```diff
@@ -57,6 +57,17 @@ export const ERROR_CODES = [
   // workspace setup (onboarding)
   'setup_started',
   'setup_not_failed',
+  // chart of accounts
+  'account_code_format',
+  'account_code_taken',
+  'account_name_required',
+  'account_parent_required',
+  'account_parent_invalid',
+  'account_parent_loop',
+  'account_parent_archived',
+  'account_locked',
+  'account_has_children',
+  'account_has_active_children',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- One code per thing the person must do differently, because each gets its own sentence in 9.6: "Archive the
  accounts under this group first" and "Move or delete the accounts under this group first" are different
  instructions.

**File: `packages/contracts/src/audit.ts`** (change)

```diff
@@ -9,6 +9,7 @@ export const AUDIT_ACTIONS = [
   'workspace.created',
   'workspace.setup_started',
   'workspace.provisioned',
+  'workspace.chart_created',
   'auth.signed_in',
   'auth.switched_in',
   'settings.updated',
@@ -28,6 +29,11 @@ export const AUDIT_ACTIONS = [
   'role.updated',
   'role.deleted',
   'role.permissions_changed',
+  'account.created',
+  'account.updated',
+  'account.archived',
+  'account.restored',
+  'account.deleted',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -45,6 +51,7 @@ export const AUDIT_ENTITY_TYPES = [
   'member',
   'invitation',
   'role',
+  'account',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

- `workspace.chart_created` is the backfill job's row (9.3). New workspaces get their chart inside
  `workspace.provisioned`, whose changes now include an `accounts` count.
- There is no separate `account.moved`: a move is an edit, and the audit row shows it as `parent: 1120 → 1130`.

### Registry and exports

**File: `packages/contracts/src/routes.ts`** (change)

```diff
@@ -1,5 +1,6 @@
 import { z } from 'zod';
 
+import { accountRoutes } from './accounts.js';
 import { attachmentRoutes } from './attachments.js';
 import { auditRoutes } from './audit.js';
 import { authRoutes } from './auth.js';
@@ -41,4 +42,5 @@ export const routes = {
   attachments: attachmentRoutes,
   setup: setupRoutes,
   notifications: notificationRoutes,
+  accounts: accountRoutes,
 };
```

**File: `packages/contracts/src/index.ts`** (change)

```diff
@@ -1,3 +1,4 @@
+export * from './accounts.js';
 export * from './attachments.js';
 export * from './audit.js';
 export * from './auth.js';
```

- The API's `contract.spec.ts` compares Nest's routes with this registry, so the controller in 9.4 must exist
  before `pnpm test` passes again.

### A unit test for the schemas

**File: `packages/contracts/src/accounts.spec.ts`** (new)

```ts
import { describe, expect, it } from 'vitest';

import { createAccountInputSchema, updateAccountInputSchema } from './accounts.js';

const valid = {
  parentId: '01939d1c-0000-7000-8000-000000000001',
  code: '1121',
  name: 'Dutch-Bangla Bank CD A/C 1234',
  isGroup: false,
  description: '',
};

describe('account input', () => {
  it('takes codes of digits, split by dots or hyphens', () => {
    for (const code of ['1121', '1-1-21', '11.21', ' 1121 ']) {
      expect(createAccountInputSchema.safeParse({ ...valid, code }).success).toBe(true);
    }
  });

  it('refuses letters, spaces inside and a trailing separator, with a field code', () => {
    for (const code of ['CASH', '11 21', '1121-', '', '1'.repeat(21)]) {
      const result = createAccountInputSchema.safeParse({ ...valid, code });
      expect(result.error?.issues[0]).toMatchObject({
        path: ['code'],
        message: 'account_code_format',
      });
    }
  });

  it('reads an empty parent select as "not chosen"', () => {
    const result = createAccountInputSchema.safeParse({ ...valid, parentId: '' });
    expect(result.error?.issues[0]).toMatchObject({
      path: ['parentId'],
      message: 'account_parent_required',
    });
  });

  it('stores an empty description as null', () => {
    expect(createAccountInputSchema.parse(valid).description).toBeNull();
  });

  it('lets only an update keep the parent empty (a top-level group)', () => {
    const top = { parentId: null, code: '1000', name: 'Assets', description: '', version: 3 };
    expect(updateAccountInputSchema.parse(top).parentId).toBeNull();
    expect(createAccountInputSchema.safeParse({ ...valid, parentId: null }).success).toBe(false);
  });
});
```

- `'1'.repeat(21)` checks the `max(20)`; `' 1121 '` checks that `trim()` runs before the regex.
- The last test documents decision 4's other half: only an update may send `parentId: null`.

---

## 9.2 — `packages/db`: the table and two migrations

### The table

**File: `packages/db/src/schema/ledger-accounts.ts`** (new)

```ts
import { ACCOUNT_PURPOSES, ACCOUNT_TYPES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// The chart of accounts: a tree of groups and posting accounts. Named ledger_accounts, not
// accounts — that name belongs to Better Auth's sign-in accounts (accounts.ts). The contracts and
// the UI call it simply "account".
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    // deleted_at (from baseColumns) is not used: an account is either deleted for real (only when
    // nothing uses it) or archived
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // NULL = one of the five top-level groups
    parentId: uuid('parent_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    // Copied from the parent when the account is made, and kept equal to it by the parent FK below
    type: text('type', { enum: ACCOUNT_TYPES }).notNull(),
    // A group only holds other accounts; journal lines (step 10) post to the others. Fixed at creation.
    isGroup: boolean('is_group').notNull().default(false),
    // What the system uses this account for (contracts: ACCOUNT_PURPOSES). NULL for most accounts.
    purpose: text('purpose', { enum: ACCOUNT_PURPOSES }),
    description: text('description'),
    // Like branches: hidden from new entries, never removed from old reports
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // The code is how people find an account. An archived account keeps its code, so an old
    // report's "1140" never means two different accounts.
    uniqueIndex('ledger_accounts_tenant_code_idx').on(table.tenantId, table.code),
    // The target of step 10's composite FK: a journal line → an account of the same tenant
    uniqueIndex('ledger_accounts_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the parent FK below
    uniqueIndex('ledger_accounts_tenant_id_type_idx').on(table.tenantId, table.id, table.type),
    // A group's children. Also what Postgres uses to check the parent FK when a group is deleted.
    index('ledger_accounts_tenant_parent_idx').on(table.tenantId, table.parentId),
    // Exactly one top-level group per type
    uniqueIndex('ledger_accounts_tenant_root_idx')
      .on(table.tenantId, table.type)
      .where(sql`${table.parentId} IS NULL`),
    // At most one account per purpose: "the receivable account" is always one row
    uniqueIndex('ledger_accounts_tenant_purpose_idx')
      .on(table.tenantId, table.purpose)
      .where(sql`${table.purpose} IS NOT NULL`),
    // The parent is in the same tenant AND has the same type. Type is part of the key, so the
    // database itself refuses an expense under an asset group — whatever the code does. A NULL
    // parent_id (a top-level group) skips the check (MATCH SIMPLE).
    foreignKey({
      name: 'ledger_accounts_parent_fk',
      columns: [table.tenantId, table.parentId, table.type],
      foreignColumns: [table.tenantId, table.id, table.type],
    }),
    check('ledger_accounts_parent_not_self', sql`${table.parentId} <> ${table.id}`),
    check('ledger_accounts_top_is_group', sql`${table.parentId} IS NOT NULL OR ${table.isGroup}`),
    check(
      'ledger_accounts_purpose_not_group',
      sql`${table.purpose} IS NULL OR NOT ${table.isGroup}`,
    ),
  ],
);
```

- **`...baseColumns()`** as in `branches`: id (UUIDv7), created/updated at and by, and `version` for optimistic
  locking. `deleted_at` comes along but is not used (decision 8: a delete is a real `DELETE`).
- **`parentId` has no `.references()`.** A simple FK on `parent_id → id` would allow a parent in another tenant
  and of another type. The composite `foreignKey(…)` below replaces it.
- **`type` is stored on every row**, although it could be read from the top-level group. Reports (step 11) group
  by type on every query; walking up the tree for each account would be slow and complicated. Storing it is safe
  because the FK keeps it equal to the parent's.
- **The parent FK on three columns.** `(tenant_id, parent_id, type)` must exist as `(tenant_id, id, type)`. So
  the parent is in the same tenant (like the composite FKs of step 7) **and** of the same type. Postgres checks
  it on every insert and update — also for code written years from now. `MATCH SIMPLE` (the default) skips the
  check when `parent_id` is NULL, which is exactly the top-level groups. `ON DELETE NO ACTION` (the default)
  refuses to delete a group that still has accounts: the service turns that error into
  `account_has_children` (9.4).
- **Three unique indexes on the id**, each for a reason:
  - the primary key on `id`;
  - `(tenant_id, id)` — the target of step 10's journal lines FK. Made now so step 10 does not have to lock
    this table to build it later;
  - `(tenant_id, id, type)` — the target of the parent FK. A foreign key must point at a unique index with
    exactly its columns.
- **`ledger_accounts_tenant_root_idx`** — unique `(tenant_id, type) WHERE parent_id IS NULL`: exactly one
  top-level group per type. Without it a bug (or a second run of a broken seed) could make two "Assets".
- **`ledger_accounts_tenant_purpose_idx`** — unique `(tenant_id, purpose) WHERE purpose IS NOT NULL`: "the
  receivable account" is always one row, so later code can look it up with `WHERE purpose = …` and trust the
  result.
- **`ledger_accounts_tenant_parent_idx`** — a group's children, used by the archive check and by Postgres
  itself when it checks the FK on a delete (without it, deleting an account would scan the tenant's chart).
- **Three `CHECK`s** for rules that fit in one row:
  - `parent_not_self` — a row can't be its own parent (the smallest possible loop);
  - `top_is_group` — a top-level row is always a group;
  - `purpose_not_group` — a system account is always a ledger (nothing posts to a group).

  Loops longer than one row can't be a `CHECK`; the service stops them (9.4).

**File: `packages/db/src/schema/index.ts`** (change)

```diff
@@ -17,3 +17,4 @@ export * from './number-series.js';
 export * from './invitations.js';
 export * from './outbox-events.js';
 export * from './notifications.js';
+export * from './ledger-accounts.js';
```

**File: `packages/db/src/schema/outbox-events.ts`** (change)

```diff
@@ -11,6 +11,7 @@ export const OUTBOX_EVENT_TYPES = [
   'workspace.setup_requested',
   'invitation.issued',
   'member.joined',
+  'workspace.chart_requested',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```

- The event for decision 2. A fact ("a chart was requested"), not an order, like step 8's names.

**File: `packages/db/src/permission-catalog.ts`** (change)

```diff
@@ -13,6 +13,8 @@ const DESCRIPTIONS = {
   'core.settings.manage': 'Edit the company profile, regional settings and numbering',
   'core.branch.manage': 'Add, edit and archive branches',
   'core.audit.read': 'View the audit log',
+  'accounting.account.manage':
+    'Add, edit, move, archive and delete accounts in the chart of accounts',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

- `pnpm db:migrate` runs `syncPermissions()` after the migrations, so the new row appears in `permissions`
  without a migration of its own.

### Migration 0013 (generated, then one line moved)

```bash
pnpm db:generate --name chart-of-accounts
```

**File: `packages/db/migrations/0013_chart-of-accounts.sql`**

```sql
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"is_group" boolean DEFAULT false NOT NULL,
	"purpose" text,
	"description" text,
	"archived_at" timestamp with time zone,
	CONSTRAINT "ledger_accounts_parent_not_self" CHECK ("ledger_accounts"."parent_id" <> "ledger_accounts"."id"),
	CONSTRAINT "ledger_accounts_top_is_group" CHECK ("ledger_accounts"."parent_id" IS NOT NULL OR "ledger_accounts"."is_group"),
	CONSTRAINT "ledger_accounts_purpose_not_group" CHECK ("ledger_accounts"."purpose" IS NULL OR NOT "ledger_accounts"."is_group")
);
--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_code_idx" ON "ledger_accounts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_id_idx" ON "ledger_accounts" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_id_type_idx" ON "ledger_accounts" USING btree ("tenant_id","id","type");--> statement-breakpoint
CREATE INDEX "ledger_accounts_tenant_parent_idx" ON "ledger_accounts" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_root_idx" ON "ledger_accounts" USING btree ("tenant_id","type") WHERE "ledger_accounts"."parent_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_purpose_idx" ON "ledger_accounts" USING btree ("tenant_id","purpose") WHERE "ledger_accounts"."purpose" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parent_fk" FOREIGN KEY ("tenant_id","parent_id","type") REFERENCES "public"."ledger_accounts"("tenant_id","id","type") ON DELETE no action ON UPDATE no action;
```

- ⚠️ **Move one line by hand.** drizzle-kit writes `ADD CONSTRAINT "ledger_accounts_parent_fk"` right after the
  tenant FK — **before** the `CREATE UNIQUE INDEX "ledger_accounts_tenant_id_type_idx"` it points at. Postgres
  then stops with `there is no unique constraint matching given keys for referenced table`. Cut that
  `ALTER TABLE … parent_fk …` line and paste it at the end, as above (the same kind of fix as step 7's 0009).
  Keep `--> statement-breakpoint` at the end of the line before it.
- The `CHECK`s read `"ledger_accounts"."parent_id"`: drizzle qualifies the column names. Postgres accepts the
  table's own name in a `CHECK`.

### Migration 0014 (custom)

```bash
pnpm db:generate --custom --name chart-of-accounts-rls
```

**File: `packages/db/migrations/0014_chart-of-accounts-rls.sql`**

```sql
-- Custom SQL migration file, put your code below! --

-- 1) The new tenant table: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_accounts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2) Workspaces whose setup has already started have no chart yet: the setup job of step 8 only
--    made roles. The chart itself lives in TypeScript (apps/api/src/setup/templates.ts), so SQL
--    cannot write it. Instead, one outbox event per workspace asks the worker to do it, with the
--    same code the setup job uses. 'pending' workspaces are skipped on purpose: their owner has
--    not picked a business type yet, and the setup job will make the right chart after the pick.
--    outbox_events has FORCE RLS (0012), so each insert runs inside its tenant's context, like 0010.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE setup_status <> 'pending' AND deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO outbox_events (id, tenant_id, type, payload)
    VALUES (gen_random_uuid(), t, 'workspace.chart_requested', '{}'::jsonb);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
```

- **(1)** The same `ENABLE` + `FORCE` + `tenant_isolation` as every tenant table. One table, so no loop. The RLS
  coverage test fails the build without it (checked: it names `ledger_accounts`).
- **(2) Which workspaces get a job.** `setup_status <> 'pending'`:
  - `ready` — set up in step 8 (roles only) or before step 8 (then `industry` is NULL → the general chart);
  - `failed` and `provisioning` — their setup job may still run later, and it would make the chart itself; but a
    `provisioning` job of the **old** code can finish during your deploy and leave the workspace `ready`
    without a chart. Queuing a job for these too costs nothing: whichever job runs second finds a chart and
    stops (9.3);
  - **not** `pending` — the owner has not picked a business type yet. A job now would give a garments company
    the general chart, and the real setup would then find "a chart exists" and skip its own.
- **Why each insert sets the tenant first.** `outbox_events` has `FORCE ROW LEVEL SECURITY` (step 8's 0012):
  even the migrator, who owns the table, may only insert a row of the tenant set in `app.tenant_id`. The same
  per-tenant loop as 0010. `set_config(…, true)` lasts only for the migration's transaction; the last line
  clears it anyway.
- `gen_random_uuid()` is a UUIDv4, not a v7 like the app's ids. For a handful of one-off rows the ordering does
  not matter (the same choice as 0008).
- The rows need a running worker. If the worker is down during the deploy, they wait in the outbox, and the
  charts appear when it starts — the outbox at work again.

---

## 9.3 — The worker: templates, `seedChart()` and two jobs

### The templates

**File: `apps/api/src/setup/templates.ts`** (whole file)

```ts
import type { AccountPurpose, AccountType, Industry, PermissionKey } from '@omnivo/contracts';

export interface RoleTemplate {
  name: string;
  description: string;
  permissions: PermissionKey[];
}

// One node of a template chart. With `children` it is a group (an empty list is a group the
// company fills itself, like "Bank accounts"); without, it is an account that entries post to.
export interface AccountTemplate {
  code: string;
  name: string;
  purpose?: AccountPurpose;
  children?: readonly AccountTemplate[];
}

// The five top-level groups, one per type. The type is written once here, not on every account:
// each account takes it from its top-level group, exactly as the database does (the parent FK).
export type ChartTemplate = Record<AccountType, AccountTemplate>;

// Starting data for each business type: the roles such a company is staffed with, and its chart
// of accounts. Step 12 adds the product tracking (batch for pharma). Everything here is ordinary
// data once created: the workspace can rename, change or delete it, and a later change to this
// file never touches workspaces that already exist.
export interface IndustryTemplate {
  roles: RoleTemplate[];
  chart: ChartTemplate;
}

// Some roles have few permissions today because the modules they will use (stock, sales) do not
// exist yet. Each of those steps adds its permissions to these templates for new workspaces.
const ACCOUNTANT: RoleTemplate = {
  name: 'Accountant',
  description: 'Books, VAT returns and Mushak 6.3',
  permissions: ['core.user.read', 'core.audit.read', 'accounting.account.manage'],
};

const STORE_KEEPER: RoleTemplate = {
  name: 'Store keeper',
  description: 'Receives goods and writes GRNs',
  permissions: [],
};

function group(
  code: string,
  name: string,
  children: readonly AccountTemplate[] = [],
): AccountTemplate {
  return { code, name, children };
}

// exactOptionalPropertyTypes: `purpose: undefined` is not the same as no purpose, so the key is
// only added when there is one
function account(code: string, name: string, purpose?: AccountPurpose): AccountTemplate {
  return { code, name, ...(purpose !== undefined && { purpose }) };
}

// What differs by industry. Everything else — cash, banks, VAT, payables, capital, the common
// expenses — is the same for every company in Bangladesh and comes from standardChart().
interface IndustryAccounts {
  // At code 1150: one account for a trader, a group (raw materials → finished goods) for a maker.
  // Exactly one account in it has the 'inventory' purpose.
  stock: AccountTemplate;
  // Current assets from 1180 on
  currentAssets?: readonly AccountTemplate[];
  // Current liabilities from 2180 on
  currentLiabilities?: readonly AccountTemplate[];
  // Under 4100 Revenue. Exactly one has the 'sales' purpose.
  revenue: readonly AccountTemplate[];
  // Other income from 4230 on
  otherIncome?: readonly AccountTemplate[];
  // Under 5100 Cost of sales. Exactly one has the 'cost_of_goods_sold' purpose.
  costOfSales: readonly AccountTemplate[];
  // Selling and distribution expenses from 5330 on
  selling?: readonly AccountTemplate[];
}

// Four-digit codes: the first digit is the type (1 asset … 5 expense), the second the group, the
// third the account. Gaps of 10 leave room for the company's own accounts in between.
function standardChart(industry: IndustryAccounts): ChartTemplate {
  return {
    asset: group('1000', 'Assets', [
      group('1100', 'Current assets', [
        account('1110', 'Cash in hand', 'cash'),
        // Empty: every company adds its own banks ("Dutch-Bangla Bank CD A/C …") and wallets
        group('1120', 'Bank accounts'),
        group('1130', 'Mobile wallets (bKash, Nagad)'),
        account('1140', 'Accounts receivable', 'accounts_receivable'),
        industry.stock,
        group('1160', 'Advances, deposits and prepayments', [
          account('1161', 'Advances to suppliers'),
          account('1162', 'Security deposits'),
          account('1163', 'Prepaid expenses'),
          account('1164', 'Advance income tax (AIT)'),
        ]),
        account('1170', 'Input VAT', 'vat_input'),
        ...(industry.currentAssets ?? []),
      ]),
      group('1200', 'Fixed assets', [
        account('1210', 'Land and buildings'),
        account('1220', 'Plant and machinery'),
        account('1230', 'Furniture and fixtures'),
        account('1240', 'Vehicles'),
        account('1250', 'Office equipment and computers'),
        account('1290', 'Accumulated depreciation'),
      ]),
    ]),
    liability: group('2000', 'Liabilities', [
      group('2100', 'Current liabilities', [
        account('2110', 'Accounts payable', 'accounts_payable'),
        account('2120', 'Output VAT', 'vat_output'),
        account('2130', 'VAT and tax deducted at source (VDS, TDS)'),
        account('2140', 'Salaries and wages payable'),
        account('2150', 'Accrued expenses'),
        account('2160', 'Advances from customers'),
        account('2170', 'Short-term loans and overdraft'),
        ...(industry.currentLiabilities ?? []),
      ]),
      group('2200', 'Long-term liabilities', [account('2210', 'Long-term loans')]),
    ]),
    equity: group('3000', 'Equity', [
      account('3100', 'Capital'),
      account('3200', 'Retained earnings', 'retained_earnings'),
      // The other side of the opening balances, entered in step 10 when the company moves its
      // books to Omnivo. It should read zero once everything is entered.
      account('3300', 'Opening balance equity', 'opening_balance_equity'),
    ]),
    income: group('4000', 'Income', [
      group('4100', 'Revenue', industry.revenue),
      group('4200', 'Other income', [
        account('4210', 'Interest income'),
        account('4220', 'Miscellaneous income'),
        ...(industry.otherIncome ?? []),
      ]),
    ]),
    expense: group('5000', 'Expenses', [
      group('5100', 'Cost of sales', industry.costOfSales),
      group('5200', 'Administrative expenses', [
        account('5210', 'Salaries and allowances'),
        account('5220', 'Office rent'),
        account('5230', 'Utilities (electricity, gas, water)'),
        account('5240', 'Transport and conveyance'),
        account('5250', 'Printing and stationery'),
        account('5260', 'Telephone and internet'),
        account('5270', 'Repairs and maintenance'),
        account('5280', 'Depreciation'),
      ]),
      group('5300', 'Selling and distribution expenses', [
        account('5310', 'Advertising and promotion'),
        account('5320', 'Delivery and carriage outward'),
        ...(industry.selling ?? []),
      ]),
      group('5400', 'Finance costs', [
        account('5410', 'Bank charges'),
        account('5420', 'Interest expense'),
      ]),
      account('5500', 'Income tax expense'),
    ]),
  };
}

const TRADER_STOCK = account('1150', 'Inventory', 'inventory');
const COGS = account('5110', 'Cost of goods sold', 'cost_of_goods_sold');
// Makers post the sale's cost from finished goods; raw materials move there through production
const MAKER_COSTS = [
  COGS,
  account('5120', 'Direct labour'),
  account('5130', 'Factory overhead'),
] as const;

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
    chart: standardChart({
      stock: group('1150', 'Inventories', [
        account('1151', 'Fabrics and yarn'),
        account('1152', 'Trims and accessories'),
        account('1153', 'Work in progress'),
        account('1154', 'Finished garments', 'inventory'),
      ]),
      currentAssets: [
        account('1180', 'Export bills receivable'),
        account('1190', 'Cash incentive receivable'),
      ],
      currentLiabilities: [account('2180', 'Back-to-back LC payable')],
      revenue: [account('4110', 'Export sales', 'sales'), account('4120', 'Local sales')],
      otherIncome: [account('4230', 'Cash incentive on exports')],
      costOfSales: [...MAKER_COSTS, account('5140', 'Subcontract charges')],
      selling: [
        account('5330', 'Export freight and C&F charges'),
        account('5340', 'Buying house commission'),
      ],
    }),
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
    chart: standardChart({
      stock: group('1150', 'Inventories', [
        account('1151', 'Raw materials'),
        account('1152', 'Packing materials'),
        account('1153', 'Work in progress'),
        account('1154', 'Finished goods', 'inventory'),
      ]),
      revenue: [account('4110', 'Sales', 'sales'), account('4120', 'Sales returns')],
      costOfSales: MAKER_COSTS,
      selling: [
        account('5330', 'Medical promotion and samples'),
        account('5340', 'Field force allowances'),
        account('5350', 'Expired and damaged goods'),
      ],
    }),
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
    chart: standardChart({
      stock: TRADER_STOCK,
      currentAssets: [account('1180', 'Claims receivable from principals')],
      revenue: [account('4110', 'Sales', 'sales'), account('4120', 'Trade discounts')],
      otherIncome: [account('4230', 'Commission and incentives from principals')],
      costOfSales: [COGS],
      selling: [
        account('5330', 'Damaged and expired goods'),
        account('5340', 'Sales team allowances'),
      ],
    }),
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
    chart: standardChart({
      stock: group('1150', 'Inventories', [
        account('1151', 'Raw materials'),
        account('1152', 'Work in progress'),
        account('1153', 'Finished goods', 'inventory'),
        account('1154', 'Stores and spares'),
      ]),
      revenue: [account('4110', 'Sales', 'sales')],
      costOfSales: [...MAKER_COSTS, account('5140', 'Factory power and fuel')],
    }),
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
    chart: standardChart({
      stock: TRADER_STOCK,
      currentAssets: [account('1180', 'Card and wallet settlements receivable')],
      revenue: [account('4110', 'Sales', 'sales'), account('4120', 'Sales returns')],
      costOfSales: [COGS],
      selling: [
        account('5330', 'Card and wallet charges'),
        account('5340', 'Shrinkage and damaged goods'),
      ],
    }),
  },
  other: {
    roles: [
      ACCOUNTANT,
      { name: 'Manager', description: 'Runs day-to-day work', permissions: ['core.user.read'] },
    ],
    chart: standardChart({
      stock: TRADER_STOCK,
      revenue: [account('4110', 'Sales', 'sales'), account('4120', 'Service income')],
      costOfSales: [COGS],
    }),
  },
} satisfies Record<Industry, IndustryTemplate>;
```

- **`AccountTemplate`: a group is a node with `children`.** An empty list (`group('1120', 'Bank accounts')`) is
  still a group: every company adds its own banks there ("Dutch-Bangla Bank CD A/C 1234"). A node without
  `children` is a ledger. So the template's shape says "group or ledger", and `seedChart()` reads it as
  `isGroup: node.children !== undefined`.
- **`ChartTemplate = Record<AccountType, AccountTemplate>`.** The type is written once per top-level group, not
  on every account, the same way the database derives it. A template can't put an expense under Assets.
- **`account(code, name, purpose?)` with a conditional spread.** The project has `exactOptionalPropertyTypes`:
  `{ purpose: undefined }` is not the same as "no purpose" and does not type-check against `purpose?:
  AccountPurpose`. `...(purpose !== undefined && { purpose })` adds the key only when there is one.
- **`standardChart(industry)`: one chart, a few slots.** Decision 12. The slots are exactly the places where
  industries differ: stock (one account for a trader, a group from raw materials to finished goods for a
  maker), extra current assets and liabilities, revenue lines, cost of sales and selling expenses. Each slot
  sits at a fixed code range (1150, 1180+, 2180+, 4110+, 5110+, 5330+), so industry codes never collide with
  the standard ones — `templates.spec.ts` checks it anyway.
- **The four-digit scheme with gaps of 10.** The first digit is the type (1 asset … 5 expense), which is how
  most Bangladeshi charts are numbered, and the gaps leave room for the company's own accounts between the
  template's ones (1121, 1122… under 1120).
- **Where each purpose sits:** `inventory` on the finished goods (a sale's cost comes from there; raw materials
  move to finished goods through production in step 14) or on "Inventory" for a trader; `sales` on the main
  revenue line ("Export sales" for garments). Exactly one account per purpose per chart — the unit test below
  and the database's unique index both check it.
- **Accumulated depreciation (1290) is under Fixed assets**, although it has a credit balance. That is how the
  balance sheet shows it (cost minus depreciation); an accountant expects it there.
- **The Accountant role gets `accounting.account.manage`** — for new workspaces. Existing Accountant roles are
  not changed (a template never touches existing data); an owner ticks the box on the Roles page.
- ⚠️ This file is the part of the step an accountant should read. Everything else is mechanics.

### A unit test for the templates

**File: `apps/api/src/setup/templates.spec.ts`** (new)

```ts
import {
  ACCOUNT_PURPOSES,
  ACCOUNT_TYPES,
  createAccountInputSchema,
  INDUSTRIES,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { type AccountTemplate, INDUSTRY_TEMPLATES } from './templates.js';

function flatten(node: AccountTemplate): AccountTemplate[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

// The templates are data typed by hand. The database would refuse most mistakes, but only when a
// real workspace is set up — in the worker, after the owner's click. These checks catch them here.
describe.each(INDUSTRIES)('the %s chart', (industry) => {
  const chart = INDUSTRY_TEMPLATES[industry].chart;
  const all = ACCOUNT_TYPES.flatMap((type) => flatten(chart[type]));

  it('uses each code once, in the format the API accepts', () => {
    const codes = all.map((node) => node.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(createAccountInputSchema.shape.code.safeParse(code).success, code).toBe(true);
    }
  });

  it('has exactly one account for every purpose, and never on a group', () => {
    const purposes = all.flatMap((node) => (node.purpose === undefined ? [] : [node.purpose]));
    expect(purposes.toSorted()).toEqual([...ACCOUNT_PURPOSES].sort());
    for (const node of all) {
      if (node.purpose !== undefined) expect(node.children, node.code).toBeUndefined();
    }
  });

  it('starts each type with a group, and puts every code under its type digit', () => {
    ACCOUNT_TYPES.forEach((type, index) => {
      expect(chart[type].children).toBeDefined();
      for (const node of flatten(chart[type])) {
        expect(node.code.startsWith(String(index + 1)), node.code).toBe(true);
      }
    });
  });
});
```

- Why a unit test for data: a typo here (a code used twice, a missing purpose) is refused by the database only
  when a real owner finishes the wizard — in the worker, after the click, as a failed setup. This test catches it
  in a second, on your machine.
- `describe.each(INDUSTRIES)`: a new industry in contracts is tested automatically (6 × 3 = 18 tests).
- `createAccountInputSchema.shape.code` — the template's codes must pass the same check as a code typed in the
  form, or a template account could not be saved again after an edit.
- The last test checks the code scheme: every code under Assets starts with 1, and so on. It is what keeps the
  industry slots from drifting out of their ranges.

### Seeding a chart

**File: `apps/api/src/setup/seed-chart.ts`** (new)

```ts
import { ACCOUNT_TYPES, type AccountType } from '@omnivo/contracts';
import { ledgerAccounts } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';
import type { AccountTemplate, ChartTemplate } from './templates.js';

interface Pending {
  node: AccountTemplate;
  type: AccountType;
  parentId: string | null;
}

// Creates a template chart in the transaction's tenant and returns how many accounts it made.
// Makes nothing (returns 0) if the workspace already has any account: a chart is created whole
// or not at all, so "one account exists" means "the chart was made". That is what makes the two
// jobs that call this idempotent — and they lock the tenant row first, so they never race.
export async function seedChart(
  tx: Transaction,
  tenantId: string,
  chart: ChartTemplate,
): Promise<number> {
  const [existing] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.tenantId, tenantId))
    .limit(1);
  if (existing) return 0;

  // One level at a time: a child row needs its parent's id, which Postgres makes on insert. The
  // deepest template is four levels, so four inserts — not one per account.
  let level: Pending[] = ACCOUNT_TYPES.map((type) => ({ node: chart[type], type, parentId: null }));
  let created = 0;
  while (level.length > 0) {
    const inserted = await tx
      .insert(ledgerAccounts)
      .values(
        level.map(({ node, type, parentId }) => ({
          tenantId,
          parentId,
          code: node.code,
          name: node.name,
          type,
          isGroup: node.children !== undefined,
          purpose: node.purpose ?? null,
        })),
      )
      .returning({ id: ledgerAccounts.id, code: ledgerAccounts.code });
    created += inserted.length;

    // Codes are unique in a template (templates.spec.ts), so the code finds the new row's id
    const idOf = new Map(inserted.map((row) => [row.code, row.id]));
    level = level.flatMap(({ node, type }) => {
      const parentId = idOf.get(node.code);
      if (parentId === undefined) throw new Error(`Chart template: ${node.code} was not created`);
      return (node.children ?? []).map((child) => ({ node: child, type, parentId }));
    });
  }
  return created;
}
```

- **Whole chart or nothing.** The first query asks "does this workspace have any account?". A chart is made in
  one transaction, and a person can't add an account before the top-level groups exist (every new account
  needs a parent). So "one account exists" really means "the chart was made", and the function can simply
  stop. That is the idempotency of both jobs below — no `ON CONFLICT` per row, no half charts.
- **The callers lock the tenant row first** (`FOR UPDATE`). Two jobs for one workspace (a retried setup and the
  backfill) then run one after the other, and the second one sees the first one's chart.
- **One level at a time.** A child row needs its parent's id, and that id is only made during the insert
  (Drizzle calls `baseColumns`' `$defaultFn`, a UUIDv7, for each row it sends). So: insert the five top-level
  groups, read their ids back with `returning`, insert all their children in one statement, and so on. The
  deepest template has four levels, so four inserts for ~70 accounts. The alternative — making every id
  ourselves first — would need the `uuidv7` package in `apps/api` for this one place.
- **`idOf` by code.** Codes are unique within a template (the unit test), so the code finds the row just made.
  The `throw` can only fire if that promise breaks; it turns a silent wrong tree into a loud failure.
- **`isGroup: node.children !== undefined`**, **`purpose: node.purpose ?? null`** — the template's shape becomes
  columns. `createdBy` stays NULL: the system made these rows.

### The setup job makes the chart

**File: `apps/api/src/setup/provisioning.handler.ts`** (change)

```diff
@@ -9,6 +9,7 @@ import { getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { notify } from '../notifications/notify.js';
+import { seedChart } from './seed-chart.js';
 import { INDUSTRY_TEMPLATES, type RoleTemplate } from './templates.js';
 
 type Event = OutboxEvent<'workspace.setup_requested'>;
@@ -82,7 +83,11 @@ export class ProvisioningHandler implements EventHandler<'workspace.setup_reques
       }
 
       const industry = tenant.industry;
-      const seeded = await seedRoles(tx, tenantId, INDUSTRY_TEMPLATES[industry].roles);
+      const template = INDUSTRY_TEMPLATES[industry];
+      const seeded = await seedRoles(tx, tenantId, template.roles);
+      // 0 when the workspace already has a chart: step 9's migration queued one for a workspace
+      // whose setup had failed, and it ran before this retry
+      const accounts = await seedChart(tx, tenantId, template.chart);
       await tx.update(tenants).set({ setupStatus: 'ready' }).where(eq(tenants.id, tenantId));
       // No actorUserId: the audit log shows "System" — the job did it, not a person
       await audit(tx, {
@@ -92,6 +97,7 @@ export class ProvisioningHandler implements EventHandler<'workspace.setup_reques
         changes: created({
           industry,
           roles: seeded.length === 0 ? null : seeded.map((role) => role.name).join(', '),
+          accounts: accounts === 0 ? null : accounts,
         }),
       });
       await notify(tx, {
```

- **Same transaction as the roles.** Step 8's promise stays: the setup is all or nothing. A failure in the chart
  rolls the roles back too, and the retry starts clean.
- **`accounts` can be 0.** A workspace whose setup had failed got a chart from the backfill job (0014) before
  the owner pressed "Try again". The retry then makes the roles and leaves the chart alone. The audit row says
  `accounts: null` then, like `roles: null` when all role names were taken. The setup test covers exactly
  this (9.5).

### The backfill job

**File: `apps/api/src/setup/chart.handler.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import { isIndustry } from '@omnivo/contracts';
import { tenants } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { type EventHandler, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { seedChart } from './seed-chart.js';
import { INDUSTRY_TEMPLATES } from './templates.js';

// Gives a chart of accounts to a workspace that was set up before step 9. Migration 0014 queues
// one 'workspace.chart_requested' per such workspace; new workspaces get their chart from the
// setup job instead (ProvisioningHandler). Both use seedChart(), so the result is the same.
@Injectable()
export class ChartHandler implements EventHandler<'workspace.chart_requested'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // The same lock as the setup job. If both run for one workspace (its failed setup is retried
      // while this event waits), they take turns, and the second one finds a chart and stops.
      const [tenant] = await tx
        .select({ industry: tenants.industry })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw new PermanentJobError('The workspace no longer exists');

      // Workspaces from before step 8 never picked a business type: they get the general chart
      const industry =
        tenant.industry !== null && isIndustry(tenant.industry) ? tenant.industry : 'other';
      const accounts = await seedChart(tx, tenantId, INDUSTRY_TEMPLATES[industry].chart);
      // Already had a chart: a second run of this job, or the setup job was first
      if (accounts === 0) return;
      // No actorUserId: the audit log shows "System"
      await audit(tx, {
        action: 'workspace.chart_created',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({ industry, accounts }),
      });
    });
  }
}
```

- **The same lock as the setup job** (`tenants … FOR UPDATE`). This job and a retried setup job can run for the
  same workspace; the lock makes them take turns, and `seedChart()` makes the second one a no-op.
- **`industry ?? 'other'`**, written out with `isIndustry()`: `tenants.industry` is plain text in the database,
  and workspaces from before step 8 have NULL. They get the general chart — with every system account — and the
  owner reshapes it on the Chart of accounts page.
- **No `onGiveUp`.** If this job fails five times, nothing is half done (one transaction), the error is in the
  worker's log, and the page shows "Your chart of accounts is on its way". To run it again, insert one more
  outbox row (see COMMANDS.md in 9.12). A notification for a background fix nobody asked for would only confuse.
- **No notification on success either**, for the same reason: the owner did not start this. The audit log says
  "Added the chart of accounts" by System.
- **`handle()` takes no event.** The payload is empty (the tenant is in the context), and a method with fewer
  parameters still implements `EventHandler<'workspace.chart_requested'>`.

### Wiring the new event

The four places from step 8's notes. Leave one out and `pnpm typecheck` names it.

**File: `apps/api/src/common/outbox/outbox.ts`** (change)

```diff
@@ -16,6 +16,8 @@ export const outboxPayloadSchemas = {
   'invitation.issued': z.object({ invitationId: z.uuid(), actorUserId: z.uuid() }),
   // inviterId is null when the invitation's creator is unknown (an old row)
   'member.joined': z.object({ membershipId: z.uuid(), inviterId: z.uuid().nullable() }),
+  // Nothing to carry: the workspace is the event's tenant, and its business type is on its row
+  'workspace.chart_requested': z.object({}),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

- An empty object: nothing to carry. `z.object({})` still drops any key someone might add by mistake.

**File: `apps/api/src/worker/queues.ts`** (change)

```diff
@@ -17,6 +17,7 @@ const QUEUE_OF = {
   'invitation.issued': 'email',
   'workspace.setup_requested': 'jobs',
   'member.joined': 'jobs',
+  'workspace.chart_requested': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
```

- The `jobs` queue, next to the setup job: a slow mail server never delays it.

**File: `apps/api/src/worker/handlers.ts`** (change)

```diff
@@ -4,6 +4,7 @@ import type { OutboxEventType } from '@omnivo/db';
 import type { EventHandler } from '../common/outbox/outbox.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
+import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 
@@ -22,12 +23,14 @@ export class EventHandlers {
     provisioning: ProvisioningHandler,
     invitationEmail: InvitationEmailHandler,
     memberJoined: MemberJoinedHandler,
+    chart: ChartHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
       'workspace.setup_requested': provisioning,
       'invitation.issued': invitationEmail,
       'member.joined': memberJoined,
+      'workspace.chart_requested': chart,
     };
   }
 
```

**File: `apps/api/src/worker/worker.module.ts`** (change)

```diff
@@ -7,6 +7,7 @@ import { CONFIG, DB, RELAY_DB, WITH_TENANT } from '../infra/tokens.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
 import { MailService } from '../mail/mail.service.js';
+import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 import { EventHandlers } from './handlers.js';
@@ -43,6 +44,7 @@ export class WorkerModule implements OnApplicationShutdown {
         ProvisioningHandler,
         InvitationEmailHandler,
         MemberJoinedHandler,
+        ChartHandler,
       ],
     };
   }
```

---

## 9.4 — The API: `AccountsModule`

### The service

**File: `apps/api/src/accounts/accounts.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Account, CreateAccountInput, UpdateAccountInput } from '@omnivo/contracts';
import { ledgerAccounts } from '@omnivo/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type AccountRow = typeof ledgerAccounts.$inferSelect;

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    type: row.type,
    isGroup: row.isGroup,
    purpose: row.purpose,
    description: row.description,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit log shows: the form's fields, with the group as its code — an id would mean
// nothing to the person reading the log
function snapshot(row: Pick<AccountRow, 'code' | 'name' | 'description'>, parent: string | null) {
  return { code: row.code, name: row.name, description: row.description, parent };
}

function codeTaken(code: string): AppError {
  return new AppError(409, 'account_code_taken', `Account code ${code} is already used.`, {
    fieldErrors: { code: ['account_code_taken'] },
  });
}

// The same answer for "no such group", "another tenant's group", "a posting account", "archived"
// and "another type": the form shows one message under the Group field, and nothing leaks
function parentInvalid(): AppError {
  return new AppError(409, 'account_parent_invalid', 'The parent must be an active group.', {
    fieldErrors: { parentId: ['account_parent_invalid'] },
  });
}

function locked(): AppError {
  return new AppError(
    409,
    'account_locked',
    'Top-level groups and system accounts cannot be archived or deleted.',
  );
}

// Every change to a tenant's chart takes this lock first, so the changes to one chart run one after
// another (other tenants never wait). A chart is edited a few times a month, so the wait is
// nothing, and it removes two races that row locks alone leave open:
// - Two moves in opposite directions (A under B, B under A). Each locks its own row, then the
//   parent FK needs a share lock on the other's row: a deadlock. Postgres aborts one after a
//   second, and that person sees an error. With this lock the second move simply waits, then its
//   loop check sees the first move and refuses.
// - A new account under a group that is being archived. The insert only waits for the archive to
//   commit (the FK checks that the group exists, not that it is active), then adds an active
//   account under an archived group.
// An advisory lock is a lock on a number instead of a row; the _xact_ kind is released at commit or
// rollback by itself. hashtextextended turns the text into that number; the prefix keeps it apart
// from any other advisory lock added later.
async function lockChart(tx: Transaction): Promise<void> {
  const key = `ledger_accounts:${getTenantId()}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

@Injectable()
export class AccountsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<Account[]> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.tenantId, tenantId))
        .orderBy(asc(ledgerAccounts.code));
      return rows.map(toAccount);
    });
  }

  get(id: string): Promise<Account> {
    return this.withTenant(async (tx) => toAccount(await this.lock(tx, id, false)));
  }

  async create(input: CreateAccountInput): Promise<Account> {
    const tenantId = getTenantId();
    try {
      return await this.withTenant(async (tx) => {
        await lockChart(tx);
        const parent = await this.parent(tx, input.parentId);
        const [row] = await tx
          .insert(ledgerAccounts)
          .values({
            tenantId,
            parentId: parent.id,
            // Never from the request: an account's type is always its group's
            type: parent.type,
            isGroup: input.isGroup,
            code: input.code,
            name: input.name,
            description: input.description,
            createdBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Account insert returned no row');
        await audit(tx, {
          action: 'account.created',
          entityType: 'account',
          entityId: row.id,
          changes: created(snapshot(row, parent.code)),
        });
        return toAccount(row);
      });
    } catch (error) {
      // Caught outside the transaction, after its rollback (the branches pattern, step 6)
      if (isUniqueViolation(error, 'ledger_accounts_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  async update(id: string, input: UpdateAccountInput): Promise<Account> {
    try {
      return await this.withTenant(async (tx) => {
        await lockChart(tx);
        const before = await this.lock(tx, id, true);
        if (before.version !== input.version) throw versionConflict();
        const parentBefore = await this.codeOf(tx, before.parentId);
        const parentAfter =
          input.parentId === before.parentId
            ? parentBefore
            : await this.move(tx, before, input.parentId);
        const after = await this.write(tx, id, {
          parentId: input.parentId,
          code: input.code,
          name: input.name,
          description: input.description,
        });
        await audit(tx, {
          action: 'account.updated',
          entityType: 'account',
          entityId: id,
          changes: diff(snapshot(before, parentBefore), snapshot(after, parentAfter)),
        });
        return toAccount(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'ledger_accounts_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  archive(id: string, version: number): Promise<Account> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      await lockChart(tx);
      const before = await this.lock(tx, id, true);
      if (before.version !== version) throw versionConflict();
      if (before.archivedAt !== null) return toAccount(before);
      if (before.parentId === null || before.purpose !== null) throw locked();
      if (before.isGroup) {
        // The chart lock keeps a new or restored child from appearing before we commit
        const [child] = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.tenantId, tenantId),
              eq(ledgerAccounts.parentId, id),
              isNull(ledgerAccounts.archivedAt),
            ),
          )
          .limit(1);
        if (child) {
          throw new AppError(
            409,
            'account_has_active_children',
            'Archive the accounts under this group first.',
          );
        }
      }
      const after = await this.write(tx, id, { archivedAt: new Date() });
      await audit(tx, { action: 'account.archived', entityType: 'account', entityId: id });
      return toAccount(after);
    });
  }

  restore(id: string, version: number): Promise<Account> {
    return this.withTenant(async (tx) => {
      await lockChart(tx);
      const before = await this.lock(tx, id, true);
      if (before.version !== version) throw versionConflict();
      if (before.archivedAt === null) return toAccount(before);
      // An active account under an archived group would be hidden with its group, yet usable
      if (before.parentId !== null) {
        const [parent] = await tx
          .select({ archivedAt: ledgerAccounts.archivedAt })
          .from(ledgerAccounts)
          .where(
            and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, before.parentId)),
          );
        if (parent?.archivedAt !== null) {
          throw new AppError(
            409,
            'account_parent_archived',
            'Restore the group above this account first.',
          );
        }
      }
      const after = await this.write(tx, id, { archivedAt: null });
      await audit(tx, { action: 'account.restored', entityType: 'account', entityId: id });
      return toAccount(after);
    });
  }

  async remove(id: string, version: number): Promise<void> {
    const tenantId = getTenantId();
    try {
      await this.withTenant(async (tx) => {
        await lockChart(tx);
        const before = await this.lock(tx, id, true);
        if (before.version !== version) throw versionConflict();
        if (before.parentId === null || before.purpose !== null) throw locked();
        const parent = await this.codeOf(tx, before.parentId);
        await tx
          .delete(ledgerAccounts)
          .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.id, id)));
        await audit(tx, {
          action: 'account.deleted',
          entityType: 'account',
          entityId: id,
          changes: diff(snapshot(before, parent), {
            code: null,
            name: null,
            description: null,
            parent: null,
          }),
        });
      });
    } catch (error) {
      // No "has children?" query first: the parent FK is the check. A group with accounts under
      // it (archived ones too) cannot be deleted. From step 10 the journal lines' FK adds "has
      // entries" the same way.
      if (isForeignKeyViolation(error, 'ledger_accounts_parent_fk')) {
        throw new AppError(
          409,
          'account_has_children',
          'Move or delete the accounts under this group first.',
        );
      }
      throw error;
    }
  }

  // The group a new or moved account goes under. No row lock needed: the caller holds the chart
  // lock, so nobody archives, deletes or moves this group before we commit.
  private async parent(tx: Transaction, id: string): Promise<AccountRow> {
    const [row] = await tx
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, id)));
    if (!row?.isGroup || row.archivedAt !== null) throw parentInvalid();
    return row;
  }

  // Checks a move and returns the new group's code, for the audit log
  private async move(
    tx: Transaction,
    account: AccountRow,
    parentId: string | null,
  ): Promise<string> {
    // A top-level group stays at the top; every other account stays under some group
    if (account.parentId === null || parentId === null) throw parentInvalid();

    const parent = await this.parent(tx, parentId);
    // The parent FK would refuse this too, but as an error nobody can read
    if (parent.type !== account.type) throw parentInvalid();

    // Walk up from the new group to the top. Meeting the account on the way means the new group
    // is the account itself or sits under it — the move would cut the branch off into a loop.
    // The chart lock makes sure no other move is half done while we look.
    const loop = await tx.execute(sql`
      WITH RECURSIVE up AS (
        SELECT id, parent_id FROM ledger_accounts
         WHERE tenant_id = ${account.tenantId} AND id = ${parent.id}
        UNION ALL
        SELECT a.id, a.parent_id FROM ledger_accounts a
          JOIN up ON a.id = up.parent_id
         WHERE a.tenant_id = ${account.tenantId}
      )
      SELECT 1 FROM up WHERE id = ${account.id} LIMIT 1`);
    if (loop.length > 0) {
      throw new AppError(409, 'account_parent_loop', 'A group cannot go under its own accounts.', {
        fieldErrors: { parentId: ['account_parent_loop'] },
      });
    }
    return parent.code;
  }

  private async codeOf(tx: Transaction, id: string | null): Promise<string | null> {
    if (id === null) return null;
    const [row] = await tx
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, id)));
    return row?.code ?? null;
  }

  // FOR UPDATE on the account itself: the chart lock only stops other chart edits. From step 10,
  // posting a journal line locks its account FOR SHARE, so it cannot land on an account that is
  // being archived or deleted at that moment. tenant filter + RLS: another tenant's id is "not
  // there" — 404, never 403.
  private async lock(tx: Transaction, id: string, forUpdate: boolean): Promise<AccountRow> {
    const query = tx
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, id)));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw notFound('Account');
    return row;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<AccountRow, 'parentId' | 'code' | 'name' | 'description' | 'archivedAt'>>,
  ): Promise<AccountRow> {
    const [row] = await tx
      .update(ledgerAccounts)
      .set({
        ...fields,
        version: sql`${ledgerAccounts.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, id)))
      .returning();
    if (!row) throw notFound('Account');
    return row;
  }
}
```

Top to bottom:

- **`toAccount`** — the row turned into the contract's shape: dates as ISO strings, and no `tenant_id` or
  `created_by` (the `ContractInterceptor` would drop them anyway, but the service states what it means).
- **`snapshot(row, parent)`** — what the audit log shows. The group is written as its **code**: "Group: 1120 →
  1130" says something to an accountant, a UUID does not. `type` and `isGroup` are not in it: neither can change.
- **`parentInvalid()` — one answer for five cases.** No such group, another tenant's group, a ledger, an archived
  group, a group of another type: all `409 account_parent_invalid` under the Group field. The form has one
  sentence for them ("Pick an active group of the same type from the list"), and tenant A learns nothing about
  tenant B's ids — "not a group" and "not yours" look the same.
- **`lockChart()` — decision 9.** `pg_advisory_xact_lock(n)` waits until no other transaction holds lock `n`,
  then holds it until this transaction ends (commit or rollback; there is nothing to release by hand).
  `hashtextextended(text, 0)` turns `ledger_accounts:<tenant id>` into that 64-bit number, so each tenant has
  its own lock and one company never waits for another. Every change (create, update, archive, restore, delete)
  calls it first. What it prevents, concretely:
  - **Two opposite moves.** Request 1 moves A under B, request 2 moves B under A. Without the lock, each locks its
    own row (`FOR UPDATE`), both loop checks pass (neither move is committed yet), then each `UPDATE` needs a
    share lock on the *other* row, because the parent FK checks that the new parent exists. They wait for each
    other: a deadlock. After a second Postgres aborts one of them, and that person gets a 500. (A loop can't
    actually form — the row locks see to that — but an error for a correct click is a bug.) With the lock the
    second request waits for the first to commit, then its loop check sees A under B and answers with a clear
    `account_parent_loop`. The test in 9.5 replays exactly this and fails without the lock (checked).
  - **A new account under a group that is being archived.** Without the lock the insert reads the group (still
    active), then waits only at the FK check until the archive commits — and the FK only checks that the group
    *exists*. Result: an active account under an archived group, which the tree then hides with its group.
- **`list()`** — the whole chart, ordered by code. The app builds the tree and sorts siblings itself (with a
  numeric collator), so this order is only for tools and tests.
- **`create()`**:
  - `this.parent(tx, input.parentId)` — the group must exist in this tenant, be a group and be active;
  - `type: parent.type` — never from the request (decision 4). The FK would refuse a wrong one anyway;
  - the unique-code error is caught **outside** `withTenant`, after the rollback — the branches pattern: a failed
    statement leaves the transaction unusable, so nothing more can run inside it, not even the audit.
- **`update()` — rename, recode, move.** The version check first (optimistic locking, as everywhere). Only a
  changed `parentId` goes through `move()`. `write()` then saves all four fields; the audit `diff()` keeps only
  what really changed, so "Save" without changes writes an empty change list, not a fake one.
- **`move()`**:
  - a top-level group can't move, and a non-top account can't become top-level: `parentId` null on either side
    is refused. The five top-level groups are the chart's skeleton;
  - `parent.type !== account.type` is checked here although the FK would refuse it — the FK's error is a 500
    that no form can show;
  - **the loop check is a recursive query.** `WITH RECURSIVE up` starts at the new group and follows `parent_id`
    upwards to the top. If it meets the account being moved, the new group is the account itself or inside it,
    and the move would detach that branch into a circle. Walking **up** is cheap (one row per level, at most
    four or five), unlike walking down a branch. The chart lock guarantees no other move is half done while we
    walk.
- **`archive()`**:
  - `parentId === null || purpose !== null` → `account_locked`: the top-level groups and the system accounts
    stay (decision 7);
  - a group only when all its children are archived. Archiving a group with active accounts would hide those
    accounts from the tree while they could still be used;
  - archiving twice returns the row unchanged (no error, no second audit row) — a double click is harmless.
- **`restore()`** — the mirror rule: an account can't come back while its group is archived.
- **`remove()`** — no "does it have children?" query. The `DELETE` itself fails on the parent FK when it has
  any (archived ones too), and the error is turned into `account_has_children`. That is exactly how step 10's
  "has entries" will work: the journal lines' FK will fail the same `DELETE`, and one more `if` maps it to a new
  code. The audit row records what was deleted (code, name, group), because the row itself is gone.
- **`lock()` — `FOR UPDATE` on the account itself.** The chart lock only stops other *chart* changes. From step
  10, posting a journal line will lock its account `FOR SHARE`; this `FOR UPDATE` makes an archive or delete
  wait for such a posting (and the other way round), so no entry lands on an account in the moment it is
  archived.
- **`write()`** — every write adds 1 to `version`, so a stale form gets `409 version_conflict`.

### Controller, module, wiring

**File: `apps/api/src/accounts/accounts.controller.ts`** (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { AccountsService } from './accounts.service.js';

type Routes = typeof routes.accounts;

@Controller()
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Endpoint(routes.accounts.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.accounts.list() };
  }

  @Endpoint(routes.accounts.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.accounts.get(params.id);
  }

  @Endpoint(routes.accounts.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.accounts.create(body);
  }

  @Endpoint(routes.accounts.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.accounts.update(params.id, body);
  }

  @Endpoint(routes.accounts.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.accounts.archive(params.id, body.version);
  }

  @Endpoint(routes.accounts.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.accounts.restore(params.id, body.version);
  }

  @Endpoint(routes.accounts.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.accounts.remove(params.id, query.version);
  }
}
```

- Thin, like every controller: `@Endpoint(route)` reads the method, path, schemas and permission from the
  contract, so there is no second place where "who may delete an account" is written.
- `remove` returns `Promise<void>` — the route's status is 204.

**File: `apps/api/src/accounts/accounts.module.ts`** (new)

```ts
import { Module } from '@nestjs/common';

import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';

// The chart of accounts. Its starting accounts come from the worker (setup/seed-chart.ts); this
// module is what people do with them afterwards.
@Module({
  controllers: [AccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}
```

**File: `apps/api/src/app.module.ts`** (change)

```diff
@@ -6,6 +6,7 @@ import {
 } from '@nestjs/common';
 import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
 
+import { AccountsModule } from './accounts/accounts.module.js';
 import { AttachmentsModule } from './attachments/attachments.module.js';
 import { AuditModule } from './audit/audit.module.js';
 import { AuthGuard } from './auth/auth.guard.js';
@@ -49,6 +50,7 @@ export class AppModule implements NestModule {
         AttachmentsModule,
         SetupModule,
         NotificationsModule,
+        AccountsModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

- Only in `AppModule`. The worker never edits a chart through this service; it seeds with `seedChart()`.

---

## 9.5 — The API's tests

### A helper: how many accounts a template makes

**File: `apps/api/src/testing/chart.ts`** (new)

```ts
import { ACCOUNT_TYPES } from '@omnivo/contracts';

import type { AccountTemplate, ChartTemplate } from '../setup/templates.js';

function count(node: AccountTemplate): number {
  return 1 + (node.children ?? []).reduce((sum, child) => sum + count(child), 0);
}

// How many accounts seedChart() makes from a template — tests compare with this instead of a
// number typed by hand, so adding an account to a template does not break them
export function accountCount(chart: ChartTemplate): number {
  return ACCOUNT_TYPES.reduce((sum, type) => sum + count(chart[type]), 0);
}
```

- In `testing/`, not in `templates.ts`: production code should not export helpers only tests use. Tests compare
  with this count instead of a typed number, so adding an account to a template does not break them.

### The endpoints

**File: `apps/api/src/accounts/accounts.int.spec.ts`** (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  auditPageSchema,
  meResponseSchema,
  problemSchema,
  setupSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INDUSTRY_TEMPLATES } from '../setup/templates.js';
import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import { accountCount } from '../testing/chart.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
let viewer: SignedIn;
let tenantId: string;

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  // The chart comes from the setup job, so the real worker runs. No mail server: the welcome
  // email fails quietly in the background, which these tests do not look at.
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  tenantId = meResponseSchema.parse((await send('GET', '/auth/me')).json()).tenant.id;
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });

  await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'nasrin@rahmangarments.com',
    workspace: 'rahman-garments',
  });
  viewer = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

async function chart(): Promise<Account[]> {
  return accountListSchema.parse((await send('GET', '/accounts')).json()).items;
}

async function byCode(code: string): Promise<Account> {
  const found = (await chart()).find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found;
}

async function create(parentCode: string, code: string, name: string, isGroup = false) {
  const parent = await byCode(parentCode);
  return send('POST', '/accounts', { parentId: parent.id, code, name, isGroup, description: '' });
}

// The form sends every field; these tests change one or two
async function edit(
  account: Account,
  change: Partial<Record<'parentId' | 'code' | 'name', string>>,
) {
  return send('PUT', `/accounts/${account.id}`, {
    parentId: account.parentId,
    code: account.code,
    name: account.name,
    description: account.description ?? '',
    version: account.version,
    ...change,
  });
}

describe('the starting chart', () => {
  it("is the garments template, with every account in its top-level group's type", async () => {
    const accounts = await chart();
    expect(accounts).toHaveLength(accountCount(INDUSTRY_TEMPLATES.garments.chart));

    const roots = accounts.filter((account) => account.parentId === null);
    expect(roots.map((root) => [root.code, root.type, root.isGroup])).toEqual([
      ['1000', 'asset', true],
      ['2000', 'liability', true],
      ['3000', 'equity', true],
      ['4000', 'income', true],
      ['5000', 'expense', true],
    ]);
    const typeOf = new Map(accounts.map((account) => [account.id, account.type]));
    for (const account of accounts) {
      if (account.parentId !== null) expect(typeOf.get(account.parentId)).toBe(account.type);
    }
    expect(await byCode('1154')).toMatchObject({ name: 'Finished garments', purpose: 'inventory' });
  });
});

describe('adding accounts', () => {
  it("takes the group's type and refuses a code already in use", async () => {
    const res = await create('1120', '1121', 'Dutch-Bangla Bank CD A/C 1234');
    expect(res.statusCode).toBe(201);
    const bank = accountSchema.parse(res.json());
    expect(bank).toMatchObject({ type: 'asset', isGroup: false, purpose: null, version: 1 });
    expect(bank.parentId).toBe((await byCode('1120')).id);

    const again = await create('5200', '1121', 'Same code, other group');
    expect(again.statusCode).toBe(409);
    expect(problemSchema.parse(again.json()).fieldErrors).toEqual({ code: ['account_code_taken'] });
  });

  it('refuses a posting account, an unknown id and a malformed code', async () => {
    for (const parentId of [(await byCode('1110')).id, '01939d1c-0000-7000-8000-000000000000']) {
      const res = await send('POST', '/accounts', {
        parentId,
        code: '1199',
        name: 'Petty cash',
        isGroup: false,
        description: '',
      });
      expect(res.statusCode).toBe(409);
      expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
        parentId: ['account_parent_invalid'],
      });
    }
    const malformed = await create('1120', 'DBBL', 'Letters in the code');
    expect(malformed.statusCode).toBe(400);
    expect(problemSchema.parse(malformed.json()).fieldErrors).toEqual({
      code: ['account_code_format'],
    });
  });
});

describe('moving accounts', () => {
  it('moves an account to another group of its type, and logs the groups by code', async () => {
    const bank = await byCode('1121');
    const res = await edit(bank, { parentId: (await byCode('1130')).id });
    expect(res.statusCode).toBe(200);
    expect(accountSchema.parse(res.json())).toMatchObject({ version: 2 });

    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=account')).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'account.updated',
      actor: { fullName: 'Farhana Rahman' },
      changes: { parent: { from: '1120', to: '1130' } },
    });
  });

  it('refuses another type, a top-level move and a group under its own account', async () => {
    const bank = await byCode('1121');
    const otherType = await edit(bank, { parentId: (await byCode('2100')).id });
    expect(problemSchema.parse(otherType.json()).code).toBe('account_parent_invalid');

    const assets = await byCode('1000');
    const topLevel = await edit(assets, { parentId: (await byCode('1100')).id });
    expect(problemSchema.parse(topLevel.json()).code).toBe('account_parent_invalid');

    // Current assets under "Advances…", which is inside Current assets
    const current = await byCode('1100');
    const loop = await edit(current, { parentId: (await byCode('1160')).id });
    expect(loop.statusCode).toBe(409);
    expect(problemSchema.parse(loop.json()).fieldErrors).toEqual({
      parentId: ['account_parent_loop'],
    });
  });

  it('lets two moves at the same time take turns: no deadlock, and the loop is refused', async () => {
    const a = accountSchema.parse(
      (await create('1200', '1260', 'Assets under construction', true)).json(),
    );
    const b = accountSchema.parse(
      (await create('1200', '1270', 'Leasehold improvements', true)).json(),
    );

    // Replay the first move exactly as the service runs it (chart lock, lock A, then update A),
    // and start the second move (B under A) in the middle. With the chart lock the API waits for
    // the first move to commit, then sees A under B and refuses the loop. Without it, each move
    // holds its own row and waits for the other's (the parent FK needs a share lock on the new
    // parent): Postgres finds the deadlock after a second and aborts one of the two — a 500 for
    // the person, or a failed first move.
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let pending: ReturnType<typeof edit> | undefined;
    await superuser.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`ledger_accounts:${tenantId}`}, 0))`;
      await tx`SELECT id FROM ledger_accounts WHERE id = ${a.id} FOR UPDATE`;
      pending = edit(b, { parentId: a.id });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx`UPDATE ledger_accounts SET parent_id = ${b.id}, version = version + 1 WHERE id = ${a.id}`;
    });
    await superuser.end();

    const res = await pending;
    expect(res?.statusCode).toBe(409);
    expect(problemSchema.parse(res?.json()).code).toBe('account_parent_loop');
  });
});

describe('archiving and deleting', () => {
  it('protects top-level groups and system accounts', async () => {
    for (const code of ['1000', '1140']) {
      const account = await byCode(code);
      const archive = await send('POST', `/accounts/${account.id}/archive`, {
        version: account.version,
      });
      expect(problemSchema.parse(archive.json()).code).toBe('account_locked');
      const remove = await send(
        'DELETE',
        `/accounts/${account.id}?version=${String(account.version)}`,
      );
      expect(problemSchema.parse(remove.json()).code).toBe('account_locked');
    }
  });

  it('archives a group only after the accounts in it, and restores in the other order', async () => {
    const wallets = await byCode('1130');
    const first = await send('POST', `/accounts/${wallets.id}/archive`, {
      version: wallets.version,
    });
    expect(problemSchema.parse(first.json()).code).toBe('account_has_active_children');

    const bank = await byCode('1121');
    expect(
      (await send('POST', `/accounts/${bank.id}/archive`, { version: bank.version })).statusCode,
    ).toBe(200);
    const archived = await send('POST', `/accounts/${wallets.id}/archive`, {
      version: wallets.version,
    });
    expect(accountSchema.parse(archived.json()).archivedAt).not.toBeNull();

    const archivedBank = await byCode('1121');
    const early = await send('POST', `/accounts/${bank.id}/restore`, {
      version: archivedBank.version,
    });
    expect(problemSchema.parse(early.json()).code).toBe('account_parent_archived');
    // Refused, but a new account there is refused too: an archived group takes nothing new
    expect(problemSchema.parse((await create('1130', '1131', 'bKash merchant')).json()).code).toBe(
      'account_parent_invalid',
    );
  });

  it('deletes an unused account, but not a group with accounts under it', async () => {
    const wallets = await byCode('1130');
    const group = await send(
      'DELETE',
      `/accounts/${wallets.id}?version=${String(wallets.version)}`,
    );
    expect(group.statusCode).toBe(409);
    expect(problemSchema.parse(group.json()).code).toBe('account_has_children');

    const bank = await byCode('1121');
    const res = await send('DELETE', `/accounts/${bank.id}?version=${String(bank.version)}`);
    expect(res.statusCode).toBe(204);
    expect((await send('GET', `/accounts/${bank.id}`)).statusCode).toBe(404);

    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=account')).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'account.deleted',
      changes: { code: { from: '1121', to: null }, parent: { from: '1130', to: null } },
    });
  });
});

describe('permissions', () => {
  it('lets every member read the chart, but only accounting.account.manage change it', async () => {
    expect((await send('GET', '/accounts', undefined, viewer)).statusCode).toBe(200);
    const parent = await byCode('1120');
    const res = await send(
      'POST',
      '/accounts',
      { parentId: parent.id, code: '1122', name: 'BRAC Bank', isGroup: false, description: '' },
      viewer,
    );
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'accounting.account.manage' },
    });
  });
});
```

- **The chart comes from the real worker.** `beforeAll` signs up, picks garments and waits for `ready`, exactly as
  a person would. No mail server: the welcome email fails in the background, which no test here looks at.
- **"is the garments template…"** checks the three promises of the table: one top-level group per type, every
  account in its top-level group's type, and the purpose where the template put it.
- **`edit()` sends the whole form**, like the app does, with one or two fields changed.
- **The audit test** checks that a move is logged with the groups' **codes**.
- **"lets two moves at the same time take turns"** — the race from 9.4, made certain instead of hoped for. A
  superuser transaction does what the service does for the first move (chart lock, `FOR UPDATE` on A), then the
  API is asked to move B under A, and only then does the first transaction update A. With the lock, the API
  waits and answers `account_parent_loop`. Without it, the two transactions deadlock and one gets aborted —
  checked: the test fails with a 500. A first version of this test updated A *before* starting the API request;
  it passed even without the lock (the row locks alone serialised that order) and so proved nothing. That is
  why the order in the test matters.
- **Archiving and deleting** run in order and build on each other: the bank account moved into "Mobile wallets"
  earlier is used to show "archive the children first", "restore the group first", "an archived group takes
  nothing new", and finally "delete an unused account, but not a group with accounts under it".
- **Permissions**: a member without roles reads the chart (200) but can't add (403, naming the permission).

### Tenant isolation

**File: `apps/api/src/accounts/accounts.tenant-leak.int.spec.ts`** (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type Account, accountListSchema, problemSchema, setupSchema } from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// Two workspaces with a chart each: A must never see, use or change B's accounts. Every answer is
// 404 or the same "invalid group" as for an id that does not exist — never a hint that it does.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let chartOfB: Account[];

function as(
  who: SignedIn,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload && { payload }),
  });
}

async function setUp(who: SignedIn, industry: 'garments' | 'pharma'): Promise<void> {
  expect((await as(who, 'POST', '/setup', { industry })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  tenantA = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  tenantB = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  await Promise.all([setUp(tenantA, 'garments'), setUp(tenantB, 'pharma')]);
  chartOfB = accountListSchema.parse((await as(tenantB, 'GET', '/accounts')).json()).items;
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function ofB(code: string): Account {
  const found = chartOfB.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code} in B`);
  return found;
}

describe('chart of accounts isolation over HTTP', () => {
  it("never lists or reads tenant B's accounts", async () => {
    const { items } = accountListSchema.parse((await as(tenantA, 'GET', '/accounts')).json());
    const idsOfB = new Set(chartOfB.map((account) => account.id));
    expect(items.some((account) => idsOfB.has(account.id))).toBe(false);
    // Garments' finished goods, not pharma's
    expect(items.find((account) => account.code === '1154')?.name).toBe('Finished garments');
    expect((await as(tenantA, 'GET', `/accounts/${ofB('1120').id}`)).statusCode).toBe(404);
  });

  it("cannot put an account under tenant B's group", async () => {
    const res = await as(tenantA, 'POST', '/accounts', {
      parentId: ofB('1120').id,
      code: '1129',
      name: 'Borrowed group',
      isGroup: false,
      description: '',
    });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('account_parent_invalid');
  });

  it("cannot edit, archive, restore or delete tenant B's account", async () => {
    const target = ofB('5330');
    const edit = {
      parentId: target.parentId,
      code: '5330',
      name: 'Taken over',
      description: '',
      version: 1,
    };
    expect((await as(tenantA, 'PUT', `/accounts/${target.id}`, edit)).statusCode).toBe(404);
    for (const action of ['archive', 'restore']) {
      const res = await as(tenantA, 'POST', `/accounts/${target.id}/${action}`, { version: 1 });
      expect(res.statusCode).toBe(404);
    }
    expect((await as(tenantA, 'DELETE', `/accounts/${target.id}?version=1`)).statusCode).toBe(404);

    const stillThere = accountListSchema.parse((await as(tenantB, 'GET', '/accounts')).json());
    expect(stillThere.items.find((account) => account.id === target.id)).toMatchObject({
      name: 'Medical promotion and samples',
      version: 1,
      archivedAt: null,
    });
  });
});
```

- Two workspaces of **different** industries: "1154" is "Finished garments" in A and "Finished goods" in B, so
  the first test also shows that A's list is A's chart, not just "not B's ids".
- "cannot put an account under tenant B's group" — the create path reads the parent by id; this is where a
  missing tenant filter would leak. The answer is the same `account_parent_invalid` as for an id that does not
  exist.
- Every write endpoint with B's id answers 404, and B's row is unchanged afterwards (`version: 1`).

### The setup tests

**File: `apps/api/src/setup/setup.int.spec.ts`** (change)

```diff
@@ -1,6 +1,7 @@
 import type { INestApplicationContext } from '@nestjs/common';
 import type { NestFastifyApplication } from '@nestjs/platform-fastify';
 import {
+  accountListSchema,
   auditPageSchema,
   meResponseSchema,
   notificationPageSchema,
@@ -27,7 +28,11 @@ import {
   type TestRedis,
 } from '../testing/containers.js';
 import { bearer, type SignedIn, signUp } from '../testing/http.js';
+import { accountCount } from '../testing/chart.js';
 import { lastMailTo } from '../testing/mailpit.js';
+import { INDUSTRY_TEMPLATES } from './templates.js';
+
+const GARMENTS_ACCOUNTS = accountCount(INDUSTRY_TEMPLATES.garments.chart);
 
 let pg: TestPostgres;
 let redis: TestRedis;
@@ -108,7 +113,7 @@ describe('sign-up', () => {
 });
 
 describe('starting the setup', () => {
-  it('answers with "provisioning" at once, then the worker makes the garments roles', async () => {
+  it('answers with "provisioning" at once, then the worker makes the roles and the chart', async () => {
     const res = await send('POST', '/setup', { industry: 'garments' });
     expect(res.statusCode).toBe(200);
     expect(setupSchema.parse(res.json())).toEqual({ status: 'provisioning', industry: 'garments' });
@@ -119,10 +124,15 @@ describe('starting the setup', () => {
     const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
     expect(items.map((role) => [role.name, role.permissions])).toEqual([
       ['Owner', expect.any(Array)],
-      ['Accountant', ['core.audit.read', 'core.user.read']],
+      ['Accountant', ['accounting.account.manage', 'core.audit.read', 'core.user.read']],
       ['Merchandiser', ['core.user.read']],
       ['Store keeper', []],
     ]);
+    const chart = accountListSchema.parse((await send('GET', '/accounts')).json());
+    expect(chart.items.find((account) => account.code === '4110')).toMatchObject({
+      name: 'Export sales',
+      purpose: 'sales',
+    });
   });
 
   it('writes the audit log as the system, with the request that started it', async () => {
@@ -138,7 +148,10 @@ describe('starting the setup', () => {
     expect(provisioned).toMatchObject({
       action: 'workspace.provisioned',
       actor: null,
-      changes: { roles: { from: null, to: 'Accountant, Merchandiser, Store keeper' } },
+      changes: {
+        roles: { from: null, to: 'Accountant, Merchandiser, Store keeper' },
+        accounts: { from: null, to: GARMENTS_ACCOUNTS },
+      },
     });
     // The worker ran in the context of the POST /setup request: one click, traced end to end
     expect(provisioned?.requestId).toBe(started?.requestId);
@@ -174,6 +187,8 @@ describe('starting the setup', () => {
 
     const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
     expect(items).toHaveLength(4);
+    const chart = accountListSchema.parse((await send('GET', '/accounts')).json());
+    expect(chart.items).toHaveLength(GARMENTS_ACCOUNTS);
     const bell = notificationPageSchema.parse((await send('GET', '/notifications')).json());
     expect(bell.items.filter((item) => item.type === 'workspace.ready')).toHaveLength(1);
   });
@@ -228,6 +243,21 @@ describe('when the setup job fails', () => {
     await superuserSql(
       (sql) => sql`UPDATE tenants SET industry = 'pharma' WHERE slug = 'karim-pharma'`,
     );
+    // Step 9's migration queues a chart for every workspace that is not 'pending' — this failed
+    // one too. Its chart arrives before the retry, so the retried setup job must leave it alone.
+    await superuserSql(
+      (sql) => sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
+                   SELECT gen_random_uuid(), id, 'workspace.chart_requested', '{}'::jsonb
+                   FROM tenants WHERE slug = 'karim-pharma'`,
+    );
+    const pharmaAccounts = accountCount(INDUSTRY_TEMPLATES.pharma.chart);
+    await eventually(async () => {
+      const chart = accountListSchema.parse(
+        (await send('GET', '/accounts', undefined, pharmaOwner)).json(),
+      );
+      expect(chart.items).toHaveLength(pharmaAccounts);
+    });
+
     const retried = await send('POST', '/setup/retry', undefined, pharmaOwner);
     expect(setupSchema.parse(retried.json())).toEqual({
       status: 'provisioning',
@@ -252,6 +282,18 @@ describe('when the setup job fails', () => {
       description: 'Our own',
       permissions: [],
     });
+    // Still one chart, and the setup's audit row says it added none
+    const chart = accountListSchema.parse(
+      (await send('GET', '/accounts', undefined, pharmaOwner)).json(),
+    );
+    expect(chart.items).toHaveLength(pharmaAccounts);
+    const log = auditPageSchema.parse(
+      (await send('GET', '/audit-logs?entityType=workspace', undefined, pharmaOwner)).json(),
+    );
+    expect(log.items.find((entry) => entry.action === 'workspace.provisioned')?.changes).toEqual({
+      industry: { from: null, to: 'pharma' },
+      roles: { from: null, to: 'Accountant, Sales representative' },
+    });
   });
 
   it('refuses a retry when nothing failed', async () => {
@@ -260,3 +302,66 @@ describe('when the setup job fails', () => {
     expect(problemSchema.parse(res.json()).code).toBe('setup_not_failed');
   });
 });
+
+// Migration 0014 queues one 'workspace.chart_requested' per workspace that was set up before
+// step 9. Here the same row is written by hand for a workspace that looks like one from before
+// step 8: set up, but with no business type.
+describe('a workspace set up before the chart of accounts', () => {
+  let oldOwner: SignedIn;
+
+  beforeAll(async () => {
+    oldOwner = await signUp(app, {
+      companyName: 'Hossain Traders',
+      workspaceSlug: 'hossain-traders',
+      fullName: 'Anwar Hossain',
+      email: 'anwar@hossaintraders.com',
+      password: 'Moulvibazar-2026',
+    });
+    await superuserSql(
+      (sql) => sql`UPDATE tenants SET setup_status = 'ready' WHERE slug = 'hossain-traders'`,
+    );
+  });
+
+  async function requestChart(): Promise<void> {
+    await superuserSql(
+      (sql) => sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
+                   SELECT gen_random_uuid(), id, 'workspace.chart_requested', '{}'::jsonb
+                   FROM tenants WHERE slug = 'hossain-traders'`,
+    );
+  }
+
+  async function accounts() {
+    return accountListSchema.parse((await send('GET', '/accounts', undefined, oldOwner)).json())
+      .items;
+  }
+
+  it('gets the general chart from the worker, logged as the system', async () => {
+    expect(await accounts()).toEqual([]);
+    await requestChart();
+    const general = accountCount(INDUSTRY_TEMPLATES.other.chart);
+    await eventually(async () => {
+      expect(await accounts()).toHaveLength(general);
+    });
+
+    const { items } = auditPageSchema.parse(
+      (await send('GET', '/audit-logs?entityType=workspace', undefined, oldOwner)).json(),
+    );
+    expect(items[0]).toMatchObject({
+      action: 'workspace.chart_created',
+      actor: null,
+      changes: { industry: { from: null, to: 'other' }, accounts: { from: null, to: general } },
+    });
+  });
+
+  it('adds nothing when the event comes again', async () => {
+    const before = await accounts();
+    await requestChart();
+    await eventually(() => unpublished(0));
+    await new Promise((resolve) => setTimeout(resolve, 500));
+    expect(await accounts()).toHaveLength(before.length);
+    const { items } = auditPageSchema.parse(
+      (await send('GET', '/audit-logs?entityType=workspace', undefined, oldOwner)).json(),
+    );
+    expect(items.filter((entry) => entry.action === 'workspace.chart_created')).toHaveLength(1);
+  });
+});
```

- **The Accountant's new permission**, and the garments chart's "Export sales" with the `sales` purpose.
- **The audit row** now counts the accounts.
- **"ignores the same event published twice"** also checks that the chart was not made twice.
- **The failed-setup test gets the backfill in the middle** — the case from 9.3: 0014 queues a chart for a
  failed workspace, the chart arrives, then the owner presses "Try again". The retry must finish (`ready`),
  leave the chart as it is, and log `accounts` as nothing added (the `toEqual` has no `accounts` key, because
  `created()` drops a value that is null before and after). Without the "already has a chart" check in
  `seedChart()`, the retry would fail on the unique code index — checked.
- **The new `describe`** plays migration 0014 for one workspace that looks like a pre-step-8 one (`ready`, no
  business type): the general chart arrives, logged by System as `workspace.chart_created`; a second event
  adds nothing and no second audit row.

---

## 9.6 — `packages/i18n`: the texts

**File: `packages/i18n/src/locales/en.ts`** (change)

```diff
@@ -42,6 +42,8 @@ export const en = {
     auditLog: 'Audit log',
     team: 'Team',
     roles: 'Roles',
+    accounting: 'Accounting',
+    chartOfAccounts: 'Chart of accounts',
   },
   auth: {
     workspace: 'Workspace',
@@ -189,6 +191,86 @@ export const en = {
       'Ask a workspace owner for the core.branch.manage permission to add or change branches.',
     loadFailed: "Couldn't load the branches. Refresh the page to try again.",
   },
+  accounts: {
+    title: 'Chart of accounts',
+    description: 'The groups and accounts your books are kept in',
+    add: 'Add account',
+    searchLabel: 'Search accounts',
+    searchPlaceholder: 'Code or name, like 1140 or VAT',
+    showArchived: 'Show archived',
+    expandAll: 'Expand all',
+    collapseAll: 'Collapse all',
+    expand: 'Show the accounts in {{name}}',
+    collapse: 'Hide the accounts in {{name}}',
+    addTo: 'Add an account to {{name}}',
+    types: {
+      asset: 'Asset',
+      liability: 'Liability',
+      equity: 'Equity',
+      income: 'Income',
+      expense: 'Expense',
+    },
+    balances: {
+      debit: 'grows with a debit',
+      credit: 'grows with a credit',
+    },
+    kinds: {
+      ledger: 'Ledger',
+      group: 'Group',
+    },
+    kindHints: {
+      ledger: 'Entries post to it, like a bank account or an expense.',
+      group: 'Holds other accounts, like "Bank accounts". Nothing posts to it.',
+    },
+    system: 'System',
+    archived: 'Archived',
+    noMatchTitle: 'No account matches "{{query}}"',
+    noMatchBody: 'Search by code, like 1140, or by a word of the name, like receivable.',
+    emptyTitle: 'Your chart of accounts is on its way',
+    emptyBody: 'It is created with the workspace setup and shows up here in a few seconds.',
+    newTitle: 'Add account',
+    editTitle: 'Edit {{code}}',
+    parent: 'Group',
+    parentPlaceholder: 'Pick a group',
+    kind: 'Kind',
+    code: 'Code',
+    codeHint: 'Digits, like 1121. Dots or hyphens may split them.',
+    name: 'Name',
+    namePlaceholder: 'Dutch-Bangla Bank CD A/C 1234',
+    about: 'Description',
+    aboutPlaceholder: 'Main collection account for export proceeds',
+    typeLine: '{{type}} · {{balance}}',
+    topLevel: 'A top-level group. It always stays at the top of the chart.',
+    systemHint:
+      'Omnivo posts {{purpose}} to this account by itself. You can rename or move it, but not archive or delete it.',
+    // What the system posts to each purpose's account. Missing a purpose here does not type-check.
+    purposes: {
+      cash: 'cash sales and payments',
+      accounts_receivable: 'what customers owe',
+      inventory: 'the value of stock',
+      vat_input: 'VAT paid on purchases',
+      accounts_payable: 'what suppliers are owed',
+      vat_output: 'VAT charged on sales',
+      opening_balance_equity: 'the other side of opening balances',
+      retained_earnings: 'the profit of closed years',
+      sales: 'sales',
+      cost_of_goods_sold: 'the cost of goods sold',
+    },
+    archive: 'Archive',
+    restore: 'Restore',
+    delete: 'Delete',
+    confirmDelete: 'Delete {{code}}',
+    deleteWarning:
+      'This cannot be undone. Only an account with nothing under it can be deleted; archive the others.',
+    created: '{{name}} added',
+    updated: 'Changes to {{name}} saved',
+    archivedToast: '{{name}} archived',
+    restoredToast: '{{name}} restored',
+    deleted: '{{name}} deleted',
+    readOnly:
+      'Ask a workspace owner for the accounting.account.manage permission to change the chart.',
+    loadFailed: "Couldn't load the chart of accounts. Refresh the page to try again.",
+  },
   team: {
     title: 'Team',
     description: 'People with access to this workspace, and the roles they have',
@@ -253,6 +335,7 @@ export const en = {
     groups: {
       team: 'Team',
       workspace: 'Workspace',
+      accounting: 'Accounting',
     },
     members_one: '{{count}} person',
     members_other: '{{count}} people',
@@ -294,6 +377,9 @@ export const en = {
       branch: { manage: 'Add, edit and archive branches' },
       audit: { read: 'See the audit log' },
     },
+    accounting: {
+      account: { manage: 'Add, change, archive and delete accounts' },
+    },
   },
   invite: {
     checking: 'Checking your invitation…',
@@ -328,6 +414,7 @@ export const en = {
       member: 'Team',
       invitation: 'Invitations',
       role: 'Roles',
+      account: 'Chart of accounts',
     },
     columns: {
       when: 'When',
@@ -347,7 +434,8 @@ export const en = {
       workspace: {
         created: 'Created the workspace',
         setup_started: 'Started the workspace setup',
-        provisioned: 'Added the starting roles',
+        provisioned: 'Added the starting roles and chart of accounts',
+        chart_created: 'Added the chart of accounts',
       },
       auth: { signed_in: 'Signed in', switched_in: 'Switched into this workspace' },
       settings: { updated: 'Changed the settings', logo_changed: 'Changed the logo' },
@@ -372,6 +460,13 @@ export const en = {
         deleted: 'Deleted a role',
         permissions_changed: "Changed a role's permissions",
       },
+      account: {
+        created: 'Added an account',
+        updated: 'Edited an account',
+        archived: 'Archived an account',
+        restored: 'Restored an account',
+        deleted: 'Deleted an account',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -394,6 +489,8 @@ export const en = {
       roles: 'Roles',
       description: 'Description',
       industry: 'Business type',
+      parent: 'Group',
+      accounts: 'Accounts',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -413,7 +510,7 @@ export const en = {
     business: {
       title: 'What does {{company}} do?',
       subtitle:
-        'We start you with the roles such a company usually needs. You can rename or change them any time.',
+        'We start you with the roles and the chart of accounts such a company usually needs. You can change them any time.',
       label: 'Business type',
     },
     industries: {
@@ -435,8 +532,9 @@ export const en = {
     team: {
       title: 'Invite your team',
       subtitle: 'Add your accountant and managers now, or later from the Team page.',
-      preparing: 'Preparing the roles for {{industry}}…',
-      ready: 'Roles ready: {{roles}}',
+      preparing: 'Preparing the roles and chart of accounts for {{industry}}…',
+      ready_one: 'Roles ready: {{roles}}. Chart of accounts: {{count}} account.',
+      ready_other: 'Roles ready: {{roles}}. Chart of accounts: {{count}} accounts.',
       failed: "The setup didn't finish. Try again — nothing you entered is lost.",
       retry: 'Try again',
       invite: 'Invite people',
@@ -455,7 +553,10 @@ export const en = {
     // type → text. The type's dot nests in i18next, so t(`notifications.types.${type}`) lands here;
     // a type without text here does not type-check
     types: {
-      workspace: { ready: 'Your workspace is set up. The starting roles are ready to use.' },
+      workspace: {
+        ready:
+          'Your workspace is set up. The starting roles and chart of accounts are ready to use.',
+      },
       member: { joined: '{{name}} joined the workspace' },
       invitation: {
         failed: "The invitation email to {{email}} couldn't be sent. Resend it from the Team page.",
@@ -520,6 +621,17 @@ export const en = {
       'Someone has this role or an open invitation gives it. Change their roles or cancel the invitation first.',
     setup_started: 'The setup has already started. Reload the page to see how far it is.',
     setup_not_failed: "The setup hasn't failed. Reload the page to see how far it is.",
+    account_code_format: 'Use digits, like 1121. Dots or hyphens may split them, like 1-1-21.',
+    account_code_taken: 'Another account already uses this code. Pick a different one.',
+    account_name_required: 'Enter the account name.',
+    account_parent_required: 'Pick the group this account goes under.',
+    account_parent_invalid: 'Pick an active group of the same type from the list.',
+    account_parent_loop: "A group can't go under one of its own accounts. Pick a group outside it.",
+    account_parent_archived: 'The group above this account is archived. Restore the group first.',
+    account_locked:
+      "Top-level groups and system accounts can't be archived or deleted. You can rename them.",
+    account_has_children: 'Move or delete the accounts under this group first.',
+    account_has_active_children: 'Archive the accounts under this group first.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- **Write these first.** Until the new permission, error codes, audit actions and entity type have English
  texts, `pnpm typecheck` fails in `en.ts` (the `satisfies Record<ErrorCode, string>`) and in the app (the
  typed `t()` keys). The compiler is the to-do list.
- **`accounts.about`, not `accounts.description`** for the field label: `description` is already the page's
  subtitle, and an object can't have the key twice (the build says "multiple properties with the same name").
  The roles section solved the same clash with `about`.
- **`accounts.purposes.*`** — one phrase per purpose, used inside "Omnivo posts {{purpose}} to this account by
  itself". The app only looks one up after `isAccountPurpose()`, so an unknown purpose from a newer server
  never reaches `t()`.
- **`onboarding.team.ready_one` / `ready_other`** — the sentence now has a count, so i18next picks the plural
  form from `count`. `t('onboarding.team.ready', { count, roles })` still type-checks with the base key.
- **`audit.fields.parent` / `accounts`** — the column names in the audit viewer ("Group: 1120 → 1130").
- The error texts say what to do, as CLAUDE.md asks: not "invalid parent" but "Pick an active group of the same
  type from the list".

**File: `packages/i18n/src/locales/bn.ts`** (change)

```diff
@@ -42,6 +42,8 @@ export const bn: Messages = {
     auditLog: 'অডিট লগ',
     team: 'টিম',
     roles: 'রোল',
+    accounting: 'হিসাবরক্ষণ',
+    chartOfAccounts: 'চার্ট অফ অ্যাকাউন্টস',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -188,6 +190,84 @@ export const bn: Messages = {
     readOnly: 'ব্রাঞ্চ যোগ বা বদল করতে ওয়ার্কস্পেস মালিকের কাছে core.branch.manage অনুমতি চান।',
     loadFailed: 'ব্রাঞ্চের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  accounts: {
+    title: 'চার্ট অফ অ্যাকাউন্টস',
+    description: 'যে গ্রুপ আর অ্যাকাউন্টে আপনার হিসাবের খাতা রাখা হয়',
+    add: 'অ্যাকাউন্ট যোগ করুন',
+    searchLabel: 'অ্যাকাউন্ট খুঁজুন',
+    searchPlaceholder: 'কোড বা নাম, যেমন 1140 বা VAT',
+    showArchived: 'আর্কাইভ করাগুলোও দেখান',
+    expandAll: 'সব খুলুন',
+    collapseAll: 'সব বন্ধ করুন',
+    expand: '{{name}}-এর অ্যাকাউন্টগুলো দেখান',
+    collapse: '{{name}}-এর অ্যাকাউন্টগুলো লুকান',
+    addTo: '{{name}}-এ অ্যাকাউন্ট যোগ করুন',
+    types: {
+      asset: 'সম্পদ',
+      liability: 'দায়',
+      equity: 'মালিকানা স্বত্ব',
+      income: 'আয়',
+      expense: 'ব্যয়',
+    },
+    balances: {
+      debit: 'ডেবিটে বাড়ে',
+      credit: 'ক্রেডিটে বাড়ে',
+    },
+    kinds: {
+      ledger: 'লেজার',
+      group: 'গ্রুপ',
+    },
+    kindHints: {
+      ledger: 'এন্ট্রি এখানে পোস্ট হয়, যেমন ব্যাংক অ্যাকাউন্ট বা কোনো খরচ।',
+      group: 'অন্য অ্যাকাউন্ট ধরে রাখে, যেমন "Bank accounts"। এখানে কিছু পোস্ট হয় না।',
+    },
+    system: 'সিস্টেম',
+    archived: 'আর্কাইভ করা',
+    noMatchTitle: '"{{query}}"-এর সাথে কোনো অ্যাকাউন্ট মেলেনি',
+    noMatchBody: 'কোড (যেমন 1140) বা নামের একটা শব্দ (যেমন receivable) দিয়ে খুঁজুন।',
+    emptyTitle: 'আপনার চার্ট অফ অ্যাকাউন্টস তৈরি হচ্ছে',
+    emptyBody: 'ওয়ার্কস্পেসের সেটআপের সাথে এটা তৈরি হয়, কয়েক সেকেন্ডের মধ্যে এখানে দেখা যাবে।',
+    newTitle: 'অ্যাকাউন্ট যোগ করুন',
+    editTitle: '{{code}} বদলান',
+    parent: 'গ্রুপ',
+    parentPlaceholder: 'একটা গ্রুপ বাছুন',
+    kind: 'ধরন',
+    code: 'কোড',
+    codeHint: 'সংখ্যা, যেমন 1121। মাঝে ডট বা হাইফেন দেওয়া যায়।',
+    name: 'নাম',
+    namePlaceholder: 'Dutch-Bangla Bank CD A/C 1234',
+    about: 'বিবরণ',
+    aboutPlaceholder: 'রপ্তানির টাকা জমা হওয়ার মূল অ্যাকাউন্ট',
+    typeLine: '{{type}} · {{balance}}',
+    topLevel: 'সবার উপরের গ্রুপ। এটা সবসময় চার্টের শীর্ষেই থাকে।',
+    systemHint:
+      'Omnivo নিজে থেকে এই অ্যাকাউন্টে {{purpose}} পোস্ট করে। নাম বদলানো বা সরানো যায়, কিন্তু আর্কাইভ বা মোছা যায় না।',
+    purposes: {
+      cash: 'নগদ বিক্রি আর পেমেন্ট',
+      accounts_receivable: 'গ্রাহকদের কাছে পাওনা',
+      inventory: 'স্টকের মূল্য',
+      vat_input: 'কেনাকাটায় দেওয়া VAT',
+      accounts_payable: 'সাপ্লায়ারদের দেনা',
+      vat_output: 'বিক্রিতে নেওয়া VAT',
+      opening_balance_equity: 'শুরুর ব্যালেন্সের অপর দিক',
+      retained_earnings: 'বন্ধ হওয়া বছরগুলোর মুনাফা',
+      sales: 'বিক্রি',
+      cost_of_goods_sold: 'বিক্রীত পণ্যের খরচ',
+    },
+    archive: 'আর্কাইভ করুন',
+    restore: 'ফিরিয়ে আনুন',
+    delete: 'মুছুন',
+    confirmDelete: '{{code}} মুছুন',
+    deleteWarning:
+      'এটা আর ফেরানো যাবে না। শুধু যে অ্যাকাউন্টের নিচে কিছু নেই সেটাই মোছা যায়; বাকিগুলো আর্কাইভ করুন।',
+    created: '{{name}} যোগ হয়েছে',
+    updated: '{{name}}-এর পরিবর্তন সেভ হয়েছে',
+    archivedToast: '{{name}} আর্কাইভ হয়েছে',
+    restoredToast: '{{name}} ফিরিয়ে আনা হয়েছে',
+    deleted: '{{name}} মোছা হয়েছে',
+    readOnly: 'চার্ট বদলাতে ওয়ার্কস্পেস মালিকের কাছে accounting.account.manage অনুমতি চান।',
+    loadFailed: 'চার্ট অফ অ্যাকাউন্টস আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   team: {
     title: 'টিম',
     description: 'এই ওয়ার্কস্পেসে যাঁদের অ্যাক্সেস আছে, আর তাঁদের রোল',
@@ -252,6 +332,7 @@ export const bn: Messages = {
     groups: {
       team: 'টিম',
       workspace: 'ওয়ার্কস্পেস',
+      accounting: 'হিসাবরক্ষণ',
     },
     members_one: '{{count}} জন',
     members_other: '{{count}} জন',
@@ -291,6 +372,9 @@ export const bn: Messages = {
       branch: { manage: 'ব্রাঞ্চ যোগ, বদল আর আর্কাইভ' },
       audit: { read: 'অডিট লগ দেখা' },
     },
+    accounting: {
+      account: { manage: 'অ্যাকাউন্ট যোগ, বদল, আর্কাইভ আর মোছা' },
+    },
   },
   invite: {
     checking: 'আপনার আমন্ত্রণ দেখা হচ্ছে…',
@@ -325,6 +409,7 @@ export const bn: Messages = {
       member: 'টিম',
       invitation: 'আমন্ত্রণ',
       role: 'রোল',
+      account: 'চার্ট অফ অ্যাকাউন্টস',
     },
     columns: {
       when: 'কখন',
@@ -342,7 +427,8 @@ export const bn: Messages = {
       workspace: {
         created: 'ওয়ার্কস্পেস তৈরি করেছেন',
         setup_started: 'ওয়ার্কস্পেসের সেটআপ শুরু করেছেন',
-        provisioned: 'শুরুর রোলগুলো যোগ করেছে',
+        provisioned: 'শুরুর রোল আর চার্ট অফ অ্যাকাউন্টস যোগ করেছে',
+        chart_created: 'চার্ট অফ অ্যাকাউন্টস যোগ করেছে',
       },
       auth: { signed_in: 'সাইন ইন করেছেন', switched_in: 'এই ওয়ার্কস্পেসে এসেছেন' },
       settings: { updated: 'সেটিংস বদলেছেন', logo_changed: 'লোগো বদলেছেন' },
@@ -367,6 +453,13 @@ export const bn: Messages = {
         deleted: 'রোল মুছেছেন',
         permissions_changed: 'রোলের অনুমতি বদলেছেন',
       },
+      account: {
+        created: 'অ্যাকাউন্ট যোগ করেছেন',
+        updated: 'অ্যাকাউন্ট বদলেছেন',
+        archived: 'অ্যাকাউন্ট আর্কাইভ করেছেন',
+        restored: 'অ্যাকাউন্ট ফিরিয়ে এনেছেন',
+        deleted: 'অ্যাকাউন্ট মুছেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -388,6 +481,8 @@ export const bn: Messages = {
       roles: 'রোল',
       description: 'বিবরণ',
       industry: 'ব্যবসার ধরন',
+      parent: 'গ্রুপ',
+      accounts: 'অ্যাকাউন্ট',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -407,7 +502,7 @@ export const bn: Messages = {
     business: {
       title: '{{company}} কী করে?',
       subtitle:
-        'এমন কোম্পানিতে সাধারণত যে রোলগুলো লাগে, সেগুলো দিয়ে শুরু করা হবে। পরে যেকোনো সময় নাম বা অনুমতি বদলানো যায়।',
+        'এমন কোম্পানিতে সাধারণত যে রোল আর চার্ট অফ অ্যাকাউন্টস লাগে, সেগুলো দিয়ে শুরু করা হবে। পরে যেকোনো সময় বদলানো যায়।',
       label: 'ব্যবসার ধরন',
     },
     industries: {
@@ -429,8 +524,9 @@ export const bn: Messages = {
     team: {
       title: 'টিমকে ডাকুন',
       subtitle: 'আপনার অ্যাকাউন্ট্যান্ট আর ম্যানেজারদের এখনই যোগ করুন, অথবা পরে Team পেজ থেকে।',
-      preparing: '{{industry}}-এর রোলগুলো তৈরি হচ্ছে…',
-      ready: 'রোল তৈরি: {{roles}}',
+      preparing: '{{industry}}-এর রোল আর চার্ট অফ অ্যাকাউন্টস তৈরি হচ্ছে…',
+      ready_one: 'রোল তৈরি: {{roles}}। চার্ট অফ অ্যাকাউন্টস: {{count}}টা অ্যাকাউন্ট।',
+      ready_other: 'রোল তৈরি: {{roles}}। চার্ট অফ অ্যাকাউন্টস: {{count}}টা অ্যাকাউন্ট।',
       failed: 'সেটআপ শেষ হয়নি। আবার চেষ্টা করুন — আপনার দেওয়া কোনো তথ্য হারায়নি।',
       retry: 'আবার চেষ্টা করুন',
       invite: 'আমন্ত্রণ পাঠান',
@@ -446,7 +542,10 @@ export const bn: Messages = {
     emptyBody: 'আপনার আমন্ত্রণে কেউ যোগ দিলে, বা কোনো ইমেইল পাঠানো না গেলে এখানে জানতে পারবেন।',
     loadFailed: 'নোটিফিকেশন আনা যায়নি। একটু পরে আবার চেষ্টা করুন।',
     types: {
-      workspace: { ready: 'আপনার ওয়ার্কস্পেস সেটআপ হয়ে গেছে। শুরুর রোলগুলো ব্যবহার করা যাবে।' },
+      workspace: {
+        ready:
+          'আপনার ওয়ার্কস্পেস সেটআপ হয়ে গেছে। শুরুর রোল আর চার্ট অফ অ্যাকাউন্টস ব্যবহার করা যাবে।',
+      },
       member: { joined: '{{name}} ওয়ার্কস্পেসে যোগ দিয়েছেন' },
       invitation: {
         failed: '{{email}}-এ আমন্ত্রণের ইমেইল পাঠানো যায়নি। Team পেজ থেকে আবার পাঠান।',
@@ -509,6 +608,18 @@ export const bn: Messages = {
       'এই রোল কারো আছে, বা কোনো খোলা আমন্ত্রণে আছে। আগে তাঁদের রোল বদলান বা আমন্ত্রণ বাতিল করুন।',
     setup_started: 'সেটআপ আগেই শুরু হয়েছে। কতদূর হলো দেখতে পেজটা রিলোড করুন।',
     setup_not_failed: 'সেটআপ ব্যর্থ হয়নি। কতদূর হলো দেখতে পেজটা রিলোড করুন।',
+    account_code_format: 'সংখ্যা দিন, যেমন 1121। মাঝে ডট বা হাইফেন দেওয়া যায়, যেমন 1-1-21।',
+    account_code_taken: 'এই কোড আরেকটা অ্যাকাউন্টে আছে। অন্য কোড দিন।',
+    account_name_required: 'অ্যাকাউন্টের নাম লিখুন।',
+    account_parent_required: 'অ্যাকাউন্টটা কোন গ্রুপের নিচে যাবে, বাছুন।',
+    account_parent_invalid: 'তালিকা থেকে একই ধরনের একটা চালু গ্রুপ বাছুন।',
+    account_parent_loop:
+      'কোনো গ্রুপ তার নিজের অ্যাকাউন্টের নিচে যেতে পারে না। এর বাইরের একটা গ্রুপ বাছুন।',
+    account_parent_archived: 'এই অ্যাকাউন্টের উপরের গ্রুপটা আর্কাইভ করা। আগে গ্রুপটা ফিরিয়ে আনুন।',
+    account_locked:
+      'সবার উপরের গ্রুপ আর সিস্টেম অ্যাকাউন্ট আর্কাইভ বা মোছা যায় না। নাম বদলানো যায়।',
+    account_has_children: 'আগে এই গ্রুপের নিচের অ্যাকাউন্টগুলো সরান বা মুছুন।',
+    account_has_active_children: 'আগে এই গ্রুপের নিচের অ্যাকাউন্টগুলো আর্কাইভ করুন।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

- "Chart of accounts" is written as **চার্ট অফ অ্যাকাউন্টস**, like ব্রাঞ্চ, রোল and অডিট লগ elsewhere in
  this file: the term accountants use, in Bangla letters. "Ledger" and "Group" are **লেজার** and **গ্রুপ** —
  the Tally words.
- The type names are the usual Bangla accounting words: সম্পদ, দায়, মালিকানা স্বত্ব, আয়, ব্যয়.
- Ask a Bangla-speaking accountant to read this block once (see "Not checked").

---

## 9.7 — `packages/ui`: a tree, and a field that keeps to its column

### Tree helpers

**File: `packages/ui/src/lib/tree.ts`** (new)

```ts
// A flat list with parent ids → a tree, for TreeList. Pure functions, so they are tested alone
// (tree.spec.ts) and any app list with a parent (accounts now, product categories in step 12) can
// use them.
export interface TreeNode<T> {
  id: string;
  item: T;
  children: TreeNode<T>[];
}

interface TreeKeys<T> {
  id: (item: T) => string;
  parentId: (item: T) => string | null;
  // The order of siblings
  compare: (a: T, b: T) => number;
}

export function buildTree<T>(items: readonly T[], keys: TreeKeys<T>): TreeNode<T>[] {
  // Map<…, TreeNode<T>>: the type makes `children: []` a list of nodes — no cast needed
  const nodes = new Map<string, TreeNode<T>>(
    items.map((item) => [keys.id(item), { id: keys.id(item), item, children: [] }]),
  );
  const roots: TreeNode<T>[] = [];
  for (const node of nodes.values()) {
    const parentId = keys.parentId(node.item);
    const parent = parentId === null ? undefined : nodes.get(parentId);
    // A parent that is not in the list (filtered out) makes the node a root: nothing the caller
    // passed in ever disappears silently
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: TreeNode<T>[]): TreeNode<T>[] => {
    list.sort((a, b) => keys.compare(a.item, b.item));
    for (const node of list) sort(node.children);
    return list;
  };
  return sort(roots);
}

// Keeps a node when it matches or when something under it does — a search result stays inside
// its groups, so you still see where it sits. A kept group keeps only its kept children.
export function filterTree<T>(
  nodes: readonly TreeNode<T>[],
  keep: (item: T) => boolean,
): TreeNode<T>[] {
  return nodes.flatMap((node) => {
    const children = filterTree(node.children, keep);
    return keep(node.item) || children.length > 0 ? [{ ...node, children }] : [];
  });
}

// Every node, parents before their children — the order the tree shows them in
export function flattenTree<T>(
  nodes: readonly TreeNode<T>[],
  depth = 0,
): { node: TreeNode<T>; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children, depth + 1)]);
}
```

- **Generic, with the keys passed in** (`id`, `parentId`, `compare`): the accounts tree now, product categories
  in step 12, without knowing either type.
- **`new Map<string, TreeNode<T>>(…)`** — typing the map makes `children: []` a list of nodes. Without it,
  TypeScript infers `never[]`, and the quick fix would be `[] as TreeNode<T>[]` — a cast, which CLAUDE.md asks
  to avoid when a type annotation does the job.
- **One pass to link, one to sort.** First every node goes into its parent's `children` (any input order works:
  a child before its parent is fine, because all nodes exist in the map before linking). Then each sibling list
  is sorted once.
- **A node whose parent is missing becomes a top-level node.** The page filters archived accounts out before
  building the tree; if that ever left an orphan, it would show at the top instead of vanishing silently.
- **`filterTree`** keeps a match **and the groups above it**: searching "VAT" shows "Input VAT" inside "Current
  assets" inside "Assets", so you see where it lives.
- **`flattenTree`** — the tree in display order with each node's depth: the group `<select>` uses it.

**File: `packages/ui/src/lib/tree.spec.ts`** (new)

```ts
import { describe, expect, it } from 'vitest';

import { buildTree, filterTree, flattenTree } from './tree.js';

interface Row {
  id: string;
  parentId: string | null;
  code: string;
}

const keys = {
  id: (row: Row) => row.id,
  parentId: (row: Row) => row.parentId,
  compare: (a: Row, b: Row) => a.code.localeCompare(b.code),
};

// Out of order on purpose: children before parents, siblings unsorted
const rows: Row[] = [
  { id: 'bank', parentId: 'current', code: '1120' },
  { id: 'cash', parentId: 'current', code: '1110' },
  { id: 'current', parentId: 'assets', code: '1100' },
  { id: 'assets', parentId: null, code: '1000' },
  { id: 'lost', parentId: 'missing', code: '9000' },
];

function codes(nodes: ReturnType<typeof buildTree<Row>>): string[] {
  return flattenTree(nodes).map(({ node, depth }) => `${'-'.repeat(depth)}${node.item.code}`);
}

describe('buildTree', () => {
  it('nests by parent and sorts siblings, whatever the input order', () => {
    expect(codes(buildTree(rows, keys))).toEqual(['1000', '-1100', '--1110', '--1120', '9000']);
  });

  it('puts a node whose parent is not in the list at the top, not nowhere', () => {
    expect(buildTree(rows, keys).map((node) => node.id)).toContain('lost');
  });
});

describe('filterTree', () => {
  it('keeps a match together with the groups above it, and drops its siblings', () => {
    const tree = buildTree(rows, keys);
    expect(codes(filterTree(tree, (row) => row.code === '1120'))).toEqual([
      '1000',
      '-1100',
      '--1120',
    ]);
  });
});
```

### The component

**File: `packages/ui/src/components/tree-list.tsx`** (new)

```tsx
import { ArrowDown01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type ReactNode, useId } from 'react';

import type { TreeNode } from '../lib/tree.js';

interface TreeListProps<T> {
  // The list's name for screen readers
  label: string;
  nodes: readonly TreeNode<T>[];
  // The caller keeps the open/closed state, so it can open everything while a search is on
  isOpen: (id: string) => boolean;
  onToggle: (id: string) => void;
  // Everything right of the arrow: code, name, pills, buttons
  renderRow: (item: T) => ReactNode;
  // The arrow's label, like "Show the accounts in Current assets"
  toggleLabel: (item: T, open: boolean) => string;
}

type BranchProps<T> = Omit<TreeListProps<T>, 'label' | 'nodes'> & {
  node: TreeNode<T>;
  depth: number;
};

// CLAUDE.md → Tree list. Nested lists with one show/hide button per group (the WAI-ARIA
// "disclosure" pattern), not role="tree": a real tree widget needs arrow-key focus handling
// written by hand, while lists and buttons work with Tab, Enter and every screen reader as they
// are. Not virtualized: a chart of accounts is a few hundred rows, and closed groups render nothing.
export function TreeList<T>({ label, nodes, ...branch }: TreeListProps<T>) {
  return (
    // The first row of the card has no rule above it; every other row does
    <ul
      aria-label={label}
      className="rounded-card border border-line bg-surface shadow-sm [&>li:first-child>div]:border-t-0"
    >
      {nodes.map((node) => (
        <TreeBranch key={node.id} node={node} depth={0} {...branch} />
      ))}
    </ul>
  );
}

function TreeBranch<T>({ node, depth, isOpen, onToggle, renderRow, toggleLabel }: BranchProps<T>) {
  const listId = useId();
  const hasChildren = node.children.length > 0;
  const open = hasChildren && isOpen(node.id);
  return (
    <li>
      {/* group/row: renderRow's content can react to the row's hover (group-hover/row:…) */}
      <div className="group/row flex min-h-11 items-center gap-1 border-t border-line px-2 py-1.5 transition-colors duration-150 hover:bg-subtle sm:px-4">
        {/* 16px per level. A spacer, not padding on the row: the rule above spans the full width */}
        <span aria-hidden="true" className="shrink-0" style={{ width: depth * 16 }} />
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={open}
            // Points at the list only while it exists
            aria-controls={open ? listId : undefined}
            aria-label={toggleLabel(node.item, open)}
            onClick={() => {
              onToggle(node.id);
            }}
            className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors duration-150 hover:text-ink"
          >
            {/* Two icons, not a rotated one: CLAUDE.md allows no transform animation */}
            <HugeiconsIcon
              icon={open ? ArrowDown01Icon : ArrowRight01Icon}
              size={16}
              strokeWidth={1.5}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="size-7 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2.5">{renderRow(node.item)}</div>
      </div>
      {open && (
        <ul id={listId}>
          {node.children.map((child) => (
            <TreeBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              isOpen={isOpen}
              onToggle={onToggle}
              renderRow={renderRow}
              toggleLabel={toggleLabel}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
```

- **Decision 11: disclosure buttons in nested lists.** Each group's arrow is a real `<button>` with
  `aria-expanded`, and `aria-controls` pointing at its child list while that list exists. Screen readers say
  "Show the accounts in Current assets, button, expanded". Tab moves through the arrows and the names.
- **The caller owns the open state** (`isOpen`, `onToggle`). The page needs that: while a search is on, every
  group on the way to a match must be open, whatever the person closed before.
- **Closed groups render nothing.** No virtualizer: a few hundred rows render fast, and a closed group's rows
  are simply not in the DOM.
- **Two icons instead of a rotated one.** CLAUDE.md allows transitions on colour, border and shadow only — no
  transform animations.
- **The indent is a spacer `<span>` of `depth × 16px`**, not padding on the row. The row's top rule then still
  runs the full width of the card, as in a table. A spacer also keeps the arrow column aligned for ledgers,
  which get an empty 28px box where a group has its arrow.
- **`group/row`** — a named Tailwind group, so content in `renderRow` can react to the row's hover
  (`group-hover/row:`). The page uses it for the "+" button.
- **`[&>li:first-child>div]:border-t-0`** — every row has a top rule except the very first one in the card;
  nested rows keep theirs.
- **`min-h-11`** — 44px rows: CLAUDE.md's table row height, and a good touch target on a phone.

**File: `packages/ui/src/index.ts`** (change)

```diff
@@ -1,6 +1,7 @@
 export { cn } from './lib/cn.js';
 export { DESKTOP_QUERY, useMediaQuery } from './lib/use-media-query.js';
 export { parseIsoDate, toIsoDate } from './lib/iso-date.js';
+export { buildTree, filterTree, flattenTree, type TreeNode } from './lib/tree.js';
 
 export { AppShell, NavGroup, NavItem, SidebarNav } from './components/app-shell.js';
 export { Button, IconButton } from './components/button.js';
@@ -49,3 +50,4 @@ export { SegmentedControl } from './components/segmented-control.js';
 export { SelectableCardGroup, type SelectableCardOption } from './components/selectable-card.js';
 export { Stepper } from './components/stepper.js';
 export { Toaster, toast } from './components/toast.js';
+export { TreeList } from './components/tree-list.js';
```

### The field fix

**File: `packages/ui/src/components/field.tsx`** (change)

```diff
@@ -31,8 +31,11 @@ export function Field({ id, label, optional = false, hint, error, children }: Fi
   const { t, errorText } = useLocale();
   return (
     // content-start: পাশের ফিল্ডে hint থাকলে grid-এর সারি উঁচু হয়; তখন এই ফিল্ডের ভেতরের
-    // সারিগুলো টেনে লম্বা না করে উপরে জড়ো থাকে — ইনপুটের উচ্চতা সব জায়গায় ৪২px
-    <div className="grid content-start gap-1.5">
+    // সারিগুলো টেনে লম্বা না করে উপরে জড়ো থাকে — ইনপুটের উচ্চতা সব জায়গায় ৪২px।
+    // grid-cols-1 (minmax(0, 1fr)): without it the column is as wide as the <input>'s own default
+    // width (about 20 characters), so a field in a narrow column (the 140px Code) ran under its
+    // neighbour. Found in step 9; the branch form had it too.
+    <div className="grid grid-cols-1 content-start gap-1.5">
       <label htmlFor={id} className="text-label font-medium text-ink">
         {label}
         {optional && <span className="font-normal text-ink-3"> {t('common.optional')}</span>}
```

- **The bug:** a `grid` without a column template has one `auto` column, which grows to its content's minimum
  width. An `<input>`'s minimum width is its built-in default (about 20 characters, ~180px). In the 140px "Code"
  column of a form, the input box ran ~40px under the "Name" box next to it. The branch form had the same bug
  since step 6; there the Name box painted over it, so nobody saw it. The 390px screenshot of the new dialog
  showed it.
- **The fix:** `grid-cols-1` is `repeat(1, minmax(0, 1fr))` — the column may shrink below its content's minimum,
  and the input (`min-w-0 flex-1` inside) follows. The same trick the app shell already uses for the
  workspace switcher.

---

## 9.8 — `apps/app`: the Chart of accounts page

### Tree helpers for accounts

**File: `apps/app/src/lib/account-tree.ts`** (new)

```ts
import type { Account } from '@omnivo/contracts';
import { buildTree, flattenTree, type TreeNode } from '@omnivo/ui';

// Sorts "1120" after "1110" and "1-2" before "1-10", like people read account codes
const byCode = new Intl.Collator('en', { numeric: true });

export function accountTree(accounts: readonly Account[]): TreeNode<Account>[] {
  return buildTree(accounts, {
    id: (account) => account.id,
    parentId: (account) => account.parentId,
    compare: (a, b) => byCode.compare(a.code, b.code),
  });
}

// The groups an account can go under, in tree order, indented for the native <select> (which
// shows plain text only — em spaces are the indent). For a move, `moving` leaves out the account
// itself, everything under it (a loop) and the groups of other types; the API refuses those too.
export function groupOptions(
  accounts: readonly Account[],
  moving?: Account,
): { value: string; label: string }[] {
  const tree = accountTree(
    accounts.filter((account) => account.isGroup && account.archivedAt === null),
  );
  const allowed = moving ? tree.filter((root) => root.item.type === moving.type) : tree;
  return flattenTree(withoutBranch(allowed, moving?.id)).map(({ node, depth }) => ({
    value: node.id,
    label: `${' '.repeat(depth)}${node.item.code} · ${node.item.name}`,
  }));
}

function withoutBranch(
  nodes: readonly TreeNode<Account>[],
  id: string | undefined,
): TreeNode<Account>[] {
  return nodes.flatMap((node) =>
    node.id === id ? [] : [{ ...node, children: withoutBranch(node.children, id) }],
  );
}

const DIGITS = /^\d+$/;

function trailingZeros(value: bigint): number {
  let zeros = 0;
  for (let rest = value; rest !== 0n && rest % 10n === 0n; rest /= 10n) zeros += 1;
  return zeros;
}

// A code for a new account under `parent`, following the numbers around it: after 1110 and 1120
// comes 1130; the first account in 1100 is 1110, in 1120 it is 1121. '' when there is no clear
// next number (codes with dots, or no room left in the group) — the person types one.
// BigInt: a code can be 20 digits, more than a JavaScript number holds exactly.
export function suggestCode(parent: Account, accounts: readonly Account[]): string {
  if (!DIGITS.test(parent.code)) return '';
  const siblings = accounts
    .filter((account) => account.parentId === parent.id && DIGITS.test(account.code))
    .map((account) => BigInt(account.code));

  let next: bigint;
  let step: bigint;
  const last = siblings.reduce<bigint | null>(
    (max, code) => (max === null || code > max ? code : max),
    null,
  );
  if (last !== null) {
    step = 10n ** BigInt(trailingZeros(last));
    next = last + step;
  } else {
    const zeros = trailingZeros(BigInt(parent.code));
    if (zeros === 0) return '';
    step = 10n ** BigInt(zeros - 1);
    next = BigInt(parent.code) + step;
  }

  // Stay inside the group's own range: under 1100, codes start with 11 and have four digits
  const prefix = parent.code.replace(/0+$/, '');
  const taken = new Set(accounts.map((account) => account.code));
  for (;;) {
    const code = String(next).padStart(parent.code.length, '0');
    if (code.length !== parent.code.length || !code.startsWith(prefix)) return '';
    if (!taken.has(code)) return code;
    next += step;
  }
}
```

- **`Intl.Collator('en', { numeric: true })`** — sorts `1-2` before `1-10` and `1120` after `1110`, as people
  read codes. Plain string order would put `1-10` first.
- **`groupOptions(accounts, moving?)`** — the "Group" select. Only active groups. For a move, three more rules,
  the same ones the API checks: the account's own type only, and never the account itself or anything under it
  (`withoutBranch` cuts that branch off before flattening). The API still checks; the select only avoids
  offering choices that would be refused.
- **Em spaces (` `) as the indent.** A native `<option>` shows plain text only — no padding, no icons — and
  ordinary spaces at the start of an option are collapsed by some browsers. An em space is kept and is wide
  enough to read as a level.
- **`suggestCode(parent, accounts)`** — the rules in words:
  - after the last code in the group, step by its last non-zero digit: after `1110, 1120` → `1130`; after `1161`
    → `1162`;
  - an empty group: one place below the group's own code: `1100` → `1110`, `1120` → `1121`, `1000` → `1100`;
  - skip codes taken anywhere in the chart, but stay inside the group's range (under `1100`: four digits,
    starting with `11`); when the range is full, suggest nothing;
  - codes with dots or hyphens: suggest nothing. The person types one.
- **`BigInt`** — a code may have 20 digits; a JavaScript `number` is exact only up to 15–16. `10n ** BigInt(n)`
  is "10 to the n" without rounding.

**File: `apps/app/src/lib/account-tree.spec.ts`** (new)

```ts
import type { Account } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { groupOptions, suggestCode } from './account-tree';

let next = 0;
function account(code: string, parent: Account | null, fields: Partial<Account> = {}): Account {
  next += 1;
  return {
    id: `01939d1c-0000-7000-8000-${String(next).padStart(12, '0')}`,
    parentId: parent?.id ?? null,
    code,
    name: `Account ${code}`,
    type: parent?.type ?? 'asset',
    isGroup: false,
    purpose: null,
    description: null,
    archivedAt: null,
    version: 1,
    updatedAt: '2026-09-30T10:00:00.000Z',
    ...fields,
  };
}

const assets = account('1000', null, { isGroup: true });
const current = account('1100', assets, { isGroup: true });
const cash = account('1110', current);
const banks = account('1120', current, { isGroup: true });
const expenses = account('5000', null, { isGroup: true, type: 'expense' });
const chart = [assets, current, cash, banks, expenses];

describe('suggestCode', () => {
  it('continues after the last account in the group', () => {
    expect(suggestCode(current, chart)).toBe('1130');
  });

  it('starts an empty group one place below its own code', () => {
    expect(suggestCode(banks, chart)).toBe('1121');
    expect(suggestCode(assets, [assets])).toBe('1100');
  });

  it('skips a code already taken elsewhere, and gives up at the edge of the group', () => {
    const taken = account('1130', banks);
    expect(suggestCode(current, [...chart, taken])).toBe('1140');
    const full = account('1190', current);
    expect(suggestCode(current, [...chart, full])).toBe('');
  });

  it('suggests nothing for codes it cannot count, like 1-1-10', () => {
    expect(suggestCode(account('1-1', null, { isGroup: true }), chart)).toBe('');
  });
});

describe('groupOptions', () => {
  it('lists active groups in tree order, indented', () => {
    expect(groupOptions(chart).map((option) => option.label)).toEqual([
      '1000 · Account 1000',
      ' 1100 · Account 1100',
      '  1120 · Account 1120',
      '5000 · Account 5000',
    ]);
  });

  it('never offers a moved group itself, its own branch, or another type', () => {
    expect(groupOptions(chart, current).map((option) => option.value)).toEqual([assets.id]);
  });
});
```

### The query

**File: `apps/app/src/lib/queries.ts`** (change)

```diff
@@ -34,6 +34,17 @@ export function invitationsQuery(tenantId: string) {
   });
 }
 
+// The chart of accounts: the tree on its page, the count in the wizard, and from step 10 every
+// account picker. An empty chart is still being made by the worker (a new workspace, or step 9's
+// backfill for an old one), so while it is empty, ask again every 3 seconds until it arrives.
+export function accountsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['accounts', tenantId],
+    queryFn: async () => (await call(routes.accounts.list)).items,
+    refetchInterval: (query) => (query.state.data?.length === 0 ? 3_000 : false),
+  });
+}
+
 // The wizard's view of the background setup job. Polls every 1.5 seconds while the job runs, and
 // stops as soon as the status is final (ready or failed).
 export function setupQuery(tenantId: string) {
```

- In `queries.ts`, not in the page: the wizard counts the accounts too, and from step 10 every account picker
  uses the same key. One key means one request, and saving on the page refreshes them all.
- **Polls only while the chart is empty.** Right after setup or after the deploy of this step, the chart is being
  made by the worker; the page shows "on its way" and fills itself within seconds. Once there are accounts,
  `refetchInterval` returns `false` and polling stops.

### The page

**File: `apps/app/src/routes/accounts.tsx`** (new)

```tsx
import {
  Archive02Icon,
  FolderTreeIcon,
  PlusSignIcon,
  Search01Icon,
  SquareLock02Icon,
  UnfoldLessIcon,
  UnfoldMoreIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  type AccountType,
  contractErrorMap,
  createAccountInputSchema,
  isAccountPurpose,
  NORMAL_BALANCE,
  routes,
  updateAccountInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  filterTree,
  FormAlert,
  IconButton,
  Input,
  PageHeader,
  Pill,
  SegmentedControl,
  SelectField,
  TextAreaField,
  TextField,
  toast,
  TreeList,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useCallback, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';

import { accountTree, groupOptions, suggestCode } from '../lib/account-tree';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { accountsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const CREATE_FIELDS = createAccountInputSchema.keyof().options;
const UPDATE_FIELDS = updateAccountInputSchema.keyof().options;
const KINDS = ['ledger', 'group'] as const;

function failureOf(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

// "Asset · grows with a debit" — the class every account under this group will have
function TypeLine({ type, prefix }: { type: AccountType; prefix?: string }) {
  const { t } = useLocale();
  const line = t('accounts.typeLine', {
    type: t(`accounts.types.${type}`),
    balance: t(`accounts.balances.${NORMAL_BALANCE[type]}`),
  });
  return <p className="text-label text-ink-3">{prefix ? `${prefix} · ${line}` : line}</p>;
}

function useRefresh() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: accountsQuery(tenantId).queryKey });
}

function NewAccountForm({
  accounts,
  parentId,
  onDone,
}: {
  accounts: Account[];
  // '' = the page's Add button (no group chosen yet); an id = a group row's + button
  parentId: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const groups = useMemo(() => groupOptions(accounts), [accounts]);
  const start = accounts.find((account) => account.id === parentId);
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm({
    resolver: zodResolver(createAccountInputSchema, { error: contractErrorMap }),
    defaultValues: {
      parentId,
      code: start ? suggestCode(start, accounts) : '',
      name: '',
      isGroup: false,
      description: '',
    },
  });
  const chosen = useWatch({ control, name: 'parentId' });
  const parent = accounts.find((account) => account.id === chosen);

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.accounts.create, { body: values });
      await refresh();
      toast(t('accounts.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, CREATE_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('accounts.newTitle')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="account-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('accounts.add')}
          </Button>
        </>
      }
    >
      <form
        id="account-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <div className="grid gap-1.5">
          <SelectField
            label={t('accounts.parent')}
            options={[{ value: '', label: t('accounts.parentPlaceholder') }, ...groups]}
            {...register('parentId', {
              // A new group → a code that fits it. Not over a code the person typed themselves.
              onChange: (event: ChangeEvent<HTMLSelectElement>) => {
                if (dirtyFields.code) return;
                const next = accounts.find((account) => account.id === event.target.value);
                setValue('code', next ? suggestCode(next, accounts) : '');
              },
            })}
            error={errors.parentId?.message}
          />
          {parent && <TypeLine type={parent.type} />}
        </div>
        <Controller
          control={control}
          name="isGroup"
          render={({ field }) => (
            <div className="grid gap-1.5">
              {/* The visible label; the control's own legend (sr-only) is what screen readers use */}
              <span aria-hidden="true" className="text-label font-medium text-ink">
                {t('accounts.kind')}
              </span>
              <div>
                <SegmentedControl
                  label={t('accounts.kind')}
                  value={field.value ? 'group' : 'ledger'}
                  options={KINDS.map((kind) => ({
                    value: kind,
                    label: t(`accounts.kinds.${kind}`),
                  }))}
                  onChange={(kind) => {
                    field.onChange(kind === 'group');
                  }}
                />
              </div>
              <p className="text-label text-ink-3">
                {t(`accounts.kindHints.${field.value ? 'group' : 'ledger'}`)}
              </p>
            </div>
          )}
        />
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('accounts.code')}
            hint={t('accounts.codeHint')}
            inputMode="numeric"
            spellCheck={false}
            placeholder="1121"
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField
            label={t('accounts.name')}
            placeholder={t('accounts.namePlaceholder')}
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <TextAreaField
          label={t('accounts.about')}
          optional
          placeholder={t('accounts.aboutPlaceholder')}
          {...register('description')}
          error={errors.description?.message}
        />
      </form>
    </DialogContent>
  );
}

function EditAccountForm({
  account,
  accounts,
  onDone,
}: {
  account: Account;
  accounts: Account[];
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const groups = useMemo(() => groupOptions(accounts, account), [accounts, account]);
  const top = account.parentId === null;
  // An unknown purpose (from a newer server) is still a system account: the server refuses to
  // archive or delete it, so the buttons stay hidden — only the hint needs a known purpose
  const system = account.purpose !== null;
  const purpose =
    account.purpose !== null && isAccountPurpose(account.purpose) ? account.purpose : null;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateAccountInputSchema, { error: contractErrorMap }),
    defaultValues: {
      parentId: account.parentId,
      code: account.code,
      name: account.name,
      description: account.description ?? '',
      version: account.version,
    },
  });

  const toggle = useMutation({
    mutationFn: () =>
      call(account.archivedAt === null ? routes.accounts.archive : routes.accounts.restore, {
        params: { id: account.id },
        body: { version: account.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'accounts.restoredToast' : 'accounts.archivedToast', {
          name: saved.name,
        }),
      );
      onDone();
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      call(routes.accounts.remove, {
        params: { id: account.id },
        query: { version: account.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('accounts.deleted', { name: account.name }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = await call(routes.accounts.update, {
        params: { id: account.id },
        body: { ...fields, version },
      });
      await refresh();
      toast(t('accounts.updated', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, UPDATE_FIELDS, setError);
    }
  });

  const failure =
    errors.root?.server?.message ?? failureOf(toggle.error) ?? failureOf(remove.error);
  const busy = toggle.isPending || remove.isPending;

  return (
    <DialogContent
      title={t('accounts.editTitle', { code: account.code })}
      footer={
        <>
          {!top && !system && (
            // Left, away from Save. Delete takes two clicks: it cannot be undone.
            <div className="mr-auto flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  toggle.mutate();
                }}
              >
                {account.archivedAt === null ? t('accounts.archive') : t('accounts.restore')}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (confirming) remove.mutate();
                  else setConfirming(true);
                }}
              >
                {confirming
                  ? t('accounts.confirmDelete', { code: account.code })
                  : t('accounts.delete')}
              </Button>
            </div>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="account-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="account-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && <p className="text-body-sm text-ink-2">{t('accounts.deleteWarning')}</p>}
        <TypeLine
          type={account.type}
          prefix={t(`accounts.kinds.${account.isGroup ? 'group' : 'ledger'}`)}
        />
        {top && <p className="text-body-sm text-ink-2">{t('accounts.topLevel')}</p>}
        {purpose && (
          <p className="text-body-sm text-ink-2">
            {t('accounts.systemHint', { purpose: t(`accounts.purposes.${purpose}`) })}
          </p>
        )}
        {/* A top-level group has no group to pick: it sends parentId null and stays on top */}
        {!top && (
          <SelectField
            label={t('accounts.parent')}
            options={groups}
            {...register('parentId')}
            error={errors.parentId?.message}
          />
        )}
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('accounts.code')}
            hint={t('accounts.codeHint')}
            inputMode="numeric"
            spellCheck={false}
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField
            label={t('accounts.name')}
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <TextAreaField
          label={t('accounts.about')}
          optional
          placeholder={t('accounts.aboutPlaceholder')}
          {...register('description')}
          error={errors.description?.message}
        />
      </form>
    </DialogContent>
  );
}

// One row of the tree, right of the arrow: code, name, and what applies — System, Archived, +
function AccountRow({
  account,
  canManage,
  onOpen,
  onAdd,
}: {
  account: Account;
  canManage: boolean;
  onOpen: (account: Account) => void;
  onAdd: (group: Account) => void;
}) {
  const { t } = useLocale();
  const archived = account.archivedAt !== null;
  const nameClass = cn(
    'min-w-0 truncate text-left text-body-sm',
    account.isGroup ? 'font-medium text-ink' : 'text-ink-2',
    archived && 'text-ink-3',
  );
  return (
    <>
      <span className="w-11 shrink-0 font-mono text-caption text-ink-3 tabular-nums sm:w-14">
        {account.code}
      </span>
      {canManage ? (
        <button
          type="button"
          onClick={() => {
            onOpen(account);
          }}
          className={cn(nameClass, 'underline-offset-3 hover:underline')}
        >
          {account.name}
        </button>
      ) : (
        <span className={nameClass}>{account.name}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {account.purpose !== null && (
          <Pill tone="neutral" icon={SquareLock02Icon}>
            {t('accounts.system')}
          </Pill>
        )}
        {archived && (
          <Pill tone="neutral" icon={Archive02Icon}>
            {t('accounts.archived')}
          </Pill>
        )}
        {canManage && account.isGroup && !archived && (
          <IconButton
            icon={PlusSignIcon}
            label={t('accounts.addTo', { name: account.name })}
            // With a mouse: shown on the row's hover or keyboard focus — thirty "+" at rest are
            // noise. On touch screens there is no hover, so it always shows.
            className="-my-1 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100"
            onClick={() => {
              onAdd(account);
            }}
          />
        )}
      </span>
    </>
  );
}

type Editing = null | { kind: 'new'; parentId: string } | { kind: 'edit'; account: Account };

export function AccountsPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = useCan()('accounting.account.manage');
  const { data: accounts, isError } = useQuery({
    ...accountsQuery(tenantId),
    enabled: me !== null,
  });
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // Closed groups, not open ones: a new chart opens fully, and a new group starts open
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const query = search.trim().toLowerCase();

  const tree = useMemo(() => {
    const visible = (accounts ?? []).filter(
      (account) => showArchived || account.archivedAt === null,
    );
    const full = accountTree(visible);
    if (query === '') return full;
    return filterTree(
      full,
      (account) =>
        account.code.toLowerCase().includes(query) || account.name.toLowerCase().includes(query),
    );
  }, [accounts, showArchived, query]);

  // While searching, every group on the way to a match is open, whatever was closed before
  const isOpen = useCallback(
    (id: string) => query !== '' || !collapsed.has(id),
    [query, collapsed],
  );
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const open = useCallback((account: Account) => {
    setEditing({ kind: 'edit', account });
  }, []);
  const add = useCallback((group: Account) => {
    setEditing({ kind: 'new', parentId: group.id });
  }, []);

  return (
    // grid-cols-1 = minmax(0, 1fr): without it the one column grows to the toolbar's unwrapped
    // width, and the page scrolls sideways on a phone (found by the 390px screenshot)
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader
        title={t('accounts.title')}
        description={t('accounts.description')}
        actions={
          canManage && (
            <Button
              disabled={!accounts?.length}
              onClick={() => {
                setEditing({ kind: 'new', parentId: '' });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('accounts.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-60">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('accounts.searchLabel')}
            placeholder={t('accounts.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <Checkbox
          id="accounts-show-archived"
          label={t('accounts.showArchived')}
          checked={showArchived}
          onCheckedChange={(checked) => {
            setShowArchived(checked === true);
          }}
        />
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={query !== ''}
            onClick={() => {
              setCollapsed(new Set());
            }}
          >
            <HugeiconsIcon icon={UnfoldMoreIcon} size={16} strokeWidth={1.5} />
            {t('accounts.expandAll')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={query !== ''}
            onClick={() => {
              setCollapsed(new Set(accounts?.filter((a) => a.isGroup).map((a) => a.id)));
            }}
          >
            <HugeiconsIcon icon={UnfoldLessIcon} size={16} strokeWidth={1.5} />
            {t('accounts.collapseAll')}
          </Button>
        </div>
      </div>
      {!canManage && <p className="text-body-sm text-ink-3">{t('accounts.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('accounts.loadFailed')}</p>}
      {accounts?.length === 0 && (
        <EmptyState
          icon={FolderTreeIcon}
          title={t('accounts.emptyTitle')}
          description={t('accounts.emptyBody')}
        />
      )}
      {accounts && accounts.length > 0 && tree.length === 0 && (
        <EmptyState
          icon={Search01Icon}
          title={t('accounts.noMatchTitle', { query: search.trim() })}
          description={t('accounts.noMatchBody')}
        />
      )}
      {tree.length > 0 && (
        <TreeList
          label={t('accounts.title')}
          nodes={tree}
          isOpen={isOpen}
          onToggle={toggle}
          toggleLabel={(account, isShown) =>
            t(isShown ? 'accounts.collapse' : 'accounts.expand', { name: account.name })
          }
          renderRow={(account) => (
            <AccountRow account={account} canManage={canManage} onOpen={open} onAdd={add} />
          )}
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(isShown) => {
          if (!isShown) setEditing(null);
        }}
      >
        {accounts && editing?.kind === 'new' && (
          <NewAccountForm
            key={`new-${editing.parentId}`}
            accounts={accounts}
            parentId={editing.parentId}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
        {accounts && editing?.kind === 'edit' && (
          <EditAccountForm
            key={editing.account.id}
            account={editing.account}
            accounts={accounts}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

- **Two forms, not one form with modes.** Create and edit have different schemas (`isGroup` vs `version`,
  `parentId` required vs nullable). One form for both would need a union type in `useForm` and `if`s in every
  field. Two components share the small parts (`TypeLine`, `useRefresh`, `failureOf`).
- **`NewAccountForm`:**
  - opened from the page's button (`parentId: ''`, no group yet) or from a group row's "+" (that group chosen,
    code already suggested);
  - **`useWatch` at the top of the component** for the chosen group: hooks may not be called inside callbacks.
    (A first version called it inside `accounts.find(…)` — React's rules of hooks forbid that.)
  - **the code follows the group, unless the person typed one.** `register('parentId', { onChange })` suggests a
    code for the new group; `dirtyFields.code` (read during render, so React Hook Form tracks it) is true once
    the person has typed in the Code field, and then the suggestion leaves it alone;
  - **"Kind" is a `SegmentedControl` inside a `Controller`.** The control works with the strings `'ledger'` /
    `'group'`; the form value is the boolean the API wants. The visible label is `aria-hidden`, because the
    control's own `legend` already names it for screen readers — otherwise it would be read twice;
  - `TypeLine` under the group: "Asset · grows with a debit" — the person sees what the new account will be
    before saving.
- **`EditAccountForm`:**
  - **Archive and Delete are hidden for top-level groups and system accounts**, and the reason is shown instead
    (`topLevel`, `systemHint`). An unknown purpose from a newer server still hides the buttons (`system` is
    `purpose !== null`); only the hint needs a known purpose;
  - **Delete takes two clicks** with a warning in between, like deleting a role: it cannot be undone;
  - a top-level group has no Group select; its form keeps `parentId: null` from the default values, which the
    update schema accepts.
- **`AccountRow`:**
  - the code in Geist Mono (CLAUDE.md: mono for code-like values) and `tabular-nums`, in a fixed-width column, so
    names line up;
  - groups in `ink`/500, ledgers in `ink-2`, archived ones in `ink-3`;
  - the name is a `<button>` only for someone who may change the chart; for others it is plain text, so nothing
    looks clickable that does nothing;
  - **the "+" is shown on hover only with a mouse.** `pointer-fine:` (Tailwind's `@media (pointer: fine)`) hides
    it at rest, `group-hover/row:` and `group-focus-within/row:` bring it back on the row's hover or keyboard
    focus. On a touch screen there is no hover, so it always shows. Thirty "+" icons at rest were visual noise in
    the first screenshot.
- **`AccountsPage`:**
  - **`collapsed`, not `expanded`.** A new chart opens fully, a newly added group starts open, and "Expand all"
    is just "forget what was closed";
  - **`grid-cols-1` on the page's grid** — the same bug as in `Field`: without it the page's one column grew to
    the toolbar's unwrapped width (search + checkbox + two buttons), and the page scrolled 39px sideways at
    390px. Found by the screenshot, now guarded by `expectNoSideScroll` in e2e;
  - search: case-insensitive on code and name, and while it is on every group is open and the Expand/Collapse
    buttons are disabled (they would do nothing visible);
  - three states without a tree: loading (nothing), empty chart ("on its way", while the query polls), and no
    match ("No account matches …" with how to search);
  - "Add account" is disabled while the chart is empty: there is no group to add to yet;
  - the dialog `key` makes a fresh form for each account (and each starting group), so values of the last one
    never leak into the next.

### Route, nav, wizard

**File: `apps/app/src/router.tsx`** (change)

```diff
@@ -108,6 +108,12 @@ const branchesRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/branches'), 'BranchesPage'),
 });
 
+const accountsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/accounts',
+  component: lazyRouteComponent(() => import('./routes/accounts'), 'AccountsPage'),
+});
+
 const teamRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/team',
@@ -148,6 +154,7 @@ const routeTree = rootRoute.addChildren([
     settingsRoute,
     numberingRoute,
     branchesRoute,
+    accountsRoute,
     teamRoute,
     rolesRoute,
     auditLogRoute,
```

**File: `apps/app/src/routes/app-shell.tsx`** (change)

```diff
@@ -1,4 +1,5 @@
 import {
+  BookOpen02Icon,
   DashboardSquare01Icon,
   LayoutGridIcon,
   LeftToRightListNumberIcon,
@@ -229,6 +230,12 @@ export function AppShell() {
               </NavLink>
             )}
           </NavGroup>
+          {/* Every member reads the chart (from step 10, every entry form picks accounts from it) */}
+          <NavGroup label={t('nav.accounting')}>
+            <NavLink to="/accounts" icon={BookOpen02Icon}>
+              {t('nav.chartOfAccounts')}
+            </NavLink>
+          </NavGroup>
           <NavGroup label={t('nav.workspace')}>
             {(can('core.user.read') || can('core.user.invite')) && (
               <NavLink to="/team" icon={UserGroupIcon}>
```

- A new nav group, "Accounting", above "Workspace": the journal, ledgers and reports of steps 10–11 join it.
  No permission check: every member may read the chart.

**File: `apps/app/src/routes/onboarding.tsx`** (change)

```diff
@@ -45,7 +45,7 @@ import { InviteForm } from '../components/invite-form';
 import { LanguageSwitch } from '../components/language-switch';
 import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
-import { rolesQuery, settingsQuery, setupQuery } from '../lib/queries';
+import { accountsQuery, rolesQuery, settingsQuery, setupQuery } from '../lib/queries';
 import { refreshMe } from '../lib/session';
 import { useSession } from '../lib/session-store';
 import { settingsToForm } from '../lib/settings-form';
@@ -333,6 +333,9 @@ function SetupProgress() {
   const { data: setup } = useQuery(setupQuery(tenantId));
   const ready = setup?.status === 'ready';
   const { data: roles } = useQuery({ ...rolesQuery(tenantId), enabled: ready });
+  const { data: accounts } = useQuery({ ...accountsQuery(tenantId), enabled: ready });
+  // "Ready" only once both lists are here — otherwise the line would flash "0 accounts" first
+  const done = ready && roles !== undefined && accounts !== undefined;
 
   const retry = useMutation({
     mutationFn: () => call(routes.setup.retry),
@@ -366,16 +369,17 @@ function SetupProgress() {
   // role="status": a screen reader announces the change from "Preparing…" to "Roles ready"
   return (
     <p role="status" className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
-      {ready ? (
+      {done ? (
         <>
           <Pill tone="good" icon={CheckmarkCircle02Icon}>
             {industry}
           </Pill>
           {t('onboarding.team.ready', {
-            roles: (roles ?? [])
+            roles: roles
               .filter((role) => role.kind === 'custom')
               .map((role) => role.name)
               .join(', '),
+            count: accounts.length,
           })}
         </>
       ) : (
```

- **`done` waits for both lists.** With only `ready`, the line would first say "Chart of accounts: 0 accounts"
  for a moment, then the real number. Until both are loaded it keeps showing "Preparing…".

### The kitchen sink

**File: `apps/app/src/routes/kitchen-sink.tsx`** (change)

```diff
@@ -15,6 +15,7 @@ import { zodResolver } from '@hookform/resolvers/zod';
 import type { Theme } from '@omnivo/contracts';
 import { isLanguage, LANGUAGES, setLanguage, useLocale } from '@omnivo/i18n';
 import {
+  buildTree,
   Button,
   Card,
   CardHeader,
@@ -37,6 +38,7 @@ import {
   TextField,
   toast,
   toIsoDate,
+  TreeList,
 } from '@omnivo/ui';
 import { useMemo, useState } from 'react';
 import { Controller, useForm } from 'react-hook-form';
@@ -419,6 +421,14 @@ export function KitchenSinkPage() {
         />
       </Card>
 
+      <section className="grid gap-3">
+        <SectionHeader
+          title="Tree list"
+          subtitle="Groups open and close; the page keeps the open state (chart of accounts, step 9)"
+        />
+        <CategoryTree />
+      </section>
+
       <section className="grid gap-3">
         <SectionHeader
           title="Data table"
@@ -429,3 +439,49 @@ export function KitchenSinkPage() {
     </div>
   );
 }
+
+interface Category {
+  id: string;
+  parentId: string | null;
+  name: string;
+}
+
+// Product categories of a garments factory — the kind of list step 12 shows with this component
+const CATEGORIES: Category[] = [
+  { id: 'fabric', parentId: null, name: 'Fabrics' },
+  { id: 'knit', parentId: 'fabric', name: 'Knit (single jersey, rib)' },
+  { id: 'woven', parentId: 'fabric', name: 'Woven (denim, twill)' },
+  { id: 'trims', parentId: null, name: 'Trims and accessories' },
+  { id: 'buttons', parentId: 'trims', name: 'Buttons' },
+  { id: 'labels', parentId: 'trims', name: 'Care labels' },
+  { id: 'thread', parentId: null, name: 'Sewing thread' },
+];
+
+function CategoryTree() {
+  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
+  const nodes = useMemo(
+    () =>
+      buildTree(CATEGORIES, {
+        id: (category) => category.id,
+        parentId: (category) => category.parentId,
+        compare: (a, b) => a.name.localeCompare(b.name),
+      }),
+    [],
+  );
+  return (
+    <TreeList
+      label="Product categories"
+      nodes={nodes}
+      isOpen={(id) => !closed.has(id)}
+      onToggle={(id) => {
+        setClosed((current) => {
+          const next = new Set(current);
+          if (!next.delete(id)) next.add(id);
+          return next;
+        });
+      }}
+      toggleLabel={(category, open) => `${open ? 'Hide' : 'Show'} ${category.name}`}
+      renderRow={(category) => <span className="truncate text-body-sm">{category.name}</span>}
+    />
+  );
+}
```

- Every `packages/ui` component has a demo here. The demo uses product categories on purpose: it shows the
  component is not tied to accounts.

---

## 9.9 — MSW: the chart in the mocks

**File: `apps/app/src/mocks/accounting-data.ts`** (new)

```ts
import {
  type Account,
  type AccountPurpose,
  ACCOUNT_TYPES,
  type AccountType,
  type Industry,
} from '@omnivo/contracts';

import { MockProblem } from './mock';

// A shorter copy of the API's chart templates (apps/api/src/setup/templates.ts): the mock cannot
// import server code. Same codes and purposes, fewer ordinary accounts.
interface MockNode {
  code: string;
  name: string;
  purpose?: AccountPurpose;
  children?: MockNode[];
  archived?: boolean;
}

const MAKERS: readonly Industry[] = ['garments', 'pharma', 'manufacturing'];

function template(industry: Industry): Record<AccountType, MockNode> {
  const garments = industry === 'garments';
  const stock: MockNode = MAKERS.includes(industry)
    ? {
        code: '1150',
        name: 'Inventories',
        children: [
          { code: '1151', name: garments ? 'Fabrics and yarn' : 'Raw materials' },
          { code: '1152', name: 'Work in progress' },
          {
            code: '1153',
            name: garments ? 'Finished garments' : 'Finished goods',
            purpose: 'inventory',
          },
        ],
      }
    : { code: '1150', name: 'Inventory', purpose: 'inventory' };
  return {
    asset: {
      code: '1000',
      name: 'Assets',
      children: [
        {
          code: '1100',
          name: 'Current assets',
          children: [
            { code: '1110', name: 'Cash in hand', purpose: 'cash' },
            {
              code: '1120',
              name: 'Bank accounts',
              children: [
                { code: '1121', name: 'Dutch-Bangla Bank CD A/C 1234' },
                // Closed last year: shows up with "Show archived"
                { code: '1122', name: 'Sonali Bank CD A/C 0071', archived: true },
              ],
            },
            { code: '1130', name: 'Mobile wallets (bKash, Nagad)', children: [] },
            { code: '1140', name: 'Accounts receivable', purpose: 'accounts_receivable' },
            stock,
            { code: '1170', name: 'Input VAT', purpose: 'vat_input' },
          ],
        },
        {
          code: '1200',
          name: 'Fixed assets',
          children: [
            { code: '1220', name: 'Plant and machinery' },
            { code: '1230', name: 'Furniture and fixtures' },
            { code: '1290', name: 'Accumulated depreciation' },
          ],
        },
      ],
    },
    liability: {
      code: '2000',
      name: 'Liabilities',
      children: [
        {
          code: '2100',
          name: 'Current liabilities',
          children: [
            { code: '2110', name: 'Accounts payable', purpose: 'accounts_payable' },
            { code: '2120', name: 'Output VAT', purpose: 'vat_output' },
            { code: '2130', name: 'VAT and tax deducted at source (VDS, TDS)' },
            { code: '2140', name: 'Salaries and wages payable' },
          ],
        },
      ],
    },
    equity: {
      code: '3000',
      name: 'Equity',
      children: [
        { code: '3100', name: 'Capital' },
        { code: '3200', name: 'Retained earnings', purpose: 'retained_earnings' },
        { code: '3300', name: 'Opening balance equity', purpose: 'opening_balance_equity' },
      ],
    },
    income: {
      code: '4000',
      name: 'Income',
      children: [
        {
          code: '4100',
          name: 'Revenue',
          children: [{ code: '4110', name: garments ? 'Export sales' : 'Sales', purpose: 'sales' }],
        },
        {
          code: '4200',
          name: 'Other income',
          children: [{ code: '4210', name: 'Interest income' }],
        },
      ],
    },
    expense: {
      code: '5000',
      name: 'Expenses',
      children: [
        {
          code: '5100',
          name: 'Cost of sales',
          children: [{ code: '5110', name: 'Cost of goods sold', purpose: 'cost_of_goods_sold' }],
        },
        {
          code: '5200',
          name: 'Administrative expenses',
          children: [
            { code: '5210', name: 'Salaries and allowances' },
            { code: '5220', name: 'Office rent' },
            { code: '5230', name: 'Utilities (electricity, gas, water)' },
          ],
        },
        { code: '5400', name: 'Finance costs', children: [{ code: '5410', name: 'Bank charges' }] },
      ],
    },
  };
}

export function seedAccounts(industry: Industry): Account[] {
  const now = new Date().toISOString();
  const accounts: Account[] = [];
  const add = (node: MockNode, type: AccountType, parentId: string | null): void => {
    const id = crypto.randomUUID();
    accounts.push({
      id,
      parentId,
      code: node.code,
      name: node.name,
      type,
      isGroup: node.children !== undefined,
      purpose: node.purpose ?? null,
      description: null,
      archivedAt: node.archived ? now : null,
      version: 1,
      updatedAt: now,
    });
    for (const child of node.children ?? []) add(child, type, id);
  };
  const chart = template(industry);
  for (const type of ACCOUNT_TYPES) add(chart[type], type, null);
  return accounts;
}

// The API's rules (accounts.service.ts), for the UI's error paths in `pnpm dev:mock` and e2e

export function findAccount(accounts: readonly Account[], id: string): Account {
  const found = accounts.find((account) => account.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertAccountCodeFree(
  accounts: readonly Account[],
  code: string,
  except?: string,
): void {
  if (accounts.some((other) => other.code === code && other.id !== except)) {
    throw new MockProblem(409, 'account_code_taken', { code: ['account_code_taken'] });
  }
}

function invalidParent(): MockProblem {
  return new MockProblem(409, 'account_parent_invalid', { parentId: ['account_parent_invalid'] });
}

// The group a new or moved account goes under: an active group, of the moved account's type,
// and not the moved account itself or anything under it
export function parentFor(
  accounts: readonly Account[],
  parentId: string,
  moving?: Account,
): Account {
  const parent = accounts.find((account) => account.id === parentId);
  if (!parent?.isGroup || parent.archivedAt !== null) throw invalidParent();
  if (moving) {
    if (moving.parentId === null || parent.type !== moving.type) throw invalidParent();
    // Walk up from the new group; meeting the moved account on the way means a loop
    let up: Account | undefined = parent;
    while (up) {
      if (up.id === moving.id) {
        throw new MockProblem(409, 'account_parent_loop', { parentId: ['account_parent_loop'] });
      }
      const above: string | null = up.parentId;
      up = accounts.find((account) => account.id === above);
    }
  }
  return parent;
}

export function assertNotLocked(account: Account): void {
  if (account.parentId === null || account.purpose !== null) {
    throw new MockProblem(409, 'account_locked');
  }
}

export function codeOf(accounts: readonly Account[], id: string | null): string | null {
  return accounts.find((account) => account.id === id)?.code ?? null;
}
```

- **A shorter copy of the templates** (41 accounts for garments): the mock can't import server code. The same
  codes and the same ten purposes, so every screen behaves the same; fewer ordinary accounts.
- **One archived account (`1122`, a closed Sonali Bank account)** so "Show archived" has something to show in
  `pnpm dev:mock` and in e2e.
- **The same rules as the API**, in small functions the handlers call: code taken, invalid parent, loop, other
  type, locked accounts. The UI's error paths can be seen without a server.
- **The loop walk** is a plain `while` with `const above: string | null`. A `for` loop whose variable was read
  in its own initializer made TypeScript give up on its type ("implicitly has type any").

**File: `apps/app/src/mocks/workspace-data.ts`** (change)

```diff
@@ -1,4 +1,5 @@
 import {
+  type Account,
   type AuditAction,
   type AuditChanges,
   type AuditEntityType,
@@ -19,6 +20,7 @@ import {
   todayIn,
 } from '@omnivo/contracts';
 
+import { seedAccounts } from './accounting-data';
 import { OWNER, type Workspace } from './fixtures';
 import { MockProblem } from './mock';
 import { type People, seedPeople } from './people-data';
@@ -35,6 +37,7 @@ export interface WorkspaceData {
   // When a started setup "finishes" (ms since epoch) — the pretend worker, see setup-data.ts
   setupReadyAt: number | null;
   notifications: Notification[];
+  accounts: Account[];
 }
 
 function now(): string {
@@ -84,6 +87,7 @@ function seed(workspace: Workspace): WorkspaceData {
     setup: { status: 'ready', industry: garments ? 'garments' : 'pharma' },
     setupReadyAt: null,
     notifications: garments ? seedNotifications() : [],
+    accounts: seedAccounts(garments ? 'garments' : 'pharma'),
   };
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
@@ -137,6 +141,8 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   };
   data.setup = { status: 'pending', industry: null };
   data.notifications = [];
+  // A new workspace has no chart until its setup job runs (settleSetup)
+  data.accounts = [];
   store.set(workspace.tenantId, data);
 }
 
```

**File: `apps/app/src/mocks/setup-data.ts`** (change)

```diff
@@ -1,5 +1,6 @@
 import type { Industry, Setup } from '@omnivo/contracts';
 
+import { seedAccounts } from './accounting-data';
 import { MockProblem } from './mock';
 import { record, type WorkspaceData } from './workspace-data';
 
@@ -28,7 +29,7 @@ export function startSetup(data: WorkspaceData, industry: Industry): Setup {
 }
 
 // Called on every read: once the delay has passed, do what the worker would have done — roles,
-// status, audit and a notification
+// the chart of accounts, status, audit and a notification
 export function settleSetup(data: WorkspaceData): void {
   const { industry } = data.setup;
   if (
@@ -52,11 +53,13 @@ export function settleSetup(data: WorkspaceData): void {
       updatedAt: new Date().toISOString(),
     });
   }
+  if (data.accounts.length === 0) data.accounts = seedAccounts(industry);
   data.setup = { status: 'ready', industry };
   data.setupReadyAt = null;
   record(data, 'workspace.provisioned', 'workspace', crypto.randomUUID(), {
     industry: { from: null, to: industry },
     roles: { from: null, to: added.join(', ') || null },
+    accounts: { from: null, to: data.accounts.length },
   });
   data.notifications.unshift({
     id: crypto.randomUUID(),
```

- The pretend setup job makes the chart too, so the wizard's "Chart of accounts: 41 accounts" works in mock mode.

**File: `apps/app/src/mocks/handlers.ts`** (change)

```diff
@@ -1,4 +1,10 @@
-import { type AuthSession, type Preferences, routes, type Settings } from '@omnivo/contracts';
+import {
+  type Account,
+  type AuthSession,
+  type Preferences,
+  routes,
+  type Settings,
+} from '@omnivo/contracts';
 import { delay, http, HttpResponse, type HttpResponseResolver } from 'msw';
 
 import { API_URL } from '../lib/api';
@@ -18,6 +24,13 @@ import {
   toInvitation,
   toRole,
 } from './people-data';
+import {
+  assertAccountCodeFree,
+  assertNotLocked,
+  codeOf,
+  findAccount,
+  parentFor,
+} from './accounting-data';
 import { settleSetup, startSetup } from './setup-data';
 import {
   assertCodeFree,
@@ -524,6 +537,136 @@ export const handlers = [
     }),
   ),
 
+  mock(routes.accounts.list, () =>
+    reply(routes.accounts.list, {
+      items: current().accounts.toSorted((a, b) => a.code.localeCompare(b.code)),
+    }),
+  ),
+
+  mock(
+    routes.accounts.get,
+    guarded(({ params }) => {
+      const { id } = routes.accounts.get.params.parse(params);
+      return reply(routes.accounts.get, findAccount(current().accounts, id));
+    }),
+  ),
+
+  mock(
+    routes.accounts.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.accounts.create.body, request);
+      const data = current();
+      const parent = parentFor(data.accounts, body.parentId);
+      assertAccountCodeFree(data.accounts, body.code);
+      const created = {
+        ...body,
+        id: crypto.randomUUID(),
+        type: parent.type,
+        purpose: null,
+        archivedAt: null,
+        version: 1,
+        updatedAt: new Date().toISOString(),
+      };
+      data.accounts.push(created);
+      record(
+        data,
+        'account.created',
+        'account',
+        created.id,
+        diff(
+          {},
+          { code: body.code, name: body.name, description: body.description, parent: parent.code },
+        ),
+      );
+      await delay();
+      return reply(routes.accounts.create, created);
+    }),
+  ),
+
+  mock(
+    routes.accounts.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.accounts.update.params.parse(params);
+      const { version, ...fields } = await readBody(routes.accounts.update.body, request);
+      const data = current();
+      const target = findAccount(data.accounts, id);
+      checkVersion(target.version, version);
+      if (fields.parentId !== target.parentId) {
+        if (fields.parentId === null) throw new MockProblem(409, 'account_parent_invalid');
+        parentFor(data.accounts, fields.parentId, target);
+      }
+      assertAccountCodeFree(data.accounts, fields.code, id);
+      const snapshot = (account: Account) => ({
+        code: account.code,
+        name: account.name,
+        description: account.description,
+        parent: codeOf(data.accounts, account.parentId),
+      });
+      const before = snapshot(target);
+      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
+      record(data, 'account.updated', 'account', id, diff(before, snapshot(target)));
+      await delay();
+      return reply(routes.accounts.update, target);
+    }),
+  ),
+
+  mock(
+    routes.accounts.archive,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.accounts.archive.params.parse(params);
+      const { version } = await readBody(routes.accounts.archive.body, request);
+      const data = current();
+      const target = findAccount(data.accounts, id);
+      checkVersion(target.version, version);
+      assertNotLocked(target);
+      if (data.accounts.some((child) => child.parentId === id && child.archivedAt === null)) {
+        throw new MockProblem(409, 'account_has_active_children');
+      }
+      Object.assign(target, { archivedAt: new Date().toISOString(), version: version + 1 });
+      record(data, 'account.archived', 'account', id);
+      return reply(routes.accounts.archive, target);
+    }),
+  ),
+
+  mock(
+    routes.accounts.restore,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.accounts.restore.params.parse(params);
+      const { version } = await readBody(routes.accounts.restore.body, request);
+      const data = current();
+      const target = findAccount(data.accounts, id);
+      checkVersion(target.version, version);
+      const parent = data.accounts.find((account) => account.id === target.parentId);
+      if (parent && parent.archivedAt !== null) {
+        throw new MockProblem(409, 'account_parent_archived');
+      }
+      Object.assign(target, { archivedAt: null, version: version + 1 });
+      record(data, 'account.restored', 'account', id);
+      return reply(routes.accounts.restore, target);
+    }),
+  ),
+
+  mock(
+    routes.accounts.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.accounts.remove.params.parse(params);
+      const { version } = readQuery(routes.accounts.remove.query, request);
+      const data = current();
+      const target = findAccount(data.accounts, id);
+      checkVersion(target.version, version);
+      assertNotLocked(target);
+      if (data.accounts.some((child) => child.parentId === id)) {
+        throw new MockProblem(409, 'account_has_children');
+      }
+      data.accounts = data.accounts.filter((account) => account.id !== id);
+      record(data, 'account.deleted', 'account', id, {
+        code: { from: target.code, to: null },
+        name: { from: target.name, to: null },
+      });
+      return reply(routes.accounts.remove, undefined);
+    }),
+  ),
+
   mock(routes.numberSeries.list, () =>
     reply(routes.numberSeries.list, { items: seriesList(current()) }),
   ),
```

- Each handler reads the request with the contract's own schema (`readBody`, `readQuery`), and `reply()` checks
  the response with it — the mock cannot drift from the real API's shape.

---

## 9.10 — Playwright

**File: `apps/app/e2e/accounts.e2e.ts`** (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Chart of accounts');
});

const tree = (page: Page) => page.getByRole('list', { name: 'Chart of accounts' });

// An account's row: its name is a button (it opens the edit dialog)
const account = (page: Page, name: string) => tree(page).getByRole('button', { name, exact: true });

// Everything under a group: the group's list item holds its own row and the nested list. Every
// list item above it contains the name too; the group's own item is the innermost, which comes
// last in page order. `has` is searched inside each item, so it starts from `page`, not the tree.
const group = (page: Page, name: string) =>
  tree(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name, exact: true }) })
    .last();

test('adds an account from its group, with a code suggested and a taken code refused', async ({
  page,
}) => {
  await group(page, 'Bank accounts')
    .getByRole('button', { name: 'Add an account to Bank accounts' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Add account' });
  // After 1121 and 1122 in the group
  await expect(dialog.getByLabel('Code')).toHaveValue('1123');
  await expect(dialog.getByText('Asset · grows with a debit')).toBeVisible();

  await dialog.getByLabel('Code').fill('1110');
  await dialog.getByLabel('Name').fill('BRAC Bank CD A/C 5678');
  await dialog.getByRole('button', { name: 'Add account' }).click();
  await expect(dialog.getByText('Another account already uses this code.')).toBeVisible();

  await dialog.getByLabel('Code').fill('1123');
  await dialog.getByRole('button', { name: 'Add account' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('BRAC Bank CD A/C 5678 added')).toBeVisible();
  await expect(group(page, 'Bank accounts').getByText('BRAC Bank CD A/C 5678')).toBeVisible();
  await expectNoSideScroll(page);
});

test('moves an account to another group of its type', async ({ page }) => {
  await account(page, 'Dutch-Bangla Bank CD A/C 1234').click();
  const dialog = page.getByRole('dialog', { name: 'Edit 1121' });
  // The select offers only asset groups, indented by depth (two em spaces = third level)
  await dialog
    .getByLabel('Group')
    .selectOption({ label: '  1130 · Mobile wallets (bKash, Nagad)' });
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    group(page, 'Mobile wallets (bKash, Nagad)').getByText('Dutch-Bangla Bank CD A/C 1234'),
  ).toBeVisible();
  await expect(
    group(page, 'Bank accounts').getByText('Dutch-Bangla Bank CD A/C 1234'),
  ).toBeHidden();
});

test('searches inside the groups, shows archived accounts and folds the tree', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'Search accounts' });
  await search.fill('vat');
  await expect(account(page, 'Input VAT')).toBeVisible();
  await expect(account(page, 'Output VAT')).toBeVisible();
  // Its group stays, so you still see where it sits; unrelated accounts go
  await expect(account(page, 'Current assets')).toBeVisible();
  await expect(account(page, 'Cash in hand')).toBeHidden();

  await search.fill('lc margin');
  await expect(page.getByText('No account matches "lc margin"')).toBeVisible();
  await search.fill('');

  await expect(account(page, 'Sonali Bank CD A/C 0071')).toBeHidden();
  await page.getByText('Show archived').click();
  await expect(
    tree(page)
      .getByRole('listitem')
      .filter({ hasText: 'Sonali Bank CD A/C 0071' })
      .getByText('Archived'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(account(page, 'Current assets')).toBeHidden();
  await page.getByRole('button', { name: 'Show the accounts in Assets' }).click();
  await expect(account(page, 'Current assets')).toBeVisible();
  await expect(account(page, 'Cash in hand')).toBeHidden();
});

test('protects system accounts, archives only empty groups and deletes in two clicks', async ({
  page,
}) => {
  await account(page, 'Accounts receivable').click();
  const system = page.getByRole('dialog', { name: 'Edit 1140' });
  await expect(system.getByText('Omnivo posts what customers owe to this account')).toBeVisible();
  await expect(system.getByRole('button', { name: 'Archive' })).toBeHidden();
  await system.getByRole('button', { name: 'Cancel' }).click();

  await account(page, 'Fixed assets').click();
  const fixed = page.getByRole('dialog', { name: 'Edit 1200' });
  await fixed.getByRole('button', { name: 'Archive' }).click();
  await expect(fixed.getByRole('alert')).toHaveText(/Archive the accounts under this group first/);
  await fixed.getByRole('button', { name: 'Cancel' }).click();

  await account(page, 'Accumulated depreciation').click();
  const depreciation = page.getByRole('dialog', { name: 'Edit 1290' });
  await depreciation.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(depreciation.getByText('This cannot be undone.')).toBeVisible();
  await depreciation.getByRole('button', { name: 'Delete 1290' }).click();
  await expect(page.getByText('Accumulated depreciation deleted')).toBeVisible();
  await expect(account(page, 'Accumulated depreciation')).toBeHidden();
});
```

- **Locators by role and name**, like the other e2e files. An account's name is a button, so
  `getByRole('button', { name, exact: true })` finds it; `exact` keeps "Bank accounts" from also matching
  "Bank charges".
- **`group()` — the trickiest line.** A group's `<li>` holds its own row and its nested list. But every `<li>`
  above it contains the name too ("Assets" contains "Bank accounts"). The group's own `<li>` is the innermost
  one, and nested elements come later in page order, so `.last()`. And `has:` is searched *inside* each list
  item, so its locator starts from `page`; starting it from the tree would look for a tree inside the item and
  find nothing. (The first version had both mistakes; two tests timed out.)
- **The "+" works on both sizes.** On desktop Playwright moves the mouse to the button before clicking, which
  is the hover that shows it; on the 390px project (`Pixel 7`, a touch device) it is always shown.
- **The move test selects by label with the em spaces** — the exact text of the option, which also checks the
  indentation.

**File: `apps/app/e2e/onboarding.e2e.ts`** (change)

```diff
@@ -58,9 +58,10 @@ test('a new workspace goes through the setup wizard', async ({ page }) => {
   // 3) Invite team — waits for the background job, then offers its roles. Not asserting the
   // short "Preparing the roles…" state: on a slow machine the 2-second job is done before we look
   await expect(page.getByRole('heading', { level: 1, name: 'Invite your team' })).toBeVisible();
-  // The second pick is the one that was sent: garments roles, not pharma ones
+  // The second pick is the one that was sent: garments roles, not pharma ones — and the chart
+  // came with them (the mock's garments chart has 41 accounts)
   await expect(page.getByRole('status')).toHaveText(
-    /Roles ready: Accountant, Merchandiser, Store keeper/,
+    /Roles ready: Accountant, Merchandiser, Store keeper\. Chart of accounts: 41 accounts\./,
   );
 
   // Back from here reaches the company details, but no further: the business type is sent
```

---

## 9.11 — Root files

No new package, no new `.env` line, no change to `.gitignore` or the CI workflow.

```bash
pnpm gen:openapi     # openapi.json — 41 paths (37 before); commit it
```

---

## 9.12 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Components", after "Data table":

> - **Tree list:** `TreeList` from `@omnivo/ui`, for lists with a parent (chart of accounts, product categories).
>   A card (`surface`, 1px `line`, radius 14px, `shadow-sm`) of nested lists; rows 44px high with a 1px `line`
>   rule, hover `subtle`, indented 16px per level. Each group has a 28px show/hide button (`ArrowRight01` closed,
>   `ArrowDown01` open, 16px `ink-3`, no rotation) with `aria-expanded`; rows without children get an empty
>   28px box so codes line up. The page keeps the open state; while a search is on, every group on the way to a
>   match is open. Codes in `Geist Mono` `ink-3` `tabular-nums`, group names `ink`/500, others `ink-2`. A row
>   action that would repeat on every row (an "add here" button) shows on row hover or focus with a mouse
>   (`pointer-fine:`), always on touch screens.

And under "Form label", one more sentence: "A field never grows wider than its grid column (`Field` is
`grid-cols-1`)."

**build-plan.bn.md** — step 9's text: `ledger_accounts` টেবিল (tree, type: asset/liability/equity/income/expense,
parent FK-এ type — DB নিজেই টাইপ মেলায়), ছয় ইন্ডাস্ট্রির **template** (একটা standard chart + ইন্ডাস্ট্রির অংশ),
১০টা system account (`purpose`), পুরনো workspace-এর জন্য migration থেকে outbox job। Opening balance ধাপ ১০-এ,
প্রথম journal entry হিসেবে। And in "অগ্রগতি" nothing yet (the phase ends with step 11).

**COMMANDS.md** — in "Worker and queues (Valkey)", after the outbox query:

````markdown
```sh
# accounts per workspace (0 = the chart job has not run yet)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, count(a.id) FROM tenants t LEFT JOIN ledger_accounts a ON a.tenant_id = t.id GROUP BY t.slug"
# ask the worker to make a missing chart again (it does nothing if the chart exists)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "INSERT INTO outbox_events (id, tenant_id, type, payload) SELECT gen_random_uuid(), id, 'workspace.chart_requested', '{}' FROM tenants WHERE slug = '<slug>'"
```
````

(The second command connects as `postgres`, a superuser, so RLS does not apply to it.)

---

## 9.13 — Run it

```bash
pnpm db:migrate                               # 0013 + 0014
pnpm gen:openapi                              # commit it
pnpm dev                                      # API + app + worker; restart it if it was running
```

After `pnpm db:migrate` and a few seconds of `pnpm dev`, in `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = 'ledger_accounts';   -- t
SELECT type, published_at FROM outbox_events
 WHERE type = 'workspace.chart_requested';               -- one per set-up workspace, all published
SELECT t.slug, t.setup_status, count(a.id) FROM tenants t
  LEFT JOIN ledger_accounts a ON a.tenant_id = t.id GROUP BY 1, 2;   -- ready → 61–74, pending → 0
```

### What you will see

1. The worker's log: one `workspace.chart_requested … done in … ms` line per workspace you already had.
2. The sidebar has a new group **Accounting** → **Chart of accounts**. Your workspace shows the tree: Assets,
   Liabilities, Equity, Income, Expenses, all open. Ten accounts carry a grey **System** pill.
3. Search **vat**: Input VAT, Output VAT and "VAT and tax deducted at source" stay, inside their groups;
   everything else goes. Search **lc margin**: "No account matches "lc margin"".
4. **Collapse all** → five rows. Open Assets with its arrow → Current assets and Fixed assets.
5. Hover **Bank accounts** → a "+" appears on the right → click it. The dialog has Group "1120 · Bank accounts",
   "Asset · grows with a debit", Code **1121** already filled. Type the name "Dutch-Bangla Bank CD A/C 1234" →
   **Add account** → the toast, and the account under Bank accounts.
6. Add another one there: the code is now **1122**. Change it to **1110** → "Another account already uses this
   code." Change it back → saved.
7. Click **Dutch-Bangla Bank…** → change Group to "Mobile wallets" → **Save changes** → it moves. **Audit log** →
   "Chart of accounts": "Edited an account", Group: 1120 → 1130.
8. Click **Current assets** → the Group select offers only asset groups, and neither Current assets nor
   anything inside it.
9. Click **Accounts receivable** → "Omnivo posts what customers owe to this account by itself…", and no Archive
   or Delete button.
10. Click **Fixed assets** → **Archive** → "Archive the accounts under this group first."
11. Click an account you added → **Delete** → the warning → **Delete 1122** → gone.
12. **Sign up a new workspace** (private window), pick **Pharmaceuticals** in the wizard → the last step says
    "Roles ready: Accountant, Depot manager, Sales representative. Chart of accounts: 70 accounts." Its chart
    has "Medical promotion and samples" and "Finished goods" with the System pill.
13. **Bangla** (user menu → বাংলা): the page is "চার্ট অফ অ্যাকাউন্টস"; the account names stay English (decision 10).
14. A member without `accounting.account.manage` sees the tree, no "Add account", no "+", names not clickable,
    and the hint about the permission.
15. DevTools at 390 px: the toolbar wraps, the "+" is always visible, long names end with "…", and the page
    never scrolls sideways.
16. `pnpm test:e2e` → "42 passed".

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 130: contracts 38 + api 39 + ui 19 + app 16 + i18n 11 + auth 7
pnpm test:integration        # 113 — 12 new
pnpm test:tenant-leak        # 29 — 3 new
pnpm test:e2e                # 42: 21 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 175.0 KB gz; accounts 53.6, onboarding 56.0
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **`accounts` was taken** — by Better Auth since step 3. Hence `ledger_accounts` (decision 3).
- **drizzle-kit wrote the parent FK before its unique index**, and the migration would fail. One line moved by
  hand (9.2).
- **The first race test proved nothing.** It updated A before starting the API request; the foreign key's own
  row lock then serialised the two moves, and the test passed with the chart lock removed. Replaying the
  service's real order (lock A, start the second move, then update A) shows the deadlock and fails without the
  lock (9.5). Always break the guard and watch the test fail.
- **The per-move lock first planned would itself deadlock**: it was taken after the row lock. Taking one chart
  lock first, in every change, removed the whole class of problems (9.4).
- **`seedChart` needed a test of its own reason to exist.** A second backfill event without the check fails
  quietly with the same end state, so the test that proves it is the failed-setup retry (9.5).
- **`description` twice** in the same i18n object — the page subtitle and the field label (9.6).
- **A field wider than its column**, in `packages/ui`, since step 6 (9.7).
- **A page wider than the phone**, from the toolbar's unwrapped width (9.8).
- **`useWatch` inside a callback** (breaks React's rules of hooks) and **`className` on `TextField`** (its props
  do not take one) — both in the first draft of the page, fixed before the first run.
- **The e2e `group()` locator** — `has:` must start from `page`, and the group's own `<li>` is the last match,
  not the first (9.10).
- **An implicit `any`** in the mock's loop walk (9.9).

---

## Notes left for later steps

**Step 10 (journal):**

- Opening balances (decision 1): one journal entry, dated the day before go-live, with the difference to the
  account whose `purpose` is `opening_balance_equity`. Find it with `WHERE purpose = 'opening_balance_equity'`,
  never by code or name.
- `journal_lines` gets a composite FK `(tenant_id, account_id) → ledger_accounts (tenant_id, id)`; the target
  index exists already. In `AccountsService.remove()`, map `isForeignKeyViolation(error, '<that FK's name>')` to a
  new code `account_in_use` ("Archive it instead").
- Posting allows ledgers only (`is_group = false`) and active accounts only. Lock each line's account
  `FOR SHARE` in the posting transaction; `archive()` and `remove()` lock `FOR UPDATE`, so they wait for each
  other.
- The account picker: `accountsQuery`, filtered to `!isGroup && archivedAt === null`, labelled "1121 · Dutch-Bangla
  Bank…". `groupOptions()` shows how to indent.
- `settings.baseCurrency` (step 6's note) must stop being editable once the first entry is posted.

**Step 11 (reports):** group by `type` (stored on each row) and sum up the tree with a recursive query or in
code; `NORMAL_BALANCE` decides the sign. The balance column in the tree comes then.

**A new purpose in a later step** (for example `bank_charges` or `cod_receivable_*`): add it to
`ACCOUNT_PURPOSES`, the templates and `accounts.purposes.*` in both languages; existing charts need it too —
a migration that queues a small job (like 0014) whose handler adds just that account if no account has the
purpose. Never assign a purpose to an existing account by its name.

**Step 12 (products):** product categories are a tree: use `buildTree`, `filterTree` and `TreeList` from
`@omnivo/ui`, and the same table pattern (composite parent FK, a chart-style lock for moves, the recursive
loop check).

**Warnings:**

- Never trust a template change to reach existing workspaces. Templates are only read when a chart is made.
- Never look up a system account by code or name; codes and names belong to the company.
- Never delete a group's children to make its delete pass — archive them. A delete is for mistakes, not history.
