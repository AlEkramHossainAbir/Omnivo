# Step 10: The double-entry journal — entries, posting, reversal, ledgers, opening balances and the lock date

> The implementation guide for "Phase 3 → Step 10" of [build-plan.bn.md](build-plan.bn.md): which file gets what
> code, and which command runs where.
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `2c742b5`, the end of
> step 9) and checked on 2026-10-01: `pnpm dedupe --check`, `pnpm lint`,
> `pnpm format`, `pnpm typecheck`, `pnpm test` (145 — 15 new), `pnpm test:integration` (128 — 15 new),
> `pnpm test:tenant-leak` (32 — 3 new), `pnpm build`, `pnpm test:bundle-size` (first load 182.3 KB gz, budget 200;
> the journal pages 18–83 KB), `pnpm gen:openapi` (48 paths), `pnpm test:openapi`, `pnpm boundaries` and
> `pnpm test:e2e` (Playwright, 54 — 12 new, desktop and 390px) — all pass, with the turbo cache bypassed
> (`--force`). Two suites did not pass on every run; see the last note of this box.
>
> Also checked by hand:
>
> - **The upgrade of an existing database.** A fresh Postgres container on another port (55432), migrated to the end of step 9
>   (0000–0014) with `pnpm db:seed` and a small chart for its workspace. Then `pnpm db:migrate` from this step:
>   17 migrations, the old accounts kept, `ENABLE` + `FORCE` RLS on the three new tables, the three triggers and
>   the four new permissions. Then, as `omnivo_app` with the tenant set: a balanced entry posted the way
>   `PostingService` does it committed; a 100-against-90 entry failed at `COMMIT` ("does not balance: 2 lines,
>   debits 100.0000, credits 90.0000"); an `UPDATE` of the posted entry was refused; and without a tenant the
>   app role saw no rows at all.
> - **The screens.** Screenshots at 1280px and 390px of the journal, the entry form, a posted entry, the ledger
>   and the opening balances. They found one real bug (the opening balances' total row showed ৳0.00) and two
>   layout details; all three are fixed in this guide ("What we found on the way").
> - **Every guard broken on purpose.** Switch off the balance trigger (`WHEN (false)`) → "must balance even when
>   written by hand" fails. Remove the entry guard → "is never changed" fails. Make the line guard only warn →
>   the same test fails (after one fix to the test, see "What we found on the way"). Remove `assertPeriodOpen()`
>   from `post()` → the lock date test fails. Leave `journal_lines` out of 0016's RLS loop → the RLS coverage
>   test fails. Remove `checkLines()` from `create()` → the tenant-leak test fails (a 500 from the composite FK
>   instead of the 409). Remove `assertCanPost()` → the maker-checker test fails. Put the opening balances'
>   total bug back → the e2e test fails on desktop and phone.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database — nothing new is needed there
> (no new role, no new env line, no new package). (2) The new tests on GitHub
> Actions. (3) **The accounting rules have not been reviewed by an accountant** — the build plan asks for that
> before phase 3, and this step is the one it matters most for. Show them "The decisions behind this step" and
> the opening balances page. (4) The Bangla texts were written by me, not reviewed by a native speaker.
> >
> ⚠️ **Two suites were not clean on every run on this machine** (an 8-core laptop that was also running Chrome,
> VS Code and your `pnpm dev`). `pnpm test:integration`: 15 full runs, 10 clean; the other 5 had 1–5 failures —
> timeouts (vitest's 5 s per test, 10 s per hook) in step 6–9 files while the machine was busy, and twice step
> 8's "when the mail server is down" test, which takes the newest notification and sometimes gets an earlier
> invitation's failure notice. Run alternately on a quiet machine, step 9's base and this step both passed 4 of
> 4, so I cannot say whether this step (two more container-backed test files) makes the failures more likely.
> `pnpm test:e2e`: 54/54 in 4 of 5 runs; in one run under load (3.0 min instead of 1.5) 7 tests timed out, 3 of
> them from earlier steps. Neither is fixed here ("Notes left for later steps").

## Goal

📗 **The books themselves.** Step 9 made the list of accounts. This step makes the record of every amount that
moves between them: the journal. From step 15 on, a sales invoice, a supplier bill and a stock receipt all post
here through one internal function, so this step is the meeting point of every module (build plan §10).

After this step:

- **Journal entries.** A date, a narration and two or more lines; each line is a debit or a credit to one
  ledger account, optionally for one branch. An entry is a **draft** (can be edited or deleted) or **posted**
  (in the books for good). Posting gives it its number, `JV-2026-27-0001`, from the step 6 number series.
- **Double entry, enforced twice.** The API refuses to post an entry whose debits and credits differ. The
  database refuses it too, at commit, with a trigger — whatever any future code does.
- **Posted means frozen.** No API can change or delete a posted entry, and a database trigger stops even a
  superuser's `UPDATE`. A mistake is undone by a **reversal**: a new entry with every debit and credit swapped.
- **A ledger per account.** The posted lines of one account in date order, with an opening balance, a running
  balance and a closing balance.
- **Opening balances.** One page with every balance sheet account and a go-live date. Saving posts one entry
  dated the day before go-live; what the balances are out by goes to "Opening balance equity" (step 9's system
  account). Saving again reverses the old entry and posts a new one.
- **A lock date.** "The books are closed up to 30 September": nothing is posted or reversed on or before it.
- **`PostingService.postNew()`**, the one way into the books, for every later module.

## The whole picture

```
packages/contracts   journal.ts: statuses, sources, the schemas, 12 routes (journal, ledger, opening, lock)
      │               money.ts: amountSchema, and exact sums in BigInt (contracts stays on zod alone)
      │               4 permissions · 7 audit actions · entity 'journal_entry' · 20 error codes
      ▼
packages/db          journal_entries · journal_lines · period_locks
                     0015 (drizzle, one line moved) · 0016 (RLS + three triggers: frozen, frozen lines, balanced)
      │
      ▼
apps/api             JournalModule
                       PostingService: checkLines, writeLines, insertDraft, post, postNew  ← later modules
                       JournalService: list, get, create, update, delete, post, reverse
                       LedgerService · OpeningBalancesService · PeriodLockService (+ assertPeriodOpen)
                     AccountsService: account_in_use · SettingsService: base currency locked
      │
      ▼
packages/ui          Select (the select box without a label) · DatePicker loads its calendar lazily
apps/app             /journal · /journal/new · /journal/$entryId · /ledger?account= · /opening-balances
                     nav "Accounting": Journal, Ledger, Opening balances
                     MSW: the same rules on arrays, five posted entries and a draft for the garments workspace

one entry, from "Post entry" to the ledger:
  accountant ──POST /journal-entries {date, lines, post: true}──► API tx:
     check accounts (FOR SHARE) → insert draft + lines → lock date (shared lock) → balanced? →
     number (JV-…) → UPDATE status = 'posted' → audit → COMMIT → the database checks the balance again
  the page invalidates ['journal', tenant] → the list, the ledger and the opening balances refetch
```

## The decisions behind this step

You chose the first four on 2026-10-01; the others follow from them or from the build plan.

1. **The period lock is one lock date.** (You chose this.) One date per workspace: "closed up to and including
   this day". Nothing is posted or reversed on or before it. Closing September means moving the date to
   30 September; reopening means moving it back (both in the audit log). A table of months, each open or closed,
   was the other option: more rows, more screens, and odd states such as an open month between two closed ones.
2. **Draft → posted, with separate permissions.** (You chose this.) `accounting.journal.create` writes, edits and
   deletes drafts; `accounting.journal.post` posts and reverses. Give both to one role and that person posts
   alone; give them to two roles and you have maker-checker. **The number is given when an entry is posted**,
   inside the same transaction (step 6's counter), so posted numbers have no gaps and drafts have none.
3. **Opening balances have their own page.** (You chose this.) The page posts one ordinary journal entry, dated
   the day before go-live (step 9's decision 1). Balance sheet accounts only — income and expenses start at zero
   on the go-live day, and the profit of earlier years is already inside Retained earnings. Saving again reverses
   the old entry and posts a new one, so the history stays in the journal.
4. **An optional branch on every line.** (You chose this.) For branch-wise profit and loss later. Per line, not
   per entry, so one entry can split a cost between the Gazipur factory and the head office.
5. **Two more permissions: read and close.** The journal holds salaries and margins, so reading it needs
   `accounting.journal.read` (the chart of accounts stays readable by everyone). Moving the lock date needs
   `accounting.period.close`, because reopening a closed month changes what reports already said. The decision
   above ("two permissions") was about the draft/post workflow; these two are outside it.
6. **Every posting goes through draft.** `postNew()` inserts a draft, adds the lines, then posts it. So lines are
   only ever added to a draft, and the database trigger can simply say "no line changes on a posted entry".
7. **The database enforces double entry at COMMIT.** A `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` checks
   each posted entry when the transaction commits, when all its lines are in place: at least two lines, debits
   equal credits, no line on a group account. The API checks the same things first, to give a readable error.
8. **A reversal is the only correction.** It is a new posted entry with `source = 'reversal'` and
   `reversal_of_id` pointing at the original. A unique index allows one reversal per entry. A reversal cannot be
   reversed (that would put the mistake back), and it cannot be dated before its entry.
9. **Locks, not hope.** Posting takes a *shared* advisory lock on "this tenant's lock date"; changing the lock
   date takes it *exclusive*. Postings never wait for each other, but a posting can never commit into a month
   that was closed while it ran. Posting also locks each line's account `FOR SHARE`, which waits for step 9's
   archive/delete (`FOR UPDATE`) — the note step 9 left for this step.
10. **Money stays a decimal string.** `NUMERIC(19,4)` in the database and strings on the wire (CLAUDE.md →
    Money). Sums are exact: BigInt in ten-thousandths of a taka (10.1), because `packages/contracts` may depend
    on zod only (the `contracts-only-zod` boundary) and the journal only adds and subtracts — nothing is
    rounded. `decimal.js` stays where rounding happens (`MoneyInput`, and later VAT and prices). The journal, ledger and opening balances show **2 decimals**: an accounting page whose
    totals must visibly add up cannot round ৳18,450.50 to ৳18,451. CLAUDE.md's "no decimals" stays for
    dashboards and lists (see 10.11).
11. **Balances are signed debit-minus-credit.** The ledger API sends `-1200.0000` for a credit balance; the page
    shows "৳1,200.00 Cr". The sign never depends on the account type, so the client never guesses.
12. **Online only.** The system design lists journal posting and period close as server-authoritative (§7.1).
    No offline queue for the journal.

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Trial balance, P&L, balance sheet, year close | Step 11. It reads `journal_lines` of posted entries and uses the lock date for year close |
| Customer and supplier sub-ledgers | With invoices and bills (steps 15–16). The receivable is one account for now |
| Multi-currency entries | Phase 2 (build plan §5). Entries are in the base currency, which is now locked once posted |
| Recurring entries, templates, attachments on entries | Later, when someone asks |
| Approval queue with notifications ("3 drafts wait for you") | Maker-checker works with the two permissions; a queue is a later convenience |
| Editing a posted entry | Never (decision 8) |
| Offline journal | Never (decision 12) |
| Import of opening balances from Excel/Tally | With the first imports (step 12) |
| Partitioning `journal_lines` by month | When a tenant has millions of lines (system design §5) |

## What changes in the code you already have

- **Nothing to install or create by hand.** No new package, no new database role, no new `.env` line.
- **`pnpm db:migrate`** adds the three tables and the triggers, and the four permissions (`syncPermissions()`).
  Nothing is backfilled: the lock date row is made the first time someone sets it.
- `setup/templates.ts`: the Accountant role of **new** workspaces gets the four journal permissions. Existing
  workspaces keep their roles; an owner ticks the boxes on the Roles page.
- `AccountsService.remove()`: an account that a journal line uses answers `account_in_use` ("Archive it
  instead") — the note step 9 left.
- `SettingsService.update()`: the base currency cannot change once an entry is posted — step 6's note.
- `packages/ui`: a bare `Select` (the box without the label), and `DatePicker` loads its calendar only when it
  opens (10.6).
- `branchesQuery` moves from `routes/branches.tsx` to `lib/queries.ts`, because journal lines pick branches too.
- The sidebar's "Accounting" group gets Journal, Ledger and Opening balances (for `accounting.journal.read`).

---

## 10.1 — `packages/contracts`: the contract

### Money

**File: `packages/contracts/src/money.ts`** (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';

// Money is a decimal string end to end, never a JavaScript number (CLAUDE.md → Money). The
// database column is NUMERIC(19,4): at most 15 digits before the point and 4 after it.
const MONEY = /^\d{1,15}(?:\.\d{1,4})?$/;

// One side of a journal line, as a form sends it: '' (an empty box) means nothing on this side.
// The API stores '0' for it, so the database never holds two kinds of "nothing".
export const amountSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || MONEY.test(value), errorCode('money_format'))
  .transform((value) => (value === '' ? '0' : value));

// The arithmetic below works in ten-thousandths of a taka, as BigInt: "18450.5" is 184505000n.
// Exact like decimal.js for what the journal does — adding and subtracting amounts with at most
// 4 decimals, so nothing is ever rounded — and it keeps this package on zod alone (the
// contracts-only-zod boundary: the API and the browser both load it). Rounding, when a later step
// multiplies (VAT, quantity × price), stays with decimal.js where that happens.
const UNITS_PER_TAKA = 10_000n;
const AMOUNT = /^(-?)(\d+)(?:\.(\d{1,4}))?$/;

function toUnits(value: string): bigint {
  const match = AMOUNT.exec(value);
  const whole = match?.[2];
  if (match === null || whole === undefined) throw new Error(`Not a money amount: "${value}"`);
  const fraction = (match[3] ?? '').padEnd(4, '0');
  const units = BigInt(whole) * UNITS_PER_TAKA + BigInt(fraction);
  return match[1] === '-' ? -units : units;
}

// Always 4 decimals, like Postgres sends NUMERIC(19,4), so two results compare as plain strings.
// Zero has no minus sign.
function fromUnits(units: bigint): string {
  const size = units < 0n ? -units : units;
  const fraction = String(size % UNITS_PER_TAKA).padStart(4, '0');
  return `${units < 0n ? '-' : ''}${String(size / UNITS_PER_TAKA)}.${fraction}`;
}

// '' counts as 0, so a half-filled form can be totalled while it is typed
export function isZeroMoney(value: string): boolean {
  return value === '' || toUnits(value) === 0n;
}

export function sumMoney(values: readonly string[]): string {
  return fromUnits(
    values.reduce((total, value) => total + (value === '' ? 0n : toUnits(value)), 0n),
  );
}

// a − b: the difference between the debit and the credit total, and the running balances
export function subtractMoney(a: string, b: string): string {
  return fromUnits(toUnits(a) - toUnits(b));
}

export function addMoney(a: string, b: string): string {
  return fromUnits(toUnits(a) + toUnits(b));
}

export function isNegativeMoney(value: string): boolean {
  return toUnits(value) < 0n;
}

// |value|: a ledger shows "৳1,200 Cr", not "-৳1,200"
export function absMoney(value: string): string {
  const units = toUnits(value);
  return fromUnits(units < 0n ? -units : units);
}
```

- **`amountSchema`.** A form's money box sends `''` when it is empty, so `''` is valid and becomes `'0'`. The
  database never stores two kinds of nothing. The regex allows what `NUMERIC(19,4)` holds: 15 digits before
  the point and 4 after. It refuses `-5` (a negative amount goes on the other side), `1,200` (the form's
  `MoneyInput` already removes commas) and `1e5`.
- **BigInt in ten-thousandths, not decimal.js.** `"18450.5"` becomes `184505000n`. Adding and subtracting whole
  ten-thousandths is exact, like decimal.js, for any size of amount (BigInt has no limit), and never a
  JavaScript `number` (`0.1 + 0.2`). The first version used decimal.js here and failed `pnpm boundaries`:
  `packages/contracts` is loaded by the API and the browser, so it may depend on zod only. When a later step
  multiplies and must round (VAT, quantity × price), decimal.js does that where it happens.
- **`toUnits` refuses anything else** with an error: these functions only ever see validated amounts and
  Postgres's `numeric` strings, so a wrong value is a bug to see, not to guess around.
- **`fromUnits` always writes 4 decimals**, like Postgres sends `"500000.0000"`. So two sums compare as plain
  strings (`debits !== credits`), with no parsing. Zero never gets a minus sign: `0 − 0` is `"0.0000"`, and a zero
  difference has no side.
- **`isZeroMoney('')` is `true`**, so a half-filled form can be totalled while it is typed.

### The journal

**File: `packages/contracts/src/journal.ts`** (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { amountSchema, isZeroMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// A draft can still be edited or deleted; a posted entry is in the books for good. A mistake in a
// posted entry is undone by a reversal (a new entry with the sides swapped), never by an edit.
export const JOURNAL_STATUSES = ['draft', 'posted'] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

// Where an entry comes from. Each later module that posts (sales invoice, bill, stock receipt)
// adds its own source here. The response sends it as z.string() — like an account's purpose — so a
// newer server's new source does not break an older offline client.
export const JOURNAL_SOURCES = ['manual', 'opening_balance', 'reversal'] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

export function isJournalSource(value: string): value is JournalSource {
  return JOURNAL_SOURCES.some((source) => source === value);
}

// '2026-07-01' and -1 → '2026-06-30'. The arithmetic runs in UTC, so no time zone can move the
// day (the same reason periodOf() reads the parts of the string, numbering.ts).
export function shiftIsoDate(isoDate: string, days: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// A real entry has a handful of lines; a payroll or an opening balance a few hundred at most
export const MAX_JOURNAL_LINES = 200;

const entryRefSchema = z.object({ id: z.uuid(), number: z.string() });

export const journalLineSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  branchId: z.uuid().nullable(),
  description: z.string().nullable(),
  // Decimal strings with 4 places, as Postgres sends NUMERIC(19,4): "18500.0000". One side is
  // always "0.0000".
  debit: z.string(),
  credit: z.string(),
});
export type JournalLine = z.infer<typeof journalLineSchema>;

// What the list shows: the entry without its lines
export const journalEntrySummarySchema = z.object({
  id: z.uuid(),
  // null while a draft: the number is given when the entry is posted, so the numbers have no gaps
  number: z.string().nullable(),
  // The business date, without time or time zone (system-design §10)
  date: z.iso.date(),
  narration: z.string().nullable(),
  status: z.enum(JOURNAL_STATUSES),
  source: z.string(),
  // The sum of the debits (= the sum of the credits once posted)
  total: z.string(),
  // This entry undoes reversalOf; reversedBy undid this entry
  reversalOf: entryRefSchema.nullable(),
  reversedBy: entryRefSchema.nullable(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type JournalEntrySummary = z.infer<typeof journalEntrySummarySchema>;

export const journalEntrySchema = journalEntrySummarySchema.extend({
  lines: z.array(journalLineSchema),
});
export type JournalEntry = z.infer<typeof journalEntrySchema>;

// The form's "No branch" option sends ''
const branchIdSchema = z
  .union([z.uuid(), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

// Exactly one side has an amount. Both empty or both filled is the same mistake for the person:
// "put the amount on one side". The error sits under Debit, where the eye starts.
export const journalLineInputSchema = z
  .object({
    // The form's empty "Account" select sends '' — "not chosen", not a broken id
    accountId: z.uuid(errorCode('journal_account_required')),
    branchId: branchIdSchema,
    description: optionalText(200),
    debit: amountSchema,
    credit: amountSchema,
  })
  .refine((line) => isZeroMoney(line.debit) !== isZeroMoney(line.credit), {
    error: errorCode('journal_line_amount'),
    path: ['debit'],
  });
export type JournalLineInput = z.infer<typeof journalLineInputSchema>;

export const journalEntryInputSchema = z.object({
  date: z.iso.date(errorCode('journal_date_required')),
  narration: optionalText(300),
  lines: z
    .array(journalLineInputSchema)
    .min(2, errorCode('journal_lines_too_few'))
    .max(MAX_JOURNAL_LINES),
  // true = the form's "Post": save and post in one step, or nothing at all. Needs both
  // accounting.journal.create and accounting.journal.post. false = keep it a draft.
  post: z.boolean(),
});
export type JournalEntryInput = z.infer<typeof journalEntryInputSchema>;

export const updateJournalEntryInputSchema = journalEntryInputSchema.extend({
  version: versionSchema,
});
export type UpdateJournalEntryInput = z.infer<typeof updateJournalEntryInputSchema>;

export const journalVersionInputSchema = z.object({ version: versionSchema });

export const reverseJournalEntryInputSchema = z.object({
  version: versionSchema,
  // Usually today, or the original's date to cancel it in the same period
  date: z.iso.date(errorCode('journal_date_required')),
});

export const deleteJournalEntryQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const journalListQuerySchema = pageQuerySchema.extend({
  status: z.enum(JOURNAL_STATUSES).optional(),
});

export const journalPageSchema = pageOf(journalEntrySummarySchema);

const entryParamsSchema = z.object({ id: z.uuid() });

export const journalRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/journal-entries',
    summary: 'Journal entries, newest date first',
    auth: 'bearer',
    permission: 'accounting.journal.read',
    status: 200,
    query: journalListQuerySchema,
    response: journalPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/journal-entries/:id',
    summary: 'One journal entry with its lines',
    auth: 'bearer',
    permission: 'accounting.journal.read',
    status: 200,
    params: entryParamsSchema,
    response: journalEntrySchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/journal-entries',
    summary: 'Write a journal entry as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'accounting.journal.create',
    status: 201,
    body: journalEntryInputSchema,
    response: journalEntrySchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/journal-entries/:id',
    summary: 'Change a draft, and optionally post it',
    auth: 'bearer',
    permission: 'accounting.journal.create',
    status: 200,
    params: entryParamsSchema,
    body: updateJournalEntryInputSchema,
    response: journalEntrySchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/journal-entries/:id',
    summary: 'Delete a draft (a posted entry is reversed instead)',
    auth: 'bearer',
    permission: 'accounting.journal.create',
    status: 204,
    params: entryParamsSchema,
    query: deleteJournalEntryQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/journal-entries/:id/post',
    summary: 'Post a draft as it is: it gets its number and enters the books',
    auth: 'bearer',
    permission: 'accounting.journal.post',
    status: 200,
    params: entryParamsSchema,
    body: journalVersionInputSchema,
    response: journalEntrySchema,
  }),
  reverse: defineRoute({
    method: 'POST',
    path: '/journal-entries/:id/reverse',
    summary: 'Undo a posted entry with a new entry that swaps its debits and credits',
    auth: 'bearer',
    permission: 'accounting.journal.post',
    status: 201,
    params: entryParamsSchema,
    body: reverseJournalEntryInputSchema,
    response: journalEntrySchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// The ledger of one account: its posted lines in date order, with a running balance

export const ledgerQuerySchema = pageQuerySchema.extend({
  // Both included. Without `from`, the ledger starts at the first entry.
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

// Every balance is debit minus credit: positive = a debit balance ("Dr"), negative = a credit
// balance ("Cr"). The sign does not depend on the account's type, so the app shows Dr/Cr and
// never has to guess what "plus" means for a liability.
export const ledgerLineSchema = z.object({
  lineId: z.uuid(),
  entryId: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  narration: z.string().nullable(),
  description: z.string().nullable(),
  debit: z.string(),
  credit: z.string(),
  balance: z.string(),
});
export type LedgerLine = z.infer<typeof ledgerLineSchema>;

export const ledgerPageSchema = pageOf(ledgerLineSchema).extend({
  // The balance before `from`, and after `to` — the same on every page
  openingBalance: z.string(),
  closingBalance: z.string(),
});
export type LedgerPage = z.infer<typeof ledgerPageSchema>;

export const ledgerRoutes = {
  get: defineRoute({
    method: 'GET',
    path: '/accounts/:id/ledger',
    summary: "An account's posted lines in date order, with the running balance",
    auth: 'bearer',
    permission: 'accounting.journal.read',
    status: 200,
    params: z.object({ id: z.uuid() }),
    query: ledgerQuerySchema,
    response: ledgerPageSchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// Opening balances: what each balance sheet account held the day before the company moved its
// books to Omnivo. Saved as one posted journal entry; the difference goes to the account whose
// purpose is 'opening_balance_equity'.

export const openingBalanceLineSchema = z.object({
  accountId: z.uuid(),
  debit: z.string(),
  credit: z.string(),
});

export const openingBalancesSchema = z.object({
  // The first day on Omnivo. The entry is dated the day before.
  goLiveDate: z.iso.date().nullable(),
  // The posted entry that holds them now; null before the first save
  entry: entryRefSchema.nullable(),
  // Without the opening balance equity line: the server makes that one
  lines: z.array(openingBalanceLineSchema),
});
export type OpeningBalances = z.infer<typeof openingBalancesSchema>;

export const openingBalancesInputSchema = z.object({
  goLiveDate: z.iso.date(errorCode('opening_date_required')),
  // The entry the page was opened with. If someone saved other opening balances since, the
  // server answers version_conflict instead of reversing an entry this person never saw.
  replaces: z.uuid().nullable(),
  // Zero on both sides = no opening balance for that account; such lines are dropped
  lines: z
    .array(
      z
        .object({ accountId: z.uuid(), debit: amountSchema, credit: amountSchema })
        .refine((line) => isZeroMoney(line.debit) || isZeroMoney(line.credit), {
          error: errorCode('journal_line_amount'),
          path: ['debit'],
        }),
    )
    .max(1000),
});
export type OpeningBalancesInput = z.infer<typeof openingBalancesInputSchema>;

export const openingBalanceRoutes = {
  get: defineRoute({
    method: 'GET',
    path: '/opening-balances',
    summary: 'The opening balances and the go-live date',
    auth: 'bearer',
    permission: 'accounting.journal.read',
    status: 200,
    response: openingBalancesSchema,
  }),
  save: defineRoute({
    method: 'PUT',
    path: '/opening-balances',
    summary: 'Post the opening balances, reversing the ones posted before',
    auth: 'bearer',
    permission: 'accounting.journal.post',
    status: 200,
    body: openingBalancesInputSchema,
    response: openingBalancesSchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// The lock date: the books are closed up to and including this day. Nothing is posted or
// reversed on or before it. Closing September = setting it to 30 September.

export const periodLockSchema = z.object({
  lockDate: z.iso.date().nullable(),
  // 0 = never set (no row yet), like the number series
  version: z.number().int().min(0),
});
export type PeriodLock = z.infer<typeof periodLockSchema>;

export const periodLockInputSchema = z.object({
  // The date picker sends '' for "no lock": the books are open again
  lockDate: z
    .union([z.iso.date(), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable(),
  version: z.number().int().min(0),
});
export type PeriodLockInput = z.infer<typeof periodLockInputSchema>;

export const periodLockRoutes = {
  get: defineRoute({
    method: 'GET',
    path: '/period-lock',
    summary: 'The date up to which the books are closed',
    auth: 'bearer',
    permission: 'accounting.journal.read',
    status: 200,
    response: periodLockSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/period-lock',
    summary: 'Close the books up to a date, or open them again',
    auth: 'bearer',
    permission: 'accounting.period.close',
    status: 200,
    body: periodLockInputSchema,
    response: periodLockSchema,
  }),
};
```

Top to bottom:

- **`JOURNAL_STATUSES` is a real enum, `source` is not.** There will only ever be draft and posted. Sources grow
  with every module (`sales.invoice` in step 15), so the response sends `source` as `z.string()` — an offline
  client from last month must not fail to read an entry from a newer server (the same rule as purposes in step 9).
  `isJournalSource()` narrows it in the app.
- **`shiftIsoDate`** reads the parts of the string and does the arithmetic in UTC. `new Date('2026-07-01')`
  plus local `getDate()` would move the day on a machine west of UTC (the same trap step 6 documented in
  `periodOf()`). It is used for "the day before go-live".
- **`MAX_JOURNAL_LINES = 200`.** A payroll entry with one line per department fits; a runaway client does not.
- **`journalLineSchema` amounts are strings with 4 decimals**, one side always `"0.0000"`.
- **`journalEntrySummarySchema`** is what the list shows, without lines. `total` is the sum of the debits;
  `reversalOf`/`reversedBy` are `{ id, number }` so the page can link both ways without another request.
- **`branchIdSchema`.** The line's "No branch" option sends `''`; the union turns it into `null`.
- **`journalLineInputSchema` — exactly one side.** `isZeroMoney(debit) !== isZeroMoney(credit)`: both empty and
  both filled are the same mistake for the person ("put the amount on one side"), so one code,
  `journal_line_amount`, under Debit. Zod runs an object's `refine` only when its fields parsed, so an empty
  account select shows "Pick an account" alone, not two errors.
- **`journalEntryInputSchema` does not check the balance.** A draft may be out of balance while it is written.
  The balance is checked when posting (10.3), where the error can say so.
- **`post: boolean`.** The form's "Post entry" saves and posts in one request, all or nothing. If posting fails
  (out of balance, closed period), nothing is saved — the person fixes the form and presses Post again, instead
  of finding a half-saved draft.
- **`deleteJournalEntryQuerySchema`** — the version travels in the query string, like `DELETE /roles/:id`.
- **The routes.** Reading needs `accounting.journal.read`, writing drafts `…create`, posting and reversing
  `…post`. `reverse` answers `201` with the **new** entry, because it creates one.
- **The ledger's balances are debit minus credit** (decision 11). `ledgerPageSchema` extends the usual page with
  `openingBalance` (before `from`) and `closingBalance` (up to `to`), the same on every page of the list.
- **Opening balances.** `replaces` is the id of the entry the page was opened with. It works like a version: if
  someone saved other opening balances since, the server answers `version_conflict` instead of reversing an
  entry this person never saw. Lines with both sides empty are allowed and dropped, because the page sends a
  row for every account.
- **The lock date.** `version: 0` means "never set" (no row yet), like the number series. The date picker sends
  `''` to clear it.

### Registries

**File: `packages/contracts/src/permissions.ts`** (change)

```diff
@@ -10,6 +10,10 @@ export const PERMISSION_KEYS = [
   'core.branch.manage',
   'core.audit.read',
   'accounting.account.manage',
+  'accounting.journal.read',
+  'accounting.journal.create',
+  'accounting.journal.post',
+  'accounting.period.close',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -34,4 +38,8 @@ export const PERMISSION_GROUP_OF = {
   'core.branch.manage': 'workspace',
   'core.audit.read': 'workspace',
   'accounting.account.manage': 'accounting',
+  'accounting.journal.read': 'accounting',
+  'accounting.journal.create': 'accounting',
+  'accounting.journal.post': 'accounting',
+  'accounting.period.close': 'accounting',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

- Four keys in the "accounting" group (decisions 2 and 5). The build fails until each has a text in `en.ts`/
  `bn.ts` and a description in `packages/db`.

**File: `packages/contracts/src/errors.ts`** (change)

```diff
@@ -68,6 +68,27 @@ export const ERROR_CODES = [
   'account_locked',
   'account_has_children',
   'account_has_active_children',
+  'account_in_use',
+  // journal
+  'money_format',
+  'journal_date_required',
+  'journal_account_required',
+  'journal_line_amount',
+  'journal_lines_too_few',
+  'journal_unbalanced',
+  'journal_account_invalid',
+  'journal_branch_invalid',
+  'journal_period_locked',
+  'journal_not_draft',
+  'journal_not_posted',
+  'journal_is_reversal',
+  'journal_already_reversed',
+  'journal_reversal_date',
+  'opening_date_required',
+  'opening_account_invalid',
+  'opening_account_twice',
+  'period_lock_future',
+  'base_currency_locked',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- One code per thing the person must do differently, each with its own sentence in 10.5. `account_in_use` is
  step 9's "note for step 10".

**File: `packages/contracts/src/audit.ts`** (change)

```diff
@@ -34,6 +34,13 @@ export const AUDIT_ACTIONS = [
   'account.archived',
   'account.restored',
   'account.deleted',
+  'journal.created',
+  'journal.updated',
+  'journal.deleted',
+  'journal.posted',
+  'journal.reversed',
+  'journal.opening_balances_saved',
+  'books.lock_date_changed',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -52,6 +59,7 @@ export const AUDIT_ENTITY_TYPES = [
   'invitation',
   'role',
   'account',
+  'journal_entry',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
```

- `journal.posted` is separate from `journal.created`: with maker-checker they are two people, and the audit log
  must show both.
- The lock date and the opening balances are workspace-level, so their rows use `entityType: 'workspace'`.

**File: `packages/contracts/src/routes.ts`** (change)

```diff
@@ -7,6 +7,7 @@ import { authRoutes } from './auth.js';
 import { branchRoutes } from './branches.js';
 import { defineRoute } from './http.js';
 import { invitationRoutes } from './invitations.js';
+import { journalRoutes, ledgerRoutes, openingBalanceRoutes, periodLockRoutes } from './journal.js';
 import { memberRoutes } from './members.js';
 import { notificationRoutes } from './notifications.js';
 import { numberSeriesRoutes } from './numbering.js';
@@ -43,4 +44,8 @@ export const routes = {
   setup: setupRoutes,
   notifications: notificationRoutes,
   accounts: accountRoutes,
+  journal: journalRoutes,
+  ledger: ledgerRoutes,
+  openingBalances: openingBalanceRoutes,
+  periodLock: periodLockRoutes,
 };
```

**File: `packages/contracts/src/index.ts`** (change)

```diff
@@ -7,7 +7,9 @@ export * from './errors.js';
 export * from './fields.js';
 export * from './http.js';
 export * from './invitations.js';
+export * from './journal.js';
 export * from './members.js';
+export * from './money.js';
 export * from './notifications.js';
 export * from './numbering.js';
 export * from './pagination.js';
```

### Unit tests

**File: `packages/contracts/src/money.spec.ts`** (new)

```ts
import { describe, expect, it } from 'vitest';

import {
  absMoney,
  addMoney,
  amountSchema,
  isNegativeMoney,
  isZeroMoney,
  subtractMoney,
  sumMoney,
} from './money.js';

describe('money', () => {
  it('sums exactly, where JavaScript numbers drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMoney(['0.1', '0.2'])).toBe('0.3000');
    // More digits than a double holds exactly: 2^53 + 1
    expect(sumMoney(['9007199254740993', '0.0001'])).toBe('9007199254740993.0001');
  });

  it('counts an empty box as zero, so a half-filled form adds up', () => {
    expect(sumMoney(['', '1250.5', ''])).toBe('1250.5000');
    expect(subtractMoney('100', '250.25')).toBe('-150.2500');
    expect(isZeroMoney('')).toBe(true);
    expect(isZeroMoney('0.0000')).toBe(true);
    expect(isZeroMoney('0.0001')).toBe(false);
    expect(isZeroMoney('-0.0000')).toBe(true);
    expect(isZeroMoney('100')).toBe(false);
  });

  it('keeps the sign right around zero, and never writes "-0"', () => {
    expect(subtractMoney('0', '0')).toBe('0.0000');
    expect(subtractMoney('0.05', '0.1')).toBe('-0.0500');
    expect(addMoney('-0.0500', '0.05')).toBe('0.0000');
    expect(isNegativeMoney('-0.0000')).toBe(false);
    expect(isNegativeMoney('-0.0001')).toBe(true);
    expect(absMoney('-1200.5')).toBe('1200.5000');
  });

  it('takes up to 15 digits and 4 decimals, and stores an empty box as 0', () => {
    expect(amountSchema.parse(' 18500.25 ')).toBe('18500.25');
    expect(amountSchema.parse('')).toBe('0');
    for (const bad of ['-5', '1,200', '12.34567', '1'.repeat(16), 'abc', '1e5']) {
      expect(amountSchema.safeParse(bad).error?.issues[0]?.message, bad).toBe('money_format');
    }
  });
});
```

- The first test shows why: `0.1 + 0.2` is not `0.3` in JavaScript, and `2^53 + 1` cannot be held exactly.
- The third test pins the sign rules around zero, the place where hand-written decimal code usually goes wrong.

**File: `packages/contracts/src/journal.spec.ts`** (new)

```ts
import { describe, expect, it } from 'vitest';

import { journalEntryInputSchema, periodLockInputSchema, shiftIsoDate } from './journal.js';

const cash = '01939d1c-0000-7000-8000-000000000001';
const capital = '01939d1c-0000-7000-8000-000000000002';

function entry(lines: object[]) {
  return { date: '2026-09-23', narration: 'Capital paid in', lines, post: false };
}

describe('journal entry input', () => {
  it('takes a line with an amount on exactly one side', () => {
    const parsed = journalEntryInputSchema.parse(
      entry([
        { accountId: cash, branchId: '', description: '', debit: '500000', credit: '' },
        { accountId: capital, branchId: null, description: '', debit: '', credit: '500000' },
      ]),
    );
    expect(parsed.lines[0]).toMatchObject({ branchId: null, debit: '500000', credit: '0' });
  });

  it('refuses a line with both sides, or neither, under Debit', () => {
    for (const [debit, credit] of [
      ['100', '100'],
      ['', ''],
      ['0', '0.00'],
    ]) {
      const result = journalEntryInputSchema.safeParse(
        entry([
          { accountId: cash, branchId: null, description: '', debit, credit },
          { accountId: capital, branchId: null, description: '', debit: '', credit: '100' },
        ]),
      );
      expect(result.error?.issues[0]).toMatchObject({
        path: ['lines', 0, 'debit'],
        message: 'journal_line_amount',
      });
    }
  });

  it('reads an empty account select and a missing date as "not chosen"', () => {
    const result = journalEntryInputSchema.safeParse({
      ...entry([
        { accountId: '', branchId: null, description: '', debit: '1', credit: '' },
        { accountId: capital, branchId: null, description: '', debit: '', credit: '1' },
      ]),
      date: '',
    });
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['date', 'journal_date_required'],
      ['lines.0.accountId', 'journal_account_required'],
    ]);
  });

  it('needs two lines; balancing is checked when posting, not here', () => {
    const one = [{ accountId: cash, branchId: null, description: '', debit: '1', credit: '' }];
    expect(journalEntryInputSchema.safeParse(entry(one)).error?.issues[0]?.message).toBe(
      'journal_lines_too_few',
    );
    // A draft may be out of balance while it is being written
    const unbalanced = [...one, { ...one[0], debit: '2' }];
    expect(journalEntryInputSchema.safeParse(entry(unbalanced)).success).toBe(true);
  });
});

describe('lock date input', () => {
  it('reads an empty date picker as "no lock"', () => {
    expect(periodLockInputSchema.parse({ lockDate: '', version: 0 }).lockDate).toBeNull();
    expect(periodLockInputSchema.parse({ lockDate: '2026-06-30', version: 2 }).lockDate).toBe(
      '2026-06-30',
    );
  });
});

describe('shiftIsoDate', () => {
  it('moves across months, years and leap days without a time zone', () => {
    expect(shiftIsoDate('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftIsoDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftIsoDate('2028-02-28', 1)).toBe('2028-02-29');
  });
});
```

- `['0', '0.00']` — two zeros are still "neither side".
- The third test checks the order and the codes of two errors at once: date and account.

---

## 10.2 — `packages/db`: three tables and two migrations

### The tables

**File: `packages/db/src/schema/journal.ts`** (new)

```ts
import { JOURNAL_SOURCES, JOURNAL_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { branches } from './branches.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { tenants } from './tenants.js';

// One journal entry: the header. Its debits and credits are the rows of journal_lines. Three
// rules live in the database itself (migration 0016), not only in the API:
// - a posted entry balances (sum of debits = sum of credits) and has at least two lines;
// - a posted entry and its lines never change and are never deleted;
// - lines of a posted entry post to ledgers only, never to a group.
export const journalEntries = pgTable(
  'journal_entries',
  {
    // deleted_at (from baseColumns) is not used: a draft is deleted for real, a posted entry never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when the entry is posted (NumberingService), so posted numbers have no gaps
    number: text('number'),
    // mode 'string': a business date is "2026-09-23", not a Date at midnight in some time zone
    date: date('date', { mode: 'string' }).notNull(),
    narration: text('narration'),
    status: text('status', { enum: JOURNAL_STATUSES }).notNull().default('draft'),
    source: text('source', { enum: JOURNAL_SOURCES }).notNull().default('manual'),
    // Set on a reversal: the entry it undoes
    reversalOfId: uuid('reversal_of_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    // The target of the composite FKs below (lines → entry, reversal → original)
    uniqueIndex('journal_entries_tenant_id_idx').on(table.tenantId, table.id),
    // Drafts have no number; NULLs never collide in a unique index
    uniqueIndex('journal_entries_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('journal_entries_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // An entry is reversed at most once. Two people pressing Reverse at the same time: the
    // second insert fails here, whatever the code checked before.
    uniqueIndex('journal_entries_tenant_reversal_idx')
      .on(table.tenantId, table.reversalOfId)
      .where(sql`${table.reversalOfId} IS NOT NULL`),
    foreignKey({
      name: 'journal_entries_reversal_fk',
      columns: [table.tenantId, table.reversalOfId],
      foreignColumns: [table.tenantId, table.id],
    }),
    // Posted ⇔ it has a number and a posting time. A draft with a number, or a posted entry
    // without one, cannot exist.
    check(
      'journal_entries_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
    check(
      'journal_entries_reversal_check',
      sql`(${table.source} = 'reversal') = (${table.reversalOfId} IS NOT NULL)`,
    ),
  ],
);

// The debits and credits. No created_at/updated_by of their own: a line is part of its entry,
// written with it (the entry's columns say who and when), and never changed after posting.
export const journalLines = pgTable(
  'journal_lines',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    entryId: uuid('entry_id').notNull(),
    // The order the person wrote the lines in
    lineNo: smallint('line_no').notNull(),
    accountId: uuid('account_id').notNull(),
    // Optional: which branch the amount belongs to (branch-wise P&L later)
    branchId: uuid('branch_id'),
    description: text('description'),
    // NUMERIC(19,4), read and written as strings: never a JavaScript number
    debit: numeric('debit', { precision: 19, scale: 4 }).notNull().default('0'),
    credit: numeric('credit', { precision: 19, scale: 4 }).notNull().default('0'),
  },
  (table) => [
    uniqueIndex('journal_lines_entry_line_idx').on(table.tenantId, table.entryId, table.lineNo),
    // An account's ledger, and Postgres's own check of the account FK when an account is deleted
    index('journal_lines_tenant_account_idx').on(table.tenantId, table.accountId),
    // Deleting a draft deletes its lines. A posted entry is never deleted (the trigger in 0016).
    foreignKey({
      name: 'journal_lines_entry_fk',
      columns: [table.tenantId, table.entryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }).onDelete('cascade'),
    // The step 9 index (tenant_id, id) is the target. An account with lines cannot be deleted:
    // the API turns this FK's error into account_in_use.
    foreignKey({
      name: 'journal_lines_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    // NULL branch_id skips the check (MATCH SIMPLE)
    foreignKey({
      name: 'journal_lines_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    // Exactly one side has an amount, and neither is negative
    check(
      'journal_lines_one_side',
      sql`${table.debit} >= 0 AND ${table.credit} >= 0 AND (${table.debit} = 0) <> (${table.credit} = 0)`,
    ),
  ],
);

// The lock date: the books are closed up to and including this day. One row per workspace, made
// the first time someone needs it (like number_series), so no backfill for old workspaces.
export const periodLocks = pgTable('period_locks', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  // NULL = nothing is closed
  lockDate: date('lock_date', { mode: 'string' }),
  createdAt: baseColumns().createdAt,
  updatedAt: baseColumns().updatedAt,
  updatedBy: baseColumns().updatedBy,
  version: baseColumns().version,
});
```

- **`date: date('date', { mode: 'string' })`.** A business date is `"2026-09-23"`, not a `Date` at midnight in
  some time zone (system design §10). Strings also compare in day order (`date <= lockDate`).
- **`journal_entries_tenant_id_idx (tenant_id, id)`** is the target of two composite FKs: lines → entry and
  reversal → original. Like step 7, they keep every reference inside one tenant.
- **`journal_entries_tenant_number_idx`** — unique numbers per tenant. Drafts have `NULL`, and `NULL`s never collide
  in a unique index, so no `WHERE` is needed.
- **`journal_entries_tenant_date_idx (tenant_id, date, id)`** — the list's keyset order (newest date first).
- **`journal_entries_tenant_reversal_idx`** — unique `(tenant_id, reversal_of_id)`: one reversal per entry, even if
  two people press Reverse in the same second.
- **`journal_entries_posted_check`** — posted ⇔ number and posting time. A draft with a number cannot exist.
- **`journal_entries_reversal_check`** — `source = 'reversal'` ⇔ `reversal_of_id` is set.
- **`journal_lines` has no audit columns of its own.** A line is part of its entry, written with it; the entry
  says who and when. Lines of a posted entry never change.
- **`line_no`** keeps the order the person wrote; `journal_lines_entry_line_idx` makes it unique per entry.
- **`journal_lines_tenant_account_idx`** — the ledger reads lines by account, and Postgres uses it to check the
  account FK when step 9's delete runs (without it, deleting an account would scan every line).
- **`journal_lines_entry_fk … ON DELETE CASCADE`** — deleting a draft deletes its lines. A posted entry cannot be
  deleted at all (the trigger in 0016), so the cascade only ever runs for drafts.
- **`journal_lines_account_fk`** points at step 9's `(tenant_id, id)` index, made for exactly this. It is also
  what turns "delete an account with entries" into `account_in_use`.
- **`journal_lines_one_side`** — `(debit = 0) <> (credit = 0)`: exactly one side has an amount, never a negative.
- **`period_locks`** — one row per tenant, `tenant_id` as the primary key, made on the first change.

**File: `packages/db/src/schema/index.ts`** (change)

```diff
@@ -18,3 +18,4 @@ export * from './invitations.js';
 export * from './outbox-events.js';
 export * from './notifications.js';
 export * from './ledger-accounts.js';
+export * from './journal.js';
```

**File: `packages/db/src/permission-catalog.ts`** (change)

```diff
@@ -15,6 +15,10 @@ const DESCRIPTIONS = {
   'core.audit.read': 'View the audit log',
   'accounting.account.manage':
     'Add, edit, move, archive and delete accounts in the chart of accounts',
+  'accounting.journal.read': 'View journal entries, ledgers and opening balances',
+  'accounting.journal.create': 'Write, edit and delete draft journal entries',
+  'accounting.journal.post': 'Post and reverse journal entries, and set the opening balances',
+  'accounting.period.close': 'Close the books up to a date, and open them again',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

### Migration 0015 (generated, then one line moved)

```bash
pnpm db:generate --name journal
```

**File: `packages/db/migrations/0015_journal.sql`**

```sql
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text,
	"date" date NOT NULL,
	"narration" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"reversal_of_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "journal_entries_posted_check" CHECK (("journal_entries"."status" = 'posted') = ("journal_entries"."number" IS NOT NULL AND "journal_entries"."posted_at" IS NOT NULL)),
	CONSTRAINT "journal_entries_reversal_check" CHECK (("journal_entries"."source" = 'reversal') = ("journal_entries"."reversal_of_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"account_id" uuid NOT NULL,
	"branch_id" uuid,
	"description" text,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "journal_lines_one_side" CHECK ("journal_lines"."debit" >= 0 AND "journal_lines"."credit" >= 0 AND ("journal_lines"."debit" = 0) <> ("journal_lines"."credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "period_locks" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"lock_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_tenant_id_idx" ON "journal_entries" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_fk" FOREIGN KEY ("tenant_id","reversal_of_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_tenant_number_idx" ON "journal_entries" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "journal_entries_tenant_date_idx" ON "journal_entries" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_tenant_reversal_idx" ON "journal_entries" USING btree ("tenant_id","reversal_of_id") WHERE "journal_entries"."reversal_of_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_entry_line_idx" ON "journal_lines" USING btree ("tenant_id","entry_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_lines_tenant_account_idx" ON "journal_lines" USING btree ("tenant_id","account_id");
```

- ⚠️ **Move one line by hand** — the same problem as step 9. drizzle-kit writes
  `CREATE UNIQUE INDEX "journal_entries_tenant_id_idx"` after the two FKs that point at it
  (`journal_entries_reversal_fk`, `journal_lines_entry_fk`), and Postgres stops with `there is no unique
  constraint matching given keys for referenced table`. Cut the index line and paste it right before the first
  `ALTER TABLE … ADD CONSTRAINT`, as above. Keep `--> statement-breakpoint` at its end.
- The account and branch FKs need no move: their target indexes come from steps 7 and 9.

### Migration 0016 (custom): RLS and the three rules

```bash
pnpm db:generate --custom --name journal-rules
```

**File: `packages/db/migrations/0016_journal-rules.sql`**

```sql
-- Custom SQL migration file, put your code below! --

-- 1) The three new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['journal_entries', 'journal_lines', 'period_locks'])
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

-- 2) A posted entry never changes and is never deleted. A mistake is undone by a reversal: a new
--    entry. Only a draft may be edited, deleted, or turned into a posted entry (OLD.status =
--    'draft'), which is how every entry gets posted, so the API needs no exception.
CREATE FUNCTION journal_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'journal entry % is posted and cannot be changed or deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entries_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entries_guard
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_guard();

-- 3) The lines of a posted entry are frozen with it: no line is added, changed or removed. A line
--    is checked against its entry before (OLD) and after (NEW), so moving a line from a draft
--    into a posted entry is refused too. When a draft is deleted, its lines go by ON DELETE
--    CASCADE; the entry row is gone by then, so the lookup finds nothing and lets them go.
CREATE FUNCTION journal_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM journal_entries
         WHERE tenant_id = OLD.tenant_id AND id = OLD.entry_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM journal_entries
         WHERE tenant_id = NEW.tenant_id AND id = NEW.entry_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted journal entry cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_guard();

-- 4) Double entry, checked by the database: a posted entry has at least two lines, its debits
--    equal its credits, and every line posts to a ledger (not a group). A CONSTRAINT TRIGGER that
--    is DEFERRABLE INITIALLY DEFERRED runs at COMMIT, not after each statement: by then every
--    line of the entry is in place, whatever order the code wrote them in. If it fails, the
--    whole transaction is rolled back — the entry, its lines and its number.
CREATE FUNCTION journal_entries_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  debits numeric;
  credits numeric;
  lines integer;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO debits, credits, lines
    FROM journal_lines
   WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id;
  IF lines < 2 OR debits <> credits THEN
    RAISE EXCEPTION 'journal entry % does not balance: % lines, debits %, credits %',
        NEW.id, lines, debits, credits
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entries_balanced';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines l
      JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
     WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id AND a.is_group
  ) THEN
    RAISE EXCEPTION 'journal entry % posts to a group account', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_ledger_only';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'posted')
  EXECUTE FUNCTION journal_entries_balanced();
```

- **(1)** The same `ENABLE` + `FORCE` + `tenant_isolation` loop as 0012. The RLS coverage test fails without it.
- **(2) `journal_entries_guard`** — `BEFORE UPDATE OR DELETE`: if the row is posted *before* the change
  (`OLD.status`), refuse. A draft can still be edited, deleted, or turned into a posted entry — which is the only
  way an entry is ever posted (decision 6), so the API needs no special case.
- **`ERRCODE = 'check_violation', CONSTRAINT = …`** — Postgres reports it like a failed `CHECK` with a name. The
  tests read the name (`journal_entries_posted_immutable`), and the API could map it with step 6's
  `pg-errors.ts` if it ever needed to.
- **(3) `journal_lines_guard`** — checks the entry before (`OLD`) and after (`NEW`) the change, so moving a line
  from a draft into a posted entry is refused too. During `ON DELETE CASCADE` the entry row is already gone, so
  the lookup finds nothing and the draft's lines go.
- **(4) `journal_entries_balanced`** — a `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` runs at `COMMIT`.
  An ordinary trigger would run after each statement, when the entry has only some of its lines. `WHEN
  (NEW.status = 'posted')` skips drafts. The check: at least two lines, `sum(debit) = sum(credit)` (exact,
  `numeric`), and no line on a group account. If it fails, the whole transaction rolls back — the entry, its
  lines and its number.
- **The triggers need each other.** The balance check fires when an *entry* row is inserted or updated, not when
  a line changes. A line of a posted entry changed later would not wake it — that is what (3) stops. Checked by
  breaking (3) on purpose: the test that changes one posted line then succeeds in changing it.
- The functions run as the caller (no `SECURITY DEFINER`), so they see rows through RLS like the API does. The
  deferred check still runs inside the transaction, where `app.tenant_id` is still set.

---
## 10.3 — The API: `JournalModule`

### The lock date

**File: `apps/api/src/journal/period-lock.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import { type PeriodLock, type PeriodLockInput, todayIn } from '@omnivo/contracts';
import { periodLocks, tenantSettings } from '@omnivo/db';
import { eq, sql } from 'drizzle-orm';

import { audit, diff } from '../common/audit/audit.js';
import { AppError, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// One advisory lock number per tenant for "the lock date". Every posting takes it SHARED: postings
// never wait for each other. Changing the lock date takes it EXCLUSIVE: it waits until the
// postings in flight commit, and new postings wait until the new date is committed. Without it, a
// posting could read the old date, and commit an entry into a month that was closed meanwhile.
// No row lock instead: the row exists only after the first change (version 0 = no row).
function lockKey(): string {
  return `period_lock:${getTenantId()}`;
}

async function readLock(tx: Transaction) {
  const [row] = await tx
    .select({ lockDate: periodLocks.lockDate, version: periodLocks.version })
    .from(periodLocks)
    .where(eq(periodLocks.tenantId, getTenantId()));
  return row;
}

// For every posting and reversal (PostingService). Dates are ISO strings, so `<=` on them is the
// order of the days.
export async function assertPeriodOpen(tx: Transaction, date: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${lockKey()}, 0))`);
  const lockDate = (await readLock(tx))?.lockDate ?? null;
  if (lockDate !== null && date <= lockDate) {
    throw new AppError(409, 'journal_period_locked', `The books are closed up to ${lockDate}.`, {
      fieldErrors: { date: ['journal_period_locked'] },
    });
  }
}

@Injectable()
export class PeriodLockService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  get(): Promise<PeriodLock> {
    return this.withTenant(async (tx) => {
      const row = await readLock(tx);
      return { lockDate: row?.lockDate ?? null, version: row?.version ?? 0 };
    });
  }

  update(input: PeriodLockInput): Promise<PeriodLock> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey()}, 0))`);
      const before = await readLock(tx);
      if ((before?.version ?? 0) !== input.version) throw versionConflict();

      // Closing a day that has not ended would refuse today's sales in the afternoon. "Today" is
      // the company's, not the server's: 1 am in Dhaka is still yesterday in UTC.
      if (input.lockDate !== null) {
        const [settings] = await tx
          .select({ timezone: tenantSettings.timezone })
          .from(tenantSettings)
          .where(eq(tenantSettings.tenantId, tenantId));
        if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
        if (input.lockDate > todayIn(settings.timezone)) {
          throw new AppError(409, 'period_lock_future', 'The lock date cannot be in the future.', {
            fieldErrors: { lockDate: ['period_lock_future'] },
          });
        }
      }

      const userId = currentPrincipal().userId;
      // The exclusive advisory lock above serialises every change, so the insert cannot race
      const [row] = before
        ? await tx
            .update(periodLocks)
            .set({
              lockDate: input.lockDate,
              version: sql`${periodLocks.version} + 1`,
              updatedBy: userId,
            })
            .where(eq(periodLocks.tenantId, tenantId))
            .returning({ lockDate: periodLocks.lockDate, version: periodLocks.version })
        : await tx
            .insert(periodLocks)
            .values({ tenantId, lockDate: input.lockDate, updatedBy: userId })
            .returning({ lockDate: periodLocks.lockDate, version: periodLocks.version });
      if (!row) throw new Error('Period lock write returned no row');

      await audit(tx, {
        action: 'books.lock_date_changed',
        entityType: 'workspace',
        entityId: tenantId,
        changes: diff({ lockDate: before?.lockDate ?? null }, { lockDate: row.lockDate }),
      });
      return row;
    });
  }
}
```

- **Why an advisory lock, and why two kinds.** Without a lock, this can happen: a posting reads "no lock date",
  then the owner closes September and commits, then the posting commits an entry dated 15 September — into a
  closed month. `pg_advisory_xact_lock_shared` (every posting) and `pg_advisory_xact_lock` (changing the date)
  use the same number: shared locks do not block each other, so a hundred postings run in parallel, but the
  exclusive one waits for them and they wait for it. Both are released at commit or rollback by themselves.
- **No row lock instead.** The row exists only after the first change (version 0 = no row), and `FOR SHARE` on a
  row that does not exist locks nothing.
- **`hashtextextended(…, 0)`** turns `period_lock:<tenant>` into the lock number, as in step 9's chart lock. The
  prefix keeps it apart from the chart lock.
- **`date <= lockDate`** — ISO date strings compare in day order. "Closed up to 30 September" includes the 30th.
- **No future lock date.** Closing a day that has not ended would refuse this afternoon's invoices. "Today" is
  the company's (`todayIn(timezone)`, step 6): at 1 am in Dhaka it is still yesterday in UTC.
- **The insert cannot race.** The exclusive lock already serialises every change, so "no row yet" seen here is
  still true when the insert runs.

### Posting: the one way into the books

**File: `apps/api/src/journal/posting.service.ts`** (new)

```ts
import { Injectable } from '@nestjs/common';
import { type ErrorCode, type JournalSource, sumMoney } from '@omnivo/contracts';
import { branches, journalEntries, journalLines, ledgerAccounts } from '@omnivo/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId, tenantStorage } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { assertPeriodOpen } from './period-lock.service.js';

export type EntryRow = typeof journalEntries.$inferSelect;

// One debit or credit as the API and later modules hand it in: amounts are decimal strings, one
// of them "0"
export interface LineInput {
  accountId: string;
  branchId: string | null;
  description: string | null;
  debit: string;
  credit: string;
}

export interface NewEntry {
  date: string;
  narration: string | null;
  source: JournalSource;
  // Only for source 'reversal'
  reversalOfId?: string;
  lines: readonly LineInput[];
}

// "Every line with a wrong X" as field errors under each such line: lines.2.accountId
function lineErrors(code: ErrorCode, field: string, indexes: readonly number[]): AppError {
  return new AppError(409, code, `Lines ${indexes.join(', ')} have an invalid ${field}.`, {
    fieldErrors: Object.fromEntries(
      indexes.map((index) => [`lines.${String(index)}.${field}`, [code]]),
    ),
  });
}

// Who did it: the person behind the request, or nobody (a background job) — like audit()
function actorId(): string | null {
  return tenantStorage.getStore()?.principal?.userId ?? null;
}

// The one way into the books. The journal's own endpoints use it, and so will every module that
// posts later (a sales invoice in step 15, a bill, a stock receipt): they build a NewEntry and
// call postNew() inside their own transaction, so the document and its entry commit together or
// not at all. Every rule of posting lives here once.
@Injectable()
export class PostingService {
  constructor(private readonly numbering: NumberingService) {}

  // Each line's account must be an active ledger of this tenant, and its branch (if any) an
  // active branch. FOR SHARE: until we commit, nobody archives or deletes them (AccountsService
  // locks FOR UPDATE), while other postings to the same account go on in parallel.
  // allowArchived: a reversal undoes an entry exactly, even if one of its accounts was archived
  // since — archiving hides an account from new work, it must not block fixing old work.
  async checkLines(
    tx: Transaction,
    lines: readonly LineInput[],
    { allowArchived = false }: { allowArchived?: boolean } = {},
  ): Promise<void> {
    const tenantId = getTenantId();
    const accountIds = [...new Set(lines.map((line) => line.accountId))];
    const accounts = await tx
      .select({
        id: ledgerAccounts.id,
        isGroup: ledgerAccounts.isGroup,
        archivedAt: ledgerAccounts.archivedAt,
      })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, tenantId), inArray(ledgerAccounts.id, accountIds)))
      .for('share');
    const usable = new Set(
      accounts
        .filter((account) => !account.isGroup && (allowArchived || account.archivedAt === null))
        .map((account) => account.id),
    );
    const badAccounts = lines.flatMap((line, index) => (usable.has(line.accountId) ? [] : [index]));
    // The same answer for "not a ledger", "archived", "no such id" and "another tenant's":
    // the form shows one sentence, and nothing about other tenants leaks
    if (badAccounts.length > 0)
      throw lineErrors('journal_account_invalid', 'accountId', badAccounts);

    const branchIds = [
      ...new Set(lines.flatMap((line) => (line.branchId === null ? [] : [line.branchId]))),
    ];
    if (branchIds.length === 0) return;
    const active = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(
        and(
          eq(branches.tenantId, tenantId),
          inArray(branches.id, branchIds),
          allowArchived ? undefined : isNull(branches.archivedAt),
        ),
      )
      .for('share');
    const known = new Set(active.map((branch) => branch.id));
    const badBranches = lines.flatMap((line, index) =>
      line.branchId === null || known.has(line.branchId) ? [] : [index],
    );
    if (badBranches.length > 0) throw lineErrors('journal_branch_invalid', 'branchId', badBranches);
  }

  // Lines in the order they were written: line_no 1, 2, 3…
  async writeLines(tx: Transaction, entryId: string, lines: readonly LineInput[]): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.entryId, entryId)));
    await tx.insert(journalLines).values(
      lines.map((line, index) => ({
        tenantId,
        entryId,
        lineNo: index + 1,
        accountId: line.accountId,
        branchId: line.branchId,
        description: line.description,
        debit: line.debit,
        credit: line.credit,
      })),
    );
  }

  async insertDraft(
    tx: Transaction,
    entry: Omit<NewEntry, 'lines'>,
    lines: readonly LineInput[],
  ): Promise<EntryRow> {
    const [row] = await tx
      .insert(journalEntries)
      .values({
        tenantId: getTenantId(),
        date: entry.date,
        narration: entry.narration,
        source: entry.source,
        reversalOfId: entry.reversalOfId ?? null,
        createdBy: actorId(),
        updatedBy: actorId(),
      })
      .returning();
    if (!row) throw new Error('Journal entry insert returned no row');
    await this.writeLines(tx, row.id, lines);
    return row;
  }

  // Turns a draft into a posted entry: every rule, then the number, then the status. The caller
  // has locked the draft (FOR UPDATE). The database checks the balance once more at COMMIT
  // (migration 0016) — this is where a person gets a readable error instead.
  async post(tx: Transaction, entry: EntryRow): Promise<EntryRow> {
    const tenantId = getTenantId();
    await assertPeriodOpen(tx, entry.date);
    const lines = await tx
      .select()
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.entryId, entry.id)))
      .orderBy(asc(journalLines.lineNo));
    if (lines.length < 2) {
      throw new AppError(409, 'journal_lines_too_few', 'An entry needs at least two lines.');
    }
    const debits = sumMoney(lines.map((line) => line.debit));
    const credits = sumMoney(lines.map((line) => line.credit));
    if (debits !== credits) {
      throw new AppError(
        409,
        'journal_unbalanced',
        `The debits (${debits}) and credits (${credits}) must be equal.`,
      );
    }
    await this.checkLines(tx, lines, { allowArchived: entry.source === 'reversal' });

    // In the same transaction: if anything after this fails, the number goes back (step 6)
    const number = await this.numbering.next(tx, 'accounting.journal', entry.date);
    const [row] = await tx
      .update(journalEntries)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: actorId(),
        version: sql`${journalEntries.version} + 1`,
        updatedBy: actorId(),
      })
      .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.id, entry.id)))
      .returning();
    if (!row) throw new Error('Journal entry post returned no row');
    return row;
  }

  // postJournal(): a new entry straight into the books. It is written as a draft first and then
  // posted, inside the caller's transaction — so the lines are always added to a draft (the
  // database refuses new lines on a posted entry), and every rule of post() applies.
  async postNew(tx: Transaction, entry: NewEntry): Promise<EntryRow> {
    const draft = await this.insertDraft(tx, entry, entry.lines);
    return this.post(tx, draft);
  }
}
```

This is the `postJournal()` of the build plan. Every rule of posting is written here once.

- **`checkLines` — one answer for four cases.** "Not a ledger", "archived", "no such id" and "another tenant's
  account" all answer `journal_account_invalid` under the line (`lines.2.accountId`). The form shows one sentence,
  and tenant A learns nothing about tenant B's ids.
- **`FOR SHARE` on the accounts and branches** (decision 9). Until we commit, step 9's `archive()`/`remove()`
  (`FOR UPDATE`) waits, so no entry lands on an account in the moment it is archived. Other postings to the same
  account take `FOR SHARE` too and do not wait.
- **`allowArchived` for reversals.** Archiving hides an account from new work; it must not block undoing old work.
- **`writeLines` deletes and inserts.** A draft's lines are replaced as a whole on every save. Simpler than
  matching old and new lines, and a draft has no history worth keeping (the audit row has the totals).
- **`insertDraft`** — `actorId()` is the person behind the request, or `null` for a background job (the same rule
  as `audit()`). A sales invoice posted by the worker in a later step has no person.
- **`post()` — the order matters.** (1) The lock date first: it takes the shared lock before anything else.
  (2) At least two lines and equal totals, with a readable error. (3) The accounts again: a draft saved last week
  may point at an account archived since. (4) **Then** the number, so a refused posting never uses one. (5) The
  status. If anything after the number fails, the transaction rolls back and the number goes back too (step 6).
- **`postNew()` — every posting goes through draft** (decision 6). Insert a draft, add its lines, post it — in
  the caller's transaction. A sales invoice (step 15) will call it in its own transaction, so the invoice and
  its entry commit together or not at all.

### The journal

**File: `apps/api/src/journal/journal.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type JournalEntry,
  type JournalEntryInput,
  type JournalEntrySummary,
  type JournalStatus,
  sumMoney,
  type UpdateJournalEntryInput,
} from '@omnivo/contracts';
import { journalEntries, journalLines } from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import { type EntryRow, type LineInput, PostingService } from './posting.service.js';

// The entry that reverses this one, and the entry this one reverses — two joins on the same table
const reversal = alias(journalEntries, 'reversal');
const original = alias(journalEntries, 'original');

// The sum of the debits, from the lines. round(…, 4): an entry without lines still reads
// "0.0000", like every other amount, instead of "0".
const total = sql<string>`(
  SELECT round(coalesce(sum(l.debit), 0), 4) FROM ${journalLines} l
   WHERE l.tenant_id = ${journalEntries.tenantId} AND l.entry_id = ${journalEntries.id}
)`;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

function notDraft(): AppError {
  return new AppError(
    409,
    'journal_not_draft',
    'Only a draft can be changed. Reverse a posted entry instead.',
  );
}

// What the audit log shows for an entry: the header and the size of the entry, not every line
function snapshot(entry: { date: string; narration: string | null }, lines: readonly LineInput[]) {
  return {
    date: entry.date,
    narration: entry.narration,
    total: sumMoney(lines.map((line) => line.debit)),
    lines: lines.length,
  };
}

@Injectable()
export class JournalService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly posting: PostingService,
    private readonly permissions: PermissionService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: JournalStatus | undefined;
  }): Promise<{ items: JournalEntrySummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.status === undefined ? undefined : eq(journalEntries.status, query.status),
          after === undefined
            ? undefined
            : sql`(${journalEntries.date}, ${journalEntries.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.date, last.id]);
    });
  }

  get(id: string): Promise<JournalEntry> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: JournalEntryInput): Promise<JournalEntry> {
    if (input.post) await this.assertCanPost();
    return this.withTenant(async (tx) => {
      await this.posting.checkLines(tx, input.lines);
      let row = await this.posting.insertDraft(
        tx,
        { date: input.date, narration: input.narration, source: 'manual' },
        input.lines,
      );
      await audit(tx, {
        action: 'journal.created',
        entityType: 'journal_entry',
        entityId: row.id,
        changes: created(snapshot(input, input.lines)),
      });
      if (input.post) row = await this.postAndLog(tx, row);
      return this.read(tx, row.id);
    });
  }

  async update(id: string, input: UpdateJournalEntryInput): Promise<JournalEntry> {
    if (input.post) await this.assertCanPost();
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      await this.posting.checkLines(tx, input.lines);
      const [updated] = await tx
        .update(journalEntries)
        .set({
          date: input.date,
          narration: input.narration,
          version: sql`${journalEntries.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.id, id)))
        .returning();
      if (!updated) throw notFound('Journal entry');
      await this.posting.writeLines(tx, id, input.lines);
      await audit(tx, {
        action: 'journal.updated',
        entityType: 'journal_entry',
        entityId: id,
        changes: diff(snapshot(before, linesBefore), snapshot(input, input.lines)),
      });
      if (input.post) await this.postAndLog(tx, updated);
      return this.read(tx, id);
    });
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(journalEntries)
        .where(and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.id, id)));
      await audit(tx, {
        action: 'journal.deleted',
        entityType: 'journal_entry',
        entityId: id,
        changes: diff(snapshot(before, lines), {
          date: null,
          narration: null,
          total: null,
          lines: null,
        }),
      });
    });
  }

  post(id: string, version: number): Promise<JournalEntry> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.postAndLog(tx, draft);
      return this.read(tx, id);
    });
  }

  async reverse(id: string, input: { version: number; date: string }): Promise<JournalEntry> {
    try {
      return await this.withTenant(async (tx) => {
        const entry = await this.lock(tx, id);
        if (entry.status !== 'posted') {
          throw new AppError(409, 'journal_not_posted', 'Only a posted entry can be reversed.');
        }
        if (entry.source === 'reversal') {
          // Reversing a reversal would put the mistake back. Post a new, correct entry instead.
          throw new AppError(409, 'journal_is_reversal', 'A reversal cannot be reversed.');
        }
        if (entry.version !== input.version) throw versionConflict();
        const [already] = await tx
          .select({ id: reversal.id })
          .from(reversal)
          .where(and(eq(reversal.tenantId, getTenantId()), eq(reversal.reversalOfId, id)));
        if (already) throw alreadyReversed();
        if (input.date < entry.date) {
          throw new AppError(
            409,
            'journal_reversal_date',
            'A reversal cannot be dated before the entry it reverses.',
            { fieldErrors: { date: ['journal_reversal_date'] } },
          );
        }

        // The same lines with debit and credit swapped: together the two entries add up to zero
        const lines = await this.linesOf(tx, id);
        const reversed = await this.posting.postNew(tx, {
          date: input.date,
          narration: `Reversal of ${entry.number ?? ''}`,
          source: 'reversal',
          reversalOfId: id,
          lines: lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
        });
        await audit(tx, {
          action: 'journal.reversed',
          entityType: 'journal_entry',
          entityId: id,
          changes: created({ reversal: reversed.number, date: input.date }),
        });
        return this.read(tx, reversed.id);
      });
    } catch (error) {
      // Two people pressed Reverse at the same moment: both passed the check above, the unique
      // index let only one insert through. Caught outside, after the rollback (step 6's pattern).
      if (isUniqueViolation(error, 'journal_entries_tenant_reversal_idx')) throw alreadyReversed();
      throw error;
    }
  }

  // "Save and post" needs both permissions. The route checked accounting.journal.create; the
  // post half is checked here, with the same answer the PermissionGuard gives.
  private async assertCanPost(): Promise<void> {
    const access = await this.permissions.forPrincipal(currentPrincipal());
    if (!access?.permissions.includes('accounting.journal.post')) {
      throw new AppError(
        403,
        'permission_missing',
        'Missing permission: accounting.journal.post.',
        {
          params: { permissions: 'accounting.journal.post' },
        },
      );
    }
  }

  private async postAndLog(tx: Transaction, draft: EntryRow): Promise<EntryRow> {
    const posted = await this.posting.post(tx, draft);
    await audit(tx, {
      action: 'journal.posted',
      entityType: 'journal_entry',
      entityId: posted.id,
      changes: created({ number: posted.number }),
    });
    return posted;
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lock(tx: Transaction, id: string): Promise<EntryRow> {
    const [row] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.id, id)))
      .for('update');
    if (!row) throw notFound('Journal entry');
    return row;
  }

  private async lockDraft(tx: Transaction, id: string, version: number): Promise<EntryRow> {
    const row = await this.lock(tx, id);
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, entryId: string) {
    return tx
      .select()
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, getTenantId()), eq(journalLines.entryId, entryId)))
      .orderBy(asc(journalLines.lineNo));
  }

  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<JournalEntrySummary[]> {
    const rows = await tx
      .select({
        entry: journalEntries,
        total,
        reversedById: reversal.id,
        reversedByNumber: reversal.number,
        reversalOfNumber: original.number,
      })
      .from(journalEntries)
      .leftJoin(
        reversal,
        and(
          eq(reversal.tenantId, journalEntries.tenantId),
          eq(reversal.reversalOfId, journalEntries.id),
        ),
      )
      .leftJoin(
        original,
        and(
          eq(original.tenantId, journalEntries.tenantId),
          eq(original.id, journalEntries.reversalOfId),
        ),
      )
      .where(and(eq(journalEntries.tenantId, getTenantId()), where))
      .orderBy(desc(journalEntries.date), desc(journalEntries.id))
      .limit(limit);
    return rows.map(({ entry, ...refs }) => ({
      id: entry.id,
      number: entry.number,
      date: entry.date,
      narration: entry.narration,
      status: entry.status,
      source: entry.source,
      total: refs.total,
      // A reversal is always posted, so it always has a number; the join makes both nullable
      reversalOf:
        entry.reversalOfId !== null && refs.reversalOfNumber !== null
          ? { id: entry.reversalOfId, number: refs.reversalOfNumber }
          : null,
      reversedBy:
        refs.reversedById !== null && refs.reversedByNumber !== null
          ? { id: refs.reversedById, number: refs.reversedByNumber }
          : null,
      postedAt: entry.postedAt?.toISOString() ?? null,
      version: entry.version,
      updatedAt: entry.updatedAt.toISOString(),
    }));
  }

  private async read(tx: Transaction, id: string): Promise<JournalEntry> {
    const [summary] = await this.summaries(tx, eq(journalEntries.id, id), 1);
    if (!summary) throw notFound('Journal entry');
    const lines = await this.linesOf(tx, id);
    return {
      ...summary,
      lines: lines.map((line) => ({
        id: line.id,
        accountId: line.accountId,
        branchId: line.branchId,
        description: line.description,
        debit: line.debit,
        credit: line.credit,
      })),
    };
  }
}

function alreadyReversed(): AppError {
  return new AppError(409, 'journal_already_reversed', 'This entry has been reversed already.');
}
```

Top to bottom:

- **`reversal` and `original` are aliases** of `journal_entries`: one join finds the entry that reverses this one,
  the other the entry this one reverses. Both answers come in the same query as the list.
- **`total` is a subquery** over the lines. `round(coalesce(sum(…), 0), 4)`: an entry without lines reads
  `"0.0000"`, like every other amount, not `"0"`.
- **`list()`** — keyset pages on `(date, id)`, newest first, optionally only drafts or only posted. The cursor is
  validated with Zod (`z.tuple([z.iso.date(), z.uuid()])`), so a broken cursor is a `400`, not a Postgres cast
  error (step 5's rule).
- **`create()` / `update()` with `post: true`** check `accounting.journal.post` themselves (`assertCanPost()`): the
  route only checked `…create`. Same answer as the guard (`403 permission_missing` with the permission's name),
  so the app shows the same message.
- **`update()`** — `lockDraft()` first: `FOR UPDATE`, draft only, then the version. Two saves of one draft run one
  after the other, and a save never overlaps a post. The audit `diff()` compares `{ date, narration, total,
  lines }`, so "Save" without changes writes no fake change.
- **`remove()`** — drafts only; the lines go by `ON DELETE CASCADE`. The audit row keeps the date and total,
  because the row itself is gone.
- **`reverse()`**:
  - posted only (`journal_not_posted`), not a reversal (`journal_is_reversal`), not reversed already
    (`journal_already_reversed`), not dated before the entry (`journal_reversal_date` under the date field);
  - the lines with `debit` and `credit` swapped: the two entries together add up to zero on every account;
  - the narration `Reversal of JV-…` is data, in English like account names (step 9's decision 10);
  - **two people at once:** `lock()` (`FOR UPDATE`) makes them take turns, and the second one sees the first
    reversal and answers `journal_already_reversed`. If a future change forgot the lock, the unique index
    would still let only one insert through; that error is caught outside the transaction (after its rollback,
    step 6's pattern) and gets the same answer.
- **`read()`** — the summary query for one id, plus its lines in `line_no` order.

### The ledger

**File: `apps/api/src/journal/ledger.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import { addMoney, type LedgerPage, subtractMoney } from '@omnivo/contracts';
import { journalEntries, journalLines, ledgerAccounts } from '@omnivo/db';
import { and, asc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { notFound } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// A ledger row's position: its entry's date, then the line's id (UUIDv7, so the order lines were
// written in). Together they are unique and never change once posted — a stable page order.
const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// debit − credit of the matching posted lines. round(…, 4): "0.0000" when nothing matches.
function balanceWhere(condition: SQL | undefined): SQL<string> {
  const filter = condition ?? sql`true`;
  return sql<string>`round(coalesce(sum(${journalLines.debit} - ${journalLines.credit}) FILTER (WHERE ${filter}), 0), 4)`;
}

@Injectable()
export class LedgerService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  ledger(
    accountId: string,
    query: {
      limit: number;
      cursor?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
    },
  ): Promise<LedgerPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const [account] = await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.id, accountId)));
      if (!account) throw notFound('Account');

      // Only posted lines of this account. A draft is not in the books yet.
      const ofAccount = and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.accountId, accountId),
        eq(journalEntries.status, 'posted'),
      );
      const joined = and(
        eq(journalEntries.tenantId, journalLines.tenantId),
        eq(journalEntries.id, journalLines.entryId),
      );
      const position = sql`(${journalEntries.date}, ${journalLines.id})`;
      const beforeFrom =
        query.from === undefined ? undefined : sql`${journalEntries.date} < ${query.from}::date`;

      const rows = await tx
        .select({
          lineId: journalLines.id,
          entryId: journalEntries.id,
          number: journalEntries.number,
          date: journalEntries.date,
          narration: journalEntries.narration,
          description: journalLines.description,
          debit: journalLines.debit,
          credit: journalLines.credit,
        })
        .from(journalLines)
        .innerJoin(journalEntries, joined)
        .where(
          and(
            ofAccount,
            query.from === undefined
              ? undefined
              : sql`${journalEntries.date} >= ${query.from}::date`,
            query.to === undefined ? undefined : sql`${journalEntries.date} <= ${query.to}::date`,
            after === undefined
              ? undefined
              : sql`${position} > (${after[0]}::date, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(asc(journalEntries.date), asc(journalLines.id))
        .limit(query.limit + 1);

      // Three balances in one pass over the account's lines:
      // - before this page: everything up to the cursor (or before `from` on the first page),
      //   so page 3's running balance continues exactly where page 2 stopped;
      // - opening: before `from`; closing: up to `to`.
      const [sums] = await tx
        .select({
          beforePage: balanceWhere(
            after === undefined
              ? (beforeFrom ?? sql`false`)
              : sql`${position} <= (${after[0]}::date, ${after[1]}::uuid)`,
          ),
          opening: balanceWhere(beforeFrom ?? sql`false`),
          closing: balanceWhere(
            query.to === undefined ? undefined : sql`${journalEntries.date} <= ${query.to}::date`,
          ),
        })
        .from(journalLines)
        .innerJoin(journalEntries, joined)
        .where(ofAccount);
      if (!sums) throw new Error('Ledger sums returned no row');

      const page = toPage(rows, query.limit, (last) => [last.date, last.lineId]);
      let balance = sums.beforePage;
      return {
        items: page.items.map((row) => {
          balance = addMoney(balance, subtractMoney(row.debit, row.credit));
          // Every line here is posted, so it has a number
          return { ...row, number: row.number ?? '', balance };
        }),
        nextCursor: page.nextCursor,
        openingBalance: sums.opening,
        closingBalance: sums.closing,
      };
    });
  }
}
```

- **Posted lines only.** A draft is not in the books.
- **The order: the entry's date, then the line's id.** Line ids are UUIDv7, so on one day the lines come in the
  order they were written. The pair is unique and never changes once posted, so it is a safe keyset cursor.
  (The entry number is not used: a draft written on Monday but posted on Friday would still sit on Monday's
  date, and a number in another format would sort wrongly.)
- **The running balance across pages.** Page 3 must start where page 2 stopped. So `beforePage` sums everything
  up to the cursor (or before `from` on the first page), and each row adds `debit − credit` to it. One aggregate
  query with three `FILTER`ed sums gives `beforePage`, `opening` and `closing` in one pass over the account's
  lines.
- **`addMoney`/`subtractMoney`** — the running sum in JavaScript, exact (BigInt, 10.1), on top of Postgres's
  exact `numeric` sums.
- An unknown account, or another tenant's, is a `404` — not an empty ledger, which would say "it exists".

### Opening balances

**File: `apps/api/src/journal/opening-balances.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  isNegativeMoney,
  isZeroMoney,
  type OpeningBalances,
  type OpeningBalancesInput,
  absMoney,
  shiftIsoDate,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { journalEntries, journalLines, ledgerAccounts } from '@omnivo/db';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { audit, created } from '../common/audit/audit.js';
import { AppError, versionConflict } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { type LineInput, PostingService } from './posting.service.js';

const reversal = alias(journalEntries, 'reversal');

// Balance sheet accounts only. Income and expenses start at zero on the go-live day; the profit
// of the years before is already inside Retained earnings, which is equity.
const OPENING_TYPES = ['asset', 'liability', 'equity'] as const;

function invalidLines(
  code: 'opening_account_invalid' | 'opening_account_twice',
  indexes: number[],
) {
  return new AppError(409, code, 'Some lines cannot take an opening balance.', {
    fieldErrors: Object.fromEntries(
      indexes.map((index) => [`lines.${String(index)}.accountId`, [code]]),
    ),
  });
}

@Injectable()
export class OpeningBalancesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly posting: PostingService,
  ) {}

  get(): Promise<OpeningBalances> {
    return this.withTenant((tx) => this.read(tx));
  }

  // One posted entry holds the opening balances. Saving again reverses it (dated as it was) and
  // posts a new one: the journal keeps the whole history, and nothing posted is ever edited.
  save(input: OpeningBalancesInput): Promise<OpeningBalances> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // Two saves at once would both see "no entry yet" and post two opening entries. The
      // advisory lock makes the second wait, then fail the `replaces` check below.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`opening_balances:${tenantId}`}, 0))`,
      );
      const current = await this.current(tx);
      if ((current?.id ?? null) !== input.replaces) throw versionConflict();

      // Keep each line's index in the request, so an error lands under the right row of the page
      const filled = input.lines.flatMap((line, index) =>
        isZeroMoney(line.debit) && isZeroMoney(line.credit) ? [] : [{ ...line, index }],
      );
      const seen = new Set<string>();
      const twice = filled.flatMap((line) => {
        if (!seen.has(line.accountId)) {
          seen.add(line.accountId);
          return [];
        }
        return [line.index];
      });
      if (twice.length > 0) throw invalidLines('opening_account_twice', twice);

      const accounts = await tx
        .select({
          id: ledgerAccounts.id,
          type: ledgerAccounts.type,
          isGroup: ledgerAccounts.isGroup,
          purpose: ledgerAccounts.purpose,
          archivedAt: ledgerAccounts.archivedAt,
        })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.tenantId, tenantId));
      const equity = accounts.find((account) => account.purpose === 'opening_balance_equity');
      // Every chart has it (step 9's templates and backfill), and it cannot be deleted
      if (!equity) throw new Error(`No opening balance equity account in tenant ${tenantId}`);
      const allowed = new Set(
        accounts
          .filter(
            (account) =>
              OPENING_TYPES.some((type) => type === account.type) &&
              !account.isGroup &&
              account.archivedAt === null &&
              account.id !== equity.id,
          )
          .map((account) => account.id),
      );
      const invalid = filled.flatMap((line) => (allowed.has(line.accountId) ? [] : [line.index]));
      if (invalid.length > 0) throw invalidLines('opening_account_invalid', invalid);

      if (current) {
        const lines = await this.linesOf(tx, current.id);
        await this.posting.postNew(tx, {
          date: current.date,
          narration: `Reversal of opening balances ${current.number ?? ''}`,
          source: 'reversal',
          reversalOfId: current.id,
          lines: lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
        });
      }

      let number: string | null = null;
      if (filled.length > 0) {
        const lines: LineInput[] = filled.map((line) => ({
          accountId: line.accountId,
          branchId: null,
          description: null,
          debit: line.debit,
          credit: line.credit,
        }));
        // What the books are out by goes to Opening balance equity, on the side that closes the
        // gap. Once everything is entered it should read zero (step 9's template note).
        const difference = subtractMoney(
          sumMoney(lines.map((line) => line.debit)),
          sumMoney(lines.map((line) => line.credit)),
        );
        if (!isZeroMoney(difference)) {
          const amount = absMoney(difference);
          lines.push({
            accountId: equity.id,
            branchId: null,
            description: null,
            debit: isNegativeMoney(difference) ? amount : '0',
            credit: isNegativeMoney(difference) ? '0' : amount,
          });
        }
        const entry = await this.posting.postNew(tx, {
          // The day before go-live: the balances as the old books ended
          date: shiftIsoDate(input.goLiveDate, -1),
          narration: 'Opening balances',
          source: 'opening_balance',
          lines,
        });
        number = entry.number;
      }

      await audit(tx, {
        action: 'journal.opening_balances_saved',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({
          goLiveDate: filled.length > 0 ? input.goLiveDate : null,
          accounts: filled.length,
          entry: number,
        }),
      });
      return this.read(tx);
    });
  }

  // The opening entry that is still in force: posted, and not reversed
  private async current(tx: Transaction) {
    const [row] = await tx
      .select({ id: journalEntries.id, number: journalEntries.number, date: journalEntries.date })
      .from(journalEntries)
      .leftJoin(
        reversal,
        and(
          eq(reversal.tenantId, journalEntries.tenantId),
          eq(reversal.reversalOfId, journalEntries.id),
        ),
      )
      .where(
        and(
          eq(journalEntries.tenantId, getTenantId()),
          eq(journalEntries.source, 'opening_balance'),
          eq(journalEntries.status, 'posted'),
          isNull(reversal.id),
        ),
      )
      .orderBy(desc(journalEntries.postedAt))
      .limit(1);
    return row;
  }

  private linesOf(tx: Transaction, entryId: string) {
    return tx
      .select()
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, getTenantId()), eq(journalLines.entryId, entryId)))
      .orderBy(asc(journalLines.lineNo));
  }

  private async read(tx: Transaction): Promise<OpeningBalances> {
    const current = await this.current(tx);
    if (!current?.number) return { goLiveDate: null, entry: null, lines: [] };
    const equity = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, getTenantId()),
          eq(ledgerAccounts.purpose, 'opening_balance_equity'),
        ),
      );
    const equityIds = new Set(equity.map((account) => account.id));
    const lines = await this.linesOf(tx, current.id);
    return {
      goLiveDate: shiftIsoDate(current.date, 1),
      entry: { id: current.id, number: current.number },
      // The equity line is the server's own; the page shows it as "the difference"
      lines: lines
        .filter((line) => !equityIds.has(line.accountId))
        .map((line) => ({ accountId: line.accountId, debit: line.debit, credit: line.credit })),
    };
  }
}
```

- **The current opening entry** is the posted one with `source = 'opening_balance'` that nothing reversed. No
  extra table points at it: the journal is the only source of truth.
- **An advisory lock for the whole save.** Two people saving at once would both see "no entry yet" and post two
  opening entries. With the lock the second one waits, then fails the `replaces` check (`version_conflict`).
- **`filled` keeps each line's index in the request**, so an error lands under the right row of the page, even
  though empty rows are dropped.
- **Which accounts.** Asset, liability and equity ledgers, active, and **not** opening balance equity: that one
  is the server's (decision 3). Duplicates answer `opening_account_twice`.
- **Replacing.** The old entry is reversed **on its own date**, so the books as at go-live are exactly the new
  balances. If the lock date has passed that date, the reversal is refused (`journal_period_locked`) — once
  those months are closed, the opening balances are closed too. That is on purpose.
- **The difference.** `debits − credits` of the filled lines; a positive difference is credited to opening
  balance equity, a negative one debited. If the balances already balance, there is no equity line.
- **All empty** clears the opening balances: the old entry is reversed and nothing new is posted.

### Controllers, module, wiring

**File: `apps/api/src/journal/journal.controller.ts`** (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { JournalService } from './journal.service.js';

type Routes = typeof routes.journal;

@Controller()
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Endpoint(routes.journal.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.journal.list(query);
  }

  @Endpoint(routes.journal.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.journal.get(params.id);
  }

  @Endpoint(routes.journal.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.journal.create(body);
  }

  @Endpoint(routes.journal.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.journal.update(params.id, body);
  }

  @Endpoint(routes.journal.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.journal.remove(params.id, query.version);
  }

  @Endpoint(routes.journal.post)
  post({ params, body }: RouteInput<Routes['post']>): Promise<RouteResponse<Routes['post']>> {
    return this.journal.post(params.id, body.version);
  }

  @Endpoint(routes.journal.reverse)
  reverse({
    params,
    body,
  }: RouteInput<Routes['reverse']>): Promise<RouteResponse<Routes['reverse']>> {
    return this.journal.reverse(params.id, body);
  }
}
```

**File: `apps/api/src/journal/books.controller.ts`** (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { LedgerService } from './ledger.service.js';
import { OpeningBalancesService } from './opening-balances.service.js';
import { PeriodLockService } from './period-lock.service.js';

// Everything around the journal that is not one entry: an account's ledger, the opening
// balances and the lock date
@Controller()
export class BooksController {
  constructor(
    private readonly ledgers: LedgerService,
    private readonly openingBalances: OpeningBalancesService,
    private readonly periodLock: PeriodLockService,
  ) {}

  @Endpoint(routes.ledger.get)
  ledger({
    params,
    query,
  }: RouteInput<typeof routes.ledger.get>): Promise<RouteResponse<typeof routes.ledger.get>> {
    return this.ledgers.ledger(params.id, query);
  }

  @Endpoint(routes.openingBalances.get)
  getOpeningBalances(): Promise<RouteResponse<typeof routes.openingBalances.get>> {
    return this.openingBalances.get();
  }

  @Endpoint(routes.openingBalances.save)
  saveOpeningBalances({
    body,
  }: RouteInput<typeof routes.openingBalances.save>): Promise<
    RouteResponse<typeof routes.openingBalances.save>
  > {
    return this.openingBalances.save(body);
  }

  @Endpoint(routes.periodLock.get)
  getPeriodLock(): Promise<RouteResponse<typeof routes.periodLock.get>> {
    return this.periodLock.get();
  }

  @Endpoint(routes.periodLock.update)
  updatePeriodLock({
    body,
  }: RouteInput<typeof routes.periodLock.update>): Promise<
    RouteResponse<typeof routes.periodLock.update>
  > {
    return this.periodLock.update(body);
  }
}
```

- Thin, like every controller: `@Endpoint(route)` reads the method, path, schemas and permission from the
  contract. Two classes only to keep each short; the paths come from the contract either way.

**File: `apps/api/src/journal/journal.module.ts`** (new)

```ts
import { Module } from '@nestjs/common';

import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { BooksController } from './books.controller.js';
import { JournalController } from './journal.controller.js';
import { JournalService } from './journal.service.js';
import { LedgerService } from './ledger.service.js';
import { OpeningBalancesService } from './opening-balances.service.js';
import { PeriodLockService } from './period-lock.service.js';
import { PostingService } from './posting.service.js';

// The double-entry journal. PostingService is exported: every later module that posts (sales,
// purchase, inventory) imports this module and calls postNew() in its own transaction.
@Module({
  imports: [NumberingModule, RbacModule],
  controllers: [JournalController, BooksController],
  providers: [
    JournalService,
    LedgerService,
    OpeningBalancesService,
    PeriodLockService,
    PostingService,
  ],
  exports: [PostingService],
})
export class JournalModule {}
```

- `NumberingModule` exports `NumberingService` since step 6 for exactly this. `RbacModule` gives
  `PermissionService` (for `assertCanPost()`).
- **`exports: [PostingService]`** — the module's public face for later steps.

**File: `apps/api/src/app.module.ts`** (change)

```diff
@@ -21,6 +21,7 @@ import { DocsController } from './docs/docs.controller.js';
 import { HealthController } from './health/health.controller.js';
 import { InfraModule } from './infra/infra.module.js';
 import { InvitationsModule } from './invitations/invitations.module.js';
+import { JournalModule } from './journal/journal.module.js';
 import { MembersModule } from './members/members.module.js';
 import { NotificationsModule } from './notifications/notifications.module.js';
 import { NumberingModule } from './numbering/numbering.module.js';
@@ -51,6 +52,7 @@ export class AppModule implements NestModule {
         SetupModule,
         NotificationsModule,
         AccountsModule,
+        JournalModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

### Changes in step 6, 8 and 9 code

**File: `apps/api/src/accounts/accounts.service.ts`** (change)

```diff
@@ -259,6 +259,10 @@ export class AccountsService {
           'Move or delete the accounts under this group first.',
         );
       }
+      // Journal lines point at it (a draft's too): the history must keep its account
+      if (isForeignKeyViolation(error, 'journal_lines_account_fk')) {
+        throw new AppError(409, 'account_in_use', 'Archive this account instead: entries use it.');
+      }
       throw error;
     }
   }
```

- Step 9 left this note. The `DELETE` itself fails on `journal_lines_account_fk` when any line (a draft's too)
  uses the account. No "is it used?" query first: the foreign key is the check.

**File: `apps/api/src/settings/settings.service.ts`** (change)

```diff
@@ -1,6 +1,6 @@
 import { Inject, Injectable } from '@nestjs/common';
 import type { Settings, UpdateSettingsInput } from '@omnivo/contracts';
-import { attachments, tenantSettings, tenants } from '@omnivo/db';
+import { attachments, journalEntries, tenantSettings, tenants } from '@omnivo/db';
 import { and, eq, sql } from 'drizzle-orm';
 
 import { audit, diff } from '../common/audit/audit.js';
@@ -35,6 +35,23 @@ export class SettingsService {
         .for('update', { of: tenantSettings });
       if (!current) throw notFound('Settings');
       if (current.settings.version !== version) throw versionConflict();
+      // The books are kept in the base currency. Once one entry is posted, changing it would turn
+      // every amount in them into another currency's amount without converting anything.
+      if (fields.baseCurrency !== current.settings.baseCurrency) {
+        const [posted] = await tx
+          .select({ id: journalEntries.id })
+          .from(journalEntries)
+          .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.status, 'posted')))
+          .limit(1);
+        if (posted) {
+          throw new AppError(
+            409,
+            'base_currency_locked',
+            'The base currency cannot change once entries are posted.',
+            { fieldErrors: { baseCurrency: ['base_currency_locked'] } },
+          );
+        }
+      }
 
       await tx
         .update(tenantSettings)
```

- Step 6 left this note. Only a *change* of the currency is checked, so saving the company profile still works.
- `fieldErrors.baseCurrency`: the settings page shows the message under the currency select, with no change to
  the page.

**File: `apps/api/src/setup/templates.ts`** (change)

```diff
@@ -33,7 +33,15 @@ export interface IndustryTemplate {
 const ACCOUNTANT: RoleTemplate = {
   name: 'Accountant',
   description: 'Books, VAT returns and Mushak 6.3',
-  permissions: ['core.user.read', 'core.audit.read', 'accounting.account.manage'],
+  permissions: [
+    'core.user.read',
+    'core.audit.read',
+    'accounting.account.manage',
+    'accounting.journal.read',
+    'accounting.journal.create',
+    'accounting.journal.post',
+    'accounting.period.close',
+  ],
 };
 
 const STORE_KEEPER: RoleTemplate = {
```

- For new workspaces only. A template never touches existing roles.

---

## 10.4 — The API's tests

**File: `apps/api/src/journal/journal.int.spec.ts`** (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  journalEntrySchema,
  journalPageSchema,
  ledgerPageSchema,
  memberPageSchema,
  openingBalancesSchema,
  periodLockSchema,
  problemSchema,
  roleListSchema,
  roleSchema,
  settingsSchema,
  setupSchema,
  shiftIsoDate,
  todayIn,
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
let maker: SignedIn;
let accounts: Account[];

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

function id(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

// A line as the form sends it: '' on the empty side
function debit(code: string, amount: string) {
  return { accountId: id(code), branchId: null, description: '', debit: amount, credit: '' };
}
function credit(code: string, amount: string) {
  return { accountId: id(code), branchId: null, description: '', debit: '', credit: amount };
}

function write(
  date: string,
  lines: object[],
  { post = true, narration = 'Test entry', as = owner } = {},
) {
  return send('POST', '/journal-entries', { date, narration, lines, post }, as);
}

async function posted(date: string, lines: object[], narration = 'Test entry') {
  const res = await write(date, lines, { narration });
  expect(res.statusCode).toBe(201);
  return journalEntrySchema.parse(res.json());
}

// Runs SQL as the database superuser: RLS does not apply, but every trigger does
async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// The constraint name a failed statement reports, or null if it did not fail
async function constraintOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof postgres.PostgresError) return error.constraint_name ?? error.message;
    throw error;
  }
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
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;

  // A junior accountant: writes drafts, but may not post them (maker-checker)
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
  const role = roleSchema.parse(
    (await send('POST', '/roles', { name: 'Junior accountant', description: '' })).json(),
  );
  expect(
    (
      await send('PUT', '/permission-matrix', {
        roles: [
          {
            id: role.id,
            version: role.version,
            permissions: ['accounting.journal.read', 'accounting.journal.create'],
          },
        ],
      })
    ).statusCode,
  ).toBe(200);
  const { items: members } = memberPageSchema.parse((await send('GET', '/members')).json());
  const nasrin = members.find((member) => member.email === 'nasrin@rahmangarments.com');
  if (!nasrin) throw new Error('Nasrin is not a member');
  expect(
    (
      await send('PUT', `/members/${nasrin.membershipId}/roles`, {
        roleIds: [role.id],
        version: nasrin.version,
      })
    ).statusCode,
  ).toBe(200);
  maker = await logIn(app, {
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

describe('writing and posting', () => {
  it('keeps a draft without a number, and numbers it when it is posted', async () => {
    const res = await write('2026-09-01', [debit('1110', '500000'), credit('3100', '500000')], {
      post: false,
      narration: 'Capital paid in by the directors',
    });
    expect(res.statusCode).toBe(201);
    const draft = journalEntrySchema.parse(res.json());
    expect(draft).toMatchObject({ status: 'draft', number: null, total: '500000.0000' });
    expect(draft.lines.map((line) => [line.debit, line.credit])).toEqual([
      ['500000.0000', '0.0000'],
      ['0.0000', '500000.0000'],
    ]);

    const post = await send('POST', `/journal-entries/${draft.id}/post`, {
      version: draft.version,
    });
    expect(post.statusCode).toBe(200);
    // Fiscal year July–June: September 2026 is in 2026-27
    expect(journalEntrySchema.parse(post.json())).toMatchObject({
      status: 'posted',
      number: 'JV-2026-27-0001',
    });

    const direct = await posted('2026-09-02', [debit('5220', '85000'), credit('1110', '85000')]);
    expect(direct.number).toBe('JV-2026-27-0002');
  });

  it('refuses to post an entry that does not balance — and "Post" then saves nothing', async () => {
    const before = journalPageSchema.parse((await send('GET', '/journal-entries')).json());
    const res = await write('2026-09-03', [debit('5230', '12000'), credit('1110', '11000')]);
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('journal_unbalanced');
    const after = journalPageSchema.parse((await send('GET', '/journal-entries')).json());
    expect(after.items).toHaveLength(before.items.length);

    // As a draft it may be out of balance while it is written; posting it is refused
    const draft = journalEntrySchema.parse(
      (
        await write('2026-09-03', [debit('5230', '12000'), credit('1110', '11000')], {
          post: false,
        })
      ).json(),
    );
    const post = await send('POST', `/journal-entries/${draft.id}/post`, {
      version: draft.version,
    });
    expect(problemSchema.parse(post.json()).code).toBe('journal_unbalanced');
    // Fixed and posted in one save
    const fixed = await send('PUT', `/journal-entries/${draft.id}`, {
      date: '2026-09-03',
      narration: 'DESCO bill, September',
      lines: [debit('5230', '12000'), credit('1110', '12000')],
      post: true,
      version: draft.version,
    });
    expect(journalEntrySchema.parse(fixed.json())).toMatchObject({
      status: 'posted',
      number: 'JV-2026-27-0003',
    });
  });

  it('refuses a group or an unknown account, under the line it belongs to', async () => {
    const res = await write('2026-09-04', [
      debit('1110', '100'),
      { ...credit('1100', '100') },
      { ...credit('1110', '0'), accountId: '01939d1c-0000-7000-8000-000000000000', credit: '5' },
    ]);
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      'lines.1.accountId': ['journal_account_invalid'],
      'lines.2.accountId': ['journal_account_invalid'],
    });
  });
});

describe('a posted entry', () => {
  it('is never changed: the API refuses, and so does the database', async () => {
    const entry = await posted('2026-09-05', [debit('5250', '4500'), credit('1110', '4500')]);
    const edit = await send('PUT', `/journal-entries/${entry.id}`, {
      date: entry.date,
      narration: 'Changed',
      lines: [debit('5250', '450'), credit('1110', '450')],
      post: false,
      version: entry.version,
    });
    expect(problemSchema.parse(edit.json()).code).toBe('journal_not_draft');
    const remove = await send(
      'DELETE',
      `/journal-entries/${entry.id}?version=${String(entry.version)}`,
    );
    expect(problemSchema.parse(remove.json()).code).toBe('journal_not_draft');

    // Even the superuser, past the API and RLS, cannot touch it. Only the debit line changes, so
    // every other rule (one side per line) still holds: only the trigger can refuse this.
    await superuserSql(async (sql) => {
      expect(
        await constraintOf(
          () =>
            sql`UPDATE journal_lines SET debit = 450 WHERE entry_id = ${entry.id} AND debit > 0`,
        ),
      ).toBe('journal_lines_posted_immutable');
      expect(
        await constraintOf(
          () => sql`UPDATE journal_entries SET narration = 'Changed' WHERE id = ${entry.id}`,
        ),
      ).toBe('journal_entries_posted_immutable');
      expect(
        await constraintOf(() => sql`DELETE FROM journal_entries WHERE id = ${entry.id}`),
      ).toBe('journal_entries_posted_immutable');
    });
  });

  it('must balance even when written by hand: the database checks at commit', async () => {
    const failed = await constraintOf(() =>
      superuserSql((sql) =>
        sql.begin(async (tx) => {
          const [entry] = await tx<{ id: string }[]>`
            INSERT INTO journal_entries (id, tenant_id, date, status)
            SELECT gen_random_uuid(), id, '2026-09-06', 'draft' FROM tenants
             WHERE slug = 'rahman-garments'
            RETURNING id`;
          if (!entry) throw new Error('no entry');
          // Two lines, 100 against 90: each statement is fine on its own
          await tx`
            INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_id, debit, credit)
            SELECT gen_random_uuid(), e.tenant_id, e.id, v.line_no, v.account_id::uuid, v.debit, v.credit
              FROM journal_entries e,
                   (VALUES (1, ${id('1110')}, 100, 0), (2, ${id('3100')}, 0, 90))
                     AS v(line_no, account_id, debit, credit)
             WHERE e.id = ${entry.id}`;
          await tx`
            UPDATE journal_entries SET status = 'posted', number = 'JV-HAND-1', posted_at = now()
             WHERE id = ${entry.id}`;
          // …and the imbalance is found at COMMIT
        }),
      ),
    );
    expect(failed).toBe('journal_entries_balanced');
  });

  it('is reversed once, with the sides swapped, never before its own date', async () => {
    const entry = await posted('2026-09-07', [debit('5240', '3200'), credit('1110', '3200')]);
    const early = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-09-06',
    });
    expect(problemSchema.parse(early.json()).fieldErrors).toEqual({
      date: ['journal_reversal_date'],
    });

    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-09-08',
    });
    expect(res.statusCode).toBe(201);
    const reversal = journalEntrySchema.parse(res.json());
    expect(reversal).toMatchObject({
      status: 'posted',
      source: 'reversal',
      reversalOf: { id: entry.id, number: entry.number },
      narration: `Reversal of ${entry.number ?? ''}`,
    });
    expect(reversal.lines.map((line) => [line.debit, line.credit])).toEqual(
      entry.lines.map((line) => [line.credit, line.debit]),
    );
    const original = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${entry.id}`)).json(),
    );
    expect(original.reversedBy).toEqual({ id: reversal.id, number: reversal.number });

    const again = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-09-08',
    });
    expect(problemSchema.parse(again.json()).code).toBe('journal_already_reversed');
    const back = await send('POST', `/journal-entries/${reversal.id}/reverse`, {
      version: reversal.version,
      date: '2026-09-08',
    });
    expect(problemSchema.parse(back.json()).code).toBe('journal_is_reversal');
  });

  it('keeps its account: the account can be archived, not deleted', async () => {
    const bank = accountSchema.parse(
      (
        await send('POST', '/accounts', {
          parentId: id('1120'),
          code: '1121',
          name: 'Dutch-Bangla Bank CD A/C 1234',
          isGroup: false,
          description: '',
        })
      ).json(),
    );
    accounts.push(bank);
    await posted('2026-09-09', [debit('1121', '200000'), credit('1110', '200000')]);
    const res = await send('DELETE', `/accounts/${bank.id}?version=${String(bank.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('account_in_use');
  });

  it('fixes the base currency', async () => {
    const settings = settingsSchema.parse((await send('GET', '/settings')).json());
    const res = await send('PUT', '/settings', {
      version: settings.version,
      companyName: settings.companyName,
      legalName: settings.legalName ?? '',
      bin: settings.bin ?? '',
      phone: settings.phone ?? '',
      email: settings.email ?? '',
      address: settings.address ?? '',
      baseCurrency: 'USD',
      fiscalYearStartMonth: settings.fiscalYearStartMonth,
      timezone: settings.timezone,
    });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      baseCurrency: ['base_currency_locked'],
    });
  });
});

describe('the ledger', () => {
  it('lists an account in date order, with a balance that runs on across pages', async () => {
    const tea = accountSchema.parse(
      (
        await send('POST', '/accounts', {
          parentId: id('5200'),
          code: '5290',
          name: 'Tea and entertainment',
          isGroup: false,
          description: '',
        })
      ).json(),
    );
    accounts.push(tea);
    await posted('2026-08-20', [debit('5290', '1500'), credit('1110', '1500')], 'Tea, August');
    await posted(
      '2026-09-10',
      [debit('5290', '2200.50'), credit('1110', '2200.50')],
      'Tea, September',
    );
    await posted(
      '2026-09-12',
      [debit('1110', '300'), credit('5290', '300')],
      'Refund from the canteen',
    );
    // Drafts are not in the books
    await write('2026-09-11', [debit('5290', '999'), credit('1110', '999')], { post: false });

    const first = ledgerPageSchema.parse(
      (await send('GET', `/accounts/${tea.id}/ledger?from=2026-09-01&limit=1`)).json(),
    );
    expect(first).toMatchObject({ openingBalance: '1500.0000', closingBalance: '3400.5000' });
    expect(first.items.map((line) => [line.date, line.debit, line.balance])).toEqual([
      ['2026-09-10', '2200.5000', '3700.5000'],
    ]);
    if (first.nextCursor === null) throw new Error('expected a second page');
    const second = ledgerPageSchema.parse(
      (
        await send(
          'GET',
          `/accounts/${tea.id}/ledger?from=2026-09-01&limit=1&cursor=${first.nextCursor}`,
        )
      ).json(),
    );
    expect(second.items.map((line) => [line.narration, line.credit, line.balance])).toEqual([
      ['Refund from the canteen', '300.0000', '3400.5000'],
    ]);
    expect(second.nextCursor).toBeNull();
  });
});

describe('opening balances', () => {
  it('posts them the day before go-live, with the difference in opening balance equity', async () => {
    expect(openingBalancesSchema.parse((await send('GET', '/opening-balances')).json())).toEqual({
      goLiveDate: null,
      entry: null,
      lines: [],
    });
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [
        { accountId: id('1121'), debit: '1842600.50', credit: '' },
        { accountId: id('1151'), debit: '650000', credit: '' },
        { accountId: id('2110'), debit: '', credit: '412000' },
        { accountId: id('1290'), debit: '', credit: '' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const saved = openingBalancesSchema.parse(res.json());
    expect(saved.goLiveDate).toBe('2026-07-01');
    expect(saved.lines).toHaveLength(3);

    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${saved.entry?.id ?? ''}`)).json(),
    );
    // June 2026 is still the fiscal year 2025-26
    expect(entry).toMatchObject({
      date: '2026-06-30',
      source: 'opening_balance',
      total: '2492600.5000',
    });
    expect(entry.number).toMatch(/^JV-2025-26-/);
    expect(entry.lines.at(-1)).toMatchObject({ accountId: id('3300'), credit: '2080600.5000' });
  });

  it('replaces them by reversing the old entry, and refuses a stale page', async () => {
    const current = openingBalancesSchema.parse((await send('GET', '/opening-balances')).json());
    const stale = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [],
    });
    expect(problemSchema.parse(stale.json()).code).toBe('version_conflict');

    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: current.entry?.id ?? null,
      lines: [
        { accountId: id('1121'), debit: '1842600.50', credit: '' },
        { accountId: id('3100'), debit: '', credit: '1842600.50' },
      ],
    });
    const saved = openingBalancesSchema.parse(res.json());
    expect(saved.entry?.id).not.toBe(current.entry?.id);
    const old = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${current.entry?.id ?? ''}`)).json(),
    );
    expect(old.reversedBy).not.toBeNull();
    // Balanced by itself: no equity line this time
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${saved.entry?.id ?? ''}`)).json(),
    );
    expect(entry.lines).toHaveLength(2);
  });

  it('takes balance sheet ledgers only, each once', async () => {
    const current = openingBalancesSchema.parse((await send('GET', '/opening-balances')).json());
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: current.entry?.id ?? null,
      lines: [
        { accountId: id('1110'), debit: '100', credit: '' },
        { accountId: id('4110'), debit: '', credit: '100' },
        { accountId: id('3300'), debit: '', credit: '100' },
        { accountId: id('1100'), debit: '100', credit: '' },
      ],
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      'lines.1.accountId': ['opening_account_invalid'],
      'lines.2.accountId': ['opening_account_invalid'],
      'lines.3.accountId': ['opening_account_invalid'],
    });
    const twice = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: current.entry?.id ?? null,
      lines: [
        { accountId: id('1110'), debit: '100', credit: '' },
        { accountId: id('1110'), debit: '', credit: '100' },
      ],
    });
    expect(problemSchema.parse(twice.json()).fieldErrors).toEqual({
      'lines.1.accountId': ['opening_account_twice'],
    });
  });
});

describe('permissions', () => {
  it('lets a maker write drafts, and only a poster post them', async () => {
    const draft = await write('2026-09-14', [debit('5260', '1800'), credit('1110', '1800')], {
      post: false,
      as: maker,
    });
    expect(draft.statusCode).toBe(201);
    const direct = await write('2026-09-14', [debit('5260', '1800'), credit('1110', '1800')], {
      as: maker,
    });
    expect(direct.statusCode).toBe(403);
    expect(problemSchema.parse(direct.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'accounting.journal.post' },
    });
    const entry = journalEntrySchema.parse(draft.json());
    const post = await send(
      'POST',
      `/journal-entries/${entry.id}/post`,
      { version: entry.version },
      maker,
    );
    expect(post.statusCode).toBe(403);
    // The checker posts the maker's draft
    const checked = await send('POST', `/journal-entries/${entry.id}/post`, {
      version: entry.version,
    });
    expect(journalEntrySchema.parse(checked.json()).status).toBe('posted');
  });

  it('gives the Accountant role of a new workspace the whole journal', async () => {
    const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
    expect(items.find((role) => role.name === 'Accountant')?.permissions).toEqual(
      expect.arrayContaining([
        'accounting.journal.read',
        'accounting.journal.create',
        'accounting.journal.post',
        'accounting.period.close',
      ]),
    );
  });
});

// Last: once the books are closed, the tests above could not post into August and September
describe('the lock date', () => {
  it('closes the books up to a day, for posting and reversing, but not in the future', async () => {
    const entry = await posted('2026-08-25', [debit('5270', '7000'), credit('1110', '7000')]);
    const future = shiftIsoDate(todayIn('Asia/Dhaka'), 1);
    const ahead = await send('PUT', '/period-lock', { lockDate: future, version: 0 });
    expect(problemSchema.parse(ahead.json()).fieldErrors).toEqual({
      lockDate: ['period_lock_future'],
    });

    const lock = await send('PUT', '/period-lock', { lockDate: '2026-08-31', version: 0 });
    expect(periodLockSchema.parse(lock.json())).toEqual({ lockDate: '2026-08-31', version: 1 });

    const late = await write('2026-08-31', [debit('5270', '100'), credit('1110', '100')]);
    expect(problemSchema.parse(late.json()).fieldErrors).toEqual({
      date: ['journal_period_locked'],
    });
    const reverse = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-08-30',
    });
    expect(problemSchema.parse(reverse.json()).code).toBe('journal_period_locked');
    // The day after is open, and a reversal can be dated there
    const open = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-09-01',
    });
    expect(open.statusCode).toBe(201);

    const reopen = await send('PUT', '/period-lock', { lockDate: '', version: 1 });
    expect(periodLockSchema.parse(reopen.json())).toEqual({ lockDate: null, version: 2 });
  });
});
```

- **The real worker runs**, because the chart of accounts comes from the setup job, exactly as for a person.
- **The maker** is a member with a role holding only `read` and `create`, set up through the API like an owner
  would: create the role, tick two permissions in the matrix, give her the role.
- **"keeps a draft without a number"** — the number appears only when posting, and the fiscal year decides its
  middle part (September 2026 → `2026-27`).
- **"refuses to post … and Post then saves nothing"** — counts the list before and after, so "all or nothing" is
  checked, not assumed.
- **"is never changed: the API refuses, and so does the database"** — the superuser has no RLS and no API in the
  way, and the triggers still refuse. `constraintOf()` returns the constraint name Postgres reports. The line
  update changes **only the debit line** (`AND debit > 0`): changing both would break the one-side `CHECK` first,
  and the test would pass even without the trigger (found by breaking the trigger on purpose).
- **"must balance even when written by hand"** — writes a draft and two lines (100 against 90) by hand, posts it
  with an `UPDATE`, and each statement passes; the `COMMIT` fails with `journal_entries_balanced`. This is the
  test for the deferred trigger.
- **The ledger test** posts three lines on two dates and a draft, then reads one row per page: page 2's running
  balance continues from page 1's, and the draft is not there.
- **The opening balance test** checks the date (the day before go-live), the fiscal year of the number (June
  2026 → `2025-26`) and the equity line: `1,842,600.50 + 650,000 − 412,000 = 2,080,600.50` on the credit side.
- **The lock date runs last**, because it closes August, which earlier tests post into.

**File: `apps/api/src/journal/journal.tenant-leak.int.spec.ts`** (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  branchListSchema,
  type JournalEntry,
  journalEntrySchema,
  journalPageSchema,
  problemSchema,
  setupSchema,
} from '@omnivo/contracts';
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

// Two workspaces with books of their own: A must never see, change or post into B's. Every answer
// is 404, or the same "invalid account" as for an id that does not exist.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let chartOfA: Account[];
let chartOfB: Account[];
let entryOfB: JournalEntry;
let draftOfB: JournalEntry;

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

async function setUp(who: SignedIn, industry: 'garments' | 'pharma'): Promise<Account[]> {
  expect((await as(who, 'POST', '/setup', { industry })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
  return accountListSchema.parse((await as(who, 'GET', '/accounts')).json()).items;
}

function idIn(chart: Account[], code: string): string {
  const found = chart.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function line(accountId: string, side: 'debit' | 'credit', branchId: string | null = null) {
  return {
    accountId,
    branchId,
    description: '',
    debit: side === 'debit' ? '1000' : '',
    credit: side === 'credit' ? '1000' : '',
  };
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
  [chartOfA, chartOfB] = await Promise.all([setUp(tenantA, 'garments'), setUp(tenantB, 'pharma')]);

  const entry = {
    date: '2026-09-15',
    narration: 'Medical samples for Mymensingh',
    lines: [line(idIn(chartOfB, '5330'), 'debit'), line(idIn(chartOfB, '1110'), 'credit')],
  };
  entryOfB = journalEntrySchema.parse(
    (await as(tenantB, 'POST', '/journal-entries', { ...entry, post: true })).json(),
  );
  draftOfB = journalEntrySchema.parse(
    (await as(tenantB, 'POST', '/journal-entries', { ...entry, post: false })).json(),
  );
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('journal isolation over HTTP', () => {
  it("never lists or reads tenant B's entries or ledgers", async () => {
    const { items } = journalPageSchema.parse(
      (await as(tenantA, 'GET', '/journal-entries')).json(),
    );
    expect(items).toEqual([]);
    expect((await as(tenantA, 'GET', `/journal-entries/${entryOfB.id}`)).statusCode).toBe(404);
    const ledger = await as(tenantA, 'GET', `/accounts/${idIn(chartOfB, '1110')}/ledger`);
    expect(ledger.statusCode).toBe(404);
  });

  it("cannot change, post, reverse or delete tenant B's entries", async () => {
    const body = {
      date: '2026-09-15',
      narration: 'Taken over',
      lines: [line(idIn(chartOfA, '5310'), 'debit'), line(idIn(chartOfA, '1110'), 'credit')],
      post: false,
      version: draftOfB.version,
    };
    expect((await as(tenantA, 'PUT', `/journal-entries/${draftOfB.id}`, body)).statusCode).toBe(
      404,
    );
    const post = await as(tenantA, 'POST', `/journal-entries/${draftOfB.id}/post`, {
      version: draftOfB.version,
    });
    expect(post.statusCode).toBe(404);
    const reverse = await as(tenantA, 'POST', `/journal-entries/${entryOfB.id}/reverse`, {
      version: entryOfB.version,
      date: '2026-09-16',
    });
    expect(reverse.statusCode).toBe(404);
    const remove = await as(
      tenantA,
      'DELETE',
      `/journal-entries/${draftOfB.id}?version=${String(draftOfB.version)}`,
    );
    expect(remove.statusCode).toBe(404);

    const still = journalEntrySchema.parse(
      (await as(tenantB, 'GET', `/journal-entries/${draftOfB.id}`)).json(),
    );
    expect(still).toMatchObject({ status: 'draft', version: draftOfB.version });
    const { items } = journalPageSchema.parse(
      (await as(tenantB, 'GET', '/journal-entries')).json(),
    );
    expect(items.find((entry) => entry.id === entryOfB.id)?.reversedBy).toBeNull();
  });

  it("cannot post to tenant B's accounts, branches or opening balances", async () => {
    const accountOfB = await as(tenantA, 'POST', '/journal-entries', {
      date: '2026-09-15',
      narration: 'Borrowed account',
      lines: [line(idIn(chartOfB, '1110'), 'debit'), line(idIn(chartOfA, '3100'), 'credit')],
      post: false,
    });
    expect(problemSchema.parse(accountOfB.json()).fieldErrors).toEqual({
      'lines.0.accountId': ['journal_account_invalid'],
    });

    const branchOfB = branchListSchema.parse((await as(tenantB, 'GET', '/branches')).json())
      .items[0];
    const borrowedBranch = await as(tenantA, 'POST', '/journal-entries', {
      date: '2026-09-15',
      narration: 'Borrowed branch',
      lines: [
        line(idIn(chartOfA, '1110'), 'debit', branchOfB?.id ?? null),
        line(idIn(chartOfA, '3100'), 'credit'),
      ],
      post: false,
    });
    expect(problemSchema.parse(borrowedBranch.json()).fieldErrors).toEqual({
      'lines.0.branchId': ['journal_branch_invalid'],
    });

    const opening = await as(tenantA, 'PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [{ accountId: idIn(chartOfB, '1110'), debit: '500', credit: '' }],
    });
    expect(problemSchema.parse(opening.json()).fieldErrors).toEqual({
      'lines.0.accountId': ['opening_account_invalid'],
    });
  });
});
```

- Two workspaces of different industries. Every read and write of B's entry from A is a `404`, and B's draft is
  unchanged afterwards (same version).
- **A line with B's account or branch** answers the same `journal_account_invalid` / `journal_branch_invalid` as
  an id that does not exist. Without `checkLines`, the composite FK would refuse it anyway — with a 500.

**File: `apps/api/src/setup/setup.int.spec.ts`** (change)

```diff
@@ -124,7 +124,18 @@ describe('starting the setup', () => {
     const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
     expect(items.map((role) => [role.name, role.permissions])).toEqual([
       ['Owner', expect.any(Array)],
-      ['Accountant', ['accounting.account.manage', 'core.audit.read', 'core.user.read']],
+      [
+        'Accountant',
+        [
+          'accounting.account.manage',
+          'accounting.journal.create',
+          'accounting.journal.post',
+          'accounting.journal.read',
+          'accounting.period.close',
+          'core.audit.read',
+          'core.user.read',
+        ],
+      ],
       ['Merchandiser', ['core.user.read']],
       ['Store keeper', []],
     ]);
```

- The Accountant role of a new garments workspace now has the four journal permissions.

---

## 10.5 — `packages/i18n`: the texts

**File: `packages/i18n/src/locales/en.ts`** (change)

```diff
@@ -44,6 +44,9 @@ export const en = {
     roles: 'Roles',
     accounting: 'Accounting',
     chartOfAccounts: 'Chart of accounts',
+    journal: 'Journal',
+    ledger: 'Ledger',
+    openingBalances: 'Opening balances',
   },
   auth: {
     workspace: 'Workspace',
@@ -271,6 +274,137 @@ export const en = {
       'Ask a workspace owner for the accounting.account.manage permission to change the chart.',
     loadFailed: "Couldn't load the chart of accounts. Refresh the page to try again.",
   },
+  journal: {
+    title: 'Journal',
+    description: 'Every entry in the books, newest first',
+    newEntry: 'New entry',
+    lockDate: 'Lock date',
+    lockedUntil: 'Books closed up to {{date}}',
+    show: 'Show',
+    filters: {
+      all: 'All',
+      draft: 'Drafts',
+      posted: 'Posted',
+    },
+    columns: {
+      number: 'Number',
+      date: 'Date',
+      narration: 'Narration',
+      amount: 'Amount',
+      status: 'Status',
+    },
+    statuses: {
+      draft: 'Draft',
+      posted: 'Posted',
+      reversed: 'Reversed',
+    },
+    emptyTitle: 'No journal entries yet',
+    emptyBody:
+      "Write the first one, like the capital the directors paid in or this month's office rent.",
+    loadFailed: "Couldn't load the journal. Refresh the page to try again.",
+    back: 'Back to the journal',
+    newTitle: 'New journal entry',
+    draftTitle: 'Draft entry',
+    entryDescription: '{{date}} · {{status}}',
+    date: 'Date',
+    narration: 'Narration',
+    narrationPlaceholder: 'Office rent for September, Banani head office',
+    lines: 'Lines',
+    line: 'Line {{number}}',
+    account: 'Account',
+    accountPlaceholder: 'Pick an account',
+    lineDescription: 'Description',
+    branch: 'Branch',
+    noBranch: 'No branch',
+    debit: 'Debit',
+    credit: 'Credit',
+    addLine: 'Add line',
+    removeLine: 'Remove line {{number}}',
+    total: 'Total',
+    balanced: 'Balanced',
+    outBy: 'Out by {{amount}}',
+    saveDraft: 'Save draft',
+    post: 'Post entry',
+    posting: 'Posting…',
+    deleteDraft: 'Delete draft',
+    confirmDelete: 'Delete this draft',
+    deleteWarning: 'This cannot be undone.',
+    postHint: 'Post is available when the debits and credits are equal.',
+    cantPost: 'Ask a workspace owner for the accounting.journal.post permission to post entries.',
+    reverse: 'Reverse',
+    reverseTitle: 'Reverse {{number}}',
+    reverseBody:
+      'A new entry with every debit and credit swapped cancels this one. Both stay in the books.',
+    reverseDate: 'Date of the reversal',
+    confirmReverse: 'Reverse entry',
+    reversedBy: 'Reversed by {{number}}',
+    reverses: 'Reverses {{number}}',
+    sources: {
+      manual: 'Written by hand',
+      opening_balance: 'Opening balances',
+      reversal: 'Reversal',
+    },
+    draftSaved: 'Draft saved',
+    posted: '{{number}} posted',
+    deleted: 'Draft deleted',
+    reversed: '{{number}} reverses {{original}}',
+    notFound: "This entry doesn't exist, or it was a draft that was deleted.",
+    lock: {
+      title: 'Lock date',
+      description:
+        'Nothing can be posted or reversed on or before this date. Clear it to open the books again.',
+      field: 'Books closed up to',
+      hint: 'Usually the last day of a month you have finished, like 30 Sep 2026.',
+      clear: 'Clear',
+      save: 'Save lock date',
+      saved: 'Books closed up to {{date}}',
+      cleared: 'All periods are open',
+    },
+  },
+  ledger: {
+    title: 'Ledger',
+    description: 'The posted entries of one account, with its running balance',
+    account: 'Account',
+    accountPlaceholder: 'Pick an account',
+    from: 'From',
+    to: 'To',
+    opening: 'Opening balance',
+    closing: 'Closing balance',
+    columns: {
+      date: 'Date',
+      entry: 'Entry',
+      debit: 'Debit',
+      credit: 'Credit',
+      balance: 'Balance',
+    },
+    // A balance with its side: "৳1,200 Dr"
+    debitBalance: '{{amount}} Dr',
+    creditBalance: '{{amount}} Cr',
+    pickTitle: 'Pick an account',
+    pickBody: 'Choose an account above to see its entries, like Cash in hand or Office rent.',
+    emptyTitle: 'No entries in these dates',
+    emptyBody: 'Pick other dates, or post an entry to this account from the journal.',
+    loadFailed: "Couldn't load the ledger. Refresh the page to try again.",
+  },
+  opening: {
+    title: 'Opening balances',
+    description: 'What each account held when you moved your books to Omnivo',
+    goLive: 'First day on Omnivo',
+    goLiveHint: 'The balances are posted as at the day before: {{date}}.',
+    postedAs: 'Posted as {{number}}',
+    account: 'Account',
+    debit: 'Debit',
+    credit: 'Credit',
+    total: 'Total',
+    difference: 'Opening balance equity',
+    differenceHint: 'What the balances are out by goes here. It reads zero once everything is in.',
+    save: 'Post opening balances',
+    saved: 'Opening balances posted as {{number}}',
+    cleared: 'Opening balances cleared',
+    readOnly:
+      'Ask a workspace owner for the accounting.journal.post permission to change the opening balances.',
+    loadFailed: "Couldn't load the opening balances. Refresh the page to try again.",
+  },
   team: {
     title: 'Team',
     description: 'People with access to this workspace, and the roles they have',
@@ -379,6 +513,12 @@ export const en = {
     },
     accounting: {
       account: { manage: 'Add, change, archive and delete accounts' },
+      journal: {
+        read: 'See journal entries and ledgers',
+        create: 'Write and edit draft entries',
+        post: 'Post and reverse entries, set opening balances',
+      },
+      period: { close: 'Close the books up to a date' },
     },
   },
   invite: {
@@ -415,6 +555,7 @@ export const en = {
       invitation: 'Invitations',
       role: 'Roles',
       account: 'Chart of accounts',
+      journal_entry: 'Journal',
     },
     columns: {
       when: 'When',
@@ -467,6 +608,15 @@ export const en = {
         restored: 'Restored an account',
         deleted: 'Deleted an account',
       },
+      journal: {
+        created: 'Wrote a journal entry',
+        updated: 'Edited a draft entry',
+        deleted: 'Deleted a draft entry',
+        posted: 'Posted a journal entry',
+        reversed: 'Reversed a journal entry',
+        opening_balances_saved: 'Posted the opening balances',
+      },
+      books: { lock_date_changed: 'Changed the lock date' },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -491,6 +641,15 @@ export const en = {
       industry: 'Business type',
       parent: 'Group',
       accounts: 'Accounts',
+      date: 'Date',
+      narration: 'Narration',
+      total: 'Amount',
+      lines: 'Lines',
+      number: 'Number',
+      reversal: 'Reversal',
+      lockDate: 'Lock date',
+      goLiveDate: 'First day on Omnivo',
+      entry: 'Entry',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -632,6 +791,27 @@ export const en = {
       "Top-level groups and system accounts can't be archived or deleted. You can rename them.",
     account_has_children: 'Move or delete the accounts under this group first.',
     account_has_active_children: 'Archive the accounts under this group first.',
+    account_in_use: 'Entries use this account, so it stays in the books. Archive it instead.',
+    money_format: 'Enter an amount like 18500 or 18500.50.',
+    journal_date_required: 'Pick the date of the entry.',
+    journal_account_required: 'Pick an account.',
+    journal_line_amount: 'Enter the amount as a debit or a credit, not both.',
+    journal_lines_too_few: 'An entry needs at least two lines.',
+    journal_unbalanced: 'Make the debits and credits equal, then post.',
+    journal_account_invalid: 'Pick an active account that is not a group.',
+    journal_branch_invalid: 'Pick an active branch, or no branch.',
+    journal_period_locked: 'The books are closed for this date. Pick a date after the lock date.',
+    journal_not_draft: "This entry is posted and can't change. Reverse it instead.",
+    journal_not_posted: 'Only a posted entry can be reversed. Delete the draft instead.',
+    journal_is_reversal: "A reversal can't be reversed. Post a new entry instead.",
+    journal_already_reversed: 'This entry has been reversed already. Reload to see the reversal.',
+    journal_reversal_date: "Pick a date on or after the entry's own date.",
+    opening_date_required: 'Pick your first day on Omnivo.',
+    opening_account_invalid:
+      'Only active asset, liability and equity accounts take an opening balance.',
+    opening_account_twice: 'Enter each account once.',
+    period_lock_future: 'Pick today or an earlier date.',
+    base_currency_locked: "Entries are posted in this currency, so it can't change any more.",
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- **`journal.*`** — the list, the form, the view, the reverse dialog and the lock date dialog.
- **`ledger.debitBalance` / `creditBalance`** — "৳1,200.00 Dr". Dr and Cr are what every accountant in Bangladesh
  writes; in Bangla, "ডে." and "ক্রে.".
- **`journal.columns.status`** — the phone card shows each detail with its column name, so the status column
  needs one even though the desktop header could do without.
- The error sentences say what to do: "Make the debits and credits equal, then post", not "Unbalanced entry".

**File: `packages/i18n/src/locales/bn.ts`** (change)

```diff
@@ -44,6 +44,9 @@ export const bn: Messages = {
     roles: 'রোল',
     accounting: 'হিসাবরক্ষণ',
     chartOfAccounts: 'চার্ট অফ অ্যাকাউন্টস',
+    journal: 'জার্নাল',
+    ledger: 'লেজার',
+    openingBalances: 'ওপেনিং ব্যালান্স',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -268,6 +271,135 @@ export const bn: Messages = {
     readOnly: 'চার্ট বদলাতে ওয়ার্কস্পেস মালিকের কাছে accounting.account.manage অনুমতি চান।',
     loadFailed: 'চার্ট অফ অ্যাকাউন্টস আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  journal: {
+    title: 'জার্নাল',
+    description: 'বইয়ের প্রতিটা এন্ট্রি, নতুনগুলো আগে',
+    newEntry: 'নতুন এন্ট্রি',
+    lockDate: 'লক তারিখ',
+    lockedUntil: '{{date}} পর্যন্ত বই বন্ধ',
+    show: 'দেখান',
+    filters: {
+      all: 'সব',
+      draft: 'ড্রাফট',
+      posted: 'পোস্ট করা',
+    },
+    columns: {
+      number: 'নম্বর',
+      date: 'তারিখ',
+      narration: 'বিবরণ',
+      amount: 'পরিমাণ',
+      status: 'অবস্থা',
+    },
+    statuses: {
+      draft: 'ড্রাফট',
+      posted: 'পোস্ট করা',
+      reversed: 'রিভার্স করা',
+    },
+    emptyTitle: 'এখনো কোনো জার্নাল এন্ট্রি নেই',
+    emptyBody: 'প্রথমটা লিখুন, যেমন পরিচালকদের দেওয়া মূলধন বা এই মাসের অফিস ভাড়া।',
+    loadFailed: 'জার্নাল আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    back: 'জার্নালে ফিরুন',
+    newTitle: 'নতুন জার্নাল এন্ট্রি',
+    draftTitle: 'ড্রাফট এন্ট্রি',
+    entryDescription: '{{date}} · {{status}}',
+    date: 'তারিখ',
+    narration: 'বিবরণ',
+    narrationPlaceholder: 'সেপ্টেম্বরের অফিস ভাড়া, বনানী হেড অফিস',
+    lines: 'লাইন',
+    line: 'লাইন {{number}}',
+    account: 'অ্যাকাউন্ট',
+    accountPlaceholder: 'একটা অ্যাকাউন্ট বাছুন',
+    lineDescription: 'বিবরণ',
+    branch: 'ব্রাঞ্চ',
+    noBranch: 'কোনো ব্রাঞ্চ না',
+    debit: 'ডেবিট',
+    credit: 'ক্রেডিট',
+    addLine: 'লাইন যোগ করুন',
+    removeLine: 'লাইন {{number}} সরান',
+    total: 'মোট',
+    balanced: 'মিলেছে',
+    outBy: '{{amount}} গরমিল',
+    saveDraft: 'ড্রাফট সেভ করুন',
+    post: 'এন্ট্রি পোস্ট করুন',
+    posting: 'পোস্ট হচ্ছে…',
+    deleteDraft: 'ড্রাফট মুছুন',
+    confirmDelete: 'এই ড্রাফট মুছুন',
+    deleteWarning: 'এটা আর ফেরানো যাবে না।',
+    postHint: 'ডেবিট আর ক্রেডিট সমান হলে পোস্ট করা যাবে।',
+    cantPost: 'এন্ট্রি পোস্ট করতে ওয়ার্কস্পেস মালিকের কাছে accounting.journal.post অনুমতি চান।',
+    reverse: 'রিভার্স',
+    reverseTitle: '{{number}} রিভার্স',
+    reverseBody:
+      'প্রতিটা ডেবিট আর ক্রেডিট উল্টে একটা নতুন এন্ট্রি এটাকে বাতিল করে। দুটোই বইয়ে থেকে যায়।',
+    reverseDate: 'রিভার্সের তারিখ',
+    confirmReverse: 'এন্ট্রি রিভার্স করুন',
+    reversedBy: '{{number}} দিয়ে রিভার্স করা',
+    reverses: '{{number}}-কে রিভার্স করে',
+    sources: {
+      manual: 'হাতে লেখা',
+      opening_balance: 'ওপেনিং ব্যালান্স',
+      reversal: 'রিভার্সাল',
+    },
+    draftSaved: 'ড্রাফট সেভ হয়েছে',
+    posted: '{{number}} পোস্ট হয়েছে',
+    deleted: 'ড্রাফট মোছা হয়েছে',
+    reversed: '{{number}} দিয়ে {{original}} রিভার্স হয়েছে',
+    notFound: 'এই এন্ট্রি নেই, অথবা এটা একটা ড্রাফট ছিল যা মোছা হয়েছে।',
+    lock: {
+      title: 'লক তারিখ',
+      description:
+        'এই তারিখে বা তার আগে কিছু পোস্ট বা রিভার্স করা যাবে না। বই আবার খুলতে তারিখটা মুছে দিন।',
+      field: 'যে তারিখ পর্যন্ত বই বন্ধ',
+      hint: 'সাধারণত শেষ করা কোনো মাসের শেষ দিন, যেমন ৩০ সেপ, ২০২৬।',
+      clear: 'মুছুন',
+      save: 'লক তারিখ সেভ করুন',
+      saved: '{{date}} পর্যন্ত বই বন্ধ',
+      cleared: 'সব সময়কাল খোলা',
+    },
+  },
+  ledger: {
+    title: 'লেজার',
+    description: 'একটা অ্যাকাউন্টের পোস্ট করা এন্ট্রি, চলতি ব্যালান্স সহ',
+    account: 'অ্যাকাউন্ট',
+    accountPlaceholder: 'একটা অ্যাকাউন্ট বাছুন',
+    from: 'থেকে',
+    to: 'পর্যন্ত',
+    opening: 'প্রারম্ভিক ব্যালান্স',
+    closing: 'সমাপনী ব্যালান্স',
+    columns: {
+      date: 'তারিখ',
+      entry: 'এন্ট্রি',
+      debit: 'ডেবিট',
+      credit: 'ক্রেডিট',
+      balance: 'ব্যালান্স',
+    },
+    debitBalance: '{{amount}} ডে.',
+    creditBalance: '{{amount}} ক্রে.',
+    pickTitle: 'একটা অ্যাকাউন্ট বাছুন',
+    pickBody: 'এন্ট্রি দেখতে উপরে একটা অ্যাকাউন্ট বাছুন, যেমন হাতে নগদ বা অফিস ভাড়া।',
+    emptyTitle: 'এই তারিখগুলোতে কোনো এন্ট্রি নেই',
+    emptyBody: 'অন্য তারিখ বাছুন, অথবা জার্নাল থেকে এই অ্যাকাউন্টে একটা এন্ট্রি পোস্ট করুন।',
+    loadFailed: 'লেজার আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  opening: {
+    title: 'ওপেনিং ব্যালান্স',
+    description: 'Omnivo-তে বই আনার সময় প্রতিটা অ্যাকাউন্টে কত ছিল',
+    goLive: 'Omnivo-তে প্রথম দিন',
+    goLiveHint: 'ব্যালান্সগুলো তার আগের দিনের হিসেবে পোস্ট হয়: {{date}}।',
+    postedAs: '{{number}} হিসেবে পোস্ট করা',
+    account: 'অ্যাকাউন্ট',
+    debit: 'ডেবিট',
+    credit: 'ক্রেডিট',
+    total: 'মোট',
+    difference: 'ওপেনিং ব্যালান্স ইকুইটি',
+    differenceHint: 'ব্যালান্সগুলো যতটা গরমিল, সেটা এখানে যায়। সব দেওয়া হলে এটা শূন্য হয়।',
+    save: 'ওপেনিং ব্যালান্স পোস্ট করুন',
+    saved: 'ওপেনিং ব্যালান্স {{number}} হিসেবে পোস্ট হয়েছে',
+    cleared: 'ওপেনিং ব্যালান্স মুছে ফেলা হয়েছে',
+    readOnly:
+      'ওপেনিং ব্যালান্স বদলাতে ওয়ার্কস্পেস মালিকের কাছে accounting.journal.post অনুমতি চান।',
+    loadFailed: 'ওপেনিং ব্যালান্স আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   team: {
     title: 'টিম',
     description: 'এই ওয়ার্কস্পেসে যাঁদের অ্যাক্সেস আছে, আর তাঁদের রোল',
@@ -374,6 +506,12 @@ export const bn: Messages = {
     },
     accounting: {
       account: { manage: 'অ্যাকাউন্ট যোগ, বদল, আর্কাইভ আর মোছা' },
+      journal: {
+        read: 'জার্নাল এন্ট্রি আর লেজার দেখা',
+        create: 'ড্রাফট এন্ট্রি লেখা আর বদলানো',
+        post: 'এন্ট্রি পোস্ট আর রিভার্স, ওপেনিং ব্যালান্স দেওয়া',
+      },
+      period: { close: 'একটা তারিখ পর্যন্ত বই বন্ধ করা' },
     },
   },
   invite: {
@@ -410,6 +548,7 @@ export const bn: Messages = {
       invitation: 'আমন্ত্রণ',
       role: 'রোল',
       account: 'চার্ট অফ অ্যাকাউন্টস',
+      journal_entry: 'জার্নাল',
     },
     columns: {
       when: 'কখন',
@@ -460,6 +599,15 @@ export const bn: Messages = {
         restored: 'অ্যাকাউন্ট ফিরিয়ে এনেছেন',
         deleted: 'অ্যাকাউন্ট মুছেছেন',
       },
+      journal: {
+        created: 'জার্নাল এন্ট্রি লিখেছেন',
+        updated: 'ড্রাফট এন্ট্রি বদলেছেন',
+        deleted: 'ড্রাফট এন্ট্রি মুছেছেন',
+        posted: 'জার্নাল এন্ট্রি পোস্ট করেছেন',
+        reversed: 'জার্নাল এন্ট্রি রিভার্স করেছেন',
+        opening_balances_saved: 'ওপেনিং ব্যালান্স পোস্ট করেছেন',
+      },
+      books: { lock_date_changed: 'লক তারিখ বদলেছেন' },
     },
     fields: {
       name: 'নাম',
@@ -483,6 +631,15 @@ export const bn: Messages = {
       industry: 'ব্যবসার ধরন',
       parent: 'গ্রুপ',
       accounts: 'অ্যাকাউন্ট',
+      date: 'তারিখ',
+      narration: 'বিবরণ',
+      total: 'পরিমাণ',
+      lines: 'লাইন',
+      number: 'নম্বর',
+      reversal: 'রিভার্সাল',
+      lockDate: 'লক তারিখ',
+      goLiveDate: 'Omnivo-তে প্রথম দিন',
+      entry: 'এন্ট্রি',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -620,6 +777,27 @@ export const bn: Messages = {
       'সবার উপরের গ্রুপ আর সিস্টেম অ্যাকাউন্ট আর্কাইভ বা মোছা যায় না। নাম বদলানো যায়।',
     account_has_children: 'আগে এই গ্রুপের নিচের অ্যাকাউন্টগুলো সরান বা মুছুন।',
     account_has_active_children: 'আগে এই গ্রুপের নিচের অ্যাকাউন্টগুলো আর্কাইভ করুন।',
+    account_in_use: 'এন্ট্রি এই অ্যাকাউন্ট ব্যবহার করে, তাই এটা বইয়ে থাকবে। এর বদলে আর্কাইভ করুন।',
+    money_format: '18500 বা 18500.50-এর মতো করে পরিমাণ লিখুন।',
+    journal_date_required: 'এন্ট্রির তারিখ বাছুন।',
+    journal_account_required: 'একটা অ্যাকাউন্ট বাছুন।',
+    journal_line_amount: 'পরিমাণটা ডেবিট অথবা ক্রেডিটে লিখুন, দুটোতে না।',
+    journal_lines_too_few: 'একটা এন্ট্রিতে অন্তত দুটো লাইন লাগে।',
+    journal_unbalanced: 'ডেবিট আর ক্রেডিট সমান করুন, তারপর পোস্ট করুন।',
+    journal_account_invalid: 'গ্রুপ নয় এমন একটা সক্রিয় অ্যাকাউন্ট বাছুন।',
+    journal_branch_invalid: 'একটা সক্রিয় ব্রাঞ্চ বাছুন, অথবা কোনো ব্রাঞ্চ না।',
+    journal_period_locked: 'এই তারিখের বই বন্ধ। লক তারিখের পরের একটা তারিখ বাছুন।',
+    journal_not_draft: 'এই এন্ট্রি পোস্ট করা, তাই বদলানো যায় না। এর বদলে রিভার্স করুন।',
+    journal_not_posted: 'শুধু পোস্ট করা এন্ট্রি রিভার্স করা যায়। ড্রাফট হলে মুছে ফেলুন।',
+    journal_is_reversal: 'রিভার্সালকে রিভার্স করা যায় না। এর বদলে নতুন একটা এন্ট্রি পোস্ট করুন।',
+    journal_already_reversed: 'এই এন্ট্রি আগেই রিভার্স করা হয়েছে। রিভার্সালটা দেখতে রিলোড করুন।',
+    journal_reversal_date: 'এন্ট্রির নিজের তারিখ বা তার পরের একটা তারিখ বাছুন।',
+    opening_date_required: 'Omnivo-তে আপনার প্রথম দিন বাছুন।',
+    opening_account_invalid:
+      'শুধু সক্রিয় সম্পদ, দায় আর ইকুইটি অ্যাকাউন্টে ওপেনিং ব্যালান্স দেওয়া যায়।',
+    opening_account_twice: 'প্রতিটা অ্যাকাউন্ট একবার দিন।',
+    period_lock_future: 'আজ বা তার আগের একটা তারিখ বাছুন।',
+    base_currency_locked: 'এই মুদ্রায় এন্ট্রি পোস্ট হয়েছে, তাই এটা আর বদলানো যায় না।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

- The type check fails if any key of `en.ts` is missing here. Office words stay as people say them: জার্নাল,
  লেজার, পোস্ট, রিভার্স, ড্রাফট.

---

## 10.6 — `packages/ui`: a bare select, and a calendar that loads when it opens

**File: `packages/ui/src/components/field.tsx`** (change)

```diff
@@ -139,6 +139,44 @@ export interface SelectOption {
   label: string;
 }
 
+export interface SelectProps extends Omit<ComponentProps<'select'>, 'className'> {
+  options: readonly SelectOption[];
+  icon?: IconSvgElement | undefined;
+  invalid?: boolean | undefined;
+}
+
+// The select box without a label, like Input next to TextField: for a control whose label sits
+// elsewhere, such as the column header above a journal line
+export function Select({ options, icon, invalid = false, ...select }: SelectProps) {
+  return (
+    <div className={controlBoxClass(invalid)}>
+      {icon && (
+        <HugeiconsIcon icon={icon} size={17} strokeWidth={1.5} className="shrink-0 text-ink-3" />
+      )}
+      <select
+        aria-invalid={invalid || undefined}
+        // appearance-none: ব্রাউজারের নিজের তীর মুছে আমাদের আইকন; bg-transparent: dark mode-এ
+        // Windows-এর সাদা বাক্স না
+        className="min-w-0 flex-1 appearance-none bg-transparent py-2.5 text-body outline-none"
+        {...select}
+      >
+        {options.map((option) => (
+          <option key={option.value} value={option.value}>
+            {option.label}
+          </option>
+        ))}
+      </select>
+      <HugeiconsIcon
+        icon={ArrowDown01Icon}
+        size={16}
+        strokeWidth={1.5}
+        // pointer-events-none: তীরে ক্লিক করলেও নিচের select খোলে
+        className="pointer-events-none shrink-0 text-ink-3"
+      />
+    </div>
+  );
+}
+
 export interface SelectFieldProps extends Omit<ComponentProps<'select'>, 'className' | 'id'> {
   label: string;
   id?: string;
@@ -166,33 +204,14 @@ export function SelectField({
   const fieldId = id ?? select.name ?? autoId;
   return (
     <Field id={fieldId} label={label} optional={optional} hint={hint} error={error}>
-      <div className={controlBoxClass(Boolean(error))}>
-        {icon && (
-          <HugeiconsIcon icon={icon} size={17} strokeWidth={1.5} className="shrink-0 text-ink-3" />
-        )}
-        <select
-          id={fieldId}
-          aria-invalid={Boolean(error) || undefined}
-          aria-describedby={describedBy(fieldId, error, hint)}
-          // appearance-none: ব্রাউজারের নিজের তীর মুছে আমাদের আইকন; bg-transparent: dark mode-এ
-          // Windows-এর সাদা বাক্স না
-          className="min-w-0 flex-1 appearance-none bg-transparent py-2.5 text-body outline-none"
-          {...select}
-        >
-          {options.map((option) => (
-            <option key={option.value} value={option.value}>
-              {option.label}
-            </option>
-          ))}
-        </select>
-        <HugeiconsIcon
-          icon={ArrowDown01Icon}
-          size={16}
-          strokeWidth={1.5}
-          // pointer-events-none: তীরে ক্লিক করলেও নিচের select খোলে
-          className="pointer-events-none shrink-0 text-ink-3"
-        />
-      </div>
+      <Select
+        id={fieldId}
+        options={options}
+        icon={icon}
+        invalid={Boolean(error)}
+        aria-describedby={describedBy(fieldId, error, hint)}
+        {...select}
+      />
     </Field>
   );
 }
```

- **`Select`** is the select box without a label, like `Input` next to `TextField`. A journal line's label is the
  column header on a wide screen, so `SelectField` (label included) does not fit. `SelectField` now uses
  `Select`, so the two never look different.

**File: `packages/ui/src/index.ts`** (change)

```diff
@@ -30,11 +30,13 @@ export { EmptyState } from './components/empty-state.js';
 export {
   Field,
   Input,
+  Select,
   SelectField,
   TextAreaField,
   TextField,
   type InputProps,
   type SelectFieldProps,
+  type SelectProps,
   type SelectOption,
   type TextAreaFieldProps,
   type TextFieldProps,
```

**File: `packages/ui/src/components/calendar.tsx`** (new)

```tsx
import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { type ChevronProps, DayPicker } from 'react-day-picker';
import { bn } from 'react-day-picker/locale/bn';
import { enUS } from 'react-day-picker/locale/en-US';

// The DatePicker's month grid. A module of its own, which date-picker.tsx imports lazily: the
// calendar (react-day-picker and its two locales, about 30 KB gz) loads when a date field is first
// opened, not with every page that has a date field. Found in step 10, when four journal pages
// with date fields came close to the 100 KB chunk budget.

// react-day-picker-এর নিজের SVG তীরের বদলে HugeIcons (CLAUDE.md rule ৪: আইকন একটাই লাইব্রেরি)
function Chevron({ orientation }: ChevronProps) {
  return (
    <HugeiconsIcon
      icon={orientation === 'left' ? ArrowLeft01Icon : ArrowRight01Icon}
      size={16}
      strokeWidth={1.5}
    />
  );
}

interface CalendarProps {
  selected: Date | undefined;
  onSelect: (date: Date | undefined) => void;
}

export function Calendar({ selected, onSelect }: CalendarProps) {
  const { language } = useLocale();
  return (
    <DayPicker
      mode="single"
      selected={selected}
      // খুললে বাছাই করা মাস দেখায়, খালি থাকলে এই মাস। `?? new Date()`: exactOptionalPropertyTypes-এ
      // defaultMonth-এ undefined পাঠানো যায় না
      defaultMonth={selected ?? new Date()}
      onSelect={onSelect}
      // মাস/দিনের নাম আর aria-label ভাষা অনুযায়ী; numerals='beng' দিনের সংখ্যা বাংলা অঙ্কে
      locale={language === 'bn' ? bn : enUS}
      numerals={language === 'bn' ? 'beng' : 'latn'}
      showOutsideDays
      autoFocus
      components={{ Chevron }}
      // react-day-picker-এর CSS import করা হয়নি — সব চেহারা token দিয়ে এখানে
      classNames={{
        root: 'text-body-sm',
        months: 'relative',
        month_caption: 'flex h-8 items-center justify-center font-medium text-ink',
        nav: 'absolute inset-x-0 top-0 flex h-8 items-center justify-between',
        button_previous:
          'grid size-8 place-items-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink',
        button_next:
          'grid size-8 place-items-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink',
        month_grid: 'mt-2 border-collapse',
        weekday: 'size-9 text-caption font-medium text-ink-3',
        day: 'p-0 text-center',
        day_button:
          'grid size-9 place-items-center rounded-lg tabular-nums text-ink transition-colors duration-150 hover:bg-subtle',
        // today/selected/outside বসে td-তে, রং দরকার ভেতরের বাটনে
        today: '[&>button]:font-semibold [&>button]:text-brand',
        selected: '[&>button]:bg-brand [&>button]:text-brand-ink [&>button]:hover:bg-brand-hover',
        outside: '[&>button]:text-ink-3',
        disabled: 'opacity-40',
      }}
    />
  );
}
```

**File: `packages/ui/src/components/date-picker.tsx`** (change)

```diff
@@ -1,26 +1,14 @@
-import { ArrowLeft01Icon, ArrowRight01Icon, Calendar03Icon } from '@hugeicons/core-free-icons';
+import { Calendar03Icon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { useLocale } from '@omnivo/i18n';
-import { type Ref, useState } from 'react';
-import { type ChevronProps, DayPicker } from 'react-day-picker';
-import { bn } from 'react-day-picker/locale/bn';
-import { enUS } from 'react-day-picker/locale/en-US';
+import { lazy, type Ref, Suspense, useState } from 'react';
 
 import { cn } from '../lib/cn.js';
 import { parseIsoDate, toIsoDate } from '../lib/iso-date.js';
 import { controlBoxClass } from './field.js';
 import { Popover, PopoverContent, PopoverTrigger } from './popover.js';
 
-// react-day-picker-এর নিজের SVG তীরের বদলে HugeIcons (CLAUDE.md rule ৪: আইকন একটাই লাইব্রেরি)
-function Chevron({ orientation }: ChevronProps) {
-  return (
-    <HugeiconsIcon
-      icon={orientation === 'left' ? ArrowLeft01Icon : ArrowRight01Icon}
-      size={16}
-      strokeWidth={1.5}
-    />
-  );
-}
+const Calendar = lazy(async () => ({ default: (await import('./calendar.js')).Calendar }));
 
 interface DatePickerProps {
   id?: string;
@@ -49,7 +37,7 @@ export function DatePicker({
   placeholder,
   'aria-describedby': ariaDescribedBy,
 }: DatePickerProps) {
-  const { t, language, format } = useLocale();
+  const { t, format } = useLocale();
   const [open, setOpen] = useState(false);
   const selected = parseIsoDate(value);
 
@@ -87,45 +75,16 @@ export function DatePicker({
         </button>
       </PopoverTrigger>
       <PopoverContent>
-        <DayPicker
-          mode="single"
-          selected={selected}
-          // খুললে বাছাই করা মাস দেখায়, খালি থাকলে এই মাস। `?? new Date()`: exactOptionalPropertyTypes-এ
-          // defaultMonth-এ undefined পাঠানো যায় না
-          defaultMonth={selected ?? new Date()}
-          onSelect={(date) => {
-            onChange(date ? toIsoDate(date) : '');
-            setOpen(false);
-          }}
-          // মাস/দিনের নাম আর aria-label ভাষা অনুযায়ী; numerals='beng' দিনের সংখ্যা বাংলা অঙ্কে
-          locale={language === 'bn' ? bn : enUS}
-          numerals={language === 'bn' ? 'beng' : 'latn'}
-          showOutsideDays
-          autoFocus
-          components={{ Chevron }}
-          // react-day-picker-এর CSS import করা হয়নি — সব চেহারা token দিয়ে এখানে
-          classNames={{
-            root: 'text-body-sm',
-            months: 'relative',
-            month_caption: 'flex h-8 items-center justify-center font-medium text-ink',
-            nav: 'absolute inset-x-0 top-0 flex h-8 items-center justify-between',
-            button_previous:
-              'grid size-8 place-items-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink',
-            button_next:
-              'grid size-8 place-items-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink',
-            month_grid: 'mt-2 border-collapse',
-            weekday: 'size-9 text-caption font-medium text-ink-3',
-            day: 'p-0 text-center',
-            day_button:
-              'grid size-9 place-items-center rounded-lg tabular-nums text-ink transition-colors duration-150 hover:bg-subtle',
-            // today/selected/outside বসে td-তে, রং দরকার ভেতরের বাটনে
-            today: '[&>button]:font-semibold [&>button]:text-brand',
-            selected:
-              '[&>button]:bg-brand [&>button]:text-brand-ink [&>button]:hover:bg-brand-hover',
-            outside: '[&>button]:text-ink-3',
-            disabled: 'opacity-40',
-          }}
-        />
+        {/* The fallback has the calendar's size, so the popover does not jump when it arrives */}
+        <Suspense fallback={<div className="h-[292px] w-[252px]" />}>
+          <Calendar
+            selected={selected}
+            onSelect={(date) => {
+              onChange(date ? toIsoDate(date) : '');
+              setOpen(false);
+            }}
+          />
+        </Suspense>
       </PopoverContent>
     </Popover>
   );
```

- **Why.** react-day-picker and its two locales are about 30 KB gz, and every journal page has a date field. With
  them, the entry form came to 99.3 KB and the ledger to 98.7 KB (budget 100) in the first version. Now the date field's button shows
  at once, and the calendar's code loads the first time someone opens it — a fraction of a second, once. The
  journal pages dropped to 65–83 KB, and every other page with a date field gets lighter too.
- **The fallback has the calendar's size** (`292 × 252 px`), so the popover does not jump when it arrives.
- `autoFocus` still works: the calendar takes focus when it mounts, which is after it loads.

---
## 10.7 — `apps/app`: the journal pages

### Queries

**File: `apps/app/src/lib/queries.ts`** (change)

```diff
@@ -1,4 +1,4 @@
-import { type MemberSort, routes } from '@omnivo/contracts';
+import { type BranchStatus, type JournalStatus, type MemberSort, routes } from '@omnivo/contracts';
 import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
 
 import { call } from './api';
@@ -95,3 +95,73 @@ export function membersQuery(tenantId: string, sort: MemberSort) {
     placeholderData: keepPreviousData,
   });
 }
+
+// The branches page lists them; from step 10 every journal line can pick one. One key for both, so
+// a branch added on its page shows up in the line's select at once.
+export function branchesQuery(tenantId: string, status: BranchStatus) {
+  return queryOptions({
+    queryKey: ['branches', tenantId, status],
+    queryFn: async () => (await call(routes.branches.list, { query: { status } })).items,
+  });
+}
+
+// Everything the journal shows starts with ['journal', tenantId]: posting or reversing one entry
+// invalidates the list, the entry, the ledgers and the opening balances with one call
+export function journalListQuery(tenantId: string, status: JournalStatus | undefined) {
+  return infiniteQueryOptions({
+    queryKey: ['journal', tenantId, 'list', status ?? 'all'],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.journal.list, {
+        query: {
+          limit: 50,
+          ...(status !== undefined && { status }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function journalEntryQuery(tenantId: string, entryId: string) {
+  return queryOptions({
+    queryKey: ['journal', tenantId, 'entry', entryId],
+    queryFn: () => call(routes.journal.get, { params: { id: entryId } }),
+    // A missing entry (a deleted draft) is an answer, not a network hiccup: no retries
+    retry: false,
+  });
+}
+
+export function ledgerQuery(tenantId: string, accountId: string, from: string, to: string) {
+  return infiniteQueryOptions({
+    queryKey: ['journal', tenantId, 'ledger', accountId, from, to],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.ledger.get, {
+        params: { id: accountId },
+        query: {
+          limit: 100,
+          ...(from !== '' && { from }),
+          ...(to !== '' && { to }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function openingBalancesQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['journal', tenantId, 'opening-balances'],
+    queryFn: () => call(routes.openingBalances.get),
+  });
+}
+
+export function periodLockQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['journal', tenantId, 'period-lock'],
+    queryFn: () => call(routes.periodLock.get),
+  });
+}
```

- **Every journal key starts with `['journal', tenantId]`.** After posting or reversing, one
  `invalidateQueries({ queryKey: ['journal', tenantId] })` refreshes the list, the entry, every open ledger and
  the opening balances. A posting changes all of them.
- **`branchesQuery` moved here** from the branches page: journal lines pick branches too, and one key means a
  branch added on its page shows up in the line's select at once.
- **`journalEntryQuery` has `retry: false`.** A deleted draft is a real `404`, not a network hiccup; three retries
  would only delay the "this entry doesn't exist" message.
- **`ledgerQuery`'s key has `from` and `to`.** Each date range is its own list; going back to an earlier range
  shows it from the cache.

**File: `apps/app/src/routes/branches.tsx`** (change)

```diff
@@ -32,25 +32,19 @@ import {
   TextField,
   toast,
 } from '@omnivo/ui';
-import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
+import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { useMemo, useState } from 'react';
 import { useForm } from 'react-hook-form';
 
 import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { useCan } from '../lib/permissions';
+import { branchesQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 
 const column = dataTableColumns<Branch>();
 const FIELD_NAMES = updateBranchInputSchema.keyof().options;
 
-function branchesQuery(tenantId: string, status: BranchStatus) {
-  return queryOptions({
-    queryKey: ['branches', tenantId, status],
-    queryFn: async () => (await call(routes.branches.list, { query: { status } })).items,
-  });
-}
-
 // একটা ফর্ম দুই কাজে: নতুন (branch নেই) আর বদল। নতুনের version 1 — schema-র min(1) পার হয়,
 // আর তৈরির route version পড়েই না (branchInputSchema-তে ঘরটা নেই, z.object বাড়তি key ফেলে দেয়)
 function BranchForm({ branch, onDone }: { branch: Branch | null; onDone: () => void }) {
```

### Helpers

**File: `apps/app/src/lib/journal.ts`** (new)

```ts
import {
  absMoney,
  type Account,
  isNegativeMoney,
  isZeroMoney,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import type { SelectOption } from '@omnivo/ui';

// Sorts "1120" after "1110" and "1-2" before "1-10", like the chart of accounts does
const byCode = new Intl.Collator('en', { numeric: true });

// The accounts a journal line can post to: active ledgers, in code order. Groups never take an
// entry. `keep`: the accounts a draft already uses stay in the list even if they were archived
// since — otherwise the select would silently show another account. The server then refuses
// the archived one with a clear error under the line.
export function ledgerOptions(
  accounts: readonly Account[],
  keep: readonly string[] = [],
): SelectOption[] {
  return accounts
    .filter(
      (account) => !account.isGroup && (account.archivedAt === null || keep.includes(account.id)),
    )
    .toSorted((a, b) => byCode.compare(a.code, b.code))
    .map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` }));
}

// The accounts that take an opening balance: active balance sheet ledgers, without the one the
// server fills itself (opening balance equity). Income and expenses start at zero.
export function openingAccounts(accounts: readonly Account[]): Account[] {
  return accounts
    .filter(
      (account) =>
        !account.isGroup &&
        account.archivedAt === null &&
        account.purpose !== 'opening_balance_equity' &&
        (account.type === 'asset' || account.type === 'liability' || account.type === 'equity'),
    )
    .toSorted((a, b) => byCode.compare(a.code, b.code));
}

export interface Totals {
  debit: string;
  credit: string;
  // debit − credit: what the entry is out by
  difference: string;
  // Equal, and not both zero: an empty form is not "balanced"
  balanced: boolean;
}

// The form's live totals. Decimal strings all the way: 0.1 + 0.2 must be 0.3 here too.
export function totalsOf(lines: readonly { debit: string; credit: string }[]): Totals {
  const debit = sumMoney(lines.map((line) => line.debit));
  const credit = sumMoney(lines.map((line) => line.credit));
  const difference = subtractMoney(debit, credit);
  return { debit, credit, difference, balanced: isZeroMoney(difference) && !isZeroMoney(debit) };
}

// A signed balance (debit − credit) as an amount and a side: "-1200.0000" → 1200, credit.
// Zero has no side.
export function balanceSide(value: string): { amount: string; side: 'debit' | 'credit' | null } {
  if (isZeroMoney(value)) return { amount: '0', side: null };
  return { amount: absMoney(value), side: isNegativeMoney(value) ? 'credit' : 'debit' };
}

// The server sends "0.0000" for the empty side; the form shows it empty
export function formAmount(value: string): string {
  return isZeroMoney(value) ? '' : value;
}

// The first day of the fiscal year that holds `isoDate`: 2026-09-23 with a July start →
// 2026-07-01; 2027-03-10 → 2026-07-01 too. The ledger opens on it.
export function fiscalYearStart(isoDate: string, startMonth: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const startYear = month >= startMonth ? year : year - 1;
  return `${String(startYear)}-${String(startMonth).padStart(2, '0')}-01`;
}

// A field of one row in react-hook-form's field array: linePath(2, 'debit') → "lines.2.debit".
// react-hook-form types it `lines.${number}.debit`. The lint rule restrict-template-expressions
// wants String(index) inside a template, but that gives `${string}`, which react-hook-form does not
// accept. The one cast here only says "this text was made from a number" — String(index) makes
// sure of it. Kept in this one place (CLAUDE.md rule 3).
export function linePath<F extends string>(index: number, field: F): `lines.${number}.${F}` {
  return `lines.${String(index)}.${field}` as `lines.${number}.${F}`;
}
```

- **`ledgerOptions`** — active ledgers in code order, sorted with the same numeric collator as the chart, so
  `1-2` comes before `1-10`. `keep` leaves an account a draft already uses in the list even if it was archived
  since; otherwise the native select would silently show the first option instead.
- **`totalsOf`** — the form's live totals with the contracts' exact sums. **`balanced` needs a non-zero
  total**: an empty form has equal totals (0 = 0), but it is not an entry.
- **`balanceSide`** — a signed balance as an amount and a side, for "৳1,200.00 Cr".
- **`formAmount`** — the server's `"0.0000"` for the empty side becomes an empty box in the form.
- **`linePath` and its one cast.** react-hook-form names a row's field `lines.2.debit` and types it
  `` `lines.${number}.debit` ``. The project's lint rule (`restrict-template-expressions`) refuses a number inside
  a template string, and `String(index)` gives `` `${string}` ``, which react-hook-form does not accept. The cast
  only says "this text was made from a number", which `String(index)` guarantees — one place, with a comment
  (CLAUDE.md rule 3).

**File: `apps/app/src/lib/journal.spec.ts`** (new)

```ts
import type { Account } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { balanceSide, fiscalYearStart, ledgerOptions, openingAccounts, totalsOf } from './journal';

function account(code: string, fields: Partial<Account> = {}): Account {
  return {
    id: `id-${code}`,
    parentId: null,
    code,
    name: `Account ${code}`,
    type: 'asset',
    isGroup: false,
    purpose: null,
    description: null,
    archivedAt: null,
    version: 1,
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...fields,
  };
}

describe('journal helpers', () => {
  it('offers active ledgers in code order, and keeps an archived one a draft uses', () => {
    const accounts = [
      account('1120', { isGroup: true }),
      account('1130'),
      account('1110'),
      account('1-10'),
      account('1-2'),
      account('1140', { archivedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(ledgerOptions(accounts).map((option) => option.label)).toEqual([
      '1-2 · Account 1-2',
      '1-10 · Account 1-10',
      '1110 · Account 1110',
      '1130 · Account 1130',
    ]);
    expect(ledgerOptions(accounts, ['id-1140']).map((option) => option.value)).toContain('id-1140');
  });

  it('takes opening balances on balance sheet ledgers only, without opening balance equity', () => {
    const accounts = [
      account('1110'),
      account('2110', { type: 'liability' }),
      account('3300', { type: 'equity', purpose: 'opening_balance_equity' }),
      account('4110', { type: 'income' }),
      account('1100', { isGroup: true }),
    ];
    expect(openingAccounts(accounts).map((item) => item.code)).toEqual(['1110', '2110']);
  });

  it('totals exactly and calls an empty form unbalanced', () => {
    expect(
      totalsOf([
        { debit: '0.1', credit: '' },
        { debit: '0.2', credit: '' },
        { debit: '', credit: '0.3' },
      ]),
    ).toEqual({
      debit: '0.3000',
      credit: '0.3000',
      difference: '0.0000',
      balanced: true,
    });
    expect(totalsOf([{ debit: '', credit: '' }]).balanced).toBe(false);
    expect(
      totalsOf([
        { debit: '100', credit: '' },
        { debit: '', credit: '90' },
      ]).difference,
    ).toBe('10.0000');
  });

  it('reads a balance as an amount and a side', () => {
    expect(balanceSide('-1200.0000')).toEqual({ amount: '1200.0000', side: 'credit' });
    expect(balanceSide('350.5000')).toEqual({ amount: '350.5000', side: 'debit' });
    expect(balanceSide('0.0000')).toEqual({ amount: '0', side: null });
  });
});

describe('fiscalYearStart', () => {
  it('finds the July (or January) that opens the year', () => {
    expect(fiscalYearStart('2026-09-23', 7)).toBe('2026-07-01');
    expect(fiscalYearStart('2027-03-10', 7)).toBe('2026-07-01');
    expect(fiscalYearStart('2026-07-01', 7)).toBe('2026-07-01');
    expect(fiscalYearStart('2026-09-23', 1)).toBe('2026-01-01');
  });
});
```

### Shared pieces

**File: `apps/app/src/components/journal-parts.tsx`** (new)

```tsx
import {
  Alert02Icon,
  ArrowLeft01Icon,
  CheckmarkCircle02Icon,
  FileEditIcon,
  Undo02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { JournalEntry, JournalEntrySummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { parseIsoDate, Pill } from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useCallback } from 'react';

import { ApiRequestError } from '../lib/api';
import { journalEntryQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// Shared by the journal pages. Here, not in a route file: a route file is its own lazy chunk, and
// importing from one would pull the whole page into the others.

// "23 Sep 2026" from "2026-09-23", read with local date parts, never as UTC (CLAUDE.md → Dates)
export function useIsoDate(): (iso: string) => string {
  const { format } = useLocale();
  return useCallback(
    (iso: string) => {
      const date = parseIsoDate(iso);
      return date ? format.date(date) : iso;
    },
    [format],
  );
}

// Draft, Posted, or Reversed (a posted entry that a later entry undid). Never colour alone: each
// has its icon and its word.
export function JournalStatusPill({ entry }: { entry: JournalEntrySummary }) {
  const { t } = useLocale();
  if (entry.status === 'draft') {
    return (
      <Pill tone="neutral" icon={FileEditIcon}>
        {t('journal.statuses.draft')}
      </Pill>
    );
  }
  if (entry.reversedBy !== null) {
    return (
      <Pill tone="neutral" icon={Undo02Icon}>
        {t('journal.statuses.reversed')}
      </Pill>
    );
  }
  return (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('journal.statuses.posted')}
    </Pill>
  );
}

// A control with its label for rows that repeat (journal lines, opening balances): the label sits
// above the control on a narrow card, and only screen readers read it on a wide one, where the
// column header says it. The parent card is the container (@container); @3xl = 48rem wide.
// Same error look as ui's Field.
export function LineField({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 content-start gap-1.5">
      <label htmlFor={id} className="text-label font-medium text-ink @3xl:sr-only">
        {label}
      </label>
      {children}
      <LineError id={id} error={error} />
    </div>
  );
}

// The error under a control, in the current language; `${id}-error` is what the control's
// aria-describedby points at
export function LineError({ id, error }: { id: string; error: string | undefined }) {
  const { errorText } = useLocale();
  if (error === undefined) return null;
  return (
    <p id={`${id}-error`} className="flex items-center gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
      {errorText(error)}
    </p>
  );
}

export function failureOf(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

export function BackLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/journal"
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {t('journal.back')}
    </Link>
  );
}

// After a save: the saved entry straight into its cache, then everything under ['journal', tenant]
// (the list, ledgers, opening balances) refetched
export function useJournalRefresh() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  return async (saved?: JournalEntry) => {
    if (saved) queryClient.setQueryData(journalEntryQuery(tenantId, saved.id).queryKey, saved);
    await queryClient.invalidateQueries({ queryKey: ['journal', tenantId] });
  };
}
```

- **Here, not in a route file.** Each route file is its own lazy chunk; importing from one would pull that whole
  page into the others.
- **`useIsoDate`** — `parseIsoDate()` reads `"2026-09-23"` with local date parts (CLAUDE.md → Dates), then the
  locale's format: "23 Sep 2026" / "২৩ সেপ, ২০২৬".
- **`JournalStatusPill`** — Draft (neutral, file icon), Posted (good, tick), Reversed (neutral, undo arrow). Never
  colour alone.
- **`LineField`** — a repeated row's control with its label. On a narrow card the label shows above the control;
  on a wide one (`@3xl:sr-only`) only screen readers read it, because the column header says it. `LineError` is
  the same red line with the `Alert02` icon as ui's `Field`, with the id that `aria-describedby` points at.
- **`useJournalRefresh`** — puts the saved entry straight into its cache (the page shows it at once), then
  invalidates everything under `['journal', tenantId]`.

### The journal list

**File: `apps/app/src/routes/journal.tsx`** (new)

```tsx
import { Notebook02Icon, PlusSignIcon, SquareLock02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type JournalEntrySummary,
  type JournalStatus,
  type PeriodLock,
  periodLockInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  DatePicker,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  FormField,
  PageHeader,
  SegmentedControl,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { JournalStatusPill, useIsoDate } from '../components/journal-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { journalListQuery, periodLockQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<JournalEntrySummary>();
const LOCK_FIELDS = periodLockInputSchema.keyof().options;
const FILTERS = ['all', 'draft', 'posted'] as const;
type Filter = (typeof FILTERS)[number];

function LockDateForm({ lock, onDone }: { lock: PeriodLock; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const showDate = useIsoDate();
  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(periodLockInputSchema, { error: contractErrorMap }),
    defaultValues: { lockDate: lock.lockDate ?? '', version: lock.version },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.periodLock.update, { body: values });
      queryClient.setQueryData(periodLockQuery(tenantId).queryKey, saved);
      toast(
        saved.lockDate === null
          ? t('journal.lock.cleared')
          : t('journal.lock.saved', { date: showDate(saved.lockDate) }),
      );
      onDone();
    } catch (error) {
      applyApiError(error, LOCK_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('journal.lock.title')}
      description={t('journal.lock.description')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="lock-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('journal.lock.save')}
          </Button>
        </>
      }
    >
      <form
        id="lock-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
          <FormField
            control={control}
            name="lockDate"
            label={t('journal.lock.field')}
            hint={t('journal.lock.hint')}
          >
            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
          </FormField>
          {/* Clearing the date opens every period again; it is saved like any other date */}
          <Button
            variant="secondary"
            className="mb-[26px]"
            onClick={() => {
              setValue('lockDate', '', { shouldDirty: true });
            }}
          >
            {t('journal.lock.clear')}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

export function JournalPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const can = useCan();
  const canRead = can('accounting.journal.read');
  const showDate = useIsoDate();
  const [filter, setFilter] = useState<Filter>('all');
  const [locking, setLocking] = useState(false);
  const status: JournalStatus | undefined = filter === 'all' ? undefined : filter;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...journalListQuery(tenantId, status),
    enabled: canRead,
  });
  const lock = useQuery({ ...periodLockQuery(tenantId), enabled: canRead }).data;
  const entries = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor((entry) => entry.number ?? '', {
          id: 'number',
          header: t('journal.columns.number'),
          // A paged list sorts on the server; the server always sends the newest date first
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              {/* A draft has no number yet: its word, not a fake number in the number font */}
              {row.original.number === null ? (
                <span className="text-body-sm font-medium text-ink-2">
                  {t('journal.statuses.draft')}
                </span>
              ) : (
                <span className="font-mono text-body-sm font-medium tabular-nums">
                  {row.original.number}
                </span>
              )}
              <span className="text-caption text-ink-3 tabular-nums">
                {showDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((entry) => entry.narration ?? '', {
          id: 'narration',
          header: t('journal.columns.narration'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <span className="block truncate">{getValue() || '—'}</span>,
        }),
        column.accessor('status', {
          header: t('journal.columns.status'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => <JournalStatusPill entry={row.original} />,
        }),
        column.accessor('total', {
          header: t('journal.columns.amount'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => format.money(getValue(), { decimals: 2 }),
        }),
      ]),
    [t, format, showDate],
  );

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader
        title={t('journal.title')}
        description={
          lock?.lockDate
            ? `${t('journal.description')} · ${t('journal.lockedUntil', { date: showDate(lock.lockDate) })}`
            : t('journal.description')
        }
        actions={
          <>
            {can('accounting.period.close') && (
              <Button
                variant="secondary"
                disabled={!lock}
                onClick={() => {
                  setLocking(true);
                }}
              >
                <HugeiconsIcon icon={SquareLock02Icon} size={17} strokeWidth={1.5} />
                {t('journal.lockDate')}
              </Button>
            )}
            {can('accounting.journal.create') && (
              <Button onClick={() => void navigate({ to: '/journal/new' })}>
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('journal.newEntry')}
              </Button>
            )}
          </>
        }
      />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.journal.read' })}
        </p>
      ) : (
        <>
          <div>
            <SegmentedControl
              label={t('journal.show')}
              value={filter}
              options={FILTERS.map((value) => ({ value, label: t(`journal.filters.${value}`) }))}
              onChange={setFilter}
            />
          </div>
          {isError && <p className="text-body-sm text-crit">{t('journal.loadFailed')}</p>}
          {entries && (
            <DataTable
              label={t('journal.title')}
              data={entries}
              columns={columns}
              getRowId={(entry) => entry.id}
              onRowClick={(entry) =>
                void navigate({ to: '/journal/$entryId', params: { entryId: entry.id } })
              }
              onEndReached={loadMore}
              empty={
                <EmptyState
                  icon={Notebook02Icon}
                  title={t('journal.emptyTitle')}
                  description={t('journal.emptyBody')}
                />
              }
              footer={
                isFetchingNextPage && (
                  <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                )
              }
            />
          )}
        </>
      )}
      <Dialog open={locking} onOpenChange={setLocking}>
        {lock && locking && (
          <LockDateForm
            lock={lock}
            onDone={() => {
              setLocking(false);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

- **The lock date dialog** (`LockDateForm`): the date picker, a "Clear" button (an empty date opens every period
  again; it is saved like any other date), and Save. The new lock goes straight into its query's cache.
- **The description line** says "Books closed up to 30 Sep 2026" when there is a lock date — the one fact an
  accountant needs before writing an entry.
- **Columns.** The number (or the word "Draft") with the date under it; the narration; the status; the amount,
  right-aligned with 2 decimals (decision 10). `enableSorting: false` everywhere: a paged list is sorted by the
  server (step 5's rule).
- **A draft's title is the word "Draft", not in the number font.** Found on the 390px screenshot: "Draft" in
  monospace next to a "Draft" pill looked like a broken number.
- **The filter** is the segmented control: All, Drafts, Posted. Changing it changes the query key, and
  `keepPreviousData` keeps the old rows on screen until the new ones arrive.

### One entry: a small page and two lazy halves

**File: `apps/app/src/routes/journal-entry.tsx`** (new)

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { DEFAULT_SETTINGS, todayIn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { BackLink } from '../components/journal-parts';
import { useCan } from '../lib/permissions';
import { accountsQuery, branchesQuery, journalEntryQuery, settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// The page only loads the data and picks the form or the view; each is a lazy chunk of its own.
// Together they were over the 100 KB budget, and most visits read a posted entry, which needs
// neither the form library nor the money input.
const EntryForm = lazy(async () => ({
  default: (await import('../components/journal-entry-form')).EntryForm,
}));
const EntryView = lazy(async () => ({
  default: (await import('../components/journal-entry-view')).EntryView,
}));

// The data both pages need: the chart, the branches (archived ones too, for old lines) and
// "today" in the company's time zone
function useEntryData() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const active = useQuery(branchesQuery(tenantId, 'active')).data;
  const archived = useQuery(branchesQuery(tenantId, 'archived')).data;
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  return {
    tenantId,
    accounts,
    active,
    all: active && archived ? [...active, ...archived] : undefined,
    today: todayIn(timeZone),
  };
}

export function NewJournalEntryPage() {
  const { t } = useLocale();
  const canCreate = useCan()('accounting.journal.create');
  const { accounts, active, today } = useEntryData();
  if (!canCreate) {
    return (
      <div className="grid max-w-5xl grid-cols-1 gap-5">
        <BackLink />
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.journal.create' })}
        </p>
      </div>
    );
  }
  if (!accounts || !active) return null;
  return (
    <Suspense fallback={null}>
      <EntryForm entry={null} accounts={accounts} branches={active} today={today} />
    </Suspense>
  );
}

export function JournalEntryPage() {
  const { t } = useLocale();
  const { entryId = '' } = useParams({ strict: false });
  const can = useCan();
  const { tenantId, accounts, active, all, today } = useEntryData();
  const { data: entry, isError } = useQuery({
    ...journalEntryQuery(tenantId, entryId),
    enabled: can('accounting.journal.read') && entryId !== '',
  });

  if (isError) {
    return (
      <div className="grid max-w-5xl grid-cols-1 gap-5">
        <BackLink />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('journal.draftTitle')}
          description={t('journal.notFound')}
        />
      </div>
    );
  }
  if (!entry || !accounts || !active || !all) return null;
  if (entry.status === 'draft' && can('accounting.journal.create')) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <EntryForm
          key={`${entry.id}-${String(entry.version)}`}
          entry={entry}
          accounts={accounts}
          branches={active}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <EntryView entry={entry} accounts={accounts} branches={all} today={today} />
    </Suspense>
  );
}
```

- **Why split.** The form needs react-hook-form and the money input (with its decimal.js); a posted entry, the
  most common page, needs neither. Together they were 101 KB in the first version (over the 100 KB budget, see
  "What we found on the way").
  Now this file only loads the data and picks: a draft for someone with `…create` gets the form, everything
  else gets the view.
- **`useEntryData`** — the chart, the branches (archived ones too, so an old line still shows its branch's name)
  and "today" in the company's time zone.
- **The form's `key` is id + version.** After a save the draft comes back with a new version, and the form
  starts again from what the server stored.
- **`useParams({ strict: false })`** — the params of whichever route matched; `entryId` is only there on
  `/journal/$entryId`. The default `''` keeps the query disabled instead of fetching `/journal-entries/`.

**File: `apps/app/src/components/journal-entry-form.tsx`** (new)

```tsx
import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Alert02Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  type Branch,
  contractErrorMap,
  type JournalEntry,
  routes,
  updateJournalEntryInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  DatePicker,
  FormAlert,
  FormField,
  IconButton,
  Input,
  MoneyInput,
  PageHeader,
  Pill,
  Select,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { balanceSide, formAmount, ledgerOptions, linePath, totalsOf } from '../lib/journal';
import { useCan } from '../lib/permissions';
import { BackLink, failureOf, LineField, useJournalRefresh } from './journal-parts';

// The entry form: a chunk of its own (loaded by routes/journal-entry.tsx), because the form
// library, the date picker and the money input are only needed to write — a posted entry, the most
// common page, is read without them.

type FormValues = z.input<typeof updateJournalEntryInputSchema>;
type LineValues = FormValues['lines'][number];

// One template for the lines' header, every line and the totals row, so the columns line up.
// A container query (@3xl = the card is 48rem wide), not a screen one: the sidebar takes 244px,
// so the screen width alone does not say how much room the lines have.
const LINE_COLUMNS = {
  withBranch: '@3xl:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_9rem_9rem_2.25rem]',
  withoutBranch: '@3xl:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_9rem_9rem_2.25rem]',
} as const;

function emptyLine(): LineValues {
  return { accountId: '', branchId: '', description: '', debit: '', credit: '' };
}

// The server's field names for the errors it can send — one set per line
function fieldNames(lineCount: number): Path<FormValues>[] {
  return [
    'date',
    'narration',
    'lines',
    ...Array.from({ length: lineCount }, (_, index) => [
      linePath(index, 'accountId'),
      linePath(index, 'branchId'),
      linePath(index, 'debit'),
      linePath(index, 'credit'),
    ]).flat(),
  ];
}

// Writing a new entry, or changing a draft. "Save draft" keeps it a draft; "Post entry" saves and
// posts in one request — all or nothing, so a refused post leaves nothing half saved.
export function EntryForm({
  entry,
  accounts,
  branches,
  today,
}: {
  entry: JournalEntry | null;
  accounts: Account[];
  branches: Branch[];
  today: string;
}) {
  const { t, format, errorText } = useLocale();
  const navigate = useNavigate();
  const refresh = useJournalRefresh();
  const canPost = useCan()('accounting.journal.post');
  const [confirming, setConfirming] = useState(false);
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateJournalEntryInputSchema, { error: contractErrorMap }),
    defaultValues: {
      date: entry?.date ?? today,
      narration: entry?.narration ?? '',
      lines: entry
        ? entry.lines.map((line) => ({
            accountId: line.accountId,
            branchId: line.branchId ?? '',
            description: line.description ?? '',
            debit: formAmount(line.debit),
            credit: formAmount(line.credit),
          }))
        : [emptyLine(), emptyLine()],
      post: false,
      // A new entry has no version; 1 passes the schema, and the create route never reads it
      version: entry?.version ?? 1,
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const totals = totalsOf(lines);

  const used = useMemo(() => entry?.lines.map((line) => line.accountId) ?? [], [entry]);
  const accountOptions = useMemo(
    () => [{ value: '', label: t('journal.accountPlaceholder') }, ...ledgerOptions(accounts, used)],
    [accounts, used, t],
  );
  const branchOptions = useMemo(
    () => [
      { value: '', label: t('journal.noBranch') },
      ...branches.map((branch) => ({ value: branch.id, label: `${branch.code} · ${branch.name}` })),
    ],
    [branches, t],
  );
  const showBranch = branches.length > 0;
  const columns = showBranch ? LINE_COLUMNS.withBranch : LINE_COLUMNS.withoutBranch;

  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post };
        const saved = entry
          ? await call(routes.journal.update, {
              params: { id: entry.id },
              body: { ...body, version },
            })
          : await call(routes.journal.create, { body });
        await refresh(saved);
        toast(
          saved.status === 'posted'
            ? t('journal.posted', { number: saved.number ?? '' })
            : t('journal.draftSaved'),
        );
        if (!entry) {
          void navigate({ to: '/journal/$entryId', params: { entryId: saved.id }, replace: true });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines.length), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: JournalEntry) =>
      call(routes.journal.remove, { params: { id: draft.id }, query: { version: draft.version } }),
    onSuccess: async () => {
      await refresh();
      toast(t('journal.deleted'));
      void navigate({ to: '/journal' });
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  // "At least two lines" belongs to the list, not to one line. react-hook-form keeps such an
  // array-level error on `lines.root` when it comes from a field array, on `lines` from a resolver.
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;
  const out = balanceSide(totals.difference);

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <BackLink />
      <PageHeader title={entry ? t('journal.draftTitle') : t('journal.newTitle')} />
      <form
        id="entry-form"
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-x-4">
          <FormField control={control} name="date" label={t('journal.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <TextField
            label={t('journal.narration')}
            optional
            placeholder={t('journal.narrationPlaceholder')}
            {...register('narration')}
            error={errors.narration?.message}
          />
        </Card>

        <Card
          className="@container grid grid-cols-1 overflow-hidden"
          aria-label={t('journal.lines')}
        >
          <div
            aria-hidden="true"
            className={cn(
              'hidden gap-2 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
              columns,
            )}
          >
            <span>{t('journal.account')}</span>
            <span>{t('journal.lineDescription')}</span>
            {showBranch && <span>{t('journal.branch')}</span>}
            <span className="text-right">{t('journal.debit')}</span>
            <span className="text-right">{t('journal.credit')}</span>
          </div>
          {fields.map((line, index) => {
            const number = index + 1;
            const lineErrors = errors.lines?.[index];
            const removeButton = (
              <IconButton
                icon={Delete02Icon}
                label={t('journal.removeLine', { number })}
                disabled={fields.length <= 2}
                onClick={() => {
                  remove(index);
                }}
              />
            );
            return (
              <div
                key={line.id}
                role="group"
                aria-label={t('journal.line', { number })}
                className={cn(
                  'grid grid-cols-2 gap-3 border-t border-line px-5 py-4 first:border-t-0 @3xl:items-start @3xl:gap-2 @3xl:py-3 @3xl:first:border-t',
                  columns,
                )}
              >
                <div className="col-span-2 flex items-center justify-between @3xl:hidden">
                  <span className="text-label font-medium text-ink-2">
                    {t('journal.line', { number })}
                  </span>
                  {removeButton}
                </div>
                <div className="col-span-2 @3xl:col-span-1">
                  <LineField
                    id={linePath(index, 'accountId')}
                    label={t('journal.account')}
                    error={lineErrors?.accountId?.message}
                  >
                    <Select
                      id={linePath(index, 'accountId')}
                      options={accountOptions}
                      invalid={lineErrors?.accountId !== undefined}
                      aria-describedby={
                        lineErrors?.accountId ? `${linePath(index, 'accountId')}-error` : undefined
                      }
                      {...register(linePath(index, 'accountId'))}
                    />
                  </LineField>
                </div>
                <div className="col-span-2 @3xl:col-span-1">
                  <LineField
                    id={linePath(index, 'description')}
                    label={t('journal.lineDescription')}
                    error={lineErrors?.description?.message}
                  >
                    <Input
                      id={linePath(index, 'description')}
                      invalid={lineErrors?.description !== undefined}
                      {...register(linePath(index, 'description'))}
                    />
                  </LineField>
                </div>
                {showBranch && (
                  <div className="col-span-2 @3xl:col-span-1">
                    <LineField
                      id={linePath(index, 'branchId')}
                      label={t('journal.branch')}
                      error={lineErrors?.branchId?.message}
                    >
                      <Select
                        id={linePath(index, 'branchId')}
                        options={branchOptions}
                        invalid={lineErrors?.branchId !== undefined}
                        {...register(linePath(index, 'branchId'))}
                      />
                    </LineField>
                  </div>
                )}
                {(['debit', 'credit'] as const).map((side) => (
                  <Controller
                    key={side}
                    control={control}
                    name={linePath(index, side)}
                    render={({ field, fieldState }) => (
                      <LineField
                        id={field.name}
                        label={t(`journal.${side}`)}
                        error={fieldState.error?.message}
                      >
                        <MoneyInput
                          id={field.name}
                          name={field.name}
                          ref={field.ref}
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          invalid={fieldState.error !== undefined}
                          aria-describedby={fieldState.error ? `${field.name}-error` : undefined}
                        />
                      </LineField>
                    )}
                  />
                ))}
                <div className="hidden @3xl:block @3xl:pt-1">{removeButton}</div>
              </div>
            );
          })}
          {linesError && (
            <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-label text-crit">
              <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
              {errorText(linesError)}
            </p>
          )}
          <div className="border-t border-line px-5 py-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                append(emptyLine());
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
              {t('journal.addLine')}
            </Button>
          </div>
          <div
            className={cn(
              'grid grid-cols-2 items-center gap-3 border-t border-line bg-subtle px-5 py-3 @3xl:gap-2',
              columns,
            )}
          >
            <div
              className={cn(
                'col-span-2 flex flex-wrap items-center gap-2',
                showBranch ? '@3xl:col-span-3' : '@3xl:col-span-2',
              )}
            >
              <span className="text-body-sm font-medium text-ink">{t('journal.total')}</span>
              {totals.balanced ? (
                <Pill tone="good" icon={CheckmarkCircle02Icon}>
                  {t('journal.balanced')}
                </Pill>
              ) : (
                out.side !== null && (
                  <Pill tone="crit" icon={AlertCircleIcon}>
                    {t('journal.outBy', { amount: format.money(out.amount, { decimals: 2 }) })}
                  </Pill>
                )
              )}
            </div>
            <span className="text-right text-body-sm font-medium tabular-nums">
              <span className="text-ink-3 @3xl:sr-only">{t('journal.debit')} </span>
              {format.money(totals.debit, { decimals: 2 })}
            </span>
            <span className="text-right text-body-sm font-medium tabular-nums">
              <span className="text-ink-3 @3xl:sr-only">{t('journal.credit')} </span>
              {format.money(totals.credit, { decimals: 2 })}
            </span>
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {entry && (
            // Left, away from Post. Two clicks: a deleted draft cannot come back.
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(entry);
                  else setConfirming(true);
                }}
              >
                {confirming ? t('journal.confirmDelete') : t('journal.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('journal.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('journal.saveDraft')}
          </Button>
          <Button
            disabled={isSubmitting || !canPost || !totals.balanced}
            onClick={() => void save(true)()}
          >
            {isSubmitting ? t('journal.posting') : t('journal.post')}
          </Button>
        </div>
        {(!canPost || !totals.balanced) && (
          <p className="text-right text-label text-ink-3">
            {canPost ? t('journal.postHint') : t('journal.cantPost')}
          </p>
        )}
      </form>
    </div>
  );
}
```

- **`FormValues = z.input<…>`.** The form holds what the person types (`''` for an empty side, `''` for no
  branch); the resolver turns it into what the server wants. Typed from the contract, no copy.
- **`LINE_COLUMNS` — one grid template** for the header, every line and the totals row, so the columns line up.
  Two versions: without branches the branch column disappears.
- **A container query, not a screen query.** `@container` on the card and `@3xl:` on the rows: the lines go
  side by side when *the card* is 48rem wide. With the 244px sidebar, the screen width alone says too little.
  On a narrow card each line is a small form: its number, the account, the description, the branch, and debit
  and credit side by side.
- **`fieldNames(lineCount)`** — the server's field errors (`lines.2.accountId`) mapped onto the form.
- **`save(post)`** — one function for "Save draft" (`post: false`) and "Post entry" (`post: true`). A new entry is
  created, then the address becomes `/journal/<id>` (`replace: true`, so Back does not return to an empty form).
- **The live totals** come from `useWatch` on the lines. "Balanced" (good pill) or "Out by ৳5,000.00" (crit pill
  with an icon). **Post entry is disabled** until the entry balances (the build plan: "debit/credit না মিললে সেভ
  বন্ধ"), and a line under the buttons says why. Save draft is always possible.
- **The line's `role="group"` with `aria-label="Line 2"`.** A screen reader says "Line 2, Account" — without the
  group, ten fields called "Debit" would be impossible to tell apart.
- **Removing a line** is refused below two lines (the button is disabled): an entry needs two.
- **Delete draft** sits on the left, away from Post, and takes two clicks: a deleted draft cannot come back.

**File: `apps/app/src/components/journal-entry-view.tsx`** (new)

```tsx
import { Undo02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  type Branch,
  contractErrorMap,
  isJournalSource,
  type JournalEntry,
  reverseJournalEntryInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  DatePicker,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  FormField,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { totalsOf } from '../lib/journal';
import { useCan } from '../lib/permissions';
import {
  BackLink,
  failureOf,
  JournalStatusPill,
  useIsoDate,
  useJournalRefresh,
} from './journal-parts';

// A posted entry, read only, with Reverse — or a draft for someone who may post but not edit.
// A chunk of its own, like the form (routes/journal-entry.tsx).

function ReverseForm({
  entry,
  today,
  onDone,
}: {
  entry: JournalEntry;
  today: string;
  onDone: (reversal: JournalEntry) => void;
}) {
  const { t } = useLocale();
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(reverseJournalEntryInputSchema, { error: contractErrorMap }),
    // Today, unless the entry is dated later (a reversal is never dated before its entry)
    defaultValues: { date: today < entry.date ? entry.date : today, version: entry.version },
  });
  const onSubmit = handleSubmit(async (values) => {
    try {
      onDone(await call(routes.journal.reverse, { params: { id: entry.id }, body: values }));
    } catch (error) {
      applyApiError(error, ['date'], setError);
    }
  });
  return (
    <DialogContent
      title={t('journal.reverseTitle', { number: entry.number ?? '' })}
      description={t('journal.reverseBody')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="reverse-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('journal.confirmReverse')}
          </Button>
        </>
      }
    >
      <form
        id="reverse-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <FormField control={control} name="date" label={t('journal.reverseDate')}>
          {(field) => <DatePicker {...field} />}
        </FormField>
      </form>
    </DialogContent>
  );
}

// A posted entry (read only, with Reverse), or a draft for someone who may post but not edit
export function EntryView({
  entry,
  accounts,
  branches,
  today,
}: {
  entry: JournalEntry;
  accounts: Account[];
  branches: Branch[];
  today: string;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const refresh = useJournalRefresh();
  const showDate = useIsoDate();
  const canPost = useCan()('accounting.journal.post');
  const [reversing, setReversing] = useState(false);
  const accountOf = useMemo(() => new Map(accounts.map((item) => [item.id, item])), [accounts]);
  const branchOf = useMemo(() => new Map(branches.map((item) => [item.id, item])), [branches]);
  const totals = totalsOf(entry.lines);

  const post = useMutation({
    mutationFn: () =>
      call(routes.journal.post, { params: { id: entry.id }, body: { version: entry.version } }),
    onSuccess: async (saved) => {
      await refresh(saved);
      toast(t('journal.posted', { number: saved.number ?? '' }));
    },
  });

  const canReverse =
    canPost &&
    entry.status === 'posted' &&
    entry.reversedBy === null &&
    entry.source !== 'reversal';
  const failure = failureOf(post.error);
  const amount = (value: string) =>
    value === '0.0000' ? '' : format.money(value, { decimals: 2 });

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <BackLink />
      <PageHeader
        title={entry.number ?? t('journal.draftTitle')}
        description={showDate(entry.date)}
        actions={
          <>
            {entry.status === 'draft' && canPost && (
              <Button
                disabled={post.isPending || !totals.balanced}
                onClick={() => {
                  post.mutate();
                }}
              >
                {post.isPending ? t('journal.posting') : t('journal.post')}
              </Button>
            )}
            {canReverse && (
              <Button
                variant="secondary"
                onClick={() => {
                  setReversing(true);
                }}
              >
                <HugeiconsIcon icon={Undo02Icon} size={17} strokeWidth={1.5} />
                {t('journal.reverse')}
              </Button>
            )}
          </>
        }
      />
      {failure && <FormAlert message={failure} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-body-sm text-ink-2">
        <JournalStatusPill entry={entry} />
        <span>
          {isJournalSource(entry.source) ? t(`journal.sources.${entry.source}`) : entry.source}
        </span>
        {entry.reversalOf && (
          <Link
            to="/journal/$entryId"
            params={{ entryId: entry.reversalOf.id }}
            className="font-medium text-brand underline-offset-3 hover:underline"
          >
            {t('journal.reverses', { number: entry.reversalOf.number })}
          </Link>
        )}
        {entry.reversedBy && (
          <Link
            to="/journal/$entryId"
            params={{ entryId: entry.reversedBy.id }}
            className="font-medium text-brand underline-offset-3 hover:underline"
          >
            {t('journal.reversedBy', { number: entry.reversedBy.number })}
          </Link>
        )}
      </div>
      {entry.narration && <p className="text-body text-ink">{entry.narration}</p>}
      {/* A plain table in its own scroll box: four columns, a handful of rows, a totals row */}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-body-sm">
          <thead className="bg-subtle text-left text-caption font-medium text-ink-3">
            <tr>
              <th scope="col" className="px-5 py-2.5 font-medium">
                {t('journal.account')}
              </th>
              <th scope="col" className="px-5 py-2.5 font-medium">
                {t('journal.branch')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">
                {t('journal.debit')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">
                {t('journal.credit')}
              </th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((line) => {
              const account = accountOf.get(line.accountId);
              const branch = line.branchId === null ? undefined : branchOf.get(line.branchId);
              return (
                <tr key={line.id} className="border-t border-line">
                  <td className="px-5 py-3">
                    {account ? (
                      <Link
                        to="/ledger"
                        search={{ account: account.id }}
                        className="font-medium text-ink underline-offset-3 hover:underline"
                      >
                        <span className="font-mono text-ink-3 tabular-nums">{account.code}</span>{' '}
                        {account.name}
                      </Link>
                    ) : (
                      '—'
                    )}
                    {line.description && (
                      <span className="block text-caption text-ink-3">{line.description}</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-ink-2">{branch?.name ?? '—'}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{amount(line.debit)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{amount(line.credit)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-line bg-subtle font-medium">
            <tr>
              <th scope="row" colSpan={2} className="px-5 py-3 text-left font-medium">
                {t('journal.total')}
              </th>
              <td className="px-5 py-3 text-right tabular-nums">
                {format.money(totals.debit, { decimals: 2 })}
              </td>
              <td className="px-5 py-3 text-right tabular-nums">
                {format.money(totals.credit, { decimals: 2 })}
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>
      <Dialog open={reversing} onOpenChange={setReversing}>
        {reversing && (
          <ReverseForm
            entry={entry}
            today={today}
            onDone={(reversal) => {
              setReversing(false);
              void refresh(reversal).then(() => {
                toast(
                  t('journal.reversed', {
                    number: reversal.number ?? '',
                    original: entry.number ?? '',
                  }),
                );
                void navigate({ to: '/journal/$entryId', params: { entryId: reversal.id } });
              });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

- **A plain table in its own scroll box**, not `DataTable`: four columns, a handful of rows and a totals footer.
  CLAUDE.md → Table allows it with `overflow-x-auto`.
- **Each account links to its ledger** (`/ledger?account=…`), and "Reverses JV-…" / "Reversed by JV-…" link the
  two entries both ways.
- **Reverse** shows only for a posted entry that nothing reversed, that is not itself a reversal, and only with
  `accounting.journal.post` — the same rules the API enforces, so the button never leads to a refusal.
- **The reverse dialog's date** starts at today, or at the entry's own date if that is later (a reversal is never
  dated before its entry). After reversing, the page moves to the new entry.
- **A draft for someone who may post but not edit** (the checker) shows here with a Post button.

### The ledger

**File: `apps/app/src/routes/ledger.tsx`** (new)

```tsx
import { Book02Icon, Notebook02Icon } from '@hugeicons/core-free-icons';
import { DEFAULT_SETTINGS, type LedgerLine, todayIn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Card,
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  Field,
  PageHeader,
  SelectField,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { useIsoDate } from '../components/journal-parts';
import { balanceSide, fiscalYearStart, ledgerOptions } from '../lib/journal';
import { useCan } from '../lib/permissions';
import { accountsQuery, ledgerQuery, settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<LedgerLine>();

// "৳12,500.00 Dr" — a balance with its side; zero has none
function useBalanceText(): (value: string) => string {
  const { t, format } = useLocale();
  return useCallback(
    (value: string) => {
      const { amount, side } = balanceSide(value);
      const money = format.money(amount, { decimals: 2 });
      if (side === null) return money;
      return t(side === 'debit' ? 'ledger.debitBalance' : 'ledger.creditBalance', {
        amount: money,
      });
    },
    [t, format],
  );
}

export function LedgerPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const { account: accountId = '' } = useSearch({ strict: false });
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.journal.read');
  const showDate = useIsoDate();
  const balanceText = useBalanceText();
  const accounts = useQuery({ ...accountsQuery(tenantId), enabled: canRead }).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  // Until the person picks dates: from the start of this fiscal year to today, in the company's
  // time zone. null = "not picked", so the default follows the settings once they arrive.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const today = todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone);
  const { from, to } = range ?? {
    from: fiscalYearStart(
      today,
      settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
    ),
    to: today,
  };
  const account = accounts?.find((item) => item.id === accountId);

  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...ledgerQuery(tenantId, accountId, from, to),
    enabled: canRead && account !== undefined,
  });
  const lines = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const first = data?.pages[0];

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const options = useMemo(
    () => [{ value: '', label: t('ledger.accountPlaceholder') }, ...ledgerOptions(accounts ?? [])],
    [accounts, t],
  );

  const columns = useMemo(() => {
    const amount = (value: string) =>
      value === '0.0000' ? '' : format.money(value, { decimals: 2 });
    return column.columns([
      column.accessor('number', {
        header: t('ledger.columns.entry'),
        // The server's order (date, then the order the lines were written) is the ledger
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-mono font-medium tabular-nums">{row.original.number}</span>
            <span className="text-caption text-ink-3 tabular-nums">
              {showDate(row.original.date)}
            </span>
          </span>
        ),
      }),
      column.accessor((line) => line.description ?? line.narration ?? '', {
        id: 'narration',
        header: t('journal.columns.narration'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => <span className="block truncate">{getValue() || '—'}</span>,
      }),
      column.accessor('debit', {
        header: t('ledger.columns.debit'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => amount(getValue()),
      }),
      column.accessor('credit', {
        header: t('ledger.columns.credit'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => amount(getValue()),
      }),
      column.accessor('balance', {
        header: t('ledger.columns.balance'),
        enableSorting: false,
        meta: { align: 'end', card: 'trailing' },
        cell: ({ getValue }) => <span className="font-medium">{balanceText(getValue())}</span>,
      }),
    ]);
  }, [t, format, showDate, balanceText]);

  if (!canRead) {
    return (
      <div className="grid max-w-5xl grid-cols-1 gap-5">
        <PageHeader title={t('ledger.title')} description={t('ledger.description')} />
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.journal.read' })}
        </p>
      </div>
    );
  }

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader title={t('ledger.title')} description={t('ledger.description')} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <SelectField
          label={t('ledger.account')}
          options={options}
          value={account ? accountId : ''}
          onChange={(event) => {
            const next = event.target.value;
            // In the address: the link from an entry's line lands here, and Back works
            void navigate({ to: '/ledger', search: next === '' ? {} : { account: next } });
          }}
        />
        <Field id="ledger-from" label={t('ledger.from')}>
          <DatePicker
            id="ledger-from"
            value={from}
            onChange={(value) => {
              setRange({ from: value, to });
            }}
          />
        </Field>
        <Field id="ledger-to" label={t('ledger.to')}>
          <DatePicker
            id="ledger-to"
            value={to}
            onChange={(value) => {
              setRange({ from, to: value });
            }}
          />
        </Field>
      </div>
      {!account ? (
        <EmptyState
          icon={Book02Icon}
          title={t('ledger.pickTitle')}
          description={t('ledger.pickBody')}
        />
      ) : (
        <>
          {/* One card split by a rule, like the KPI strip */}
          <Card className="grid grid-cols-2 divide-x divide-line">
            {[
              { label: t('ledger.opening'), value: first?.openingBalance },
              { label: t('ledger.closing'), value: first?.closingBalance },
            ].map((cell) => (
              <div key={cell.label} className="grid gap-1 px-5 py-4">
                <span className="text-caption text-ink-3">{cell.label}</span>
                <span className="text-h3 tabular-nums">
                  {cell.value === undefined ? '—' : balanceText(cell.value)}
                </span>
              </div>
            ))}
          </Card>
          {isError && <p className="text-body-sm text-crit">{t('ledger.loadFailed')}</p>}
          {lines && (
            <DataTable
              label={t('ledger.title')}
              data={lines}
              columns={columns}
              getRowId={(line) => line.lineId}
              onRowClick={(line) =>
                void navigate({ to: '/journal/$entryId', params: { entryId: line.entryId } })
              }
              onEndReached={loadMore}
              empty={
                <EmptyState
                  icon={Notebook02Icon}
                  title={t('ledger.emptyTitle')}
                  description={t('ledger.emptyBody')}
                />
              }
              footer={
                isFetchingNextPage && (
                  <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                )
              }
            />
          )}
        </>
      )}
    </div>
  );
}
```

- **The account is in the address** (`?account=…`): an entry's line links straight here, the address can be
  bookmarked, and Back works.
- **The default range is this fiscal year up to today**, in the company's time zone. `range` stays `null` until
  the person picks a date, so the default follows the settings once they load.
- **Opening and closing balance** in one card split by a rule (the KPI strip pattern), each with its side.
- **Phone cards:** the entry number and date as the title, the narration under it, the balance on the right, and
  debit and credit as details with their labels.
- **Rows open the entry.**

### Opening balances

**File: `apps/app/src/routes/opening-balances.tsx`** (new)

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  ACCOUNT_TYPES,
  contractErrorMap,
  type OpeningBalances,
  openingBalancesInputSchema,
  routes,
  shiftIsoDate,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  DatePicker,
  FormAlert,
  FormField,
  MoneyInput,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { LineError, LineField, useIsoDate } from '../components/journal-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { balanceSide, formAmount, linePath, openingAccounts, totalsOf } from '../lib/journal';
import { useCan } from '../lib/permissions';
import { accountsQuery, openingBalancesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

type FormValues = z.input<typeof openingBalancesInputSchema>;

// Name, Debit, Credit — the same template for the header, every row and the totals
const ROW = '@3xl:grid-cols-[minmax(0,1fr)_10rem_10rem] @3xl:items-start';

function fieldNames(count: number): Path<FormValues>[] {
  return [
    'goLiveDate',
    ...Array.from({ length: count }, (_, index) => [
      linePath(index, 'accountId'),
      linePath(index, 'debit'),
      linePath(index, 'credit'),
    ]).flat(),
  ];
}

function OpeningForm({
  saved,
  rows,
  equity,
}: {
  saved: OpeningBalances;
  // One per account that can take an opening balance, in code order
  rows: Account[];
  equity: Account | undefined;
}) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const showDate = useIsoDate();
  const canPost = useCan()('accounting.journal.post');
  const savedOf = new Map(saved.lines.map((line) => [line.accountId, line]));
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(openingBalancesInputSchema, { error: contractErrorMap }),
    defaultValues: {
      goLiveDate: saved.goLiveDate ?? '',
      replaces: saved.entry?.id ?? null,
      // Every row is in the form, empty or not; the server drops the empty ones
      lines: rows.map((account) => ({
        accountId: account.id,
        debit: formAmount(savedOf.get(account.id)?.debit ?? ''),
        credit: formAmount(savedOf.get(account.id)?.credit ?? ''),
      })),
    },
  });
  const lines = useWatch({ control, name: 'lines' });
  const goLiveDate = useWatch({ control, name: 'goLiveDate' });
  const totals = totalsOf(lines);
  // Opening balance equity takes the other side of the difference, so the entry balances
  const gap = balanceSide(totals.difference);

  const onSubmit = handleSubmit(async (values) => {
    try {
      const result = await call(routes.openingBalances.save, { body: values });
      queryClient.setQueryData(openingBalancesQuery(tenantId).queryKey, result);
      await queryClient.invalidateQueries({ queryKey: ['journal', tenantId] });
      toast(
        result.entry ? t('opening.saved', { number: result.entry.number }) : t('opening.cleared'),
      );
    } catch (error) {
      applyApiError(error, fieldNames(rows.length), setError);
    }
  });

  const money = (value: string) => format.money(value, { decimals: 2 });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid grid-cols-1 gap-5">
      {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
      {!canPost && <p className="text-body-sm text-ink-3">{t('opening.readOnly')}</p>}
      <Card className="grid grid-cols-1 gap-2 p-5 sm:max-w-sm">
        <FormField
          control={control}
          name="goLiveDate"
          label={t('opening.goLive')}
          hint={
            goLiveDate === ''
              ? undefined
              : t('opening.goLiveHint', { date: showDate(shiftIsoDate(goLiveDate, -1)) })
          }
        >
          {(field) => <DatePicker {...field} disabled={!canPost} />}
        </FormField>
        {saved.entry && (
          <Link
            to="/journal/$entryId"
            params={{ entryId: saved.entry.id }}
            className="w-fit text-body-sm font-medium text-brand underline-offset-3 hover:underline"
          >
            {t('opening.postedAs', { number: saved.entry.number })}
          </Link>
        )}
      </Card>

      <Card className="@container grid grid-cols-1 overflow-hidden">
        <div
          aria-hidden="true"
          className={cn(
            'hidden gap-2 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
            ROW,
          )}
        >
          <span>{t('opening.account')}</span>
          <span className="text-right">{t('opening.debit')}</span>
          <span className="text-right">{t('opening.credit')}</span>
        </div>
        {ACCOUNT_TYPES.filter((type) => rows.some((account) => account.type === type)).map(
          (type) => (
            <section key={type} aria-label={t(`accounts.types.${type}`)}>
              <h2 className="border-t border-line px-5 pt-4 pb-1 text-caption font-medium text-ink-3">
                {t(`accounts.types.${type}`)}
              </h2>
              {rows.map((account, index) =>
                account.type !== type ? null : (
                  <div
                    key={account.id}
                    className={cn('grid grid-cols-2 gap-x-3 gap-y-2 px-5 py-2', ROW)}
                  >
                    <div className="col-span-2 min-w-0 self-center @3xl:col-span-1">
                      <span className="block truncate text-body-sm text-ink">
                        <span className="font-mono text-ink-3 tabular-nums">{account.code}</span>{' '}
                        {account.name}
                      </span>
                      <LineError
                        id={linePath(index, 'accountId')}
                        error={errors.lines?.[index]?.accountId?.message}
                      />
                    </div>
                    {(['debit', 'credit'] as const).map((side) => (
                      <Controller
                        key={side}
                        control={control}
                        name={linePath(index, side)}
                        render={({ field, fieldState }) => (
                          <LineField
                            id={field.name}
                            label={`${t(`opening.${side}`)}, ${account.code}`}
                            error={fieldState.error?.message}
                          >
                            <MoneyInput
                              id={field.name}
                              name={field.name}
                              ref={field.ref}
                              value={field.value}
                              onChange={field.onChange}
                              onBlur={field.onBlur}
                              disabled={!canPost}
                              invalid={fieldState.error !== undefined}
                              aria-describedby={
                                fieldState.error ? `${field.name}-error` : undefined
                              }
                            />
                          </LineField>
                        )}
                      />
                    ))}
                  </div>
                ),
              )}
            </section>
          ),
        )}
        {equity && (
          <div
            className={cn('grid grid-cols-2 gap-x-3 gap-y-1 border-t border-line px-5 py-3', ROW)}
          >
            <div className="col-span-2 min-w-0 @3xl:col-span-1">
              <span className="block text-body-sm text-ink">
                <span className="font-mono text-ink-3 tabular-nums">{equity.code}</span>{' '}
                {t('opening.difference')}
              </span>
              <span className="block text-caption text-ink-3">{t('opening.differenceHint')}</span>
            </div>
            {/* A debit gap is closed on the credit side, and the other way round */}
            <span className="text-right text-body-sm tabular-nums">
              {gap.side === 'credit' ? money(gap.amount) : ''}
            </span>
            <span className="text-right text-body-sm tabular-nums">
              {gap.side === 'debit' ? money(gap.amount) : ''}
            </span>
          </div>
        )}
        <div
          className={cn(
            'grid grid-cols-2 gap-x-3 border-t border-line bg-subtle px-5 py-3 text-body-sm font-medium',
            ROW,
          )}
        >
          <span className="col-span-2 @3xl:col-span-1">{t('opening.total')}</span>
          {/* With the equity line both sides are equal: the larger of the two. A debit gap
              (more debits) means the debit total is the larger one. */}
          <span className="text-right tabular-nums">
            {money(gap.side === 'debit' ? totals.debit : totals.credit)}
          </span>
          <span className="text-right tabular-nums">
            {money(gap.side === 'debit' ? totals.debit : totals.credit)}
          </span>
        </div>
      </Card>

      {canPost && (
        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('opening.save')}
          </Button>
        </div>
      )}
    </form>
  );
}

export function OpeningBalancesPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.journal.read');
  const accounts = useQuery({ ...accountsQuery(tenantId), enabled: canRead }).data;
  const { data: saved, isError } = useQuery({
    ...openingBalancesQuery(tenantId),
    enabled: canRead,
  });

  const rows = useMemo(() => {
    if (!accounts || !saved) return undefined;
    const list = openingAccounts(accounts);
    // An account that holds a saved balance but was archived since stays on the page, so its
    // amount never disappears without a word; the server then asks to restore it or clear it
    const extra = saved.lines.flatMap((line) => {
      const account = accounts.find((item) => item.id === line.accountId);
      return account && !list.includes(account) ? [account] : [];
    });
    return [...list, ...extra];
  }, [accounts, saved]);
  const equity = accounts?.find((account) => account.purpose === 'opening_balance_equity');

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader title={t('opening.title')} description={t('opening.description')} />
      {!canRead && (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.journal.read' })}
        </p>
      )}
      {isError && <p className="text-body-sm text-crit">{t('opening.loadFailed')}</p>}
      {saved && rows && (
        // key: after a save the entry changes, and the form starts again from what was posted
        <OpeningForm key={saved.entry?.id ?? 'none'} saved={saved} rows={rows} equity={equity} />
      )}
    </div>
  );
}
```

- **Every balance sheet ledger is a row**, grouped under Asset, Liability and Equity, empty or not. The server
  drops the empty ones.
- **An archived account that holds a saved balance stays on the page**, so an amount never disappears without a
  word; the server then asks to restore the account or clear the amount.
- **The equity row is computed live** and shown on the side that closes the gap, with the hint "It reads zero
  once everything is in" — so the accountant sees how far off the old books are while typing.
- **The total row shows the larger side**, because with the equity line both sides are equal. Found on the
  screenshot: the first version picked the wrong side and showed ৳0.00 (see "What we found on the way").
- **The money inputs' labels say the account** ("Debit, 1121"): on a wide screen the visible label is the column
  header, and a screen reader needs to know which row it is in.
- **Without `accounting.journal.post`** the inputs are disabled and a line says whom to ask.

### Route and nav

**File: `apps/app/src/router.tsx`** (change)

```diff
@@ -114,6 +114,42 @@ const accountsRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/accounts'), 'AccountsPage'),
 });
 
+const journalRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/journal',
+  component: lazyRouteComponent(() => import('./routes/journal'), 'JournalPage'),
+});
+
+// '/journal/new' beats '/journal/$entryId': TanStack ranks a fixed segment above a parameter.
+// Both pages live in one file and one chunk.
+const newJournalEntryRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/journal/new',
+  component: lazyRouteComponent(() => import('./routes/journal-entry'), 'NewJournalEntryPage'),
+});
+
+const journalEntryRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/journal/$entryId',
+  component: lazyRouteComponent(() => import('./routes/journal-entry'), 'JournalEntryPage'),
+});
+
+// ?account=<id>: an entry's line links straight to its account's ledger, and the address can be
+// bookmarked. Anything else in the query string is dropped, not trusted.
+const ledgerRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/ledger',
+  validateSearch: (search: Record<string, unknown>): { account?: string } =>
+    typeof search.account === 'string' ? { account: search.account } : {},
+  component: lazyRouteComponent(() => import('./routes/ledger'), 'LedgerPage'),
+});
+
+const openingBalancesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/opening-balances',
+  component: lazyRouteComponent(() => import('./routes/opening-balances'), 'OpeningBalancesPage'),
+});
+
 const teamRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/team',
@@ -155,6 +191,11 @@ const routeTree = rootRoute.addChildren([
     numberingRoute,
     branchesRoute,
     accountsRoute,
+    journalRoute,
+    newJournalEntryRoute,
+    journalEntryRoute,
+    ledgerRoute,
+    openingBalancesRoute,
     teamRoute,
     rolesRoute,
     auditLogRoute,
```

- **`/journal/new` and `/journal/$entryId`** are two routes; TanStack ranks the fixed segment above the parameter.
- **`validateSearch`** keeps only a string `account`. Anything else in the query string is dropped, not trusted,
  and the type is `{ account?: string }` with no cast.

**File: `apps/app/src/routes/app-shell.tsx`** (change)

```diff
@@ -1,9 +1,12 @@
 import {
+  BalanceScaleIcon,
+  Book02Icon,
   BookOpen02Icon,
   DashboardSquare01Icon,
   LayoutGridIcon,
   LeftToRightListNumberIcon,
   Logout01Icon,
+  Notebook02Icon,
   SecurityCheckIcon,
   Settings02Icon,
   Store01Icon,
@@ -235,6 +238,20 @@ export function AppShell() {
             <NavLink to="/accounts" icon={BookOpen02Icon}>
               {t('nav.chartOfAccounts')}
             </NavLink>
+            {/* The books themselves (salaries, margins) are for people with the read permission */}
+            {can('accounting.journal.read') && (
+              <>
+                <NavLink to="/journal" icon={Notebook02Icon}>
+                  {t('nav.journal')}
+                </NavLink>
+                <NavLink to="/ledger" icon={Book02Icon}>
+                  {t('nav.ledger')}
+                </NavLink>
+                <NavLink to="/opening-balances" icon={BalanceScaleIcon}>
+                  {t('nav.openingBalances')}
+                </NavLink>
+              </>
+            )}
           </NavGroup>
           <NavGroup label={t('nav.workspace')}>
             {(can('core.user.read') || can('core.user.invite')) && (
```

- Only for `accounting.journal.read`. Hiding is a convenience; the API is the guard.

---

## 10.8 — MSW: the journal in the mocks

**File: `apps/app/src/mocks/journal-data.ts`** (new)

```ts
import {
  absMoney,
  addMoney,
  defaultNumberFormat,
  formatDocumentNumber,
  isNegativeMoney,
  isZeroMoney,
  type JournalEntry,
  type JournalEntrySummary,
  type JournalLineInput,
  type JournalSource,
  type LedgerPage,
  type OpeningBalances,
  type OpeningBalancesInput,
  periodOf,
  shiftIsoDate,
  subtractMoney,
  sumMoney,
  todayIn,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
import type { WorkspaceData } from './workspace-data';

// The mock's books: the API's rules (journal.service.ts, posting.service.ts) on plain arrays, so
// `pnpm dev:mock` and the e2e tests walk the same paths as the real API
export interface MockJournal {
  // In the order they were written
  entries: JournalEntry[];
  lockDate: string | null;
  // 0 = never set, like the API's lazy row
  lockVersion: number;
  // The last number given per period ('2026-27')
  counters: Map<string, number>;
}

export function emptyJournal(): MockJournal {
  return { entries: [], lockDate: null, lockVersion: 0, counters: new Map() };
}

type LineIn = Pick<JournalLineInput, 'accountId' | 'branchId' | 'description' | 'debit' | 'credit'>;

// "18500" → "18500.0000", the way Postgres sends NUMERIC(19,4)
function fixed(value: string): string {
  return addMoney(value, '0');
}

function linesProblem(
  code: 'journal_account_invalid' | 'journal_branch_invalid',
  field: string,
  indexes: number[],
) {
  return new MockProblem(
    409,
    code,
    Object.fromEntries(indexes.map((index) => [`lines.${String(index)}.${field}`, [code]])),
  );
}

export function checkLines(
  data: WorkspaceData,
  lines: readonly LineIn[],
  allowArchived = false,
): void {
  const badAccounts = lines.flatMap((line, index) => {
    const account = data.accounts.find((item) => item.id === line.accountId);
    return account && !account.isGroup && (allowArchived || account.archivedAt === null)
      ? []
      : [index];
  });
  if (badAccounts.length > 0)
    throw linesProblem('journal_account_invalid', 'accountId', badAccounts);
  const badBranches = lines.flatMap((line, index) => {
    if (line.branchId === null) return [];
    const branch = data.branches.find((item) => item.id === line.branchId);
    return branch && (allowArchived || branch.archivedAt === null) ? [] : [index];
  });
  if (badBranches.length > 0) throw linesProblem('journal_branch_invalid', 'branchId', badBranches);
}

function assertOpen(data: WorkspaceData, date: string): void {
  if (data.journal.lockDate !== null && date <= data.journal.lockDate) {
    throw new MockProblem(409, 'journal_period_locked', { date: ['journal_period_locked'] });
  }
}

function nextNumber(data: WorkspaceData, date: string): string {
  const format = data.series.get('accounting.journal') ?? defaultNumberFormat('accounting.journal');
  const period = periodOf(date, format.yearStyle, data.settings.fiscalYearStartMonth);
  const next = (data.journal.counters.get(period) ?? 0) + 1;
  data.journal.counters.set(period, next);
  return formatDocumentNumber(format, period, next);
}

export function findEntry(data: WorkspaceData, id: string): JournalEntry {
  const found = data.journal.entries.find((entry) => entry.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// The list's shape: everything but the lines
export function summaryOf(entry: JournalEntry): JournalEntrySummary {
  return {
    id: entry.id,
    number: entry.number,
    date: entry.date,
    narration: entry.narration,
    status: entry.status,
    source: entry.source,
    total: entry.total,
    reversalOf: entry.reversalOf,
    reversedBy: entry.reversedBy,
    postedAt: entry.postedAt,
    version: entry.version,
    updatedAt: entry.updatedAt,
  };
}

// Newest date first; on the same date, the last written first (the API's order is by id, UUIDv7)
export function sortedEntries(data: WorkspaceData): JournalEntry[] {
  const order = new Map(data.journal.entries.map((entry, index) => [entry.id, index]));
  return data.journal.entries.toSorted(
    (a, b) => b.date.localeCompare(a.date) || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0),
  );
}

export function writeDraft(
  data: WorkspaceData,
  input: { date: string; narration: string | null; lines: readonly LineIn[] },
  source: JournalSource = 'manual',
  reversalOf: JournalEntry['reversalOf'] = null,
): JournalEntry {
  const now = new Date().toISOString();
  const entry: JournalEntry = {
    id: crypto.randomUUID(),
    number: null,
    date: input.date,
    narration: input.narration,
    status: 'draft',
    source,
    total: sumMoney(input.lines.map((line) => line.debit)),
    reversalOf,
    reversedBy: null,
    postedAt: null,
    version: 1,
    updatedAt: now,
    lines: input.lines.map((line) => ({
      id: crypto.randomUUID(),
      accountId: line.accountId,
      branchId: line.branchId,
      description: line.description,
      debit: fixed(line.debit),
      credit: fixed(line.credit),
    })),
  };
  data.journal.entries.push(entry);
  return entry;
}

export function replaceDraft(
  entry: JournalEntry,
  input: { date: string; narration: string | null; lines: readonly LineIn[] },
): void {
  Object.assign(entry, {
    date: input.date,
    narration: input.narration,
    total: sumMoney(input.lines.map((line) => line.debit)),
    version: entry.version + 1,
    updatedAt: new Date().toISOString(),
    lines: input.lines.map((line) => ({
      id: crypto.randomUUID(),
      accountId: line.accountId,
      branchId: line.branchId,
      description: line.description,
      debit: fixed(line.debit),
      credit: fixed(line.credit),
    })),
  });
}

export function postDraft(data: WorkspaceData, entry: JournalEntry): void {
  assertOpen(data, entry.date);
  if (entry.lines.length < 2) throw new MockProblem(409, 'journal_lines_too_few');
  const debits = sumMoney(entry.lines.map((line) => line.debit));
  const credits = sumMoney(entry.lines.map((line) => line.credit));
  if (debits !== credits) throw new MockProblem(409, 'journal_unbalanced');
  checkLines(data, entry.lines, entry.source === 'reversal');
  Object.assign(entry, {
    status: 'posted',
    number: nextNumber(data, entry.date),
    postedAt: new Date().toISOString(),
    version: entry.version + 1,
    updatedAt: new Date().toISOString(),
  });
}

export function reverseEntry(data: WorkspaceData, entry: JournalEntry, date: string): JournalEntry {
  if (entry.status !== 'posted') throw new MockProblem(409, 'journal_not_posted');
  if (entry.source === 'reversal') throw new MockProblem(409, 'journal_is_reversal');
  if (entry.reversedBy !== null) throw new MockProblem(409, 'journal_already_reversed');
  if (date < entry.date) {
    throw new MockProblem(409, 'journal_reversal_date', { date: ['journal_reversal_date'] });
  }
  const reversal = writeDraft(
    data,
    {
      date,
      narration: `Reversal of ${entry.number ?? ''}`,
      lines: entry.lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
    },
    'reversal',
    { id: entry.id, number: entry.number ?? '' },
  );
  try {
    postDraft(data, reversal);
  } catch (error) {
    data.journal.entries = data.journal.entries.filter((item) => item.id !== reversal.id);
    throw error;
  }
  entry.reversedBy = { id: reversal.id, number: reversal.number ?? '' };
  return reversal;
}

// Posts in one go, or leaves nothing behind (the API's transaction)
export function postNew(
  data: WorkspaceData,
  input: { date: string; narration: string | null; lines: readonly LineIn[] },
  source: JournalSource = 'manual',
): JournalEntry {
  const entry = writeDraft(data, input, source);
  try {
    postDraft(data, entry);
  } catch (error) {
    data.journal.entries = data.journal.entries.filter((item) => item.id !== entry.id);
    throw error;
  }
  return entry;
}

export function ledgerOf(
  data: WorkspaceData,
  accountId: string,
  query: {
    from?: string | undefined;
    to?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): LedgerPage {
  if (!data.accounts.some((account) => account.id === accountId)) {
    throw new MockProblem(404, 'not_found');
  }
  const order = new Map(data.journal.entries.map((entry, index) => [entry.id, index]));
  const all = data.journal.entries
    .filter((entry) => entry.status === 'posted')
    .toSorted(
      (a, b) => a.date.localeCompare(b.date) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    )
    .flatMap((entry) =>
      entry.lines.filter((line) => line.accountId === accountId).map((line) => ({ entry, line })),
    );
  const before = all.filter(({ entry }) => query.from !== undefined && entry.date < query.from);
  const inRange = all.filter(
    ({ entry }) =>
      (query.from === undefined || entry.date >= query.from) &&
      (query.to === undefined || entry.date <= query.to),
  );
  const net = (rows: typeof all) =>
    subtractMoney(
      sumMoney(rows.map(({ line }) => line.debit)),
      sumMoney(rows.map(({ line }) => line.credit)),
    );
  const opening = net(before);
  // The mock's cursor is an offset into the range, like its other lists
  const start = query.cursor === undefined ? 0 : Number(query.cursor);
  let balance = addMoney(opening, net(inRange.slice(0, start)));
  const page = inRange.slice(start, start + query.limit);
  const end = start + page.length;
  return {
    items: page.map(({ entry, line }) => {
      balance = addMoney(balance, subtractMoney(line.debit, line.credit));
      return {
        lineId: line.id,
        entryId: entry.id,
        number: entry.number ?? '',
        date: entry.date,
        narration: entry.narration,
        description: line.description,
        debit: line.debit,
        credit: line.credit,
        balance,
      };
    }),
    nextCursor: end < inRange.length ? String(end) : null,
    openingBalance: opening,
    closingBalance: net(
      all.filter(({ entry }) => query.to === undefined || entry.date <= query.to),
    ),
  };
}

function currentOpening(data: WorkspaceData): JournalEntry | undefined {
  return data.journal.entries.findLast(
    (entry) =>
      entry.source === 'opening_balance' && entry.status === 'posted' && entry.reversedBy === null,
  );
}

function equityOf(data: WorkspaceData) {
  return data.accounts.find((account) => account.purpose === 'opening_balance_equity');
}

export function openingOf(data: WorkspaceData): OpeningBalances {
  const entry = currentOpening(data);
  if (!entry?.number) return { goLiveDate: null, entry: null, lines: [] };
  const equity = equityOf(data);
  return {
    goLiveDate: shiftIsoDate(entry.date, 1),
    entry: { id: entry.id, number: entry.number },
    lines: entry.lines
      .filter((line) => line.accountId !== equity?.id)
      .map((line) => ({ accountId: line.accountId, debit: line.debit, credit: line.credit })),
  };
}

export function saveOpening(data: WorkspaceData, input: OpeningBalancesInput): void {
  const current = currentOpening(data);
  if ((current?.id ?? null) !== input.replaces) throw new MockProblem(409, 'version_conflict');
  const equity = equityOf(data);
  if (!equity) throw new Error('The mock chart has no opening balance equity account');
  const filled = input.lines.flatMap((line, index) =>
    isZeroMoney(line.debit) && isZeroMoney(line.credit) ? [] : [{ ...line, index }],
  );
  const invalid = filled.flatMap((line) => {
    const account = data.accounts.find((item) => item.id === line.accountId);
    const ok =
      account &&
      !account.isGroup &&
      account.archivedAt === null &&
      account.id !== equity.id &&
      ['asset', 'liability', 'equity'].includes(account.type);
    return ok ? [] : [line.index];
  });
  if (invalid.length > 0) {
    throw new MockProblem(
      409,
      'opening_account_invalid',
      Object.fromEntries(
        invalid.map((index) => [`lines.${String(index)}.accountId`, ['opening_account_invalid']]),
      ),
    );
  }
  if (current) reverseEntry(data, current, current.date);
  if (filled.length === 0) return;
  const lines: LineIn[] = filled.map((line) => ({
    accountId: line.accountId,
    branchId: null,
    description: null,
    debit: line.debit,
    credit: line.credit,
  }));
  const difference = subtractMoney(
    sumMoney(lines.map((line) => line.debit)),
    sumMoney(lines.map((line) => line.credit)),
  );
  if (!isZeroMoney(difference)) {
    const amount = absMoney(difference);
    const negative = isNegativeMoney(difference);
    lines.push({
      accountId: equity.id,
      branchId: null,
      description: null,
      debit: negative ? amount : '0',
      credit: negative ? '0' : amount,
    });
  }
  postNew(
    data,
    { date: shiftIsoDate(input.goLiveDate, -1), narration: 'Opening balances', lines },
    'opening_balance',
  );
}

export function setLockDate(data: WorkspaceData, lockDate: string | null, version: number): void {
  if (data.journal.lockVersion !== version) throw new MockProblem(409, 'version_conflict');
  if (lockDate !== null && lockDate > todayIn(data.settings.timezone)) {
    throw new MockProblem(409, 'period_lock_future', { lockDate: ['period_lock_future'] });
  }
  data.journal.lockDate = lockDate;
  data.journal.lockVersion += 1;
}

// The garments workspace's first weeks on Omnivo: capital, rent, petty cash, a DESCO bill at the
// factory, salaries — and one draft still waiting. Dated in the last three weeks, but never before
// the fiscal year started, so the ledger's default range (this fiscal year) always shows them.
export function seedJournal(data: WorkspaceData): void {
  const today = todayIn(data.settings.timezone);
  const startMonth = String(data.settings.fiscalYearStartMonth).padStart(2, '0');
  const year = Number(today.slice(0, 4));
  const fiscalStart =
    today.slice(5, 7) >= startMonth
      ? `${String(year)}-${startMonth}-01`
      : `${String(year - 1)}-${startMonth}-01`;
  const day = (ago: number) => {
    const date = shiftIsoDate(today, -ago);
    return date < fiscalStart ? fiscalStart : date;
  };
  const id = (code: string) => {
    const found = data.accounts.find((account) => account.code === code);
    if (!found) throw new Error(`The mock chart has no ${code}`);
    return found.id;
  };
  const factory = data.branches.find((branch) => branch.code === 'GZP')?.id ?? null;
  const line = (code: string, debit: string, credit: string, branchId: string | null = null) => ({
    accountId: id(code),
    branchId,
    description: null,
    debit,
    credit,
  });

  postNew(data, {
    date: day(20),
    narration: 'Share capital paid in by the directors',
    lines: [line('1121', '5000000', '0'), line('3100', '0', '5000000')],
  });
  postNew(data, {
    date: day(15),
    narration: 'Office rent for the Banani head office',
    lines: [line('5220', '185000', '0'), line('1121', '0', '185000')],
  });
  postNew(data, {
    date: day(12),
    narration: 'Petty cash for the Gazipur factory',
    lines: [line('1110', '50000', '0', factory), line('1121', '0', '50000')],
  });
  postNew(data, {
    date: day(8),
    narration: 'DESCO electricity bill, Gazipur factory',
    lines: [line('5230', '18450.50', '0', factory), line('1110', '0', '18450.50', factory)],
  });
  postNew(data, {
    date: day(5),
    narration: 'Salaries for the month, payable on the 7th',
    lines: [line('5210', '1240000', '0'), line('2140', '0', '1240000')],
  });
  writeDraft(data, {
    date: day(2),
    narration: 'LC opening charges, Dutch-Bangla Bank',
    lines: [line('5410', '2300', '0'), line('1121', '0', '2300')],
  });
}
```

- **The API's rules on arrays**: line checks, the lock date, balance, numbering with the workspace's own number
  format and fiscal year, reversal, the ledger's running balance, opening balances with the equity line. The
  e2e tests run against these, so they must refuse what the API refuses.
- **All or nothing, like a transaction.** `postNew()` and `reverseEntry()` remove the new entry again if posting
  it throws. `nextNumber()` runs only after every check, so a refused posting never uses a number.
- **The seed** — a garments company's first weeks: share capital into the bank, office rent, petty cash for the
  Gazipur factory, a DESCO bill there (with the branch on the line), salaries payable, and an LC charge still in
  draft. The dates are "N days ago" but never before the fiscal year started, so the ledger's default range
  (this fiscal year) always shows them, even on 2 July.

**File: `apps/app/src/mocks/workspace-data.ts`** (change)

```diff
@@ -22,6 +22,7 @@ import {
 
 import { seedAccounts } from './accounting-data';
 import { OWNER, type Workspace } from './fixtures';
+import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
 import { type People, seedPeople } from './people-data';
 
@@ -38,6 +39,7 @@ export interface WorkspaceData {
   setupReadyAt: number | null;
   notifications: Notification[];
   accounts: Account[];
+  journal: MockJournal;
 }
 
 function now(): string {
@@ -88,7 +90,9 @@ function seed(workspace: Workspace): WorkspaceData {
     setupReadyAt: null,
     notifications: garments ? seedNotifications() : [],
     accounts: seedAccounts(garments ? 'garments' : 'pharma'),
+    journal: emptyJournal(),
   };
+  if (garments) seedJournal(data);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
@@ -143,6 +147,7 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   data.notifications = [];
   // A new workspace has no chart until its setup job runs (settleSetup)
   data.accounts = [];
+  data.journal = emptyJournal();
   store.set(workspace.tenantId, data);
 }
 
@@ -214,8 +219,14 @@ export function seriesList(data: WorkspaceData): NumberSeries[] {
       documentType,
       ...format,
       version: saved?.version ?? 0,
-      // mock-এ কোনো ডকুমেন্ট তৈরি হয় না, তাই পরের নম্বর সবসময় ১
-      nextNumber: formatDocumentNumber(format, period(format), 1),
+      // Only journal entries get numbers in the mock so far; every other type starts at 1
+      nextNumber: formatDocumentNumber(
+        format,
+        period(format),
+        (documentType === 'accounting.journal'
+          ? (data.journal.counters.get(period(format)) ?? 0)
+          : 0) + 1,
+      ),
     };
   });
 }
```

- The numbering page's "next number" for the journal now follows the mock's counters.

**File: `apps/app/src/mocks/handlers.ts`** (change)

```diff
@@ -31,6 +31,21 @@ import {
   findAccount,
   parentFor,
 } from './accounting-data';
+import {
+  checkLines,
+  findEntry,
+  ledgerOf,
+  openingOf,
+  postDraft,
+  postNew,
+  replaceDraft,
+  reverseEntry,
+  saveOpening,
+  setLockDate,
+  sortedEntries,
+  summaryOf,
+  writeDraft,
+} from './journal-data';
 import { settleSetup, startSetup } from './setup-data';
 import {
   assertCodeFree,
@@ -433,6 +448,14 @@ export const handlers = [
       const { version, ...fields } = await readBody(routes.settings.update.body, request);
       const data = current();
       checkVersion(data.settings.version, version);
+      if (
+        fields.baseCurrency !== data.settings.baseCurrency &&
+        data.journal.entries.some((entry) => entry.status === 'posted')
+      ) {
+        throw new MockProblem(409, 'base_currency_locked', {
+          baseCurrency: ['base_currency_locked'],
+        });
+      }
       const before = editable(data.settings);
       data.settings = { ...data.settings, ...fields, version: version + 1 };
       record(data, 'settings.updated', 'workspace', workspace.tenantId, diff(before, fields));
@@ -658,6 +681,9 @@ export const handlers = [
       if (data.accounts.some((child) => child.parentId === id)) {
         throw new MockProblem(409, 'account_has_children');
       }
+      if (data.journal.entries.some((entry) => entry.lines.some((line) => line.accountId === id))) {
+        throw new MockProblem(409, 'account_in_use');
+      }
       data.accounts = data.accounts.filter((account) => account.id !== id);
       record(data, 'account.deleted', 'account', id, {
         code: { from: target.code, to: null },
@@ -667,6 +693,171 @@ export const handlers = [
     }),
   ),
 
+  mock(routes.journal.list, ({ request }) => {
+    const query = readQuery(routes.journal.list.query, request);
+    // The mock's cursor is an offset, like its other lists
+    const start = query.cursor === undefined ? 0 : Number(query.cursor);
+    const all = sortedEntries(current()).filter(
+      (entry) => query.status === undefined || entry.status === query.status,
+    );
+    const items = all.slice(start, start + query.limit).map(summaryOf);
+    const end = start + items.length;
+    return reply(routes.journal.list, { items, nextCursor: end < all.length ? String(end) : null });
+  }),
+
+  mock(
+    routes.journal.get,
+    guarded(({ params }) => {
+      const { id } = routes.journal.get.params.parse(params);
+      return reply(routes.journal.get, findEntry(current(), id));
+    }),
+  ),
+
+  mock(
+    routes.journal.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.journal.create.body, request);
+      const data = current();
+      checkLines(data, body.lines);
+      const entry = body.post ? postNew(data, body) : writeDraft(data, body);
+      record(data, 'journal.created', 'journal_entry', entry.id);
+      if (body.post) {
+        record(data, 'journal.posted', 'journal_entry', entry.id, {
+          number: { from: null, to: entry.number },
+        });
+      }
+      await delay();
+      return reply(routes.journal.create, entry);
+    }),
+  ),
+
+  mock(
+    routes.journal.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.journal.update.params.parse(params);
+      const { version, post, ...fields } = await readBody(routes.journal.update.body, request);
+      const data = current();
+      const entry = findEntry(data, id);
+      if (entry.status !== 'draft') throw new MockProblem(409, 'journal_not_draft');
+      checkVersion(entry.version, version);
+      checkLines(data, fields.lines);
+      // All or nothing, like the API's transaction: post a copy, keep it only if it posts
+      const before = structuredClone(entry);
+      replaceDraft(entry, fields);
+      if (post) {
+        try {
+          postDraft(data, entry);
+        } catch (error) {
+          Object.assign(entry, before);
+          throw error;
+        }
+      }
+      record(data, 'journal.updated', 'journal_entry', id);
+      await delay();
+      return reply(routes.journal.update, entry);
+    }),
+  ),
+
+  mock(
+    routes.journal.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.journal.remove.params.parse(params);
+      const { version } = readQuery(routes.journal.remove.query, request);
+      const data = current();
+      const entry = findEntry(data, id);
+      if (entry.status !== 'draft') throw new MockProblem(409, 'journal_not_draft');
+      checkVersion(entry.version, version);
+      data.journal.entries = data.journal.entries.filter((item) => item.id !== id);
+      record(data, 'journal.deleted', 'journal_entry', id);
+      return reply(routes.journal.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.journal.post,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.journal.post.params.parse(params);
+      const { version } = await readBody(routes.journal.post.body, request);
+      const data = current();
+      const entry = findEntry(data, id);
+      if (entry.status !== 'draft') throw new MockProblem(409, 'journal_not_draft');
+      checkVersion(entry.version, version);
+      postDraft(data, entry);
+      record(data, 'journal.posted', 'journal_entry', id, {
+        number: { from: null, to: entry.number },
+      });
+      return reply(routes.journal.post, entry);
+    }),
+  ),
+
+  mock(
+    routes.journal.reverse,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.journal.reverse.params.parse(params);
+      const { version, date } = await readBody(routes.journal.reverse.body, request);
+      const data = current();
+      const entry = findEntry(data, id);
+      checkVersion(entry.version, version);
+      const reversal = reverseEntry(data, entry, date);
+      record(data, 'journal.reversed', 'journal_entry', id, {
+        reversal: { from: null, to: reversal.number },
+      });
+      await delay();
+      return reply(routes.journal.reverse, reversal);
+    }),
+  ),
+
+  mock(
+    routes.ledger.get,
+    guarded(({ request, params }) => {
+      const { id } = routes.ledger.get.params.parse(params);
+      const query = readQuery(routes.ledger.get.query, request);
+      return reply(routes.ledger.get, ledgerOf(current(), id, query));
+    }),
+  ),
+
+  mock(routes.openingBalances.get, () => reply(routes.openingBalances.get, openingOf(current()))),
+
+  mock(
+    routes.openingBalances.save,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.openingBalances.save.body, request);
+      const data = current();
+      saveOpening(data, body);
+      const saved = openingOf(data);
+      record(data, 'journal.opening_balances_saved', 'workspace', workspace.tenantId, {
+        entry: { from: null, to: saved.entry?.number ?? null },
+      });
+      await delay();
+      return reply(routes.openingBalances.save, saved);
+    }),
+  ),
+
+  mock(routes.periodLock.get, () => {
+    const { journal } = current();
+    return reply(routes.periodLock.get, {
+      lockDate: journal.lockDate,
+      version: journal.lockVersion,
+    });
+  }),
+
+  mock(
+    routes.periodLock.update,
+    guarded(async ({ request }) => {
+      const { lockDate, version } = await readBody(routes.periodLock.update.body, request);
+      const data = current();
+      const before = data.journal.lockDate;
+      setLockDate(data, lockDate, version);
+      record(data, 'books.lock_date_changed', 'workspace', workspace.tenantId, {
+        lockDate: { from: before, to: lockDate },
+      });
+      return reply(routes.periodLock.update, {
+        lockDate: data.journal.lockDate,
+        version: data.journal.lockVersion,
+      });
+    }),
+  ),
+
   mock(routes.numberSeries.list, () =>
     reply(routes.numberSeries.list, { items: seriesList(current()) }),
   ),
```

- **`update` with `post: true`** keeps a copy and puts it back if posting throws: the API's transaction, by hand.
- The settings and account handlers get the same two new rules as the API.

---

## 10.9 — Playwright

**File: `apps/app/e2e/journal.e2e.ts`** (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

// The mock garments workspace has five posted entries (JV-…-0001 to 0005) and one draft
test('writes an entry and posts it only once the debits and credits are equal', async ({
  page,
}) => {
  await openFromNav(page, 'Journal');
  await page.getByRole('button', { name: 'New entry' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New journal entry' })).toBeVisible();

  await page.getByLabel('Narration').fill('Courier charges for buyer samples');
  await line(page, 1).getByLabel('Account').selectOption({ label: '5220 · Office rent' });
  await line(page, 1).getByLabel('Debit').fill('25000');
  await line(page, 2).getByLabel('Account').selectOption({ label: '1110 · Cash in hand' });
  await line(page, 2).getByLabel('Credit').fill('20000');

  const post = page.getByRole('button', { name: 'Post entry' });
  await expect(page.getByText('Out by ৳5,000.00')).toBeVisible();
  await expect(post).toBeDisabled();

  await line(page, 2).getByLabel('Credit').fill('25000');
  await expect(page.getByText('Balanced')).toBeVisible();
  await expectNoSideScroll(page);
  await post.click();

  await expect(page.getByText(/^JV-\d{4}-\d{2}-0006 posted$/)).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: /^JV-\d{4}-\d{2}-0006$/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '1110 Cash in hand' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('finishes a waiting draft, and deletes a new one in two clicks', async ({ page }) => {
  await openFromNav(page, 'Journal');
  // The segmented control's radio sits under its label; the label is what a person clicks
  await page.getByText('Drafts', { exact: true }).click();
  await listItem(page, /LC opening charges/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Draft entry' })).toBeVisible();
  await page.getByRole('button', { name: 'Post entry' }).click();
  await expect(page.getByText(/^JV-\d{4}-\d{2}-0006 posted$/)).toBeVisible();

  await page.getByRole('link', { name: 'Back to the journal' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByLabel('Narration').fill('Half-written');
  await line(page, 1).getByLabel('Account').selectOption({ label: '5410 · Bank charges' });
  await line(page, 1).getByLabel('Debit').fill('500');
  await line(page, 2).getByLabel('Account').selectOption({ label: '1110 · Cash in hand' });
  await line(page, 2).getByLabel('Credit').fill('500');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Draft entry' })).toBeVisible();

  await page.getByRole('button', { name: 'Delete draft' }).click();
  await expect(page.getByText('This cannot be undone.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete this draft' }).click();
  await expect(page.getByText('Draft deleted')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Journal' })).toBeVisible();
});

test('reverses a posted entry once, and links the two', async ({ page }) => {
  await openFromNav(page, 'Journal');
  await listItem(page, /Office rent for the Banani head office/).click();
  const original = page.getByRole('heading', { level: 1, name: /^JV-/ });
  const number = (await original.textContent()) ?? '';

  await page.getByRole('button', { name: 'Reverse' }).click();
  const dialog = page.getByRole('dialog', { name: `Reverse ${number}` });
  await dialog.getByRole('button', { name: 'Reverse entry' }).click();
  await expect(page.getByText(new RegExp(`reverses ${number}$`))).toBeVisible();
  await expect(page.getByText('Reversal', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: `Reverses ${number}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Reversed by JV-/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reverse' })).toBeHidden();
});

test("shows an account's ledger with the running balance", async ({ page }) => {
  await openFromNav(page, 'Ledger');
  await expect(page.getByText(/^Choose an account above to see its entries/)).toBeVisible();
  // A combobox: the user menu's button is called "Account" too
  await page
    .getByRole('combobox', { name: 'Account' })
    .selectOption({ label: '1110 · Cash in hand' });
  // 50,000 petty cash in, 18,450.50 paid for electricity
  await expect(page.getByText('৳31,549.50 Dr').first()).toBeVisible();
  await expect(page.getByText('DESCO electricity bill, Gazipur factory')).toBeVisible();
  await expectNoSideScroll(page);
});

test('posts the opening balances, with the difference in opening balance equity', async ({
  page,
}) => {
  await openFromNav(page, 'Opening balances');
  await page.getByRole('button', { name: 'First day on Omnivo' }).click();
  await page.locator('td[data-today] button').click();
  await page.getByLabel('Debit, 1121').fill('1842600.50');
  await page.getByLabel('Credit, 2110').fill('412000');
  // What the books are out by, on the side that closes the gap
  await expect(page.getByText('৳14,30,600.50')).toBeVisible();
  // …and with it both totals are the larger side
  await expect(page.getByText('৳18,42,600.50')).toHaveCount(2);
  await page.getByRole('button', { name: 'Post opening balances' }).click();
  await expect(page.getByText(/^Opening balances posted as JV-/)).toBeVisible();
  await expect(page.getByRole('link', { name: /^Posted as JV-/ })).toBeVisible();
  await expectNoSideScroll(page);
});

test('closes the books up to today, and then refuses to post into it', async ({ page }) => {
  await openFromNav(page, 'Journal');
  await page.getByRole('button', { name: 'Lock date' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lock date' });
  await dialog.getByRole('button', { name: 'Books closed up to' }).click();
  await page.locator('td[data-today] button').click();
  await dialog.getByRole('button', { name: 'Save lock date' }).click();
  await expect(page.getByText(/^Books closed up to /)).toBeVisible();

  await page.getByRole('button', { name: 'New entry' }).click();
  await line(page, 1).getByLabel('Account').selectOption({ label: '5220 · Office rent' });
  await line(page, 1).getByLabel('Debit').fill('100');
  await line(page, 2).getByLabel('Account').selectOption({ label: '1110 · Cash in hand' });
  await line(page, 2).getByLabel('Credit').fill('100');
  await page.getByRole('button', { name: 'Post entry' }).click();
  await expect(
    page.getByText('The books are closed for this date. Pick a date after the lock date.'),
  ).toBeVisible();
});
```

- **`line(page, n)`** finds a line by its group label, so `getByLabel('Debit')` inside it is unique — on a phone
  (visible labels) and on a desktop (screen-reader labels) alike.
- **"writes an entry and posts it only once…"** — checks the crit pill and the disabled Post while the entry is out
  by ৳5,000, then the number `…-0006` (the mock has five posted entries).
- **The segmented control** is clicked by its label text: the radio input itself sits under the label
  (`sr-only`), and Playwright refuses a click that another element would catch.
- **The ledger's account select** is found as a `combobox`: the user menu's button is also called "Account".
- **Dates** are picked with `td[data-today] button` — react-day-picker marks today's cell. The lock date test
  closes today and then tries to post today.
- **The opening balances test** checks both totals (`toHaveCount(2)`), the check that would have caught the
  ৳0.00 bug.

---

## 10.10 — Root files

No new package, no new `.env` line, no change to `.gitignore` or the CI workflow.

```bash
pnpm gen:openapi      # openapi.json — 48 paths (41 before); commit it
```

---

## 10.11 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Content and formatting" → "Money", one sentence:

> Accounting documents (journal entries, ledgers, opening balances, and later the trial balance) show 2 decimals,
> because their totals must visibly add up; dashboards and lists stay without decimals.

Under "Components", after "Select":

> - **Select (bare):** `Select` from `@omnivo/ui` is the select box without its label, for controls labelled by a
>   column header (journal lines). `SelectField` is built on it.
> - **Line editor (journal lines, opening balances):** a card that is a container (`@container`); each row is a
>   `role="group"` labelled "Line 2". On a wide card (`@3xl`) the rows share one grid template with the header and
>   the totals row, and each control's label is `sr-only`; on a narrow card the labels show and debit/credit sit
>   side by side. Totals row on `subtle` with a `good` "Balanced" or `crit` "Out by" pill.

And under "Date picker", one sentence: "The calendar's code loads the first time the picker opens
(`calendar.tsx`); the button is there at once."

**build-plan.bn.md** — step 10's text: `journal_entries` + `journal_lines`, draft → posted (`accounting.journal.create`
/ `.post`, আলাদা রোল = maker-checker), DB-তে deferred constraint trigger দিয়ে `SUM(debit) = SUM(credit)`, posted
entry ও তার লাইন trigger দিয়ে frozen — শুধু reversal, lock date (একটা তারিখ পর্যন্ত বই বন্ধ), ওপেনিং ব্যালান্সের পাতা,
লাইনে ঐচ্ছিক ব্রাঞ্চ, `PostingService.postNew()` পরের সব মডিউলের জন্য।

**COMMANDS.md** — in the database section:

````markdown
```sh
# the journal: entries per status, and any posted entry that does not balance (should be none)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, e.status, count(*) FROM journal_entries e JOIN tenants t ON t.id = e.tenant_id GROUP BY 1, 2"
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT e.number, sum(l.debit) - sum(l.credit) AS out_by FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.status = 'posted' GROUP BY e.number HAVING sum(l.debit) <> sum(l.credit)"
```
````

---

## 10.12 — Run it

```bash
pnpm db:migrate                               # 0015 + 0016, and the four permissions
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it if it was running
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('journal_entries', 'journal_lines', 'period_locks');        -- three rows, all t
SELECT tgname FROM pg_trigger WHERE tgname LIKE 'journal_%';                    -- the three triggers
SELECT key FROM permissions WHERE key LIKE 'accounting.%';                      -- five keys
```

### What you will see

1. **Your existing roles do not have the new permissions yet** (templates never touch existing data). As the
   owner you have them all. To let your Accountant role in: Roles → tick the four journal boxes.
2. The sidebar's **Accounting** group: Chart of accounts, **Journal**, **Ledger**, **Opening balances**.
3. **Journal → New entry.** Line 1: "5220 · Office rent", Debit 25000. Line 2: "1110 · Cash in hand", Credit
   20000 → a red "Out by ৳5,000.00" and **Post entry** is disabled. Credit 25000 → "Balanced" → **Post entry** →
   "JV-2026-27-0001 posted" and the entry's page.
4. Click **1110 Cash in hand** on that page → the ledger of cash, with the entry and "৳25,000.00 Cr".
5. Back on the entry → **Reverse** → **Reverse entry** → a new entry "Reverses JV-2026-27-0001"; the original
   says "Reversed by …" and has no Reverse button any more. The ledger of cash is back at ৳0.00.
6. **New entry → Save draft** → "Draft entry", no number. Change it, save again. **Delete draft** → "Delete this
   draft" → gone.
7. **Opening balances** → pick the first day on Omnivo, type a bank balance and a payable → the "Opening balance
   equity" row shows the difference → **Post opening balances** → "Posted as JV-…", dated the day before.
8. **Journal → Lock date** → pick yesterday → Save → "Books closed up to …". A new entry dated yesterday →
   Post → "The books are closed for this date. Pick a date after the lock date." Clear the lock date again.
9. **Settings** → change the base currency → "Entries are posted in this currency, so it can't change any more."
10. **Chart of accounts** → an account with entries → Delete → "Entries use this account, so it stays in the
    books. Archive it instead."
11. **Audit log → Journal**: "Wrote a journal entry", "Posted a journal entry" with the number, "Reversed a
    journal entry".
12. A member with only `…read` and `…create`: New entry works, **Post entry** stays disabled with "Ask a workspace
    owner for the accounting.journal.post permission". Someone with `…post` opens that draft and posts it.
13. **Bangla**: জার্নাল, লেজার, ওপেনিং ব্যালান্স; balances end in "ডে." / "ক্রে.".
14. DevTools at 390 px: each line is a small card, debit and credit side by side, and nothing scrolls sideways.

---
## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 145: contracts 48 + api 39 + ui 19 + app 21 + i18n 11 + auth 7
pnpm test:integration        # 128 — 15 new
pnpm test:tenant-leak        # 32 — 3 new
pnpm test:e2e                # 54: 27 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 182.3 KB gz; journal 82.6, entry form 77.7, opening 73.6, ledger 64.8, view 60.5
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **drizzle-kit wrote two FKs before their unique index** — the same as step 9. One line moved by hand (10.2).
- **decimal.js in `packages/contracts` broke two things.** The line schema needed "is this amount zero?", and it
  sat next to the decimal.js sums: every page then carried decimal.js (first load 175 → 194 KB gz, budget 200),
  and `pnpm boundaries` failed — contracts may depend on zod only. The sums are BigInt in ten-thousandths now
  (10.1): exact, no dependency, and the first load is 182 KB.
- **The journal pages were over 100 KB** with the form library, the money input and the calendar. Splitting the
  entry page into a form and a view helped; loading the calendar only when a date picker opens (10.6) is what
  brought every page down to 65–83 KB.
- **The opening balances' total row showed ৳0.00** while the equity row was right: the "larger side" picked the
  wrong one. Found on the screenshot, not by a test — the e2e test now checks both totals (10.9).
- **A number inside a template string** (`` `lines.${index}.debit` ``) breaks the project's lint rule, and
  `String(index)` breaks react-hook-form's path type. One helper with one commented cast, `linePath()` (10.7).
- **"Account" was two things on the ledger page**: the select and the user menu's button. The e2e test finds the
  select as a `combobox`.
- **The segmented control's radio cannot be clicked directly** — its label covers it. The test clicks the label.
- **A draft's title "Draft" in the number font** looked like a broken number next to its pill (390px screenshot).
- **A guard test that proved nothing.** The first "posted lines are frozen" test changed both lines of an entry;
  the one-side `CHECK` refused that before the trigger was asked. With the trigger switched off the test still
  passed. It now changes only the debit line (10.4). Always break the guard and watch the test fail.
- **The delete icon of a line sat higher than the inputs** on a wide screen (`@3xl:pt-1`).
- **An unused variable in the mock** (`const { lines: _lines, ...summary }`) — the lint rule does not ignore `_`
  names here; the mock builds the summary field by field instead.
- **Busy-machine failures in older tests** (the box at the top): timeouts in step 6–9 files, and an ordering race
  in step 8's invitations test. Recorded, not fixed, because they are not this step's code.

---

## Notes left for later steps

**Step 11 (reports):**

- Read `journal_lines` joined to `journal_entries` with `status = 'posted'`. Never read drafts into a report.
- Group by `ledger_accounts.type` and use `NORMAL_BALANCE` (step 9) for the sign. The ledger API's convention —
  debit minus credit — is the raw number; a report flips it for credit-normal types.
- Year close: post the closing entry (income and expense accounts to the account whose `purpose` is
  `retained_earnings`) through `PostingService.postNew()` with a new source (for example `year_close`), then move
  the lock date to the year's last day. Add the source to `JOURNAL_SOURCES` and to `journal.sources.*` in both
  languages (the type check asks for both).
- A trial balance must show debits = credits for every date — 0016's trigger guarantees it per entry; a test
  that sums all posted lines of a tenant is a cheap second check.

**Step 15 onwards (sales, purchase, inventory):**

- Import `JournalModule` and call `posting.postNew(tx, { date, narration, source, lines })` **inside the
  document's own transaction**, so the invoice and its entry commit together. Add the source first.
- Find the accounts by `purpose` (step 9's warning), never by code or name: `accounts_receivable`, `sales`,
  `vat_output`, `inventory`, `cost_of_goods_sold`.
- A posted invoice is never edited either: a credit note posts the opposite entry, like a reversal.
- If a worker job posts (no person behind it), `postedBy` and `createdBy` stay `NULL` — that is "System".

**Notes for any step:**

- Never `UPDATE` or `DELETE` a posted entry or its lines, not even in a migration: the triggers refuse it, and the
  fix is a reversal. If data must ever be repaired by hand, do it as a new, posted correcting entry.
- Every posting goes through `PostingService` — never insert into `journal_lines` from another module.
- The lock date is checked in `assertPeriodOpen()`; a new way of posting that skips `PostingService` would skip it.
- **Two test fixes worth doing soon** (see the box at the top; not done here, because they are in step 6–8 code):
  step 8's "when the mail server is down" test should find the notification by its email instead of taking
  `items[0]`; and if the integration suite keeps timing out on a busy laptop, give `*.int.spec.ts` a longer
  `testTimeout` or fewer `maxWorkers` in `apps/api`'s vitest config.
