# Step 11: Financial statements — trial balance, profit and loss, balance sheet, year-end close and exports

> The implementation guide for "Phase 3 → Step 11" of [build-plan.bn.md](build-plan.bn.md): which file gets what
> code, and which command runs where.
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `78d2bfb`, the end of
> step 10) and checked on 2026-10-01: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`,
> `pnpm test` (167 — 22 new), `pnpm test:integration` (153 — 25 new), `pnpm test:tenant-leak` (35 — 3 new),
> `pnpm build`, `pnpm test:bundle-size` (first load 187.5 KB gz, budget 200; the report pages 40–81 KB),
> `pnpm gen:openapi` (56 paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 64 —
> 10 new, desktop and 390px) — all pass, with the turbo cache bypassed (`--force`). On a machine with a load average of 34 (VS Code, Chrome and macOS background jobs), two runs were not clean: one e2e run had two 5-second visibility timeouts (one of them in a step 10 test this step does not touch), and one integration run had one 5-second test timeout (that test is split now). The last three e2e runs (64/64 each) and four integration runs (153/153) were clean.
>
> Also checked by hand:
>
> - **The real API, the real worker and a real MinIO.** Throwaway containers on other ports (Postgres 55432,
>   Valkey 56379, MinIO 59000, Mailpit 51025), migrated from empty, the built API and worker, and the app
>   pointed at them. In a browser: sign up, the setup wizard, two entries posted from the journal form, then the
>   trial balance ("Balanced"), the profit and loss, the balance sheet, the year-end page, an Excel export and a
>   PDF export. The bell said both were ready; both downloaded under their own names. The `.xlsx` holds real
>   numbers with the `#,##0.00` format; the PDF's totals balance.
> - **The upgrade of an existing database.** A Postgres migrated with step 10's migrations (17), one tenant
>   added, then this step's: 19 migrations, `report_exports` with `ENABLE` + `FORCE` RLS and its policy, the old
>   tenant kept.
> - **The PDFs in both languages**, rendered to images and looked at: lakh grouping (1,84,26,000.50), Bangla
>   digits, Bangla conjuncts and vowel signs shaped correctly (ক্ষ, র্ক, কি), `৳` on the same baseline as the
>   digits, a long Bangla account name cut at a whole letter, and a 70-row trial balance on three landscape
>   pages with the column headers repeated.
> - **The screens.** Screenshots at 1280px and 390px of all five new pages (mock data). They found three
>   layout details, fixed in this guide ("What we found on the way").
> - **Every guard broken on purpose.** Let the profit and loss count closing entries → "still reports the
>   closed year with its profit" fails. Let the reports count drafts → three report tests fail. Skip the
>   "earlier year first" check → "closes years in order" fails. Let the journal reverse a closing entry → four
>   year-end tests fail. Stop a closing entry from reaching an archived account → "closes years in order" fails.
>   Let anyone download anyone's export → the export ownership test fails. Make reopen leave the lock date, or
>   close leave it → four tests fail each time.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database. Nothing new is needed
> there (no new env line — the worker now reads the `S3_*` lines the API already had), but run
> `pnpm db:migrate` (10.12 of step 10 is the lesson: an unmigrated database makes the new pages fail).
> (2) The new tests on GitHub Actions. (3) **The accounting rules have not been reviewed by an accountant**
> — show them "The decisions behind this step", especially decisions 6–9 (what the profit and loss leaves
> out, the year order, reopening). (4) The Bangla texts were written by me, not reviewed by a native speaker.
> (5) The files in Excel itself and in a PDF reader on Windows: checked as files (the sheet's XML, the PDF
> rendered by macOS), not opened in Microsoft Excel.

## Goal

📗 **The books as statements.** Step 10 made the journal. This step reads it: the three reports every company
in Bangladesh files and shows its bank, and the yearly close that turns a year's profit into retained earnings.

After this step:

- **Trial balance.** Every ledger account with its opening balance, what moved in the period (debits and
  credits) and its closing balance. Grouped by type, with a "Balanced" pill when both sides are equal.
- **Profit and loss.** Income and expenses of a period as the chart's tree (groups summed), the net profit,
  and optionally a second period next to it (the period before, or last year) and one branch only.
- **Balance sheet.** Assets, liabilities and equity on a day, optionally next to another day (the last year
  end, or a year before). Until a year is closed, its profit shows as "Profit not yet closed" inside equity, so
  the two sides are always equal.
- **Year-end close.** One page with every fiscal year. "Close year" posts a closing entry (every income and
  expense account emptied into retained earnings) and moves the lock date to the year's last day. "Reopen"
  reverses it on its own date and opens the year's books again.
- **Excel and PDF exports.** Every report has Export → Excel or PDF. The worker writes the file, stores it in
  S3/MinIO, and the bell says when it is ready. "Exports" lists your files with a Download button.
- **A report permission.** `accounting.report.read`: a director can read the statements without the journal.

## The whole picture

```
packages/contracts   reports.ts: fiscalYearOf · 3 report queries and answers · reportSection() (API and mock)
      │               fiscal years (list, close, reopen) · exports (create, list, download) · 8 routes
      │               journal source 'year_close' · 1 permission · 2 audit actions · 2 notifications · 12 errors
      ▼
packages/db          report_exports (+ CHECK: a ready export has its file) · outbox event 'report.export_requested'
                     0017 (drizzle) · 0018 (RLS)
      │
      ▼
apps/api             ReportsModule
                       report-queries.ts: trialBalance · profitAndLoss · balanceSheet   ← plain SQL, API and worker
                       FiscalYearsService: list · close · reopen (PostingService.postNew + the lock date)
                       ReportExportsService: create (row + outbox event) · list · download
                     worker: ReportExportHandler → document.ts → xlsx.ts | pdf.ts → S3 → notify
                     StorageService gets its own STORAGE_CONFIG, so the worker can store files
                     journal: closing entries reach archived accounts, and are not reversed from the journal
      │
      ▼
apps/app             /reports/trial-balance · /reports/profit-and-loss · /reports/balance-sheet · /reports/exports
                     /year-end · nav group "Reports" · the ledger opens with a report's dates
                     MSW: the same reports on arrays, last fiscal year in the mock, a pretend export worker

one export, from the click to the file:
  Export → PDF ──POST /report-exports──► API tx: INSERT report_exports (pending) + outbox event → COMMIT
  relay → BullMQ 'jobs' → worker: read the report (same SQL) → PDF → S3 put → UPDATE ready + notification
  bell (polls 30 s) "Profit and loss (PDF) is ready" → Exports → Download → short-lived signed URL → file
```

## The decisions behind this step

You chose the first four on 2026-10-01; the others follow from them, from the build plan, or from what an
accountant expects of these reports. Please read 5–10 with care: they are mine.

1. **Year-end close posts a real closing entry, then locks the year.** (You chose this.) The entry empties
   every income and expense account into the account whose purpose is `retained_earnings`, dated the year's
   last day, through step 10's `PostingService.postNew()` with the new source `year_close`. Then the lock date
   moves to that day. The other option, a "virtual" close that only computes retained earnings at report time,
   leaves income accounts that never return to zero — strange to an auditor, and to Tally users.
2. **Excel and PDF, written by the worker.** (You chose this.) A large report never holds the API or the page.
   The file goes to the same bucket as the uploads; the bell tells the person; the Exports page keeps the list.
3. **Period, branch and a comparison.** (You chose this.) Presets (this or last fiscal year, quarter, month)
   or any two dates; a second column for the period before or the same period last year; one branch.
4. **No cash flow statement yet.** (You chose this.) An indirect cash flow needs a cash-flow category on every
   account; it makes sense once sales and purchases exist.
5. **A new permission, `accounting.report.read`.** The statements are what a director or a bank asks for; the
   journal holds salaries line by line. A role can have one without the other. Year-end close needs
   `accounting.period.close` (the lock date's permission), because closing is closing the books.
6. **The profit and loss leaves out closing entries, and the reversals that reopened a year.** A closing
   entry is not income or expense; it moves the profit. Counted, every closed year would show a profit of
   zero. The trial balance and the balance sheet include them: they show what the ledgers say.
7. **Years close in order, and reopen backwards.** A year closes only when every income and expense account
   was empty the day before it began (the earlier year was closed, or never used). A year reopens only when no
   later year is closed. So retained earnings never counts a year twice, and never misses one.
8. **A closing entry is undone only by reopening its year.** The journal's Reverse refuses it. Reopen reverses
   it **on its own date** (not today), and moves the lock date back to the day before the year began. A
   reversal dated today would put last year's income into this year's profit and loss.
9. **Drafts block a close.** After the close, a draft dated in the year could never be posted (the lock
   date). The close says how many there are; post or delete them first.
10. **Branch filter on the profit and loss only.** One entry can touch several branches (step 10's decision 4),
    so a branch's assets and liabilities rarely balance on their own. Branch-wise profit is the question people
    ask; branch-wise balance sheets come with inter-branch accounts, if ever.
11. **Plain SQL for the reports** (the build plan asks for it). Each report is one `GROUP BY` over the posted
    lines; the rows are checked with Zod, not cast. The API and the worker call the same functions.
12. **Money stays a decimal string — until the Excel cell.** Excel stores every number as a double, which is
    what lets people add the cells up. Before writing one, the amount is turned back into a string and
    compared; if the double cannot hold it exactly, the cell gets the exact text instead.
13. **An export belongs to the person who asked for it.** The list and the download show only your own; a
    colleague's export is "not found", like another tenant's row.

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Cash flow statement | You chose later (decision 4). Needs a cash-flow category per account |
| Pre-closing trial balance (the year's balances before its closing entry) | Ask the accountant if they want it; it is a filter on `source` in `trialBalance()` |
| Notes to the accounts, schedules (fixed asset schedule, Schedule XI style layout) | With fixed assets and depreciation |
| Deleting old export files | A cleanup job (like step 8's outbox cleanup) once there are many; see "Notes left for later steps" |
| Scheduled reports by email | Later, when someone asks |
| Budget vs actual, ratios, dashboards | Phase 4 (build plan) |
| Branch-wise balance sheet | Decision 10 |

## What changes in the code you already have

- **One new package set, in `apps/api` only:** `write-excel-file` (Excel), `pdfkit` (PDF) and the fonts
  `@fontsource/geist` and `@fontsource/noto-sans-bengali` (the PDF carries its fonts), plus `@types/pdfkit`. No
  new `.env` line, no new database role.
- **`pnpm db:migrate`** adds `report_exports` and the new permission (`syncPermissions()`). Nothing is
  backfilled.
- **The worker now needs the `S3_*` settings** the API already reads (`config.ts`). The same `.env` serves both;
  a production deploy must give them to the worker too.
- `StorageService` takes only the storage part of the config (a new `STORAGE_CONFIG` token), so the worker can
  have it without the API's auth secrets.
- `period-lock.service.ts`: the exclusive lock and the lock-date write become functions the year-end close
  calls in its own transaction.
- `PostingService.post()`: a closing entry reaches archived accounts, like a reversal does.
- `JournalService.reverse()`: refuses a closing entry (`journal_is_year_close`).
- `setup/templates.ts`: the Accountant role of **new** workspaces gets `accounting.report.read`. Existing roles
  do not; an owner ticks the box on the Roles page.
- The ledger page accepts `?from=&to=` in its address: an account clicked in a report opens with the report's
  dates.
- The mock garments workspace gets last fiscal year (four entries) and an export sale this year, so the reports
  and the year-end page have something to show. This year's journal numbers now run to 0006, so step 10's
  journal e2e test expects 0007 for the next one.

---

## 11.1 — `packages/contracts`: the contract

**File: `packages/contracts/src/reports.ts`** (new)

```ts
import { z } from 'zod';

import { ACCOUNT_TYPES, type AccountType, NORMAL_BALANCE } from './accounts.js';
import { signedUrlSchema } from './attachments.js';
import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { addMoney, isZeroMoney, subtractMoney, sumMoney } from './money.js';
import { periodOf } from './numbering.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { shiftIsoDate } from './journal.js';

// ---------------------------------------------------------------------------------------------
// Fiscal years. The workspace's settings say in which month a year starts (July in Bangladesh).

// The fiscal year that holds `isoDate`: 2026-09-23 with a July start → 2026-07-01 … 2027-06-30.
// It reads the parts of the string, never a Date, so no time zone can move the day (the same rule
// as periodOf in numbering.ts).
export function fiscalYearOf(isoDate: string, startMonth: number): { start: string; end: string } {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const startYear = month >= startMonth ? year : year - 1;
  const mm = String(startMonth).padStart(2, '0');
  return {
    start: `${String(startYear)}-${mm}-01`,
    // The day before the next year starts
    end: shiftIsoDate(`${String(startYear + 1)}-${mm}-01`, -1),
  };
}

// "2025-26" for a July–June year, "2026" for a calendar year: the same label the journal's
// numbers carry (JV-2025-26-0001), so a person sees one name for one year everywhere
export function fiscalYearLabel(start: string, startMonth: number): string {
  return periodOf(start, 'fiscal', startMonth);
}

// ---------------------------------------------------------------------------------------------
// The three reports. Every amount is a decimal string with 4 places, like the ledger.

export const REPORT_KINDS = ['trial_balance', 'profit_and_loss', 'balance_sheet'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export function isReportKind(value: string): value is ReportKind {
  return REPORT_KINDS.some((kind) => kind === value);
}

// Both days included. `to` before `from` is a mistake the form can show under "To".
export const trialBalanceQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((query) => query.from <= query.to, {
    error: errorCode('report_range_invalid'),
    path: ['to'],
  });
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;

// compareFrom/compareTo: a second period shown in its own column (last year, or the period just
// before). The app works the dates out from a preset; the server takes them as they are.
// branchId: only lines tagged with that branch (step 10's optional branch per line).
export const profitAndLossQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    compareFrom: z.iso.date().optional(),
    compareTo: z.iso.date().optional(),
    branchId: z.uuid().optional(),
  })
  .superRefine((query, ctx) => {
    if (query.from > query.to) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: errorCode('report_range_invalid') });
    }
    if ((query.compareFrom === undefined) !== (query.compareTo === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['compareFrom'],
        message: errorCode('report_compare_incomplete'),
      });
    } else if (
      query.compareFrom !== undefined &&
      query.compareTo !== undefined &&
      query.compareFrom > query.compareTo
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['compareTo'],
        message: errorCode('report_range_invalid'),
      });
    }
  });
export type ProfitAndLossQuery = z.infer<typeof profitAndLossQuerySchema>;

// A balance sheet is a picture of one day, so it has dates, not ranges. No branch: a branch's
// assets and liabilities rarely balance on their own, because one entry can touch several branches.
export const balanceSheetQuerySchema = z.object({
  asOf: z.iso.date(),
  compareAsOf: z.iso.date().optional(),
});
export type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;

// One ledger account in the trial balance. opening and closing are signed debit − credit, like the
// ledger (positive = Dr, negative = Cr); debit and credit are what moved inside the range.
export const trialBalanceRowSchema = z.object({
  accountId: z.uuid(),
  code: z.string(),
  name: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  opening: z.string(),
  debit: z.string(),
  credit: z.string(),
  closing: z.string(),
});
export type TrialBalanceRow = z.infer<typeof trialBalanceRowSchema>;

// The debit and credit columns of the totals row. Each pair is equal when the books balance —
// which the journal's rules guarantee; the page still shows both, because that is the point.
export const trialBalanceSchema = z.object({
  rows: z.array(trialBalanceRowSchema),
  totals: z.object({
    openingDebit: z.string(),
    openingCredit: z.string(),
    debit: z.string(),
    credit: z.string(),
    closingDebit: z.string(),
    closingCredit: z.string(),
  }),
});
export type TrialBalance = z.infer<typeof trialBalanceSchema>;

// One row of the profit and loss or the balance sheet: an account or a group, in tree order.
// amount has the account type's natural sign: income and liabilities are positive on the credit
// side, expenses and assets on the debit side. A negative amount is real (sales returns larger
// than sales, an overdrawn bank) and is shown with a minus.
export const reportRowSchema = z.object({
  accountId: z.uuid(),
  parentId: z.uuid().nullable(),
  code: z.string(),
  name: z.string(),
  isGroup: z.boolean(),
  // 0 = right under the section's top group ("Revenue" under "Income")
  depth: z.number().int().min(0),
  // A group's amount is the sum of everything under it
  amount: z.string(),
  // null when no comparison was asked for
  compareAmount: z.string().nullable(),
});
export type ReportRow = z.infer<typeof reportRowSchema>;

export const reportSectionSchema = z.object({
  type: z.enum(ACCOUNT_TYPES),
  rows: z.array(reportRowSchema),
  total: z.string(),
  compareTotal: z.string().nullable(),
});
export type ReportSection = z.infer<typeof reportSectionSchema>;

export const profitAndLossSchema = z.object({
  income: reportSectionSchema,
  expense: reportSectionSchema,
  // income − expenses: negative is a loss
  netProfit: z.string(),
  compareNetProfit: z.string().nullable(),
});
export type ProfitAndLoss = z.infer<typeof profitAndLossSchema>;

export const balanceSheetSchema = z.object({
  asset: reportSectionSchema,
  liability: reportSectionSchema,
  equity: reportSectionSchema,
  // Income minus expenses that no year-end close has moved into retained earnings yet: this
  // year's profit so far. Without it the two sides would not be equal until the year is closed.
  profitNotClosed: z.string(),
  compareProfitNotClosed: z.string().nullable(),
  // liabilities + equity + profitNotClosed: equal to asset.total
  liabilitiesAndEquity: z.string(),
  compareLiabilitiesAndEquity: z.string().nullable(),
});
export type BalanceSheet = z.infer<typeof balanceSheetSchema>;

// What the report builder needs to know about an account: the API reads it from ledger_accounts,
// the mock from its array
export interface ReportAccount {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  type: AccountType;
  isGroup: boolean;
}

// Sorts "1120" after "1110" and "1-2" before "1-10", like the chart of accounts
const byCode = new Intl.Collator('en', { numeric: true });

export function compareCodes(a: string, b: string): number {
  return byCode.compare(a, b);
}

// A signed balance (debit − credit) in the account type's natural sign: a liability's credit
// balance of -1200 becomes 1200
export function naturalAmount(type: AccountType, signed: string): string {
  return NORMAL_BALANCE[type] === 'debit' ? signed : subtractMoney('0', signed);
}

// One section of a report (all income, all assets…) as tree-ordered rows with group totals. The
// API and the mock both call it, so the two always shape a report the same way.
// amounts: account id → natural amount of each ledger (missing = zero). A row is left out when it
// and everything under it are zero in both columns, so the page shows what moved, not the whole
// chart. The section's top group is not a row: its sum is the section total.
export function reportSection(
  type: AccountType,
  accounts: readonly ReportAccount[],
  amounts: ReadonlyMap<string, string>,
  compareAmounts: ReadonlyMap<string, string> | null,
): ReportSection {
  const children = new Map<string | null, ReportAccount[]>();
  for (const account of accounts) {
    if (account.type !== type) continue;
    const siblings = children.get(account.parentId) ?? [];
    siblings.push(account);
    children.set(account.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => byCode.compare(a.code, b.code));

  // Depth-first: a group's row comes before its children, but its sum is only known after them,
  // so the row is reserved first and filled in afterwards
  function walk(
    account: ReportAccount,
    depth: number,
    rows: ReportRow[],
  ): { amount: string; compare: string; visible: boolean } {
    if (!account.isGroup) {
      const amount = addMoney(amounts.get(account.id) ?? '0', '0');
      const compare = addMoney(compareAmounts?.get(account.id) ?? '0', '0');
      const visible = !isZeroMoney(amount) || !isZeroMoney(compare);
      if (visible) rows.push(row(account, depth, amount, compare));
      return { amount, compare, visible };
    }
    const own: ReportRow[] = [];
    const parts = (children.get(account.id) ?? []).map((child) => walk(child, depth + 1, own));
    const amount = sumMoney(parts.map((part) => part.amount));
    const compare = sumMoney(parts.map((part) => part.compare));
    // A group shows when anything under it moved, even if it nets to zero (+100 and −100)
    const visible = parts.some((part) => part.visible);
    if (visible) rows.push(row(account, depth, amount, compare), ...own);
    return { amount, compare, visible };
  }

  function row(account: ReportAccount, depth: number, amount: string, compare: string): ReportRow {
    return {
      accountId: account.id,
      parentId: account.parentId,
      code: account.code,
      name: account.name,
      isGroup: account.isGroup,
      depth,
      amount,
      compareAmount: compareAmounts === null ? null : compare,
    };
  }

  const root = children.get(null)?.[0];
  const rows: ReportRow[] = [];
  // The top group itself is depth -1: its children start at 0
  const total = root ? walk(root, -1, rows) : { amount: '0.0000', compare: '0.0000' };
  return {
    type,
    // walk() pushed the top group as the first row (if anything moved); the total says it already
    rows: rows.filter((item) => item.accountId !== root?.id),
    total: total.amount,
    compareTotal: compareAmounts === null ? null : total.compare,
  };
}

const reportRouteBase = {
  auth: 'bearer',
  permission: 'accounting.report.read',
  status: 200,
} as const;

export const reportRoutes = {
  trialBalance: defineRoute({
    ...reportRouteBase,
    method: 'GET',
    path: '/reports/trial-balance',
    summary: 'Every ledger account: opening balance, debits, credits and closing balance',
    query: trialBalanceQuerySchema,
    response: trialBalanceSchema,
  }),
  profitAndLoss: defineRoute({
    ...reportRouteBase,
    method: 'GET',
    path: '/reports/profit-and-loss',
    summary:
      'Income and expenses of a period, optionally for one branch and against a second period',
    query: profitAndLossQuerySchema,
    response: profitAndLossSchema,
  }),
  balanceSheet: defineRoute({
    ...reportRouteBase,
    method: 'GET',
    path: '/reports/balance-sheet',
    summary: 'Assets, liabilities and equity on a day, optionally against a second day',
    query: balanceSheetQuerySchema,
    response: balanceSheetSchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// Year-end close: a closing entry moves every income and expense balance into retained earnings,
// and the lock date moves to the year's last day.

export const FISCAL_YEAR_STATUSES = ['open', 'closed'] as const;
export type FiscalYearStatus = (typeof FISCAL_YEAR_STATUSES)[number];

const entryRefSchema = z.object({ id: z.uuid(), number: z.string() });

export const fiscalYearSchema = z.object({
  start: z.iso.date(),
  end: z.iso.date(),
  // "2025-26"
  label: z.string(),
  // closed = it has a closing entry that was not reversed
  status: z.enum(FISCAL_YEAR_STATUSES),
  closingEntry: entryRefSchema.nullable(),
  // Income − expenses of this year, without its closing entry
  netProfit: z.string(),
  // Drafts dated inside the year. A year with drafts cannot be closed: after the close they could
  // never be posted.
  drafts: z.number().int().min(0),
});
export type FiscalYear = z.infer<typeof fiscalYearSchema>;

// Newest first: from the current fiscal year back to the year of the first posted entry
export const fiscalYearListSchema = z.object({
  items: z.array(fiscalYearSchema),
  lockDate: z.iso.date().nullable(),
});
export type FiscalYearList = z.infer<typeof fiscalYearListSchema>;

// The year is named by its last day: the date the closing entry carries
export const fiscalYearInputSchema = z.object({ end: z.iso.date() });
export type FiscalYearInput = z.infer<typeof fiscalYearInputSchema>;

export const fiscalYearRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/fiscal-years',
    summary: 'The fiscal years, newest first, with their close status',
    auth: 'bearer',
    permission: 'accounting.journal.read',
    status: 200,
    response: fiscalYearListSchema,
  }),
  close: defineRoute({
    method: 'POST',
    path: '/fiscal-years/close',
    summary: 'Post the closing entry of a year and close the books up to its last day',
    auth: 'bearer',
    permission: 'accounting.period.close',
    status: 200,
    body: fiscalYearInputSchema,
    response: fiscalYearSchema,
  }),
  reopen: defineRoute({
    method: 'POST',
    path: '/fiscal-years/reopen',
    summary: 'Reverse the closing entry of the latest closed year and open its books again',
    auth: 'bearer',
    permission: 'accounting.period.close',
    status: 200,
    body: fiscalYearInputSchema,
    response: fiscalYearSchema,
  }),
};

// ---------------------------------------------------------------------------------------------
// Exports: the worker writes a report as an Excel or PDF file, and the bell says when it is ready.

export const EXPORT_FORMATS = ['xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: string): value is ExportFormat {
  return EXPORT_FORMATS.some((format) => format === value);
}

export const EXPORT_STATUSES = ['pending', 'ready', 'failed'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

// The report and its query, exactly as the report page asked for it. The worker parses the query
// with the same schema again when it runs.
export const reportExportInputSchema = z.discriminatedUnion('report', [
  z.object({
    report: z.literal('trial_balance'),
    format: z.enum(EXPORT_FORMATS),
    query: trialBalanceQuerySchema,
  }),
  z.object({
    report: z.literal('profit_and_loss'),
    format: z.enum(EXPORT_FORMATS),
    query: profitAndLossQuerySchema,
  }),
  z.object({
    report: z.literal('balance_sheet'),
    format: z.enum(EXPORT_FORMATS),
    query: balanceSheetQuerySchema,
  }),
]);
export type ReportExportInput = z.infer<typeof reportExportInputSchema>;

export const reportExportSchema = z.object({
  id: z.uuid(),
  // z.string(), not enums: a newer server's new report must not break an older offline client.
  // The app narrows them with isReportKind() and isExportFormat().
  report: z.string(),
  format: z.string(),
  // The query's dates and ids, for the list ("1 Jul 2026 – 30 Sep 2026")
  query: z.record(z.string(), z.string()),
  status: z.enum(EXPORT_STATUSES),
  fileName: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ReportExport = z.infer<typeof reportExportSchema>;

export const reportExportPageSchema = pageOf(reportExportSchema);

export const reportExportRoutes = {
  create: defineRoute({
    method: 'POST',
    path: '/report-exports',
    summary: 'Ask the worker to write a report as an Excel or PDF file',
    auth: 'bearer',
    permission: 'accounting.report.read',
    status: 201,
    body: reportExportInputSchema,
    response: reportExportSchema,
  }),
  // Only your own: an export is a copy of the books made for one person
  list: defineRoute({
    method: 'GET',
    path: '/report-exports',
    summary: "The signed-in user's exports, newest first",
    auth: 'bearer',
    permission: 'accounting.report.read',
    status: 200,
    query: pageQuerySchema,
    response: reportExportPageSchema,
  }),
  download: defineRoute({
    method: 'GET',
    path: '/report-exports/:id/download',
    summary: 'A short-lived URL to download a finished export',
    auth: 'bearer',
    permission: 'accounting.report.read',
    status: 200,
    params: z.object({ id: z.uuid() }),
    // The same short-lived link as an attachment's download
    response: signedUrlSchema,
  }),
};
```

Why it is written this way, block by block:

- **`fiscalYearOf()` reads the parts of the string.** `new Date('2026-07-01')` is midnight UTC, which west of
  Greenwich is still 30 June — the wrong fiscal year. The same rule as `periodOf()` in `numbering.ts`. The end
  is "the day before the next year starts" (`shiftIsoDate(…, -1)`), so a March year ends on 28 or 29 February
  without a table of month lengths.
- **`fiscalYearLabel()` reuses `periodOf()`.** The year page says "FY 2025-26" and the closing entry's number
  says `JV-2025-26-0005`: one name for one year, from one function.
- **The query schemas refine on the object.** `from` after `to` is reported under `to` (where the form shows
  it), not as a general error. Zod 4's `.refine()`/`.superRefine()` keep the `ZodObject` type, which the
  contract's `query` slot needs (`RouteDef.query: z.ZodObject`).
- **`compareFrom`/`compareTo` are dates, not a mode.** The app turns "Last year" into dates (it knows the
  presets); the server only runs the query twice. A new comparison in the app never needs a new API.
- **`branchId` only on the profit and loss** (decision 10).
- **`trialBalanceRowSchema.opening`/`closing` are signed** (debit − credit), like step 10's ledger: the page
  shows "Dr"/"Cr" and never guesses what plus means for a liability. Debit and credit are what moved.
- **`reportRowSchema.amount` has the type's natural sign.** A report is read in the type's own direction:
  income positive, expenses positive. `naturalAmount()` does the flip once, from `NORMAL_BALANCE` (step 9).
- **`profitNotClosed`** is the line that makes an unclosed balance sheet balance: income minus expenses that no
  closing entry has moved yet. After a close it is zero at the year end.
- **`reportSection()` lives in contracts** so the API and the MSW mock build the sections with the same code —
  the mock cannot drift. It needs only `zod`-free arithmetic from `money.ts` (the `contracts-only-zod`
  boundary). Depth-first, a group row is pushed before its children but its sum is known after them, hence the
  `own` list. **A group shows when anything under it moved**, even if it nets to zero (+100 and −100) — hiding
  it would hide two real rows. The section's top group is not a row: its sum is the total.
- **`addMoney(x, '0')`** turns "1200" into "1200.0000": every amount leaves with 4 places, like Postgres sends
  NUMERIC(19,4), so two answers compare as strings.
- **`fiscalYearSchema.drafts`** lets the page say "1 draft dated in this year" before the person clicks Close.
- **`reportExportInputSchema` is a discriminated union on `report`.** Each report's query is checked with its
  own schema (a balance sheet export without `asOf` is a 400 under `query.asOf`).
- **`reportExportSchema.report` and `.format` are `z.string()`** — the rule from error codes: a newer server's
  new report must not break an older offline client. `isReportKind()`/`isExportFormat()` narrow them.
- **The download reuses `signedUrlSchema`** from `attachments.ts`: the same short-lived link shape.

**File: `packages/contracts/src/journal.ts`** (change)

```diff
@@ -14,7 +14,9 @@ export type JournalStatus = (typeof JOURNAL_STATUSES)[number];
 // Where an entry comes from. Each later module that posts (sales invoice, bill, stock receipt)
 // adds its own source here. The response sends it as z.string() — like an account's purpose — so a
 // newer server's new source does not break an older offline client.
-export const JOURNAL_SOURCES = ['manual', 'opening_balance', 'reversal'] as const;
+// year_close: the closing entry of a fiscal year (step 11), which moves income and expenses into
+// retained earnings. The profit and loss leaves it out, or every closed year would show zero profit.
+export const JOURNAL_SOURCES = ['manual', 'opening_balance', 'reversal', 'year_close'] as const;
 export type JournalSource = (typeof JOURNAL_SOURCES)[number];
 
 export function isJournalSource(value: string): value is JournalSource {
```

The new source needs no migration: `source` is a text column whose enum lives only in TypeScript (step 10).

**File: `packages/contracts/src/errors.ts`** (change)

```diff
@@ -89,6 +89,19 @@ export const ERROR_CODES = [
   'opening_account_twice',
   'period_lock_future',
   'base_currency_locked',
+  'journal_is_year_close',
+  // reports and year-end close
+  'report_range_invalid',
+  'report_compare_incomplete',
+  'year_end_invalid',
+  'year_not_ended',
+  'year_already_closed',
+  'year_not_closed',
+  'year_has_drafts',
+  'year_nothing_to_close',
+  'year_earlier_open',
+  'year_later_closed',
+  'export_not_ready',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

Twelve codes. `en.ts` and `bn.ts` must have a text for each (`satisfies Record<ErrorCode, string>`), so a
missing translation does not compile.

**File: `packages/contracts/src/permissions.ts`** (change)

```diff
@@ -14,6 +14,7 @@ export const PERMISSION_KEYS = [
   'accounting.journal.create',
   'accounting.journal.post',
   'accounting.period.close',
+  'accounting.report.read',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -42,4 +43,5 @@ export const PERMISSION_GROUP_OF = {
   'accounting.journal.create': 'accounting',
   'accounting.journal.post': 'accounting',
   'accounting.period.close': 'accounting',
+  'accounting.report.read': 'accounting',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

In the `accounting` group of the permission matrix. Owners get it at once (an owner's permissions are the whole
catalog, step 7).

**File: `packages/contracts/src/audit.ts`** (change)

```diff
@@ -41,6 +41,8 @@ export const AUDIT_ACTIONS = [
   'journal.reversed',
   'journal.opening_balances_saved',
   'books.lock_date_changed',
+  'books.year_closed',
+  'books.year_reopened',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
```

**File: `packages/contracts/src/notifications.ts`** (change)

```diff
@@ -5,10 +5,13 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 
 // Every kind of in-app notification. The server stores the type and a few values (params), never a
 // sentence: the app turns them into text in the reader's language (notifications.types.* in en.ts).
+// report.ready / report.failed: params { report, format } — the export the person asked for
 export const NOTIFICATION_TYPES = [
   'workspace.ready',
   'member.joined',
   'invitation.failed',
+  'report.ready',
+  'report.failed',
 ] as const;
 export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
```

The params are keys (`trial_balance`, `xlsx`), never words: the bell puts the words in, in the reader's language.

**File: `packages/contracts/src/routes.ts`** (change)

```diff
@@ -12,6 +12,7 @@ import { memberRoutes } from './members.js';
 import { notificationRoutes } from './notifications.js';
 import { numberSeriesRoutes } from './numbering.js';
 import { meRoutes } from './preferences.js';
+import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js';
 import { roleRoutes } from './roles.js';
 import { settingsRoutes } from './settings.js';
 import { setupRoutes } from './setup.js';
@@ -48,4 +49,7 @@ export const routes = {
   ledger: ledgerRoutes,
   openingBalances: openingBalanceRoutes,
   periodLock: periodLockRoutes,
+  reports: reportRoutes,
+  fiscalYears: fiscalYearRoutes,
+  reportExports: reportExportRoutes,
 };
```

**File: `packages/contracts/src/index.ts`** (change)

```diff
@@ -15,6 +15,7 @@ export * from './numbering.js';
 export * from './pagination.js';
 export * from './permissions.js';
 export * from './preferences.js';
+export * from './reports.js';
 export * from './roles.js';
 export * from './routes.js';
 export * from './settings.js';
```

**File: `packages/contracts/src/reports.spec.ts`** (new)

```ts
import { describe, expect, it } from 'vitest';

import {
  fiscalYearLabel,
  fiscalYearOf,
  naturalAmount,
  profitAndLossQuerySchema,
  type ReportAccount,
  reportExportInputSchema,
  reportSection,
  trialBalanceQuerySchema,
} from './reports.js';

describe('fiscal years', () => {
  it('finds the July–June year of a date on either side of the new year', () => {
    expect(fiscalYearOf('2026-09-23', 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
    expect(fiscalYearOf('2027-06-30', 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
    expect(fiscalYearOf('2026-07-01', 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
  });

  it('ends a calendar year on 31 December, and a March year on the last day of February', () => {
    expect(fiscalYearOf('2026-05-10', 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    // 2028 is a leap year
    expect(fiscalYearOf('2027-04-01', 3)).toEqual({ start: '2027-03-01', end: '2028-02-29' });
  });

  it('labels a year the way the journal numbers do', () => {
    expect(fiscalYearLabel('2025-07-01', 7)).toBe('2025-26');
    expect(fiscalYearLabel('2026-01-01', 1)).toBe('2026');
  });
});

describe('report queries', () => {
  it('refuses a range that ends before it starts, under To', () => {
    const result = trialBalanceQuerySchema.safeParse({ from: '2026-09-30', to: '2026-09-01' });
    expect(result.error?.issues[0]).toMatchObject({
      path: ['to'],
      message: 'report_range_invalid',
    });
  });

  it('needs both comparison dates or neither', () => {
    const half = profitAndLossQuerySchema.safeParse({
      from: '2026-07-01',
      to: '2026-09-30',
      compareFrom: '2025-07-01',
    });
    expect(half.error?.issues[0]?.message).toBe('report_compare_incomplete');
    expect(
      profitAndLossQuerySchema.safeParse({
        from: '2026-07-01',
        to: '2026-09-30',
        compareFrom: '2025-07-01',
        compareTo: '2025-09-30',
      }).success,
    ).toBe(true);
  });

  it('checks an export query with the schema of its own report', () => {
    const result = reportExportInputSchema.safeParse({
      report: 'balance_sheet',
      format: 'pdf',
      query: { from: '2026-07-01', to: '2026-09-30' },
    });
    expect(result.error?.issues[0]?.path).toEqual(['query', 'asOf']);
  });
});

describe('a report section', () => {
  const id = (n: number) => `01939d1c-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const accounts: ReportAccount[] = [
    { id: id(1), parentId: null, code: '4000', name: 'Income', type: 'income', isGroup: true },
    { id: id(2), parentId: id(1), code: '4100', name: 'Revenue', type: 'income', isGroup: true },
    {
      id: id(3),
      parentId: id(2),
      code: '4120',
      name: 'Local sales',
      type: 'income',
      isGroup: false,
    },
    {
      id: id(4),
      parentId: id(2),
      code: '4110',
      name: 'Export sales',
      type: 'income',
      isGroup: false,
    },
    {
      id: id(5),
      parentId: id(1),
      code: '4200',
      name: 'Other income',
      type: 'income',
      isGroup: true,
    },
    { id: id(6), parentId: id(5), code: '4210', name: 'Interest', type: 'income', isGroup: false },
    { id: id(7), parentId: null, code: '5000', name: 'Expenses', type: 'expense', isGroup: true },
  ];

  it('orders rows as a tree by code, sums groups, and leaves out what never moved', () => {
    const section = reportSection(
      'income',
      accounts,
      new Map([
        [id(3), '250000'],
        [id(4), '1200000.5'],
      ]),
      null,
    );
    expect(section.rows.map((row) => [row.code, row.depth, row.amount])).toEqual([
      ['4100', 0, '1450000.5000'],
      ['4110', 1, '1200000.5000'],
      ['4120', 1, '250000.0000'],
    ]);
    expect(section.total).toBe('1450000.5000');
    expect(section.compareTotal).toBeNull();
  });

  it('keeps a group that nets to zero, and a row that only moved in the comparison', () => {
    const section = reportSection(
      'income',
      accounts,
      new Map([
        [id(3), '100'],
        [id(4), '-100'],
      ]),
      new Map([[id(6), '75']]),
    );
    expect(section.rows.map((row) => [row.code, row.amount, row.compareAmount])).toEqual([
      ['4100', '0.0000', '0.0000'],
      ['4110', '-100.0000', '0.0000'],
      ['4120', '100.0000', '0.0000'],
      ['4200', '0.0000', '75.0000'],
      ['4210', '0.0000', '75.0000'],
    ]);
    expect(section.compareTotal).toBe('75.0000');
  });

  it('is empty with zero totals when nothing moved', () => {
    expect(reportSection('expense', accounts, new Map(), new Map())).toEqual({
      type: 'expense',
      rows: [],
      total: '0.0000',
      compareTotal: '0.0000',
    });
  });

  it('turns a signed balance into the natural sign of the type', () => {
    expect(naturalAmount('income', '-1200.0000')).toBe('1200.0000');
    expect(naturalAmount('expense', '300.0000')).toBe('300.0000');
    expect(naturalAmount('liability', '50.0000')).toBe('-50.0000');
  });
});
```

The fiscal-year tests cover both sides of the new year and a leap February. The section tests pin the three
rules of `reportSection()`: code order (4110 before 4120 even when the chart lists 4120 first), a group that
nets to zero still shows, and a row that only moved in the comparison still shows.

---

## 11.2 — `packages/db`: one table and two migrations

**File: `packages/db/src/schema/report-exports.ts`** (new)

```ts
import { EXPORT_FORMATS, EXPORT_STATUSES, REPORT_KINDS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// A report written to a file by the worker (step 11): one row per click on "Export". The file
// itself is in S3/MinIO; this row says what was asked for, whose it is and where the file is.
// No baseColumns: a row is written by the API, finished by the worker, and never edited after.
export const reportExports = pgTable(
  'report_exports',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Only this person sees and downloads it: an export is a copy of the books made for them
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    report: text('report', { enum: REPORT_KINDS }).notNull(),
    format: text('format', { enum: EXPORT_FORMATS }).notNull(),
    // The report's query as the page sent it (dates, branch). The worker parses it again with the
    // report's schema, so a row changed by hand cannot feed the report anything else.
    query: jsonb('query').$type<Record<string, string>>().notNull(),
    status: text('status', { enum: EXPORT_STATUSES }).notNull().default('pending'),
    // Set by the worker when the file is in storage
    fileName: text('file_name'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    storageKey: text('storage_key'),
    createdAt: baseColumns().createdAt,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // "My exports", newest first: id is UUIDv7, so its order is the order they were asked for
    index('report_exports_tenant_user_idx').on(table.tenantId, table.requestedBy, table.id),
    // A ready export always says where its file is, so a download never meets a half-made row
    check(
      'report_exports_ready_check',
      sql`${table.status} <> 'ready' OR (${table.fileName} IS NOT NULL AND ${table.contentType} IS NOT NULL AND ${table.sizeBytes} IS NOT NULL AND ${table.storageKey} IS NOT NULL AND ${table.finishedAt} IS NOT NULL)`,
    ),
  ],
);
```

- **No `baseColumns()`**: a row is written by the API, finished by the worker, and never edited by a person; a
  `version` or `updated_by` would mean nothing.
- **`requested_by`**: the list and the download filter on it (decision 13).
- **`query` is the query as the page sent it.** The worker parses it again with the report's own schema, so a
  row changed by hand cannot feed a report anything the page could not.
- **The check constraint** makes "ready" mean "the file is there": a download never meets a ready row without a
  storage key. The worker writes the five columns in the same `UPDATE` that sets `ready`.
- **The index `(tenant_id, requested_by, id)`** is the list's: one person's rows, newest first (UUIDv7 ids are
  in time order).

**File: `packages/db/src/schema/index.ts`** (change)

```diff
@@ -19,3 +19,4 @@ export * from './outbox-events.js';
 export * from './notifications.js';
 export * from './ledger-accounts.js';
 export * from './journal.js';
+export * from './report-exports.js';
```

**File: `packages/db/src/schema/outbox-events.ts`** (change)

```diff
@@ -12,6 +12,7 @@ export const OUTBOX_EVENT_TYPES = [
   'invitation.issued',
   'member.joined',
   'workspace.chart_requested',
+  'report.export_requested',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
```

**File: `packages/db/src/permission-catalog.ts`** (change)

```diff
@@ -18,7 +18,10 @@ const DESCRIPTIONS = {
   'accounting.journal.read': 'View journal entries, ledgers and opening balances',
   'accounting.journal.create': 'Write, edit and delete draft journal entries',
   'accounting.journal.post': 'Post and reverse journal entries, and set the opening balances',
-  'accounting.period.close': 'Close the books up to a date, and open them again',
+  'accounting.period.close':
+    'Close the books up to a date, close and reopen fiscal years, and open the books again',
+  'accounting.report.read':
+    'View the trial balance, profit and loss and balance sheet, and export them to Excel or PDF',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

The description is what `psql` and Drizzle Studio show; the app shows the text from `en.ts`/`bn.ts`.

### Migration 0017 (generated, nothing to move)

```bash
pnpm db:generate --name reports
```

**File: `packages/db/migrations/0017_reports.sql`**

```sql
CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"report" text NOT NULL,
	"format" text NOT NULL,
	"query" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_name" text,
	"content_type" text,
	"size_bytes" integer,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "report_exports_ready_check" CHECK ("report_exports"."status" <> 'ready' OR ("report_exports"."file_name" IS NOT NULL AND "report_exports"."content_type" IS NOT NULL AND "report_exports"."size_bytes" IS NOT NULL AND "report_exports"."storage_key" IS NOT NULL AND "report_exports"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_exports_tenant_user_idx" ON "report_exports" USING btree ("tenant_id","requested_by","id");
```

Unlike steps 9 and 10, no line needs moving: the two FKs point at `tenants` and `users`, whose keys exist
already.

### Migration 0018 (custom): RLS

```bash
pnpm db:generate --custom --name reports-rls
```

**File: `packages/db/migrations/0018_reports-rls.sql`**

```sql
-- Custom SQL migration file, put your code below! --

-- The new tenant table: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002). The
-- worker reads and finishes an export as omnivo_app inside the export's tenant, like every job,
-- so no grant to omnivo_worker is needed: that role stays limited to the outbox (0012).
ALTER TABLE report_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_exports
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

`ENABLE` + `FORCE` + the policy with `NULLIF` (step 2's lesson about the empty setting). The worker finishes an
export as `omnivo_app` inside the export's tenant — like every job since step 8 — so `omnivo_worker` gets no
grant: that role stays limited to the outbox. The RLS coverage test (`rls-coverage.tenant-leak.int.spec.ts`)
finds the new table by its `tenant_id` column without any change.

---

## 11.3 — The API: storage for the worker too

The worker writes the export files, so it needs S3. Until now `StorageService` read the API's whole `Config`
(auth secrets included), which the worker must not hold. It now takes only the storage settings.

**File: `apps/api/src/config.ts`** (change)

```diff
@@ -9,13 +9,10 @@ const sharedEnvSchema = z.object({
   APP_ORIGIN: z.url(),
 });
 
-// process.env-এর সব মান string | undefined — এখানে একবার যাচাই করে টাইপ-নিরাপদ Config বানানো
-const envSchema = sharedEnvSchema.extend({
-  PORT: z.coerce.number().int().positive().default(3000),
-  API_BASE_URL: z.url(),
-  BETTER_AUTH_SECRET: z.string().min(32),
-  JWT_SECRET: z.string().min(32),
-  // S3-এর মতো storage: dev-এ MinIO (docker-compose), production-এ Cloudflare R2 (system-design §৩.৭)
+// S3-এর মতো storage: dev-এ MinIO (docker-compose), production-এ Cloudflare R2 (system-design §৩.৭).
+// Both processes use it from step 11: the API for uploads and downloads, the worker to store the
+// report files it writes.
+const storageEnvSchema = z.object({
   S3_ENDPOINT: z.url(),
   S3_REGION: z.string().default('us-east-1'),
   S3_BUCKET: z.string().min(3).default('omnivo'),
@@ -23,7 +20,15 @@ const envSchema = sharedEnvSchema.extend({
   S3_SECRET_ACCESS_KEY: z.string().min(1),
 });
 
-const workerEnvSchema = sharedEnvSchema.extend({
+// process.env-এর সব মান string | undefined — এখানে একবার যাচাই করে টাইপ-নিরাপদ Config বানানো
+const envSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
+  PORT: z.coerce.number().int().positive().default(3000),
+  API_BASE_URL: z.url(),
+  BETTER_AUTH_SECRET: z.string().min(32),
+  JWT_SECRET: z.string().min(32),
+});
+
+const workerEnvSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
   // The relay's own database role (omnivo_worker): it may read every tenant's outbox rows, and
   // nothing else. The jobs themselves use DATABASE_URL (omnivo_app) with a tenant context.
   WORKER_DATABASE_URL: z.url(),
@@ -35,6 +40,21 @@ const workerEnvSchema = sharedEnvSchema.extend({
 
 const DAY = 24 * 60 * 60;
 
+function storageConfig(e: z.output<typeof storageEnvSchema> & { NODE_ENV: string }) {
+  return {
+    endpoint: e.S3_ENDPOINT,
+    region: e.S3_REGION,
+    bucket: e.S3_BUCKET,
+    accessKeyId: e.S3_ACCESS_KEY_ID,
+    secretAccessKey: e.S3_SECRET_ACCESS_KEY,
+    // dev আর test-এ bucket না থাকলে API নিজে বানায়; production-এ bucket IaC-র কাজ (ধাপ ২৫),
+    // সেখানে API-র bucket বানানোর অধিকারই থাকবে না
+    createBucket: e.NODE_ENV !== 'production',
+  };
+}
+
+export type StorageConfig = ReturnType<typeof storageConfig>;
+
 function parseEnv<S extends z.ZodType>(schema: S, env: Record<string, string | undefined>) {
   const parsed = schema.safeParse(env);
   if (!parsed.success) {
@@ -57,16 +77,7 @@ export function loadConfig(env: Record<string, string | undefined>) {
     appOrigin: e.APP_ORIGIN,
     // localhost-এ http, তাই dev-এ Secure cookie বন্ধ; production-এ বাধ্যতামূলক
     secureCookies: e.NODE_ENV === 'production',
-    storage: {
-      endpoint: e.S3_ENDPOINT,
-      region: e.S3_REGION,
-      bucket: e.S3_BUCKET,
-      accessKeyId: e.S3_ACCESS_KEY_ID,
-      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
-      // dev আর test-এ bucket না থাকলে API নিজে বানায়; production-এ bucket IaC-র কাজ (ধাপ ২৫),
-      // সেখানে API-র bucket বানানোর অধিকারই থাকবে না
-      createBucket: e.NODE_ENV !== 'production',
-    },
+    storage: storageConfig(e),
     auth: {
       betterAuthSecret: e.BETTER_AUTH_SECRET,
       baseURL: e.API_BASE_URL,
@@ -95,6 +106,8 @@ export function loadWorkerConfig(env: Record<string, string | undefined>) {
       url: e.SMTP_URL,
       from: e.MAIL_FROM,
     },
+    // The report exports (step 11) go to the same bucket as the uploads
+    storage: storageConfig(e),
     relay: {
       // How long the relay sleeps when it found nothing to publish. One second keeps an invitation
       // email about a second behind the click, for one cheap index read per second.
```

- **`storageEnvSchema` is shared** by both env schemas (`.extend(storageEnvSchema.shape)`), and
  `storageConfig()` builds the same object for both: one place says what the storage settings are.
- **`StorageConfig`** is the type `StorageService` now asks for.
- No new `.env` line: the API already required these five; the worker now reads them from the same `.env`.

**File: `apps/api/src/infra/tokens.ts`** (change)

```diff
@@ -6,6 +6,8 @@ export const WITH_TENANT = Symbol('WITH_TENANT');
 export const WITH_USER = Symbol('WITH_USER');
 export const REDIS = Symbol('REDIS');
 export const AUTH = Symbol('AUTH');
+// Only the storage part of the config: the worker has it too, without the API's auth secrets
+export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');
 
 // The worker's second database pool, as omnivo_worker: only the outbox relay and its cleanup use it
 export const RELAY_DB = Symbol('RELAY_DB');
```

**File: `apps/api/src/infra/infra.module.ts`** (change)

```diff
@@ -13,7 +13,7 @@ import { createWithTenant } from '../common/tenant/with-tenant.js';
 import { createWithUser } from '../common/tenant/with-user.js';
 import type { Config } from '../config.js';
 import { StorageService } from '../storage/storage.service.js';
-import { AUTH, CONFIG, DB, REDIS, WITH_TENANT, WITH_USER } from './tokens.js';
+import { AUTH, CONFIG, DB, REDIS, STORAGE_CONFIG, WITH_TENANT, WITH_USER } from './tokens.js';
 
 function createRedis(url: string): Redis {
   const redis = new Redis(url, {
@@ -50,6 +50,7 @@ export class InfraModule implements OnApplicationShutdown {
         { provide: WITH_USER, inject: [DB], useFactory: (db: Db) => createWithUser(db) },
         { provide: REDIS, useFactory: () => createRedis(config.redisUrl) },
         { provide: AUTH, inject: [DB], useFactory: (db: Db) => createAuth({ db, ...config.auth }) },
+        { provide: STORAGE_CONFIG, useValue: config.storage },
         StorageService,
       ],
       exports: [CONFIG, DB, WITH_TENANT, WITH_USER, REDIS, AUTH, StorageService],
```

**File: `apps/api/src/storage/storage.service.ts`** (change)

```diff
@@ -1,4 +1,5 @@
 import {
+  BucketAlreadyOwnedByYou,
   CreateBucketCommand,
   DeleteObjectCommand,
   GetObjectCommand,
@@ -11,8 +12,8 @@ import {
 import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
 import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
 
-import type { Config } from '../config.js';
-import { CONFIG } from '../infra/tokens.js';
+import type { StorageConfig } from '../config.js';
+import { STORAGE_CONFIG } from '../infra/tokens.js';
 
 export interface SignedUrl {
   url: string;
@@ -29,8 +30,7 @@ export class StorageService implements OnApplicationBootstrap {
   private readonly client: S3Client;
   private readonly bucket: string;
 
-  constructor(@Inject(CONFIG) private readonly config: Config) {
-    const storage = config.storage;
+  constructor(@Inject(STORAGE_CONFIG) private readonly storage: StorageConfig) {
     this.bucket = storage.bucket;
     this.client = new S3Client({
       endpoint: storage.endpoint,
@@ -49,7 +49,7 @@ export class StorageService implements OnApplicationBootstrap {
   // শুধু dev/test: `pnpm db:up`-এর পরে বাড়তি কোনো ধাপ ছাড়াই আপলোড চলে। storage বন্ধ থাকলে API
   // তবু চালু হয় (Redis-এর মতো) — শুধু আপলোড ব্যর্থ হবে, লগে কারণ
   async onApplicationBootstrap(): Promise<void> {
-    if (!this.config.storage.createBucket) return;
+    if (!this.storage.createBucket) return;
     try {
       await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
     } catch (error) {
@@ -57,8 +57,14 @@ export class StorageService implements OnApplicationBootstrap {
         this.logger.warn(`Can't reach storage (${String(error)}). Start it with pnpm db:up.`);
         return;
       }
-      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
-      this.logger.log(`Created bucket ${this.bucket}`);
+      try {
+        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
+        this.logger.log(`Created bucket ${this.bucket}`);
+      } catch (createError) {
+        // From step 11 the worker checks the bucket too. Started together on an empty MinIO, both
+        // see "not found" and both create it; the second one is told it already owns it — done.
+        if (!(createError instanceof BucketAlreadyOwnedByYou)) throw createError;
+      }
     }
   }
 
@@ -77,12 +83,21 @@ export class StorageService implements OnApplicationBootstrap {
   // পড়ার ঠিকানা এক ঘণ্টার "জানালায়" একই থাকে: সই করার সময় ঘণ্টার শুরুতে বাঁধা, মেয়াদ দুই ঘণ্টা।
   // প্রতিবার নতুন সময়ে সই করলে প্রতিটা request-এ URL বদলাত, আর ব্রাউজার একই লোগো বারবার নামাত —
   // এখন ঘণ্টাজুড়ে একই URL, তাই ব্রাউজারের cache কাজে লাগে। মেয়াদের অন্তত এক ঘণ্টা সবসময় বাকি থাকে
-  async downloadUrl(key: string, contentType: string): Promise<SignedUrl> {
+  // fileName: download it under this name instead of showing it in the tab (a report export).
+  // filename= is the plain fallback; filename*= (RFC 6266) carries any character for browsers.
+  async downloadUrl(key: string, contentType: string, fileName?: string): Promise<SignedUrl> {
     const signingDate = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
     const url = await getSignedUrl(
       this.client,
       // ResponseContentType: storage যা-ই ভাবুক, ব্রাউজার ফাইলটাকে ঠিক এই ধরন হিসেবে পায়
-      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentType: contentType }),
+      new GetObjectCommand({
+        Bucket: this.bucket,
+        Key: key,
+        ResponseContentType: contentType,
+        ...(fileName !== undefined && {
+          ResponseContentDisposition: `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
+        }),
+      }),
       { expiresIn: 2 * 60 * 60, signingDate },
     );
     return { url, expiresAt: new Date(signingDate.getTime() + 2 * HOUR_MS) };
@@ -99,6 +114,14 @@ export class StorageService implements OnApplicationBootstrap {
     }
   }
 
+  // A file the server made itself (a report export from the worker). The same key twice replaces
+  // the file, so a job that runs again after a crash writes the same object, not a second one.
+  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
+    await this.client.send(
+      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
+    );
+  }
+
   async delete(key: string): Promise<void> {
     await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
   }
```

- **`@Inject(STORAGE_CONFIG)`** instead of `CONFIG`: the same class works in both processes.
- **`BucketAlreadyOwnedByYou` is not an error any more.** In dev both the API and the worker check the bucket
  when they start. On an empty MinIO (`pnpm db:up` on a new machine) both see "not found" and both create it;
  checked: of two `CreateBucket` calls at once, one is refused with exactly this error. Without the `catch`, the
  loser would stop its whole process at start.
- **`downloadUrl(…, fileName)`** adds `Content-Disposition: attachment`, so the browser saves the file under its
  name instead of opening it. `filename=` is the plain fallback (anything outside `[\w.-]` becomes `_`);
  `filename*=UTF-8''…` (RFC 6266) carries any character. The export names are ASCII anyway.
- **`put()`** stores a file the server made. The key is fixed per export, so a job that runs twice writes the
  same object again instead of a second one.

**File: `apps/api/src/testing/app.ts`** (change)

```diff
@@ -43,12 +43,13 @@ export async function createTestApp(config: Config): Promise<NestFastifyApplicat
 // The worker's config, checked like production's, but fast: the relay looks every 50 ms and a
 // failed job gives up after 2 quick tries, so a test waits well under a second for either. With
 // no mailUrl the SMTP address is dead (port 1): every send fails at once, which is how the tests
-// see "Email not sent".
+// see "Email not sent". No storageUrl: the same dead address, for tests that write no files.
 export function testWorkerConfig(urls: {
   databaseUrl: string;
   workerDatabaseUrl: string;
   redisUrl: string;
   mailUrl?: string;
+  storageUrl?: string;
 }): WorkerConfig {
   const config = loadWorkerConfig({
     NODE_ENV: 'test',
@@ -57,6 +58,9 @@ export function testWorkerConfig(urls: {
     REDIS_URL: urls.redisUrl,
     APP_ORIGIN: 'http://localhost:5173',
     SMTP_URL: urls.mailUrl ?? 'smtp://127.0.0.1:1',
+    S3_ENDPOINT: urls.storageUrl ?? 'http://127.0.0.1:1',
+    S3_ACCESS_KEY_ID: 'omnivo',
+    S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
   });
   return {
     ...config,
```

Without `storageUrl` the worker's storage points at a dead address, like the SMTP default: test files that write
no file need no MinIO container.

---

## 11.4 — The API: the journal's part

**File: `apps/api/src/journal/period-lock.service.ts`** (change)

```diff
@@ -5,7 +5,7 @@ import { eq, sql } from 'drizzle-orm';
 
 import { audit, diff } from '../common/audit/audit.js';
 import { AppError, versionConflict } from '../common/http/app-error.js';
-import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
+import { getTenantId, tenantStorage } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 
@@ -18,7 +18,7 @@ function lockKey(): string {
   return `period_lock:${getTenantId()}`;
 }
 
-async function readLock(tx: Transaction) {
+export async function readLock(tx: Transaction) {
   const [row] = await tx
     .select({ lockDate: periodLocks.lockDate, version: periodLocks.version })
     .from(periodLocks)
@@ -26,6 +26,42 @@ async function readLock(tx: Transaction) {
   return row;
 }
 
+// The exclusive side of the lock above: the lock date's own page, and the year-end close and
+// reopen (step 11), which post an entry and move the lock date in one transaction. Taking it
+// exclusive first matters there: a transaction that already holds the shared lock and then asks
+// for the exclusive one would wait for every other posting, and two of them would deadlock.
+export async function lockBooks(tx: Transaction): Promise<void> {
+  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey()}, 0))`);
+}
+
+// Writes the lock date and logs it. The caller holds lockBooks(), so the insert cannot race.
+export async function writeLockDate(
+  tx: Transaction,
+  before: { lockDate: string | null; version: number } | undefined,
+  lockDate: string | null,
+): Promise<PeriodLock> {
+  const tenantId = getTenantId();
+  const userId = tenantStorage.getStore()?.principal?.userId ?? null;
+  const [row] = before
+    ? await tx
+        .update(periodLocks)
+        .set({ lockDate, version: sql`${periodLocks.version} + 1`, updatedBy: userId })
+        .where(eq(periodLocks.tenantId, tenantId))
+        .returning({ lockDate: periodLocks.lockDate, version: periodLocks.version })
+    : await tx
+        .insert(periodLocks)
+        .values({ tenantId, lockDate, updatedBy: userId })
+        .returning({ lockDate: periodLocks.lockDate, version: periodLocks.version });
+  if (!row) throw new Error('Period lock write returned no row');
+  await audit(tx, {
+    action: 'books.lock_date_changed',
+    entityType: 'workspace',
+    entityId: tenantId,
+    changes: diff({ lockDate: before?.lockDate ?? null }, { lockDate: row.lockDate }),
+  });
+  return row;
+}
+
 // For every posting and reversal (PostingService). Dates are ISO strings, so `<=` on them is the
 // order of the days.
 export async function assertPeriodOpen(tx: Transaction, date: string): Promise<void> {
@@ -52,7 +88,7 @@ export class PeriodLockService {
   update(input: PeriodLockInput): Promise<PeriodLock> {
     const tenantId = getTenantId();
     return this.withTenant(async (tx) => {
-      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey()}, 0))`);
+      await lockBooks(tx);
       const before = await readLock(tx);
       if ((before?.version ?? 0) !== input.version) throw versionConflict();
 
@@ -71,31 +107,7 @@ export class PeriodLockService {
         }
       }
 
-      const userId = currentPrincipal().userId;
-      // The exclusive advisory lock above serialises every change, so the insert cannot race
-      const [row] = before
-        ? await tx
-            .update(periodLocks)
-            .set({
-              lockDate: input.lockDate,
-              version: sql`${periodLocks.version} + 1`,
-              updatedBy: userId,
-            })
-            .where(eq(periodLocks.tenantId, tenantId))
-            .returning({ lockDate: periodLocks.lockDate, version: periodLocks.version })
-        : await tx
-            .insert(periodLocks)
-            .values({ tenantId, lockDate: input.lockDate, updatedBy: userId })
-            .returning({ lockDate: periodLocks.lockDate, version: periodLocks.version });
-      if (!row) throw new Error('Period lock write returned no row');
-
-      await audit(tx, {
-        action: 'books.lock_date_changed',
-        entityType: 'workspace',
-        entityId: tenantId,
-        changes: diff({ lockDate: before?.lockDate ?? null }, { lockDate: row.lockDate }),
-      });
-      return row;
+      return writeLockDate(tx, before, input.lockDate);
     });
   }
 }
```

- **`lockBooks()`** is the exclusive side of step 10's advisory lock, now a function the year-end close calls.
  The comment says why the close takes it **first**: a transaction that holds the shared lock (any posting
  takes it) and then asks for the exclusive one waits for every other posting — and two such transactions wait
  for each other forever. Taking the exclusive lock first, the close's own posting then asks for the shared
  one, which Postgres grants at once (a backend never conflicts with itself).
- **`writeLockDate()`** is the write and the audit row of step 10's `update()`, moved out unchanged so the close
  and the reopen move the lock date the same way (and log it the same way). `tenantStorage…?.principal` instead
  of `currentPrincipal()`: the same value inside a request, and it does not throw if a job ever calls it.

**File: `apps/api/src/journal/posting.service.ts`** (change)

```diff
@@ -171,7 +171,11 @@ export class PostingService {
         `The debits (${debits}) and credits (${credits}) must be equal.`,
       );
     }
-    await this.checkLines(tx, lines, { allowArchived: entry.source === 'reversal' });
+    // A reversal undoes old work, and a year-end close empties every income and expense account
+    // that holds a balance: both must reach an account that was archived since
+    await this.checkLines(tx, lines, {
+      allowArchived: entry.source === 'reversal' || entry.source === 'year_close',
+    });
 
     // In the same transaction: if anything after this fails, the number goes back (step 6)
     const number = await this.numbering.next(tx, 'accounting.journal', entry.date);
```

An income account archived during the year still holds the year's income. The closing entry must empty it, or
the year cannot close. Archiving hides an account from new work; it does not take its balance away. (A test
archives one and closes its year — and fails if this line is undone.)

**File: `apps/api/src/journal/journal.service.ts`** (change)

```diff
@@ -176,6 +176,15 @@ export class JournalService {
           // Reversing a reversal would put the mistake back. Post a new, correct entry instead.
           throw new AppError(409, 'journal_is_reversal', 'A reversal cannot be reversed.');
         }
+        if (entry.source === 'year_close') {
+          // A closing entry is undone by reopening its year (FiscalYearsService.reopen), which
+          // also moves the lock date and dates the reversal on the year's last day
+          throw new AppError(
+            409,
+            'journal_is_year_close',
+            'A closing entry is undone by reopening its year.',
+          );
+        }
         if (entry.version !== input.version) throw versionConflict();
         const [already] = await tx
           .select({ id: reversal.id })
```

Decision 8. The journal's Reverse would date the reversal today and leave the lock date where it is; the year
would look closed with its income back in this year. Reopen does both parts correctly.

---

## 11.5 — The API: the reports module

**File: `apps/api/src/reports/report-queries.ts`** (new)

```ts
import {
  ACCOUNT_TYPES,
  type AccountType,
  type BalanceSheet,
  type BalanceSheetQuery,
  compareCodes,
  isNegativeMoney,
  isZeroMoney,
  naturalAmount,
  type ProfitAndLoss,
  type ProfitAndLossQuery,
  type ReportAccount,
  reportSection,
  subtractMoney,
  sumMoney,
  type TrialBalance,
  type TrialBalanceQuery,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// The three reports, in plain SQL (build plan, step 11): a report is one GROUP BY over the posted
// lines, and SQL says that more clearly than a query builder. Each function takes the caller's
// transaction, so the API (a request) and the worker (an export job) run exactly the same queries.
//
// Two rules hold for every query here:
// - Only posted entries. A draft is not in the books.
// - Amounts come back as text, rounded to 4 places (NUMERIC(19,4)), never as a JavaScript number.
//   Dates come back as text too: the driver would turn a `date` into a Date at midnight UTC.

// Raw rows are data from outside TypeScript's view: checked with a schema, never cast
async function select<S extends z.ZodType>(
  tx: Transaction,
  query: SQL,
  row: S,
): Promise<z.output<S>[]> {
  return z.array(row).parse(await tx.execute(query));
}

// The join every report starts from: posted lines of this tenant with their entry and account.
// The tenant is named in the query even though RLS also filters by it, like every other query in
// the API: two locks on one door.
function postedLines(tenantId: string): SQL {
  return sql`
    FROM journal_lines l
    JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
    JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
    WHERE l.tenant_id = ${tenantId}::uuid AND e.status = 'posted'`;
}

// A closing entry (and the reversal that reopened its year) is not income or expense of the year:
// it only moves the year's profit into retained earnings. The profit and loss leaves both out —
// with them, every closed year would show a profit of zero.
function withoutClosingEntries(): SQL {
  return sql`
    AND e.source <> 'year_close'
    AND NOT EXISTS (
      SELECT 1 FROM journal_entries o
       WHERE o.tenant_id = e.tenant_id AND o.id = e.reversal_of_id AND o.source = 'year_close'
    )`;
}

// debit − credit of the lines that match `filter`, rounded like the column: "0.0000" when none do
function signedSum(filter: SQL): SQL {
  return sql`round(coalesce(sum(l.debit - l.credit) FILTER (WHERE ${filter}), 0), 4)::text`;
}

// Every account of the chart, groups included: the sections need the tree to sum the groups
async function loadAccounts(tx: Transaction): Promise<ReportAccount[]> {
  const rows = await select(
    tx,
    sql`SELECT id::text, parent_id::text, code, name, type, is_group
          FROM ledger_accounts WHERE tenant_id = ${getTenantId()}::uuid`,
    z.object({
      id: z.uuid(),
      parent_id: z.uuid().nullable(),
      code: z.string(),
      name: z.string(),
      type: z.enum(ACCOUNT_TYPES),
      is_group: z.boolean(),
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    code: row.code,
    name: row.name,
    type: row.type,
    isGroup: row.is_group,
  }));
}

// A signed balance split into the debit and credit columns of a totals row
function sides(values: readonly string[]): { debit: string; credit: string } {
  return {
    debit: sumMoney(values.filter((value) => !isNegativeMoney(value))),
    credit: sumMoney(values.filter(isNegativeMoney).map((value) => subtractMoney('0', value))),
  };
}

export async function trialBalance(
  tx: Transaction,
  query: TrialBalanceQuery,
): Promise<TrialBalance> {
  const rows = await select(
    tx,
    sql`SELECT a.id::text AS account_id, a.code, a.name, a.type,
               ${signedSum(sql`e.date < ${query.from}::date`)} AS opening,
               round(coalesce(sum(l.debit) FILTER (WHERE e.date >= ${query.from}::date), 0), 4)::text AS debit,
               round(coalesce(sum(l.credit) FILTER (WHERE e.date >= ${query.from}::date), 0), 4)::text AS credit,
               ${signedSum(sql`true`)} AS closing
        ${postedLines(getTenantId())}
          AND e.date <= ${query.to}::date
        GROUP BY a.id, a.code, a.name, a.type`,
    z.object({
      account_id: z.uuid(),
      code: z.string(),
      name: z.string(),
      type: z.enum(ACCOUNT_TYPES),
      opening: z.string(),
      debit: z.string(),
      credit: z.string(),
      closing: z.string(),
    }),
  );
  // An account whose lines cancel out before the range and that did not move inside it has
  // nothing to say: zero in all four columns
  const items = rows
    .filter((row) => [row.opening, row.debit, row.credit, row.closing].some((v) => !isZeroMoney(v)))
    .map((row) => ({
      accountId: row.account_id,
      code: row.code,
      name: row.name,
      type: row.type,
      opening: row.opening,
      debit: row.debit,
      credit: row.credit,
      closing: row.closing,
    }))
    .sort((a, b) => compareCodes(a.code, b.code));
  const opening = sides(items.map((row) => row.opening));
  const closing = sides(items.map((row) => row.closing));
  return {
    rows: items,
    totals: {
      openingDebit: opening.debit,
      openingCredit: opening.credit,
      debit: sumMoney(items.map((row) => row.debit)),
      credit: sumMoney(items.map((row) => row.credit)),
      closingDebit: closing.debit,
      closingCredit: closing.credit,
    },
  };
}

// account id → amount in the type's natural sign, for one column
type Amounts = Map<string, string>;

const balanceRowSchema = z.object({
  account_id: z.uuid(),
  type: z.enum(ACCOUNT_TYPES),
  current: z.string(),
  compare: z.string(),
});

function columns(
  rows: readonly z.output<typeof balanceRowSchema>[],
  withCompare: boolean,
): { current: Amounts; compare: Amounts | null } {
  const current: Amounts = new Map();
  const compare: Amounts = new Map();
  for (const row of rows) {
    current.set(row.account_id, naturalAmount(row.type, row.current));
    compare.set(row.account_id, naturalAmount(row.type, row.compare));
  }
  return { current, compare: withCompare ? compare : null };
}

export async function profitAndLoss(
  tx: Transaction,
  query: ProfitAndLossQuery,
): Promise<ProfitAndLoss> {
  const inRange = sql`e.date BETWEEN ${query.from}::date AND ${query.to}::date`;
  const inCompare =
    query.compareFrom !== undefined && query.compareTo !== undefined
      ? sql`e.date BETWEEN ${query.compareFrom}::date AND ${query.compareTo}::date`
      : sql`false`;
  const rows = await select(
    tx,
    sql`SELECT l.account_id::text AS account_id, a.type,
               ${signedSum(inRange)} AS current, ${signedSum(inCompare)} AS compare
        ${postedLines(getTenantId())}
          AND a.type IN ('income', 'expense')
          AND (${inRange} OR ${inCompare})
          ${withoutClosingEntries()}
          ${query.branchId === undefined ? sql`` : sql`AND l.branch_id = ${query.branchId}::uuid`}
        GROUP BY l.account_id, a.type`,
    balanceRowSchema,
  );
  const accounts = await loadAccounts(tx);
  const { current, compare } = columns(rows, query.compareFrom !== undefined);
  const income = reportSection('income', accounts, current, compare);
  const expense = reportSection('expense', accounts, current, compare);
  return {
    income,
    expense,
    netProfit: subtractMoney(income.total, expense.total),
    compareNetProfit:
      income.compareTotal === null || expense.compareTotal === null
        ? null
        : subtractMoney(income.compareTotal, expense.compareTotal),
  };
}

// Income and expenses that no closing entry has emptied yet, up to a day: the profit not closed
// into retained earnings. Read in the natural sign of income (a profit is positive).
function profitOf(
  rows: readonly z.output<typeof balanceRowSchema>[],
  column: 'current' | 'compare',
) {
  return naturalAmount(
    'income',
    sumMoney(
      rows
        .filter((row) => row.type === 'income' || row.type === 'expense')
        .map((row) => row[column]),
    ),
  );
}

export async function balanceSheet(
  tx: Transaction,
  query: BalanceSheetQuery,
): Promise<BalanceSheet> {
  const compareAsOf = query.compareAsOf ?? null;
  const rows = await select(
    tx,
    sql`SELECT l.account_id::text AS account_id, a.type,
               ${signedSum(sql`e.date <= ${query.asOf}::date`)} AS current,
               ${signedSum(compareAsOf === null ? sql`false` : sql`e.date <= ${compareAsOf}::date`)} AS compare
        ${postedLines(getTenantId())}
          AND e.date <= greatest(${query.asOf}::date, ${compareAsOf}::date)
        GROUP BY l.account_id, a.type`,
    balanceRowSchema,
  );
  const accounts = await loadAccounts(tx);
  const sheetRows = rows.filter((row) => !['income', 'expense'].includes(row.type));
  const { current, compare } = columns(sheetRows, compareAsOf !== null);
  const asset = reportSection('asset', accounts, current, compare);
  const liability = reportSection('liability', accounts, current, compare);
  const equity = reportSection('equity', accounts, current, compare);
  const profitNotClosed = profitOf(rows, 'current');
  const compareProfit = compareAsOf === null ? null : profitOf(rows, 'compare');
  return {
    asset,
    liability,
    equity,
    profitNotClosed,
    compareProfitNotClosed: compareProfit,
    liabilitiesAndEquity: sumMoney([liability.total, equity.total, profitNotClosed]),
    compareLiabilitiesAndEquity:
      compareProfit === null || liability.compareTotal === null || equity.compareTotal === null
        ? null
        : sumMoney([liability.compareTotal, equity.compareTotal, compareProfit]),
  };
}

// The signed balance (debit − credit) of every income and expense account up to and including a
// day, closing entries included: what a closing entry dated that day has to empty
export async function profitAndLossBalances(
  tx: Transaction,
  upTo: string,
): Promise<{ accountId: string; type: AccountType; balance: string }[]> {
  const rows = await select(
    tx,
    sql`SELECT l.account_id::text AS account_id, a.type, ${signedSum(sql`true`)} AS balance
        ${postedLines(getTenantId())}
          AND a.type IN ('income', 'expense')
          AND e.date <= ${upTo}::date
        GROUP BY l.account_id, a.type, a.code
        ORDER BY a.code`,
    z.object({ account_id: z.uuid(), type: z.enum(ACCOUNT_TYPES), balance: z.string() }),
  );
  return rows
    .filter((row) => !isZeroMoney(row.balance))
    .map((row) => ({ accountId: row.account_id, type: row.type, balance: row.balance }));
}

// Income − expenses of each day, without closing entries: the fiscal year list sums its days
export async function dailyProfit(tx: Transaction): Promise<Map<string, string>> {
  const rows = await select(
    tx,
    sql`SELECT e.date::text AS date, ${signedSum(sql`true`)} AS net
        ${postedLines(getTenantId())}
          AND a.type IN ('income', 'expense')
          ${withoutClosingEntries()}
        GROUP BY e.date`,
    z.object({ date: z.iso.date(), net: z.string() }),
  );
  return new Map(rows.map((row) => [row.date, naturalAmount('income', row.net)]));
}
```

- **`select()` parses every row with Zod.** `tx.execute()` returns rows TypeScript knows nothing about; a
  schema checks them instead of a cast (CLAUDE.md rule 3).
- **`::text` on every amount and date.** The postgres driver already returns `numeric` as a string, but it turns
  a `date` into a JavaScript `Date` at midnight UTC — a day early west of Greenwich. Text everywhere is one
  rule to remember.
- **`postedLines()` names the tenant** even though RLS filters by it too, like every other query in the API. It
  also joins the account, for its type.
- **`signedSum()`**: `round(…, 4)` gives "0.0000" for nothing (with `coalesce`) and 4 places otherwise. `FILTER`
  lets one pass over the lines give several columns (opening and closing, this period and the comparison).
- **`trialBalance()`**: everything up to `to` in one query; "opening" is before `from`, "closing" is all of it.
  An account whose lines cancel out and that did not move is left out. The rows are sorted in TypeScript with
  `compareCodes()`, because SQL's text order puts "1-10" before "1-2".
- **`profitAndLoss()`**: one query for both periods (`inRange OR inCompare`), the closing entries left out
  (decision 6), the branch filter when asked.
- **`balanceSheet()`**: the balances of every account up to the day, and income/expenses summed into
  `profitNotClosed`. `greatest(asOf, compareAsOf)` reads up to the later of the two days; `greatest` ignores
  the `NULL` when there is no comparison.
- **`profitAndLossBalances()`** includes closing entries on purpose: it answers "what is still in income and
  expenses", which is what a close must empty.
- **`dailyProfit()`** excludes them: it is the year list's "net profit of the year".

**File: `apps/api/src/reports/reports.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  BalanceSheet,
  BalanceSheetQuery,
  ProfitAndLoss,
  ProfitAndLossQuery,
  TrialBalance,
  TrialBalanceQuery,
} from '@omnivo/contracts';

import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { balanceSheet, profitAndLoss, trialBalance } from './report-queries.js';

// The report pages. The queries live in report-queries.ts, where the worker's export job finds
// them too.
@Injectable()
export class ReportsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  trialBalance(query: TrialBalanceQuery): Promise<TrialBalance> {
    return this.withTenant((tx) => trialBalance(tx, query));
  }

  profitAndLoss(query: ProfitAndLossQuery): Promise<ProfitAndLoss> {
    return this.withTenant((tx) => profitAndLoss(tx, query));
  }

  balanceSheet(query: BalanceSheetQuery): Promise<BalanceSheet> {
    return this.withTenant((tx) => balanceSheet(tx, query));
  }
}
```

**File: `apps/api/src/reports/fiscal-years.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  absMoney,
  type FiscalYear,
  fiscalYearLabel,
  type FiscalYearList,
  fiscalYearOf,
  isNegativeMoney,
  isZeroMoney,
  naturalAmount,
  shiftIsoDate,
  sumMoney,
  todayIn,
} from '@omnivo/contracts';
import { tenantSettings } from '@omnivo/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import {
  assertPeriodOpen,
  lockBooks,
  readLock,
  writeLockDate,
} from '../journal/period-lock.service.js';
import { type LineInput, PostingService } from '../journal/posting.service.js';
import { dailyProfit, profitAndLossBalances } from './report-queries.js';

interface YearSettings {
  startMonth: number;
  timezone: string;
}

const closingEntrySchema = z.object({ id: z.uuid(), number: z.string(), date: z.iso.date() });
type ClosingEntry = z.output<typeof closingEntrySchema>;

async function readSettings(tx: Transaction): Promise<YearSettings> {
  const [row] = await tx
    .select({ startMonth: tenantSettings.fiscalYearStartMonth, timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, getTenantId()));
  if (!row) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
  return row;
}

// The closing entries still in force: posted, and not undone by a reopen. Plain SQL, like the
// reports: one anti-join says it.
async function closingEntries(tx: Transaction): Promise<ClosingEntry[]> {
  const rows = await tx.execute(sql`
    SELECT e.id::text, e.number, e.date::text
      FROM journal_entries e
     WHERE e.tenant_id = ${getTenantId()}::uuid
       AND e.source = 'year_close' AND e.status = 'posted'
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries r
          WHERE r.tenant_id = e.tenant_id AND r.reversal_of_id = e.id)
     ORDER BY e.date`);
  return z.array(closingEntrySchema).parse(rows);
}

// The year that `end` closes, or an error under the field when `end` is not a year's last day
function yearEndingOn(end: string, settings: YearSettings): { start: string; end: string } {
  const year = fiscalYearOf(end, settings.startMonth);
  if (year.end !== end) {
    throw new AppError(409, 'year_end_invalid', `${end} is not the last day of a fiscal year.`, {
      fieldErrors: { end: ['year_end_invalid'] },
    });
  }
  return year;
}

// The lines that empty each income and expense account into retained earnings. A debit balance
// (an expense) is closed with a credit, a credit balance (income) with a debit; the difference —
// the profit or the loss — goes to retained earnings on the side that balances the entry.
function closingLines(
  balances: readonly { accountId: string; balance: string }[],
  retainedEarningsId: string,
): LineInput[] {
  const lines: LineInput[] = balances.map((item) => ({
    accountId: item.accountId,
    branchId: null,
    description: null,
    debit: isNegativeMoney(item.balance) ? absMoney(item.balance) : '0',
    credit: isNegativeMoney(item.balance) ? '0' : item.balance,
  }));
  // Income − expenses: positive = a profit, which retained earnings takes as a credit
  const profit = naturalAmount('income', sumMoney(balances.map((item) => item.balance)));
  if (!isZeroMoney(profit)) {
    lines.push({
      accountId: retainedEarningsId,
      branchId: null,
      description: null,
      debit: isNegativeMoney(profit) ? absMoney(profit) : '0',
      credit: isNegativeMoney(profit) ? '0' : profit,
    });
  }
  return lines;
}

@Injectable()
export class FiscalYearsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly posting: PostingService,
  ) {}

  list(): Promise<FiscalYearList> {
    return this.withTenant(async (tx) => ({
      items: await this.years(tx),
      lockDate: (await readLock(tx))?.lockDate ?? null,
    }));
  }

  close(end: string): Promise<FiscalYear> {
    return this.withTenant(async (tx) => {
      // Exclusive first: nothing posts while the year closes, and the lock date moves at the end
      // of the same transaction (period-lock.service.ts explains why exclusive comes first)
      await lockBooks(tx);
      const settings = await readSettings(tx);
      const year = yearEndingOn(end, settings);
      const label = fiscalYearLabel(year.start, settings.startMonth);

      // The last day must be over: the afternoon's sales would otherwise land in a closed year
      if (end >= todayIn(settings.timezone)) {
        throw new AppError(409, 'year_not_ended', `The year ${label} has not ended yet.`);
      }
      if ((await closingEntries(tx)).some((entry) => entry.date === end)) {
        throw new AppError(409, 'year_already_closed', `The year ${label} is closed already.`);
      }
      const drafts = await this.draftsBetween(tx, year.start, year.end);
      if (drafts > 0) {
        throw new AppError(
          409,
          'year_has_drafts',
          `${String(drafts)} drafts are dated in ${label}.`,
          {
            params: { count: drafts },
          },
        );
      }
      // Years close in order. The day before this year starts, every income and expense account
      // must be empty — closed by the earlier year's closing entry, or never used.
      if ((await profitAndLossBalances(tx, shiftIsoDate(year.start, -1))).length > 0) {
        throw new AppError(409, 'year_earlier_open', 'Close the earlier fiscal year first.');
      }
      // A clear answer when the lock date already covers the year, before anything is computed
      await assertPeriodOpen(tx, end);

      const balances = await profitAndLossBalances(tx, end);
      if (balances.length === 0) {
        throw new AppError(409, 'year_nothing_to_close', `Nothing moved in ${label}.`);
      }
      const [retained] = z.array(z.object({ id: z.uuid() })).parse(
        await tx.execute(
          sql`SELECT id::text FROM ledger_accounts
                 WHERE tenant_id = ${getTenantId()}::uuid AND purpose = 'retained_earnings'`,
        ),
      );
      // Every template has it, and a purpose account cannot be deleted or archived (step 9)
      if (!retained) throw new Error('The chart has no retained earnings account');

      const entry = await this.posting.postNew(tx, {
        date: end,
        narration: `Year-end close ${label}`,
        source: 'year_close',
        lines: closingLines(balances, retained.id),
      });
      // The whole year is closed now; the lock date was before `end` (assertPeriodOpen above)
      await writeLockDate(tx, await readLock(tx), end);
      await audit(tx, {
        action: 'books.year_closed',
        entityType: 'workspace',
        entityId: getTenantId(),
        changes: created({ year: label, entry: entry.number }),
      });
      return this.year(tx, end);
    });
  }

  reopen(end: string): Promise<FiscalYear> {
    return this.withTenant(async (tx) => {
      await lockBooks(tx);
      const settings = await readSettings(tx);
      const year = yearEndingOn(end, settings);
      const label = fiscalYearLabel(year.start, settings.startMonth);
      const closings = await closingEntries(tx);
      const closing = closings.find((entry) => entry.date === end);
      if (!closing) throw new AppError(409, 'year_not_closed', `The year ${label} is not closed.`);
      // Years reopen backwards: a later year's closing entry already counts this year's profit in
      // retained earnings, so reopening only this one would count it twice
      if (closings.some((entry) => entry.date > end)) {
        throw new AppError(409, 'year_later_closed', 'Reopen the later fiscal year first.');
      }

      // Open the books from the year's first day; the years before it stay closed
      const lock = await readLock(tx);
      if (lock && lock.lockDate !== null && lock.lockDate >= year.start) {
        await writeLockDate(tx, lock, shiftIsoDate(year.start, -1));
      }
      // The reversal is dated on the closing entry's own day, so the year's income and expenses
      // are back exactly where they were, and nothing spills into the next year
      const lines = await tx.execute(sql`
        SELECT account_id::text, branch_id::text, description, debit::text, credit::text
          FROM journal_lines
         WHERE tenant_id = ${getTenantId()}::uuid AND entry_id = ${closing.id}::uuid
         ORDER BY line_no`);
      const reversed = await this.posting.postNew(tx, {
        date: end,
        narration: `Reversal of ${closing.number}`,
        source: 'reversal',
        reversalOfId: closing.id,
        lines: z
          .array(
            z.object({
              account_id: z.uuid(),
              branch_id: z.uuid().nullable(),
              description: z.string().nullable(),
              debit: z.string(),
              credit: z.string(),
            }),
          )
          .parse(lines)
          .map((line) => ({
            accountId: line.account_id,
            branchId: line.branch_id,
            description: line.description,
            debit: line.credit,
            credit: line.debit,
          })),
      });
      await audit(tx, {
        action: 'books.year_reopened',
        entityType: 'workspace',
        entityId: getTenantId(),
        changes: created({ year: label, reversal: reversed.number }),
      });
      return this.year(tx, end);
    });
  }

  private async draftsBetween(tx: Transaction, start: string, end: string): Promise<number> {
    const [row] = z.array(z.object({ count: z.number().int() })).parse(
      await tx.execute(sql`
          SELECT count(*)::int AS count FROM journal_entries
           WHERE tenant_id = ${getTenantId()}::uuid AND status = 'draft'
             AND date BETWEEN ${start}::date AND ${end}::date`),
    );
    return row?.count ?? 0;
  }

  // Newest first, from the current fiscal year (or a later one, if an entry is dated there) back
  // to the year of the oldest entry. A draft counts: an old draft blocks its year's close, so its
  // year must be on the list.
  private async years(tx: Transaction): Promise<FiscalYear[]> {
    const settings = await readSettings(tx);
    const current = fiscalYearOf(todayIn(settings.timezone), settings.startMonth);
    const [range] = z
      .array(z.object({ oldest: z.iso.date().nullable(), newest: z.iso.date().nullable() }))
      .parse(
        await tx.execute(
          sql`SELECT min(date)::text AS oldest, max(date)::text AS newest
                FROM journal_entries WHERE tenant_id = ${getTenantId()}::uuid`,
        ),
      );
    const yearOf = (date: string | null | undefined) =>
      date ? fiscalYearOf(date, settings.startMonth) : current;
    const first = yearOf(range?.oldest);
    const last = yearOf(range?.newest);
    const closings = await closingEntries(tx);
    const profit = await dailyProfit(tx);
    const drafts = new Map(
      z
        .array(z.object({ date: z.iso.date(), count: z.number().int() }))
        .parse(
          await tx.execute(sql`
            SELECT date::text AS date, count(*)::int AS count FROM journal_entries
             WHERE tenant_id = ${getTenantId()}::uuid AND status = 'draft' GROUP BY date`),
        )
        .map((row) => [row.date, row.count]),
    );

    const items: FiscalYear[] = [];
    let start = last.start > current.start ? last.start : current.start;
    const stop = first.start < current.start ? first.start : current.start;
    for (;;) {
      const year = fiscalYearOf(start, settings.startMonth);
      const inYear = (date: string) => date >= year.start && date <= year.end;
      const closing = closings.find((entry) => entry.date === year.end);
      items.push({
        start: year.start,
        end: year.end,
        label: fiscalYearLabel(year.start, settings.startMonth),
        status: closing ? 'closed' : 'open',
        closingEntry: closing ? { id: closing.id, number: closing.number } : null,
        netProfit: sumMoney([...profit].filter(([date]) => inYear(date)).map(([, net]) => net)),
        drafts: [...drafts].filter(([date]) => inYear(date)).reduce((sum, [, n]) => sum + n, 0),
      });
      if (year.start <= stop) break;
      start = shiftIsoDate(year.start, -1);
    }
    return items;
  }

  private async year(tx: Transaction, end: string): Promise<FiscalYear> {
    const found = (await this.years(tx)).find((item) => item.end === end);
    if (!found) throw new Error(`Fiscal year ending ${end} not in the list`);
    return found;
  }
}
```

- **`close()` in order:** lock, settings, "is this a year's last day", "is it over" (today in the company's time
  zone — 1 am in Dhaka is still yesterday in UTC), "already closed", drafts (decision 9), earlier years
  (decision 7), the lock date (`assertPeriodOpen` — a clear `journal_period_locked` before anything is
  computed), the balances, the closing entry, the new lock date, the audit row. All in one transaction: if
  anything fails, nothing is posted and the lock date does not move.
- **`closingLines()`**: a debit balance (an expense) is emptied with a credit, a credit balance (income) with a
  debit. Their sum, read as income, is the profit, which goes to retained earnings as a credit (a loss as a
  debit). The entry balances by construction, and the database checks it again at COMMIT (step 10's trigger).
- **`year_nothing_to_close`** when no income or expense account holds anything: there is no entry to post (an
  entry needs two lines), and "closed" would mean nothing.
- **`reopen()`** moves the lock date **before** posting the reversal, because the reversal is dated inside the
  year and `assertPeriodOpen()` would refuse it otherwise. The new lock date is the day before the year began,
  so earlier years stay closed. The reversal reuses the closing entry's lines with the sides swapped, like
  `JournalService.reverse()`.
- **`years()`** reads everything it needs in four queries and builds the list in TypeScript: years are few (one
  a year), and one query per year would grow with the company's age.

**File: `apps/api/src/reports/report-exports.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { ReportExport, ReportExportInput } from '@omnivo/contracts';
import { reportExports } from '@omnivo/db';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { type SignedUrl, StorageService } from '../storage/storage.service.js';

type ExportRow = typeof reportExports.$inferSelect;

function toReportExport(row: ExportRow): ReportExport {
  return {
    id: row.id,
    report: row.report,
    format: row.format,
    query: row.query,
    status: row.status,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

// The query's set values only: an optional field the page left out is not stored as null
function storedQuery(query: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
}

const cursorSchema = z.tuple([z.uuid()]);

// The API's half of an export: the row and the outbox event. The worker writes the file
// (export.handler.ts) and tells the person through the bell.
@Injectable()
export class ReportExportsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  create(input: ReportExportInput): Promise<ReportExport> {
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .insert(reportExports)
        .values({
          tenantId: getTenantId(),
          requestedBy: currentPrincipal().userId,
          report: input.report,
          format: input.format,
          query: storedQuery(input.query),
        })
        .returning();
      if (!row) throw new Error('Report export insert returned no row');
      // Same transaction: if the row commits, the job is safely queued (step 8's outbox)
      await emit(tx, 'report.export_requested', { exportId: row.id });
      return toReportExport(row);
    });
  }

  list(query: { limit: number; cursor?: string | undefined }) {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(reportExports)
        .where(
          and(
            eq(reportExports.tenantId, getTenantId()),
            eq(reportExports.requestedBy, currentPrincipal().userId),
            after === undefined ? undefined : lt(reportExports.id, after[0]),
          ),
        )
        .orderBy(desc(reportExports.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.id]);
      return { items: page.items.map(toReportExport), nextCursor: page.nextCursor };
    });
  }

  download(id: string): Promise<SignedUrl> {
    return this.withTenant(async (tx) => {
      // Someone else's export is "not found", like another tenant's row
      const [row] = await tx
        .select()
        .from(reportExports)
        .where(
          and(
            eq(reportExports.tenantId, getTenantId()),
            eq(reportExports.id, id),
            eq(reportExports.requestedBy, currentPrincipal().userId),
          ),
        );
      if (!row) throw notFound('Report export');
      // The check constraint makes these four present whenever the status is 'ready'
      if (
        row.status !== 'ready' ||
        row.storageKey === null ||
        row.contentType === null ||
        row.fileName === null
      ) {
        throw new AppError(409, 'export_not_ready', 'The file is not ready yet.');
      }
      return this.storage.downloadUrl(row.storageKey, row.contentType, row.fileName);
    });
  }
}
```

- **`create()`** writes the row and the outbox event in one transaction (step 8): if the row commits, the job is
  safely queued; if it does not, no job runs for a row that does not exist.
- **`storedQuery()`** keeps only the set values: an absent comparison is absent in the stored JSON too.
- **`download()`**: someone else's export is "not found" (decision 13). The four `null` checks are what the
  database's check constraint guarantees; TypeScript cannot know that, so the code says it once more.

**File: `apps/api/src/reports/reports.controller.ts`** (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { FiscalYearsService } from './fiscal-years.service.js';
import { ReportExportsService } from './report-exports.service.js';
import { ReportsService } from './reports.service.js';

type Reports = typeof routes.reports;
type Years = typeof routes.fiscalYears;
type Exports = typeof routes.reportExports;

@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly years: FiscalYearsService,
    private readonly exports: ReportExportsService,
  ) {}

  @Endpoint(routes.reports.trialBalance)
  trialBalance({
    query,
  }: RouteInput<Reports['trialBalance']>): Promise<RouteResponse<Reports['trialBalance']>> {
    return this.reports.trialBalance(query);
  }

  @Endpoint(routes.reports.profitAndLoss)
  profitAndLoss({
    query,
  }: RouteInput<Reports['profitAndLoss']>): Promise<RouteResponse<Reports['profitAndLoss']>> {
    return this.reports.profitAndLoss(query);
  }

  @Endpoint(routes.reports.balanceSheet)
  balanceSheet({
    query,
  }: RouteInput<Reports['balanceSheet']>): Promise<RouteResponse<Reports['balanceSheet']>> {
    return this.reports.balanceSheet(query);
  }

  @Endpoint(routes.fiscalYears.list)
  listYears(): Promise<RouteResponse<Years['list']>> {
    return this.years.list();
  }

  @Endpoint(routes.fiscalYears.close)
  closeYear({ body }: RouteInput<Years['close']>): Promise<RouteResponse<Years['close']>> {
    return this.years.close(body.end);
  }

  @Endpoint(routes.fiscalYears.reopen)
  reopenYear({ body }: RouteInput<Years['reopen']>): Promise<RouteResponse<Years['reopen']>> {
    return this.years.reopen(body.end);
  }

  @Endpoint(routes.reportExports.create)
  createExport({ body }: RouteInput<Exports['create']>): Promise<RouteResponse<Exports['create']>> {
    return this.exports.create(body);
  }

  @Endpoint(routes.reportExports.list)
  listExports({ query }: RouteInput<Exports['list']>): Promise<RouteResponse<Exports['list']>> {
    return this.exports.list(query);
  }

  @Endpoint(routes.reportExports.download)
  async downloadExport({
    params,
  }: RouteInput<Exports['download']>): Promise<RouteResponse<Exports['download']>> {
    const signed = await this.exports.download(params.id);
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }
}
```

**File: `apps/api/src/reports/reports.module.ts`** (new)

```ts
import { Module } from '@nestjs/common';

import { JournalModule } from '../journal/journal.module.js';
import { FiscalYearsService } from './fiscal-years.service.js';
import { ReportExportsService } from './report-exports.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

// The financial statements, the year-end close and the exports. JournalModule gives
// PostingService: the closing entry goes into the books the same way as every other entry.
@Module({
  imports: [JournalModule],
  controllers: [ReportsController],
  providers: [ReportsService, FiscalYearsService, ReportExportsService],
})
export class ReportsModule {}
```

**File: `apps/api/src/app.module.ts`** (change)

```diff
@@ -27,6 +27,7 @@ import { NotificationsModule } from './notifications/notifications.module.js';
 import { NumberingModule } from './numbering/numbering.module.js';
 import { PermissionGuard } from './rbac/permission.guard.js';
 import { RbacModule } from './rbac/rbac.module.js';
+import { ReportsModule } from './reports/reports.module.js';
 import { RolesModule } from './roles/roles.module.js';
 import { SettingsModule } from './settings/settings.module.js';
 import { SetupModule } from './setup/setup.module.js';
@@ -53,6 +54,7 @@ export class AppModule implements NestModule {
         NotificationsModule,
         AccountsModule,
         JournalModule,
+        ReportsModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

---

## 11.6 — The API: the export job in the worker

```bash
pnpm --filter @omnivo/api add write-excel-file@^4.1.1 pdfkit@^0.20.2 @fontsource/geist@^5.3.0 @fontsource/noto-sans-bengali@^5.3.0
pnpm --filter @omnivo/api add -D @types/pdfkit@^0.17.6
```

**File: `apps/api/package.json`** (change, written by the commands above)

```diff
@@ -20,6 +20,7 @@
     "@omnivo/config": "workspace:*",
     "@testcontainers/postgresql": "^12.1.0",
     "@types/node": "^26.6.2",
+    "@types/pdfkit": "^0.17.6",
     "postgres": "^3.4.9",
     "testcontainers": "^12.1.0",
     "typescript": "^6.0.3",
@@ -29,6 +30,8 @@
     "@aws-sdk/client-s3": "^3.1141.0",
     "@aws-sdk/s3-request-presigner": "^3.1141.0",
     "@fastify/cookie": "^11.1.2",
+    "@fontsource/geist": "^5.3.0",
+    "@fontsource/noto-sans-bengali": "^5.3.0",
     "@nestjs/common": "^12.0.4",
     "@nestjs/core": "^12.0.4",
     "@nestjs/platform-fastify": "^12.0.4",
@@ -41,8 +44,10 @@
     "fastify": "5.12.5",
     "ioredis": "^6.0.0",
     "nodemailer": "^10.0.12",
+    "pdfkit": "^0.20.2",
     "reflect-metadata": "^0.2.2",
     "rxjs": "^7.8.2",
+    "write-excel-file": "^4.1.1",
     "zod": "^4.6.5"
   }
 }
```

- **`write-excel-file`, not `exceljs`.** `exceljs` 4.4 (last release December 2024) pulls in an old `uuid` that
  `npm audit` flags, and nine dependencies; `write-excel-file` (maintained in 2026) has one, `fflate`, which
  `pdfkit` uses too. It writes; we never need to read a sheet on the server.
- **`pdfkit`** draws with real fonts and shapes Bangla (fontkit's Indic shaper): checked on conjuncts and vowel
  signs.
- **The fonts are the app's own** (`@fontsource`), so a PDF looks like the app. The `.woff` files are read at
  run time from `node_modules`, so they must be `dependencies`, not `devDependencies`.

**File: `apps/api/src/common/outbox/outbox.ts`** (change)

```diff
@@ -18,6 +18,8 @@ export const outboxPayloadSchemas = {
   'member.joined': z.object({ membershipId: z.uuid(), inviterId: z.uuid().nullable() }),
   // Nothing to carry: the workspace is the event's tenant, and its business type is on its row
   'workspace.chart_requested': z.object({}),
+  // The report_exports row says which report, which dates and for whom
+  'report.export_requested': z.object({ exportId: z.uuid() }),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

An id, never the report: the worker reads the current row (step 8's rule).

**File: `apps/api/src/worker/queues.ts`** (change)

```diff
@@ -18,6 +18,7 @@ const QUEUE_OF = {
   'workspace.setup_requested': 'jobs',
   'member.joined': 'jobs',
   'workspace.chart_requested': 'jobs',
+  'report.export_requested': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
```

The `jobs` queue, not `email`: a slow PDF must not hold up invitation emails.

**File: `apps/api/src/reports/export/format.ts`** (new)

```ts
import type { LanguageCode } from '@omnivo/contracts';

// Numbers and dates inside an exported file, in the language of the person who asked for it.
// The same rules as the app's @omnivo/i18n (format.ts), written again here: that package is for
// the browser (React, i18next), and the server must not load it (the same reason as the emails,
// mail/invitation-email.ts).

// en-IN = lakh/crore grouping (18,42,600.50); bn-BD = the same grouping in Bangla digits
const MONEY = {
  en: new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'negative',
  }),
  bn: new Intl.NumberFormat('bn-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'negative',
  }),
} satisfies Record<LanguageCode, Intl.NumberFormat>;

const DECIMAL = /^-?\d+(\.\d+)?$/;

// Intl formats a decimal string exactly (no trip through a JavaScript number), but its type asks
// for `${number}`, not any string: this guard says which strings are decimals
function isDecimal(value: string): value is `${number}` {
  return DECIMAL.test(value);
}

// "1842600.5000" → "18,42,600.50". No ৳ in every cell: the heading says the currency once.
export function formatAmount(value: string, language: LanguageCode): string {
  return isDecimal(value) ? MONEY[language].format(value) : value;
}

const DAY = {
  en: new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }),
  bn: new Intl.DateTimeFormat('bn-BD', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }),
} satisfies Record<LanguageCode, Intl.DateTimeFormat>;

// "2026-09-23" → "23 Sep 2026" / "২৩ সেপ, ২০২৬". Read as a UTC day and written in UTC, so the
// server's own time zone can never move it.
export function formatIsoDate(iso: string, language: LanguageCode): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (language === 'bn') return DAY.bn.format(date);
  const parts = DAY.en.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}

// When the file was made, on the company's clock: "1 Oct 2026, 14:05"
export function formatMoment(moment: Date, language: LanguageCode, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(language === 'bn' ? 'bn-BD' : 'en-US', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(moment);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  const day =
    language === 'bn' ? `${part('day')} ${part('month')},` : `${part('day')} ${part('month')}`;
  return `${day} ${part('year')}, ${part('hour')}:${part('minute')}`;
}
```

The app's formatting rules (lakh grouping, Bangla digits, "23 Sep 2026") written again for the server, for the
same reason as the emails: `@omnivo/i18n` is React and i18next. `formatAmount()` passes the decimal string to
`Intl` as it is — `Intl.NumberFormat` formats strings exactly, with no trip through a number.

**File: `apps/api/src/reports/export/copy.ts`** (new)

```ts
import type { AccountType, LanguageCode, ReportKind } from '@omnivo/contracts';

// Every word inside an exported file, in both languages side by side. satisfies: a text missing in
// one language does not compile. Common office terms (ledger, balance) stay as people say them,
// like the app's bn.ts.
export interface Copy {
  titles: Record<ReportKind, string>;
  sections: Record<AccountType, string>;
  totalOf: Record<AccountType, string>;
  code: string;
  account: string;
  openingDebit: string;
  openingCredit: string;
  debit: string;
  credit: string;
  closingDebit: string;
  closingCredit: string;
  total: string;
  netProfit: string;
  profitNotClosed: string;
  liabilitiesAndEquity: string;
  range: (from: string, to: string) => string;
  asOf: (date: string) => string;
  branch: (name: string) => string;
  currency: (code: string) => string;
  generated: (moment: string) => string;
  page: (page: string, pages: string) => string;
  // The date column headers of a comparison: "1 Jul 2026 – 30 Sep 2026"
  column: (from: string, to: string) => string;
}

export const COPY = {
  en: {
    titles: {
      trial_balance: 'Trial balance',
      profit_and_loss: 'Profit and loss',
      balance_sheet: 'Balance sheet',
    },
    sections: {
      asset: 'Assets',
      liability: 'Liabilities',
      equity: 'Equity',
      income: 'Income',
      expense: 'Expenses',
    },
    totalOf: {
      asset: 'Total assets',
      liability: 'Total liabilities',
      equity: 'Total equity',
      income: 'Total income',
      expense: 'Total expenses',
    },
    code: 'Code',
    account: 'Account',
    openingDebit: 'Opening Dr',
    openingCredit: 'Opening Cr',
    debit: 'Debit',
    credit: 'Credit',
    closingDebit: 'Closing Dr',
    closingCredit: 'Closing Cr',
    total: 'Total',
    netProfit: 'Net profit',
    profitNotClosed: 'Profit not yet closed into retained earnings',
    liabilitiesAndEquity: 'Total liabilities and equity',
    range: (from, to) => `${from} – ${to}`,
    asOf: (date) => `As at ${date}`,
    branch: (name) => `Branch: ${name}`,
    currency: (code) => `Amounts in ${code}`,
    generated: (moment) => `Made on ${moment}`,
    page: (page, pages) => `Page ${page} of ${pages}`,
    column: (from, to) => `${from} – ${to}`,
  },
  bn: {
    titles: {
      trial_balance: 'ট্রায়াল ব্যালান্স',
      profit_and_loss: 'লাভ-ক্ষতির হিসাব',
      balance_sheet: 'ব্যালান্স শিট',
    },
    sections: {
      asset: 'সম্পদ',
      liability: 'দায়',
      equity: 'মালিকানা স্বত্ব',
      income: 'আয়',
      expense: 'ব্যয়',
    },
    totalOf: {
      asset: 'মোট সম্পদ',
      liability: 'মোট দায়',
      equity: 'মোট মালিকানা স্বত্ব',
      income: 'মোট আয়',
      expense: 'মোট ব্যয়',
    },
    code: 'কোড',
    account: 'অ্যাকাউন্ট',
    openingDebit: 'প্রারম্ভিক ডে.',
    openingCredit: 'প্রারম্ভিক ক্রে.',
    debit: 'ডেবিট',
    credit: 'ক্রেডিট',
    closingDebit: 'সমাপনী ডে.',
    closingCredit: 'সমাপনী ক্রে.',
    total: 'মোট',
    netProfit: 'নিট লাভ',
    profitNotClosed: 'যে লাভ এখনো রিটেইনড আর্নিংসে যায়নি',
    liabilitiesAndEquity: 'মোট দায় ও মালিকানা স্বত্ব',
    range: (from, to) => `${from} – ${to}`,
    asOf: (date) => `${date} তারিখে`,
    branch: (name) => `ব্রাঞ্চ: ${name}`,
    currency: (code) => `অঙ্কগুলো ${code}-এ`,
    generated: (moment) => `তৈরি: ${moment}`,
    page: (page, pages) => `পৃষ্ঠা ${page} / ${pages}`,
    column: (from, to) => `${from} – ${to}`,
  },
} satisfies Record<LanguageCode, Copy>;
```

Both languages side by side, bound to one shape by `satisfies`: a text missing in Bangla does not compile.

**File: `apps/api/src/reports/export/document.ts`** (new)

```ts
import {
  absMoney,
  addMoney,
  type BalanceSheet,
  type BalanceSheetQuery,
  isNegativeMoney,
  isZeroMoney,
  type LanguageCode,
  type ProfitAndLoss,
  type ProfitAndLossQuery,
  type ReportKind,
  type ReportSection,
  type TrialBalance,
  type TrialBalanceQuery,
} from '@omnivo/contracts';

import { COPY, type Copy } from './copy.js';
import { formatIsoDate, formatMoment } from './format.js';

// One report as a plain table: the Excel and the PDF writer both draw this, so the two files
// always hold the same rows in the same order. Amounts stay decimal strings here; each writer
// decides how a cell shows them.

export type DocCell =
  { kind: 'text'; text: string } | { kind: 'money'; amount: string } | { kind: 'empty' };

export interface DocColumn {
  header: string;
  kind: 'text' | 'money';
  // Relative width: characters in Excel, a share of the line in the PDF
  width: number;
}

// heading: a section's name; group: an account group with its sum; total: a section total;
// grand: the line the report is about (net profit, total liabilities and equity)
export type DocRowStyle = 'normal' | 'group' | 'heading' | 'total' | 'grand';

export interface DocRow {
  style: DocRowStyle;
  // Steps to the right in the first text column: a group's children sit under it
  indent: number;
  cells: DocCell[];
}

export interface ReportDocument {
  language: LanguageCode;
  company: string;
  title: string;
  // Under the title: the dates, the branch, the currency, when it was made
  lines: string[];
  // A trial balance has eight columns and needs the page turned
  landscape: boolean;
  columns: DocColumn[];
  rows: DocRow[];
}

export type ReportData =
  | { report: 'trial_balance'; query: TrialBalanceQuery; data: TrialBalance }
  | { report: 'profit_and_loss'; query: ProfitAndLossQuery; data: ProfitAndLoss }
  | { report: 'balance_sheet'; query: BalanceSheetQuery; data: BalanceSheet };

export interface DocumentContext {
  language: LanguageCode;
  company: string;
  currency: string;
  timeZone: string;
  branchName: string | null;
  madeAt: Date;
}

const text = (value: string): DocCell => ({ kind: 'text', text: value });
const money = (amount: string): DocCell => ({ kind: 'money', amount });
const empty: DocCell = { kind: 'empty' };

// "1110 Cash in hand" — one column for the code and the name, as the statements print it
function accountCell(code: string, name: string): DocCell {
  return text(`${code} ${name}`);
}

// A section's rows: the heading, every account and group indented by depth, and the total
function sectionRows(section: ReportSection, copy: Copy, compare: boolean): DocRow[] {
  const amounts = (amount: string, compareAmount: string | null): DocCell[] =>
    compare ? [money(amount), money(compareAmount ?? '0')] : [money(amount)];
  return [
    { style: 'heading', indent: 0, cells: [text(copy.sections[section.type])] },
    ...section.rows.map((row): DocRow => ({
      style: row.isGroup ? 'group' : 'normal',
      indent: row.depth + 1,
      cells: [accountCell(row.code, row.name), ...amounts(row.amount, row.compareAmount)],
    })),
    {
      style: 'total',
      indent: 0,
      cells: [text(copy.totalOf[section.type]), ...amounts(section.total, section.compareTotal)],
    },
  ];
}

function trialBalanceDocument(
  query: TrialBalanceQuery,
  data: TrialBalance,
  copy: Copy,
  language: LanguageCode,
): Pick<ReportDocument, 'columns' | 'rows' | 'landscape' | 'lines'> {
  // What moved in the range; nothing is an empty cell, like on the page
  const moved = (value: string): DocCell => (isZeroMoney(value) ? empty : money(value));
  // A signed balance in its Dr or Cr column, the other one empty
  const split = (value: string): DocCell[] =>
    isZeroMoney(value)
      ? [empty, empty]
      : isNegativeMoney(value)
        ? [empty, money(absMoney(value))]
        : [money(value), empty];
  return {
    landscape: true,
    lines: [copy.range(formatIsoDate(query.from, language), formatIsoDate(query.to, language))],
    columns: [
      { header: copy.code, kind: 'text', width: 10 },
      { header: copy.account, kind: 'text', width: 34 },
      { header: copy.openingDebit, kind: 'money', width: 16 },
      { header: copy.openingCredit, kind: 'money', width: 16 },
      { header: copy.debit, kind: 'money', width: 16 },
      { header: copy.credit, kind: 'money', width: 16 },
      { header: copy.closingDebit, kind: 'money', width: 16 },
      { header: copy.closingCredit, kind: 'money', width: 16 },
    ],
    rows: [
      ...data.rows.map((row): DocRow => ({
        style: 'normal',
        indent: 0,
        cells: [
          text(row.code),
          text(row.name),
          ...split(row.opening),
          moved(row.debit),
          moved(row.credit),
          ...split(row.closing),
        ],
      })),
      {
        style: 'grand',
        indent: 0,
        cells: [
          text(copy.total),
          empty,
          money(data.totals.openingDebit),
          money(data.totals.openingCredit),
          money(data.totals.debit),
          money(data.totals.credit),
          money(data.totals.closingDebit),
          money(data.totals.closingCredit),
        ],
      },
    ],
  };
}

function profitAndLossDocument(
  query: ProfitAndLossQuery,
  data: ProfitAndLoss,
  copy: Copy,
  language: LanguageCode,
  branchName: string | null,
): Pick<ReportDocument, 'columns' | 'rows' | 'landscape' | 'lines'> {
  const date = (iso: string) => formatIsoDate(iso, language);
  const compare =
    query.compareFrom !== undefined && query.compareTo !== undefined
      ? { from: query.compareFrom, to: query.compareTo }
      : null;
  const amountColumns: DocColumn[] = [
    { header: copy.column(date(query.from), date(query.to)), kind: 'money', width: 22 },
    ...(compare
      ? [
          {
            header: copy.column(date(compare.from), date(compare.to)),
            kind: 'money' as const,
            width: 22,
          },
        ]
      : []),
  ];
  return {
    landscape: false,
    lines: [
      copy.range(date(query.from), date(query.to)),
      ...(branchName === null ? [] : [copy.branch(branchName)]),
    ],
    columns: [{ header: copy.account, kind: 'text', width: 46 }, ...amountColumns],
    rows: [
      ...sectionRows(data.income, copy, compare !== null),
      ...sectionRows(data.expense, copy, compare !== null),
      {
        style: 'grand',
        indent: 0,
        cells: [
          text(copy.netProfit),
          money(data.netProfit),
          ...(compare ? [money(data.compareNetProfit ?? '0')] : []),
        ],
      },
    ],
  };
}

function balanceSheetDocument(
  query: BalanceSheetQuery,
  data: BalanceSheet,
  copy: Copy,
  language: LanguageCode,
): Pick<ReportDocument, 'columns' | 'rows' | 'landscape' | 'lines'> {
  const date = (iso: string) => formatIsoDate(iso, language);
  const compare = query.compareAsOf !== undefined;
  const amounts = (amount: string, compareAmount: string | null): DocCell[] =>
    compare ? [money(amount), money(compareAmount ?? '0')] : [money(amount)];
  return {
    landscape: false,
    lines: [copy.asOf(date(query.asOf))],
    columns: [
      { header: copy.account, kind: 'text', width: 46 },
      { header: copy.asOf(date(query.asOf)), kind: 'money', width: 22 },
      ...(query.compareAsOf === undefined
        ? []
        : [{ header: copy.asOf(date(query.compareAsOf)), kind: 'money' as const, width: 22 }]),
    ],
    rows: [
      ...sectionRows(data.asset, copy, compare),
      ...sectionRows(data.liability, copy, compare),
      // Equity, then the profit no year-end close has moved into it yet, inside the equity block
      ...sectionRows(data.equity, copy, compare).slice(0, -1),
      {
        style: 'normal',
        indent: 1,
        cells: [
          text(copy.profitNotClosed),
          ...amounts(data.profitNotClosed, data.compareProfitNotClosed),
        ],
      },
      {
        style: 'total',
        indent: 0,
        cells: [
          text(copy.totalOf.equity),
          ...amounts(
            addMoney(data.equity.total, data.profitNotClosed),
            data.equity.compareTotal === null || data.compareProfitNotClosed === null
              ? null
              : addMoney(data.equity.compareTotal, data.compareProfitNotClosed),
          ),
        ],
      },
      {
        style: 'grand',
        indent: 0,
        cells: [
          text(copy.liabilitiesAndEquity),
          ...amounts(data.liabilitiesAndEquity, data.compareLiabilitiesAndEquity),
        ],
      },
    ],
  };
}

export function buildDocument(report: ReportData, context: DocumentContext): ReportDocument {
  const copy: Copy = COPY[context.language];
  const body =
    report.report === 'trial_balance'
      ? trialBalanceDocument(report.query, report.data, copy, context.language)
      : report.report === 'profit_and_loss'
        ? profitAndLossDocument(
            report.query,
            report.data,
            copy,
            context.language,
            context.branchName,
          )
        : balanceSheetDocument(report.query, report.data, copy, context.language);
  return {
    language: context.language,
    company: context.company,
    title: copy.titles[report.report],
    lines: [
      ...body.lines,
      copy.currency(context.currency),
      copy.generated(formatMoment(context.madeAt, context.language, context.timeZone)),
    ],
    landscape: body.landscape,
    columns: body.columns,
    rows: body.rows,
  };
}

// "trial-balance-2026-07-01-to-2026-09-30": ASCII only, so every browser and mail program keeps
// the name as it is
export function fileStem(report: ReportData): string {
  const name: Record<ReportKind, string> = {
    trial_balance: 'trial-balance',
    profit_and_loss: 'profit-and-loss',
    balance_sheet: 'balance-sheet',
  };
  const dates =
    report.report === 'balance_sheet'
      ? report.query.asOf
      : `${report.query.from}-to-${report.query.to}`;
  return `${name[report.report]}-${dates}`;
}
```

- **One table model for both files.** The Excel and the PDF writer draw the same `ReportDocument`, so the two
  files can never show different rows.
- **Cells keep the decimal string**; each writer decides how to show it.
- **The trial balance gets eight columns** (opening and closing split into Dr and Cr) and a landscape page: in
  Excel, a column of numbers people can add up beats "1,200 Dr" text. What did not move is an empty cell, as on
  the page.
- **The balance sheet's equity** ends with "Profit not yet closed", and the equity total includes it, so the
  last line equals total assets — the same as the page.
- **`fileStem()`** is ASCII only: every browser, mail program and file system keeps the name as it is.

**File: `apps/api/src/reports/export/xlsx.ts`** (new)

```ts
import writeXlsxFile, { type Cell, type CellObject, type Row } from 'write-excel-file/node';

import type { DocCell, DocRow, ReportDocument } from './document.js';

// Excel's own number format with thousands separators. Excel groups the digits the way the
// computer's region says (12,34,567.00 on a Bangladeshi or Indian Windows), so it is not spelled
// out here.
const AMOUNT_FORMAT = '#,##0.00';

// The one place money becomes a JavaScript number, because an Excel cell stores every number as a
// double: that is what lets people add the cells up in Excel. Before writing, the number is turned
// back into a string and compared: if the double cannot hold the amount exactly (beyond about 15
// digits), the cell gets the exact text instead of a rounded number.
function amountCell(amount: string, bold: boolean): CellObject {
  const value = Number(amount);
  const exact = Number.isFinite(value) && value.toFixed(4) === amount;
  return {
    value: exact ? value : amount,
    type: exact ? Number : String,
    format: AMOUNT_FORMAT,
    align: 'right',
    ...(bold && { fontWeight: 'bold' }),
  };
}

const BOLD_STYLES = new Set<DocRow['style']>(['group', 'heading', 'total', 'grand']);

function cellOf(cell: DocCell, row: DocRow, first: boolean): Cell {
  const bold = BOLD_STYLES.has(row.style);
  const lines =
    row.style === 'total' || row.style === 'grand'
      ? { topBorderStyle: 'thin' as const, topBorderColor: '#D0D5DD' }
      : {};
  if (cell.kind === 'money') return { ...amountCell(cell.amount, bold), ...lines };
  if (cell.kind === 'empty') return { value: '', type: String, ...lines };
  return {
    value: cell.text,
    type: String,
    ...(bold && { fontWeight: 'bold' }),
    // Excel's own indent, not spaces: the text stays clean when someone copies the cell
    ...(first && row.indent > 0 && { indent: row.indent }),
    ...lines,
  };
}

export async function writeXlsx(doc: ReportDocument): Promise<Buffer> {
  const width = doc.columns.length;
  // A title line spans every column, so a long company name is not cut at the first one
  const titleRow = (value: string, size: number, bold: boolean): Row => [
    { value, type: String, fontSize: size, columnSpan: width, ...(bold && { fontWeight: 'bold' }) },
  ];
  const header: Row = doc.columns.map((column) => ({
    value: column.header,
    type: String,
    fontWeight: 'bold',
    backgroundColor: '#F1F3F6',
    bottomBorderStyle: 'thin',
    bottomBorderColor: '#D0D5DD',
    align: column.kind === 'money' ? 'right' : 'left',
  }));
  const top: Row[] = [
    titleRow(doc.company, 12, true),
    titleRow(doc.title, 14, true),
    ...doc.lines.map((line) => titleRow(line, 10, false)),
    [],
  ];
  const body: Row[] = doc.rows.map((row) =>
    row.cells.map((cell, index) => cellOf(cell, row, index === 0)),
  );

  return writeXlsxFile([...top, header, ...body], {
    // Sheet names may not hold more than 31 characters or : \ / ? * [ ]
    sheet: doc.title.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31),
    columns: doc.columns.map((column) => ({ width: column.width })),
    // The column headers stay in view while the rows scroll
    stickyRowsCount: top.length + 1,
    ...(doc.landscape && { orientation: 'landscape' }),
  }).toBuffer();
}
```

- **`amountCell()`** is decision 12: a number when the double holds the amount exactly (checked by turning it
  back into a 4-place string), the exact text otherwise. `#,##0.00` lets Excel group the digits the way the
  computer's region says (lakh grouping on a Bangladeshi Windows).
- **Excel's own `indent`**, not spaces, for the tree: copying a cell gives the name without leading blanks.
- **A title line spans every column** (`columnSpan`), so a long company name is not cut at column A.
- **The sheet name** may not hold `: \ / ? * [ ]` or be longer than 31 characters — Excel refuses the file
  otherwise.
- **`stickyRowsCount`** keeps the headers in view while the rows scroll.

**File: `apps/api/src/reports/export/pdf.ts`** (new)

```ts
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

import { COPY } from './copy.js';
import type { DocCell, DocRow, ReportDocument } from './document.js';
import { formatAmount } from './format.js';

// The fonts of the app (CLAUDE.md → Typography): Geist for Latin text and digits, Noto Sans
// Bengali for Bangla and the ৳ sign. A PDF must carry its fonts inside it; these files come from
// the same @fontsource packages the app uses, resolved through node_modules at run time.
const require = createRequire(import.meta.url);
const FONT_FILES = {
  latin: require.resolve('@fontsource/geist/files/geist-latin-400-normal.woff'),
  'latin-bold': require.resolve('@fontsource/geist/files/geist-latin-600-normal.woff'),
  bengali:
    require.resolve('@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-400-normal.woff'),
  'bengali-bold':
    require.resolve('@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-600-normal.woff'),
} as const;

// The design system's colors (CLAUDE.md → Color tokens, light): the PDF is printed on white
const INK = '#0F1728';
const INK_2 = '#475467';
const INK_3 = '#8A94A6';
const LINE = '#E4E7EC';
const LINE_STRONG = '#D0D5DD';
const SUBTLE = '#F1F3F6';

const MARGIN = 40;
const ROW_HEIGHT = 18;
const FONT_SIZE = 8.5;
const INDENT = 10;

type Doc = InstanceType<typeof PDFDocument>;

// pdfkit draws a string with one font, and neither font has every character: Geist has no
// Bangla, the Bangla subset has no Latin letters. So a string is cut into runs, each drawn with
// its own font. U+0980–U+09FF is the Bengali block (৳ is U+09F3); the zero-width joiners stay with
// the Bangla run they shape.
const BENGALI = /[ঀ-৿‌‍]/;

function runs(text: string): { bengali: boolean; text: string }[] {
  const out: { bengali: boolean; text: string }[] = [];
  for (const char of text) {
    const bengali = BENGALI.test(char);
    const last = out.at(-1);
    if (last?.bengali === bengali) last.text += char;
    else out.push({ bengali, text: char });
  }
  return out;
}

function fontOf(bengali: boolean, bold: boolean): keyof typeof FONT_FILES {
  if (bengali) return bold ? 'bengali-bold' : 'bengali';
  return bold ? 'latin-bold' : 'latin';
}

// tnum: Geist's tabular figures, so the digits of a column of amounts line up (CLAUDE.md:
// tabular-nums on every number that lines up)
const NUMBERS: PDFKit.Mixins.OpenTypeFeatures[] = ['tnum'];

function widthOf(doc: Doc, text: string, size: number, bold: boolean): number {
  return runs(text).reduce((sum, run) => {
    doc.font(fontOf(run.bengali, bold)).fontSize(size);
    return sum + doc.widthOfString(run.text, { features: NUMBERS });
  }, 0);
}

// Whole letters as a reader sees them: a Bangla conjunct (ক্ষ) or a vowel sign is one grapheme
// of several code points, and cutting between them would leave a broken shape
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Cut with "…" until it fits: a long account name never runs into the amount next to it
function fit(doc: Doc, text: string, max: number, size: number, bold: boolean): string {
  if (widthOf(doc, text, size, bold) <= max) return text;
  let cut = Array.from(graphemes.segment(text), (part) => part.segment);
  while (cut.length > 0 && widthOf(doc, `${cut.join('')}…`, size, bold) > max) {
    cut = cut.slice(0, -1);
  }
  return `${cut.join('').trimEnd()}…`;
}

// y is the baseline: the two fonts have different heights above it, and lining both up on the
// baseline (not on the top of the line) keeps "৳" level with the digits next to it
function draw(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  options: { size: number; bold: boolean; color: string; align: 'left' | 'right'; width: number },
): void {
  const shown = fit(doc, text, options.width, options.size, options.bold);
  let cursor =
    options.align === 'right'
      ? x + options.width - widthOf(doc, shown, options.size, options.bold)
      : x;
  doc.fillColor(options.color);
  for (const run of runs(shown)) {
    doc.font(fontOf(run.bengali, options.bold)).fontSize(options.size);
    doc.text(run.text, cursor, y, { lineBreak: false, baseline: 'alphabetic', features: NUMBERS });
    cursor += doc.widthOfString(run.text, { features: NUMBERS });
  }
}

function cellText(cell: DocCell, language: ReportDocument['language']): string {
  if (cell.kind === 'money') return formatAmount(cell.amount, language);
  return cell.kind === 'text' ? cell.text : '';
}

const BOLD = new Set<DocRow['style']>(['group', 'heading', 'total', 'grand']);

export function writePdf(doc: ReportDocument): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    layout: doc.landscape ? 'landscape' : 'portrait',
    margin: MARGIN,
    // Every page stays in memory until the end, so the footer can say "Page 1 of 3"
    bufferPages: true,
    info: { Title: `${doc.title} — ${doc.company}`, Creator: 'Omnivo' },
  });
  for (const [name, file] of Object.entries(FONT_FILES)) pdf.registerFont(name, file);

  const chunks: Buffer[] = [];
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    pdf.on('error', reject);
  });

  const left = MARGIN;
  const width = pdf.page.width - 2 * MARGIN;
  const bottom = pdf.page.height - MARGIN - 20;
  const share = doc.columns.reduce((sum, column) => sum + column.width, 0);
  const gap = 8;
  // Each column's x and width, from its share of the line
  const columns = doc.columns.reduce<{ x: number; width: number }[]>((list, column) => {
    const x = list.length === 0 ? left : (list.at(-1)?.x ?? left) + (list.at(-1)?.width ?? 0) + gap;
    return [
      ...list,
      { x, width: (width - gap * (doc.columns.length - 1)) * (column.width / share) },
    ];
  }, []);

  // The heading of the first page: company, title and the lines under it
  let y = MARGIN + 12;
  draw(pdf, doc.company, left, y, { size: 10, bold: true, color: INK_2, align: 'left', width });
  y += 22;
  draw(pdf, doc.title, left, y, { size: 18, bold: true, color: INK, align: 'left', width });
  y += 8;
  for (const line of doc.lines) {
    y += 14;
    draw(pdf, line, left, y, { size: 9, bold: false, color: INK_3, align: 'left', width });
  }
  y += 18;

  // The column headers, again at the top of every page
  const headerRow = () => {
    pdf.rect(left, y, width, ROW_HEIGHT).fill(SUBTLE);
    doc.columns.forEach((column, index) => {
      const place = columns[index];
      if (!place) return;
      draw(pdf, column.header, place.x + (index === 0 ? 6 : 0), y + 12, {
        size: 7.5,
        bold: true,
        color: INK_3,
        align: column.kind === 'money' ? 'right' : 'left',
        width: place.width - (index === 0 ? 6 : 0),
      });
    });
    y += ROW_HEIGHT;
  };
  headerRow();

  for (const row of doc.rows) {
    if (y + ROW_HEIGHT > bottom) {
      pdf.addPage();
      y = MARGIN;
      headerRow();
    }
    const bold = BOLD.has(row.style);
    // A total sits under a stronger rule; every other row under a light one
    if (row.style === 'total' || row.style === 'grand') {
      pdf
        .moveTo(left, y)
        .lineTo(left + width, y)
        .lineWidth(0.75)
        .strokeColor(LINE_STRONG)
        .stroke();
    }
    row.cells.forEach((cell, index) => {
      const place = columns[index];
      const column = doc.columns[index];
      if (!place || !column) return;
      const indent = index === 0 ? 6 + row.indent * INDENT : 0;
      draw(pdf, cellText(cell, doc.language), place.x + indent, y + 12, {
        size: row.style === 'grand' ? 9 : FONT_SIZE,
        bold,
        color: row.style === 'heading' ? INK_3 : INK,
        align: column.kind === 'money' ? 'right' : 'left',
        width: place.width - indent,
      });
    });
    y += ROW_HEIGHT;
    if (row.style !== 'heading') {
      pdf
        .moveTo(left, y)
        .lineTo(left + width, y)
        .lineWidth(0.5)
        .strokeColor(LINE)
        .stroke();
    }
  }

  // "Page 1 of 3" at the foot of every page, now that the number of pages is known
  const range = pdf.bufferedPageRange();
  const copy = COPY[doc.language];
  const digits = new Intl.NumberFormat(doc.language === 'bn' ? 'bn-BD' : 'en-US');
  for (let index = range.start; index < range.start + range.count; index += 1) {
    pdf.switchToPage(index);
    draw(
      pdf,
      copy.page(digits.format(index + 1), digits.format(range.count)),
      left,
      pdf.page.height - MARGIN,
      { size: 7.5, bold: false, color: INK_3, align: 'right', width },
    );
  }
  pdf.end();
  return done;
}
```

- **Runs of one script each.** A PDF draws a string with one font, and neither font has every character: Geist
  has no Bangla, the Bangla subset has no Latin letters. `runs()` cuts a string at every change; the zero-width
  joiners stay with the Bangla they shape.
- **`baseline: 'alphabetic'`.** pdfkit places text by the top of the line by default, and the two fonts have
  different heights above the baseline: "৳" sat higher than the digits next to it (seen on the first render).
  Drawing every run on the same baseline lines them up.
- **`features: ['tnum']`**: Geist's tabular figures, so a column of amounts lines up digit under digit
  (CLAUDE.md asks for tabular numbers everywhere numbers line up).
- **`fit()` cuts by grapheme** (`Intl.Segmenter`). A Bangla conjunct (ক্ষ) or a vowel sign is one letter of
  several code points; cutting between them would leave a broken shape. (The lint rule `no-misused-spread`
  pointed at `[...text]`, which cuts code points.)
- **`bufferPages: true`** keeps every page until the end, so the footer can say "Page 1 of 3".
- **The header row repeats on every page**, so page 3 of a trial balance is still readable alone.

**File: `apps/api/src/reports/export.handler.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  balanceSheetQuerySchema,
  type ExportFormat,
  profitAndLossQuerySchema,
  trialBalanceQuerySchema,
} from '@omnivo/contracts';
import { branches, reportExports, tenants, tenantSettings, users } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';

import { type EventHandler, type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';
import { StorageService } from '../storage/storage.service.js';
import {
  buildDocument,
  type DocumentContext,
  fileStem,
  type ReportData,
} from './export/document.js';
import { writePdf } from './export/pdf.js';
import { writeXlsx } from './export/xlsx.js';
import { balanceSheet, profitAndLoss, trialBalance } from './report-queries.js';

const CONTENT_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} satisfies Record<ExportFormat, string>;

type ExportRow = typeof reportExports.$inferSelect;

// The stored query is parsed again with the report's own schema. A row changed by hand (or by a
// bug) can then not feed a report anything it would not take from the page; running the job
// again cannot fix that, so it fails for good.
function queryOf<S extends z.ZodType>(schema: S, row: ExportRow): z.output<S> {
  const parsed = schema.safeParse(row.query);
  if (!parsed.success) throw new PermanentJobError(`Export ${row.id} has a broken query`);
  return parsed.data;
}

async function reportData(tx: Transaction, row: ExportRow): Promise<ReportData> {
  switch (row.report) {
    case 'trial_balance': {
      const query = queryOf(trialBalanceQuerySchema, row);
      return { report: row.report, query, data: await trialBalance(tx, query) };
    }
    case 'profit_and_loss': {
      const query = queryOf(profitAndLossQuerySchema, row);
      return { report: row.report, query, data: await profitAndLoss(tx, query) };
    }
    case 'balance_sheet': {
      const query = queryOf(balanceSheetQuerySchema, row);
      return { report: row.report, query, data: await balanceSheet(tx, query) };
    }
  }
}

// Writes the file of one report_exports row (step 11). Idempotent like every handler: a finished
// row is left alone, the file's key is fixed by the row's id (a second run overwrites the same
// object), and the notification is keyed by the event.
@Injectable()
export class ReportExportHandler implements EventHandler<'report.export_requested'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  async handle(event: OutboxEvent<'report.export_requested'>): Promise<void> {
    const tenantId = getTenantId();
    // 1) Read everything in one short transaction: the export, the report itself and the words
    //    around it. The file is written and uploaded outside it, so no transaction stays open
    //    while the PDF is drawn or the upload waits on the network.
    const job = await this.withTenant(async (tx) => {
      const [row] = await tx
        .select()
        .from(reportExports)
        .where(
          and(eq(reportExports.tenantId, tenantId), eq(reportExports.id, event.payload.exportId)),
        );
      if (!row) throw new PermanentJobError('The export no longer exists');
      // Done already: this is a second run of the same job
      if (row.status !== 'pending') return null;

      const [context] = await tx
        .select({
          company: tenants.name,
          currency: tenantSettings.baseCurrency,
          timeZone: tenantSettings.timezone,
        })
        .from(tenantSettings)
        .innerJoin(tenants, eq(tenants.id, tenantSettings.tenantId))
        .where(eq(tenantSettings.tenantId, tenantId));
      if (!context) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
      // The file is in the language of the person who asked for it; English until they pick one
      const [user] = await tx
        .select({ language: users.language })
        .from(users)
        .where(eq(users.id, row.requestedBy));
      const report = await reportData(tx, row);
      const branchId = report.report === 'profit_and_loss' ? report.query.branchId : undefined;
      const [branch] =
        branchId === undefined
          ? []
          : await tx
              .select({ name: branches.name })
              .from(branches)
              .where(and(eq(branches.tenantId, tenantId), eq(branches.id, branchId)));
      const documentContext: DocumentContext = {
        language: user?.language ?? 'en',
        company: context.company,
        currency: context.currency,
        timeZone: context.timeZone,
        branchName: branch?.name ?? null,
        madeAt: new Date(),
      };
      return { row, report, documentContext };
    });
    if (!job) return;

    // 2) The file, and into storage under a key that only this export uses
    const { row } = job;
    const doc = buildDocument(job.report, job.documentContext);
    const bytes = row.format === 'xlsx' ? await writeXlsx(doc) : await writePdf(doc);
    const contentType = CONTENT_TYPES[row.format];
    const key = ['tenants', tenantId, 'report-exports', `${row.id}.${row.format}`].join('/');
    await this.storage.put(key, bytes, contentType);

    // 3) Mark it ready and tell the person. `status = 'pending'` in the WHERE: if two runs raced
    //    this far, only one row update (and one notification) happens.
    await this.withTenant(async (tx) => {
      const [done] = await tx
        .update(reportExports)
        .set({
          status: 'ready',
          fileName: `${fileStem(job.report)}.${row.format}`,
          contentType,
          sizeBytes: bytes.byteLength,
          storageKey: key,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(reportExports.tenantId, tenantId),
            eq(reportExports.id, row.id),
            eq(reportExports.status, 'pending'),
          ),
        )
        .returning({ id: reportExports.id });
      if (!done) return;
      await notify(tx, {
        userId: row.requestedBy,
        type: 'report.ready',
        params: { report: row.report, format: row.format },
        eventId: event.id,
      });
    });
  }

  // After the last attempt: the row says "failed" and the person hears it, instead of waiting
  async onGiveUp(event: OutboxEvent<'report.export_requested'>): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [failed] = await tx
        .update(reportExports)
        .set({ status: 'failed', finishedAt: new Date() })
        .where(
          and(
            eq(reportExports.tenantId, tenantId),
            eq(reportExports.id, event.payload.exportId),
            eq(reportExports.status, 'pending'),
          ),
        )
        .returning({
          requestedBy: reportExports.requestedBy,
          report: reportExports.report,
          format: reportExports.format,
        });
      if (!failed) return;
      await notify(tx, {
        userId: failed.requestedBy,
        type: 'report.failed',
        params: { report: failed.report, format: failed.format },
        eventId: event.id,
      });
    });
  }
}
```

- **Three parts.** (1) A short transaction reads the row, the report and the words around it. (2) The file is
  written and uploaded **outside** any transaction: drawing a PDF or waiting on S3 must not keep a database
  connection open. (3) A second short transaction marks it ready and notifies.
- **Idempotent** (step 8's rule for every handler): a finished row is left alone; the storage key is fixed by the
  row's id, so a second run overwrites the same object; `status = 'pending'` in the final `UPDATE`'s `WHERE`
  means only one run marks it and notifies; the notification is keyed by the event.
- **`queryOf()`** parses the stored query again with the report's schema; a broken one is a
  `PermanentJobError` (running it again cannot fix it), which goes straight to `onGiveUp()`.
- **`onGiveUp()`** marks the row failed and tells the person, instead of leaving "Preparing" forever. (Tested
  with a broken row written past the API.)
- **The file's language is the requester's** (`users.language`), English until they pick one.

**File: `apps/api/src/worker/handlers.ts`** (change)

```diff
@@ -4,6 +4,7 @@ import type { OutboxEventType } from '@omnivo/db';
 import type { EventHandler } from '../common/outbox/outbox.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
+import { ReportExportHandler } from '../reports/export.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
@@ -24,6 +25,7 @@ export class EventHandlers {
     invitationEmail: InvitationEmailHandler,
     memberJoined: MemberJoinedHandler,
     chart: ChartHandler,
+    reportExport: ReportExportHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -31,6 +33,7 @@ export class EventHandlers {
       'invitation.issued': invitationEmail,
       'member.joined': memberJoined,
       'workspace.chart_requested': chart,
+      'report.export_requested': reportExport,
     };
   }
```

**File: `apps/api/src/worker/worker.module.ts`** (change)

```diff
@@ -3,21 +3,24 @@ import { createDb, type Db } from '@omnivo/db';
 
 import { createWithTenant } from '../common/tenant/with-tenant.js';
 import type { WorkerConfig } from '../config.js';
-import { CONFIG, DB, RELAY_DB, WITH_TENANT } from '../infra/tokens.js';
+import { CONFIG, DB, RELAY_DB, STORAGE_CONFIG, WITH_TENANT } from '../infra/tokens.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
 import { MailService } from '../mail/mail.service.js';
+import { ReportExportHandler } from '../reports/export.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
+import { StorageService } from '../storage/storage.service.js';
 import { EventHandlers } from './handlers.js';
 import { JobRunner } from './job-runner.js';
 import { OutboxRelay } from './outbox-relay.js';
 import { Queues } from './queues.js';
 
 // The worker process: no HTTP server, no controllers — the relay and the queue workers. It does
-// not import InfraModule: that one brings the API's things (auth, S3 storage, the permission
-// cache) which the worker neither needs nor should hold the secrets for.
+// not import InfraModule: that one brings the API's things (auth, the permission cache) which the
+// worker neither needs nor should hold the secrets for. Storage it does need from step 11, to save
+// the report files it writes — so it gets StorageService alone, with the storage settings only.
 @Module({})
 export class WorkerModule implements OnApplicationShutdown {
   constructor(
@@ -35,6 +38,8 @@ export class WorkerModule implements OnApplicationShutdown {
         // The relay's pool: omnivo_worker. Two connections: one for the relay, one for the cleanup
         { provide: RELAY_DB, useFactory: () => createDb(config.relayDatabaseUrl, { max: 2 }) },
         { provide: WITH_TENANT, inject: [DB], useFactory: (db: Db) => createWithTenant(db) },
+        { provide: STORAGE_CONFIG, useValue: config.storage },
+        StorageService,
         MailService,
         Queues,
         OutboxRelay,
@@ -45,6 +50,7 @@ export class WorkerModule implements OnApplicationShutdown {
         InvitationEmailHandler,
         MemberJoinedHandler,
         ChartHandler,
+        ReportExportHandler,
       ],
     };
   }
```

`StorageService` alone, with `STORAGE_CONFIG`: the worker still does not import `InfraModule` (auth, the
permission cache). Its `onApplicationBootstrap()` creates the dev bucket too — hence the race in 11.3.

**File: `apps/api/src/setup/templates.ts`** (change)

```diff
@@ -41,6 +41,7 @@ const ACCOUNTANT: RoleTemplate = {
     'accounting.journal.create',
     'accounting.journal.post',
     'accounting.period.close',
+    'accounting.report.read',
   ],
 };
```

---

## 11.7 — The API's tests

**File: `apps/api/src/reports/reports.int.spec.ts`** (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  auditPageSchema,
  balanceSheetSchema,
  branchSchema,
  fiscalYearLabel,
  fiscalYearListSchema,
  fiscalYearOf,
  fiscalYearSchema,
  journalEntrySchema,
  ledgerPageSchema,
  memberPageSchema,
  type PermissionKey,
  periodLockSchema,
  problemSchema,
  profitAndLossSchema,
  type ReportSection,
  roleSchema,
  setupSchema,
  shiftIsoDate,
  todayIn,
  trialBalanceSchema,
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
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// Reads the reports and nothing else: a director who wants the numbers, not the journal
let director: SignedIn;
// Reads the journal, but not the reports
let clerk: SignedIn;
let accounts: Account[];
let factory: string;

// Dates from today, so the test never goes stale: last fiscal year is over, this one is not.
// Bangladesh's July–June year, the default of a new workspace.
const today = todayIn('Asia/Dhaka');
const thisYear = fiscalYearOf(today, 7);
const lastYear = fiscalYearOf(shiftIsoDate(thisYear.start, -1), 7);
const yearBefore = fiscalYearOf(shiftIsoDate(lastYear.start, -1), 7);
const lastYearDay = (days: number) => shiftIsoDate(lastYear.start, days);

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

function line(code: string, debit: string, credit: string, branchId: string | null = null) {
  return { accountId: id(code), branchId, description: '', debit, credit };
}

async function post(date: string, lines: object[], narration = 'Test entry') {
  const res = await send('POST', '/journal-entries', { date, narration, lines, post: true });
  expect(res.statusCode).toBe(201);
  return journalEntrySchema.parse(res.json());
}

async function memberWith(
  person: { fullName: string; email: string; password: string; slug: string },
  permissions: PermissionKey[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${person.fullName} Traders`,
    workspaceSlug: person.slug,
    fullName: person.fullName,
    email: person.email,
    password: person.password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'rahman-garments' });
  const role = roleSchema.parse(
    (await send('POST', '/roles', { name: `${person.fullName}'s role`, description: '' })).json(),
  );
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode).toBe(200);
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const member = items.find((item) => item.email === person.email);
  if (!member) throw new Error(`${person.email} is not a member`);
  const roles = await send('PUT', `/members/${member.membershipId}/roles`, {
    roleIds: [role.id],
    version: member.version,
  });
  expect(roles.statusCode).toBe(200);
  return logIn(app, {
    workspace: 'rahman-garments',
    email: person.email,
    password: person.password,
    keepSignedIn: false,
  });
}

async function trialBalance(from: string, to: string) {
  const res = await send('GET', `/reports/trial-balance?from=${from}&to=${to}`);
  expect(res.statusCode).toBe(200);
  return trialBalanceSchema.parse(res.json());
}

async function profitAndLoss(query: string) {
  const res = await send('GET', `/reports/profit-and-loss?${query}`);
  expect(res.statusCode).toBe(200);
  return profitAndLossSchema.parse(res.json());
}

async function balanceSheet(query: string) {
  const res = await send('GET', `/reports/balance-sheet?${query}`);
  expect(res.statusCode).toBe(200);
  return balanceSheetSchema.parse(res.json());
}

const rowsOf = (section: ReportSection) =>
  section.rows.map((row) => [row.code, row.depth, row.amount]);

async function years() {
  return fiscalYearListSchema.parse((await send('GET', '/fiscal-years')).json());
}

async function balanceOf(code: string, to: string): Promise<string> {
  const res = await send('GET', `/accounts/${id(code)}/ledger?to=${to}`);
  return ledgerPageSchema.parse(res.json()).closingBalance;
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
  factory = branchSchema.parse(
    (
      await send('POST', '/branches', {
        code: 'GZP',
        name: 'Gazipur factory',
        phone: '',
        address: '',
      })
    ).json(),
  ).id;

  director = await memberWith(
    {
      fullName: 'Anwar Hossain',
      email: 'anwar@rahmangarments.com',
      password: 'Director-books-2026',
      slug: 'anwar-traders',
    },
    ['accounting.report.read'],
  );
  clerk = await memberWith(
    {
      fullName: 'Nasrin Akter',
      email: 'nasrin@rahmangarments.com',
      password: 'Tongi-store-2026',
      slug: 'nasrin-traders',
    },
    ['accounting.journal.read'],
  );

  // Last fiscal year: capital, two sales and two costs. Profit: 1,450,000 − 485,000 = 965,000.
  await post(lastYearDay(0), [line('1110', '5000000', ''), line('3100', '', '5000000')]);
  await post(lastYearDay(30), [
    line('1180', '1200000', '', factory),
    line('4110', '', '1200000', factory),
  ]);
  await post(lastYearDay(40), [line('1110', '250000', ''), line('4120', '', '250000')]);
  await post(lastYearDay(60), [line('5210', '400000', ''), line('1110', '', '400000')]);
  await post(lastYearDay(61), [line('5220', '85000', ''), line('1110', '', '85000')]);
  // This year so far, on its first day (always on or before today)
  await post(thisYear.start, [line('1180', '300000', ''), line('4110', '', '300000')]);
  await post(thisYear.start, [line('5230', '18450.50', ''), line('1110', '', '18450.50')]);
  // A draft is not in the books: no report may count it
  const draft = await send('POST', '/journal-entries', {
    date: thisYear.start,
    narration: 'LC opening charges, not checked yet',
    lines: [line('5410', '2300', ''), line('1110', '', '2300')],
    post: false,
  });
  expect(draft.statusCode).toBe(201);
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('the trial balance', () => {
  it('shows each account once, and both sides add up to the same totals', async () => {
    const tb = await trialBalance(lastYear.start, lastYear.end);
    const cash = tb.rows.find((row) => row.code === '1110');
    expect(cash).toMatchObject({
      opening: '0.0000',
      debit: '5250000.0000',
      credit: '485000.0000',
      closing: '4765000.0000',
    });
    // A credit balance is negative, like the ledger
    expect(tb.rows.find((row) => row.code === '3100')?.closing).toBe('-5000000.0000');
    expect(tb.rows.map((row) => row.code)).toEqual([
      '1110',
      '1180',
      '3100',
      '4110',
      '4120',
      '5210',
      '5220',
    ]);
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(tb.totals.closingDebit).toBe(tb.totals.closingCredit);
    // 4,765,000 cash + 1,200,000 receivable + 485,000 costs = 5,000,000 capital + 1,450,000 sales
    expect(tb.totals.closingDebit).toBe('6450000.0000');
  });

  it('carries what came before the range in the opening column', async () => {
    const tb = await trialBalance(thisYear.start, today);
    expect(tb.rows.find((row) => row.code === '1110')).toMatchObject({
      opening: '4765000.0000',
      debit: '0.0000',
      credit: '18450.5000',
      closing: '4746549.5000',
    });
    expect(tb.totals.openingDebit).toBe(tb.totals.openingCredit);
    // The draft's bank charges are nowhere
    expect(tb.rows.map((row) => row.code)).not.toContain('5410');
  });

  it('refuses a range that ends before it starts', async () => {
    const res = await send('GET', `/reports/trial-balance?from=${today}&to=${lastYear.start}`);
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({ to: ['report_range_invalid'] });
  });
});

describe('the profit and loss', () => {
  it('sums the groups and leaves out the accounts that did not move', async () => {
    const pl = await profitAndLoss(`from=${lastYear.start}&to=${lastYear.end}`);
    expect(rowsOf(pl.income)).toEqual([
      ['4100', 0, '1450000.0000'],
      ['4110', 1, '1200000.0000'],
      ['4120', 1, '250000.0000'],
    ]);
    expect(rowsOf(pl.expense)).toEqual([
      ['5200', 0, '485000.0000'],
      ['5210', 1, '400000.0000'],
      ['5220', 1, '85000.0000'],
    ]);
    expect(pl.netProfit).toBe('965000.0000');
    expect(pl.compareNetProfit).toBeNull();
  });

  it('puts a second period next to the first', async () => {
    const pl = await profitAndLoss(
      `from=${thisYear.start}&to=${today}&compareFrom=${lastYear.start}&compareTo=${lastYear.end}`,
    );
    expect(pl.netProfit).toBe('281549.5000');
    expect(pl.compareNetProfit).toBe('965000.0000');
    // 4120 only moved last year: it shows, with zero this year
    expect(pl.income.rows.find((row) => row.code === '4120')).toMatchObject({
      amount: '0.0000',
      compareAmount: '250000.0000',
    });
  });

  it("counts only a branch's own lines when one is picked", async () => {
    const pl = await profitAndLoss(`from=${lastYear.start}&to=${lastYear.end}&branchId=${factory}`);
    expect(rowsOf(pl.income)).toEqual([
      ['4100', 0, '1200000.0000'],
      ['4110', 1, '1200000.0000'],
    ]);
    expect(pl.expense.rows).toEqual([]);
    expect(pl.netProfit).toBe('1200000.0000');
  });

  it('needs both comparison dates', async () => {
    const res = await send(
      'GET',
      `/reports/profit-and-loss?from=${thisYear.start}&to=${today}&compareFrom=${lastYear.start}`,
    );
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      compareFrom: ['report_compare_incomplete'],
    });
  });
});

describe('the balance sheet', () => {
  it('balances with the profit that is not closed yet', async () => {
    const bs = await balanceSheet(`asOf=${lastYear.end}`);
    expect(rowsOf(bs.asset)).toEqual([
      ['1100', 0, '5965000.0000'],
      ['1110', 1, '4765000.0000'],
      ['1180', 1, '1200000.0000'],
    ]);
    expect(bs.liability.total).toBe('0.0000');
    expect(rowsOf(bs.equity)).toEqual([['3100', 0, '5000000.0000']]);
    expect(bs.profitNotClosed).toBe('965000.0000');
    expect(bs.liabilitiesAndEquity).toBe(bs.asset.total);
  });

  it('compares two days', async () => {
    const bs = await balanceSheet(`asOf=${today}&compareAsOf=${lastYear.end}`);
    expect(bs.asset.total).toBe('6246549.5000');
    expect(bs.asset.compareTotal).toBe('5965000.0000');
    expect(bs.compareLiabilitiesAndEquity).toBe('5965000.0000');
    expect(bs.liabilitiesAndEquity).toBe(bs.asset.total);
  });
});

describe('who reads the reports', () => {
  it('lets a member with the report permission read them, without the journal', async () => {
    const tb = await send(
      'GET',
      `/reports/trial-balance?from=${lastYear.start}&to=${lastYear.end}`,
      undefined,
      director,
    );
    expect(tb.statusCode).toBe(200);
    expect((await send('GET', '/journal-entries', undefined, director)).statusCode).toBe(403);
    const close = await send('POST', '/fiscal-years/close', { end: lastYear.end }, director);
    expect(close.statusCode).toBe(403);
  });

  it('keeps the reports from a member who only reads the journal', async () => {
    const res = await send('GET', `/reports/balance-sheet?asOf=${today}`, undefined, clerk);
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json()).params).toEqual({
      permissions: 'accounting.report.read',
    });
  });
});

describe('closing a fiscal year', () => {
  it('refuses a year that has not ended, and a day that does not end a year', async () => {
    const open = await send('POST', '/fiscal-years/close', { end: thisYear.end });
    expect(problemSchema.parse(open.json()).code).toBe('year_not_ended');
    const wrong = await send('POST', '/fiscal-years/close', { end: lastYearDay(10) });
    expect(wrong.statusCode).toBe(409);
    expect(problemSchema.parse(wrong.json()).fieldErrors).toEqual({ end: ['year_end_invalid'] });
  });

  it('refuses while a draft is dated in the year', async () => {
    const draft = journalEntrySchema.parse(
      (
        await send('POST', '/journal-entries', {
          date: lastYearDay(100),
          narration: 'LC charges, not checked yet',
          lines: [line('5410', '2300', ''), line('1110', '', '2300')],
          post: false,
        })
      ).json(),
    );
    const res = await send('POST', '/fiscal-years/close', { end: lastYear.end });
    expect(problemSchema.parse(res.json())).toMatchObject({
      code: 'year_has_drafts',
      params: { count: 1 },
    });
    expect(
      (await send('DELETE', `/journal-entries/${draft.id}?version=${String(draft.version)}`))
        .statusCode,
    ).toBe(204);
  });

  it('moves the profit into retained earnings and closes the books up to the last day', async () => {
    const res = await send('POST', '/fiscal-years/close', { end: lastYear.end });
    expect(res.statusCode).toBe(200);
    const year = fiscalYearSchema.parse(res.json());
    expect(year).toMatchObject({ status: 'closed', netProfit: '965000.0000', drafts: 0 });
    expect(year.closingEntry?.number).toMatch(/^JV-\d{4}-\d{2}-\d{4}$/);

    const closing = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${year.closingEntry?.id ?? ''}`)).json(),
    );
    expect(closing).toMatchObject({ source: 'year_close', date: lastYear.end, status: 'posted' });
    // Income and expenses are empty at the year end; the profit sits in retained earnings
    expect(await balanceOf('4110', lastYear.end)).toBe('0.0000');
    expect(await balanceOf('5210', lastYear.end)).toBe('0.0000');
    expect(await balanceOf('3200', lastYear.end)).toBe('-965000.0000');

    const list = await years();
    expect(list.lockDate).toBe(lastYear.end);
    expect(list.items.map((item) => [item.label, item.status])).toEqual([
      [fiscalYearLabel(thisYear.start, 7), 'open'],
      [fiscalYearLabel(lastYear.start, 7), 'closed'],
    ]);
  });

  it('still reports the closed year with its profit, and the balance sheet still balances', async () => {
    const pl = await profitAndLoss(`from=${lastYear.start}&to=${lastYear.end}`);
    expect(pl.netProfit).toBe('965000.0000');
    const bs = await balanceSheet(`asOf=${lastYear.end}`);
    expect(bs.profitNotClosed).toBe('0.0000');
    expect(rowsOf(bs.equity)).toEqual([
      ['3100', 0, '5000000.0000'],
      ['3200', 0, '965000.0000'],
    ]);
    expect(bs.liabilitiesAndEquity).toBe(bs.asset.total);
  });

  it('keeps the closed year shut: no posting into it, no second close, no reversal by hand', async () => {
    const late = await send('POST', '/journal-entries', {
      date: lastYearDay(200),
      narration: 'Forgotten bill',
      lines: [line('5220', '1000', ''), line('1110', '', '1000')],
      post: true,
    });
    expect(problemSchema.parse(late.json()).code).toBe('journal_period_locked');
    const again = await send('POST', '/fiscal-years/close', { end: lastYear.end });
    expect(problemSchema.parse(again.json()).code).toBe('year_already_closed');

    const closingId = (await years()).items[1]?.closingEntry?.id ?? '';
    const closing = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${closingId}`)).json(),
    );
    const reverse = await send('POST', `/journal-entries/${closingId}/reverse`, {
      version: closing.version,
      date: today,
    });
    expect(problemSchema.parse(reverse.json()).code).toBe('journal_is_year_close');
  });

  it('reopens the year: the closing entry is reversed on its own day, and the books open again', async () => {
    const res = await send('POST', '/fiscal-years/reopen', { end: lastYear.end });
    expect(res.statusCode).toBe(200);
    expect(fiscalYearSchema.parse(res.json())).toMatchObject({
      status: 'open',
      closingEntry: null,
      netProfit: '965000.0000',
    });
    expect(await balanceOf('4110', lastYear.end)).toBe('-1200000.0000');
    expect(await balanceOf('3200', lastYear.end)).toBe('0.0000');
    expect((await years()).lockDate).toBe(yearBefore.end);
    // The reversal is not income or expense either: the profit stays the same
    const pl = await profitAndLoss(`from=${lastYear.start}&to=${lastYear.end}`);
    expect(pl.netProfit).toBe('965000.0000');
  });

  it('closes years in order and reopens them backwards', async () => {
    // A cost in the year before, which nobody closed: open the books to post it
    const lock = periodLockSchema.parse((await send('GET', '/period-lock')).json());
    expect(
      (await send('PUT', '/period-lock', { lockDate: '', version: lock.version })).statusCode,
    ).toBe(200);
    await post(shiftIsoDate(yearBefore.end, -5), [
      line('5410', '1500', ''),
      line('2150', '', '1500'),
    ]);
    // Archived since: the closing entry must still empty it (archiving hides an account from new
    // work, it does not take its balance away)
    const bankCharges = accounts.find((account) => account.code === '5410');
    const archive = await send('POST', `/accounts/${id('5410')}/archive`, {
      version: bankCharges?.version ?? 1,
    });
    expect(archive.statusCode).toBe(200);

    const skipped = await send('POST', '/fiscal-years/close', { end: lastYear.end });
    expect(problemSchema.parse(skipped.json()).code).toBe('year_earlier_open');

    const first = await send('POST', '/fiscal-years/close', { end: yearBefore.end });
    expect(fiscalYearSchema.parse(first.json())).toMatchObject({
      status: 'closed',
      netProfit: '-1500.0000',
    });
    expect(await balanceOf('3200', yearBefore.end)).toBe('1500.0000');
    const second = await send('POST', '/fiscal-years/close', { end: lastYear.end });
    expect(fiscalYearSchema.parse(second.json()).status).toBe('closed');
    expect(await balanceOf('3200', lastYear.end)).toBe('-963500.0000');
  });

  it('reopens only the latest closed year', async () => {
    const backwards = await send('POST', '/fiscal-years/reopen', { end: yearBefore.end });
    expect(problemSchema.parse(backwards.json()).code).toBe('year_later_closed');
    const notClosed = await send('POST', '/fiscal-years/reopen', { end: thisYear.end });
    expect(problemSchema.parse(notClosed.json()).code).toBe('year_not_closed');
  });

  it('logs the close and the reopen in the audit log', async () => {
    const res = await send('GET', '/audit-logs?entityType=workspace&limit=100');
    const actions = auditPageSchema.parse(res.json()).items.map((item) => item.action);
    expect(actions).toEqual(expect.arrayContaining(['books.year_closed', 'books.year_reopened']));
  });
});
```

- **Dates from today**: last fiscal year is always over and this one never is, whatever day the suite runs.
  (Step 10's tests use fixed 2026 dates; these will not go stale.)
- **The numbers are chosen to be checked by hand**: last year's profit is 1,450,000 − 485,000 = 965,000; the
  comments say the sums.
- **A draft sits in this year from the start**, and the trial balance must not show its account. Without it, a
  report that forgot `status = 'posted'` would pass every test (found by breaking it on purpose).
- **The two members** test the permission both ways: reports without the journal, the journal without reports.
- **The year tests run in order** and tell one story: refuse, close, still report, stay shut, reopen, close in
  order, reopen backwards, audit. The archived account in "closes years in order" is what tests the posting
  change in 11.4.
- **"closes years in order" is split from "reopens only the latest closed year"**: as one test it took 79 ms
  alone, but once ran past vitest's 5-second limit while the whole suite was starting its containers at the
  same time. Two shorter tests stay well inside it.

**File: `apps/api/src/reports/report-exports.int.spec.ts`** (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  fiscalYearOf,
  memberPageSchema,
  notificationPageSchema,
  problemSchema,
  type ReportExport,
  reportExportPageSchema,
  reportExportSchema,
  roleSchema,
  setupSchema,
  signedUrlSchema,
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
  startStorage,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// The whole way of an export: the API stores the row and the event, the real worker writes the
// file into a real MinIO, the bell says it is ready, and the download link gives the file.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// Nasrin in Farhana's workspace, allowed to read and export reports herself
let colleague: SignedIn;
// Nasrin in her own workspace, where she is the owner
let outsider: SignedIn;
let accounts: Account[];

const today = todayIn('Asia/Dhaka');
const thisYear = fiscalYearOf(today, 7);

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, as = owner) {
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

async function exportOf(body: object): Promise<ReportExport> {
  const res = await send('POST', '/report-exports', body);
  expect(res.statusCode).toBe(201);
  return reportExportSchema.parse(res.json());
}

// Waits for the worker: the export in "My exports" with its final status
async function finished(exportId: string, as = owner): Promise<ReportExport> {
  return eventually(async () => {
    const { items } = reportExportPageSchema.parse(
      (await send('GET', '/report-exports', undefined, as)).json(),
    );
    const found = items.find((item) => item.id === exportId);
    expect(found?.status).not.toBe('pending');
    if (!found) throw new Error('export not listed');
    return found;
  }, 8_000);
}

async function download(exportId: string) {
  const res = await send('GET', `/report-exports/${exportId}/download`);
  expect(res.statusCode).toBe(200);
  const file = await fetch(signedUrlSchema.parse(res.json()).url);
  expect(file.status).toBe(200);
  return { file, bytes: new Uint8Array(await file.arrayBuffer()) };
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  [pg, redis, storage] = await Promise.all([startPostgres(), startRedis(), startStorage()]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      storageUrl: storage.url,
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
  const posted = await send('POST', '/journal-entries', {
    date: thisYear.start,
    narration: 'Export sale to H&M, Stockholm',
    lines: [
      { accountId: id('1180'), branchId: null, description: '', debit: '1842600.50', credit: '' },
      { accountId: id('4110'), branchId: null, description: '', debit: '', credit: '1842600.50' },
    ],
    post: true,
  });
  expect(posted.statusCode).toBe(201);

  // Nasrin owns a workspace of her own, and reads reports in Farhana's
  outsider = await signUp(app, {
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
    (await send('POST', '/roles', { name: 'Report reader', description: '' })).json(),
  );
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions: ['accounting.report.read'] }],
  });
  expect(matrix.statusCode).toBe(200);
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const nasrin = items.find((item) => item.email === 'nasrin@rahmangarments.com');
  if (!nasrin) throw new Error('Nasrin is not a member');
  const roles = await send('PUT', `/members/${nasrin.membershipId}/roles`, {
    roleIds: [role.id],
    version: nasrin.version,
  });
  expect(roles.statusCode).toBe(200);
  colleague = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), storage.container.stop()]);
});

describe('exporting a report', () => {
  it('writes an Excel file in the background and offers it for download', async () => {
    const asked = await exportOf({
      report: 'trial_balance',
      format: 'xlsx',
      query: { from: thisYear.start, to: today },
    });
    expect(asked).toMatchObject({
      status: 'pending',
      fileName: null,
      query: { from: thisYear.start, to: today },
    });

    const ready = await finished(asked.id);
    expect(ready).toMatchObject({
      status: 'ready',
      fileName: `trial-balance-${thisYear.start}-to-${today}.xlsx`,
    });
    const { file, bytes } = await download(asked.id);
    expect(file.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(file.headers.get('content-disposition')).toContain(
      `filename="trial-balance-${thisYear.start}-to-${today}.xlsx"`,
    );
    // An .xlsx file is a zip archive: it starts with "PK"
    expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toBe('PK');
    expect(bytes.byteLength).toBe(ready.sizeBytes);
  });

  it('writes a PDF, and the bell says each file is ready', async () => {
    const asked = await exportOf({
      report: 'profit_and_loss',
      format: 'pdf',
      query: { from: thisYear.start, to: today },
    });
    expect((await finished(asked.id)).status).toBe('ready');
    const { bytes } = await download(asked.id);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');

    const { items } = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(items.filter((item) => item.type === 'report.ready').map((item) => item.params)).toEqual(
      expect.arrayContaining([
        { report: 'trial_balance', format: 'xlsx' },
        { report: 'profit_and_loss', format: 'pdf' },
      ]),
    );
  });

  it('checks the query with the schema of its own report', async () => {
    const res = await send('POST', '/report-exports', {
      report: 'balance_sheet',
      format: 'pdf',
      query: { from: thisYear.start, to: today },
    });
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      'query.asOf': ['required'],
    });
  });

  it("answers 409 while the file is not written, and 404 for another person's export", async () => {
    const [pending] = await superuserSql(
      (sql) => sql<{ id: string }[]>`
        INSERT INTO report_exports (id, tenant_id, requested_by, report, format, query)
        SELECT gen_random_uuid(), m.tenant_id, m.user_id, 'balance_sheet', 'pdf',
               ${sql.json({ asOf: today })}
          FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE u.email = 'farhana@rahmangarments.com'
        RETURNING id`,
    );
    const res = await send('GET', `/report-exports/${pending?.id ?? ''}/download`);
    expect(problemSchema.parse(res.json()).code).toBe('export_not_ready');

    // Nasrin may export reports in this workspace, but this export is Farhana's: it does not
    // exist for her, in her list or by its id — and not from her own workspace either
    for (const who of [colleague, outsider]) {
      const download = await send(
        'GET',
        `/report-exports/${pending?.id ?? ''}/download`,
        undefined,
        who,
      );
      expect(download.statusCode).toBe(404);
      const { items } = reportExportPageSchema.parse(
        (await send('GET', '/report-exports', undefined, who)).json(),
      );
      expect(items).toEqual([]);
    }
  });

  it('gives up on an export that can never be written, and says so in the bell', async () => {
    // A query no report takes, written past the API (as a bug might): the job fails for good
    const [broken] = await superuserSql(async (sql) => {
      const rows = await sql<{ id: string; tenant_id: string }[]>`
        INSERT INTO report_exports (id, tenant_id, requested_by, report, format, query)
        SELECT gen_random_uuid(), m.tenant_id, m.user_id, 'trial_balance', 'xlsx',
               ${sql.json({ from: 'yesterday' })}
          FROM memberships m JOIN users u ON u.id = m.user_id
          JOIN tenants t ON t.id = m.tenant_id
         WHERE u.email = 'farhana@rahmangarments.com' AND t.slug = 'rahman-garments'
        RETURNING id, tenant_id`;
      const row = rows[0];
      if (!row) throw new Error('no export row');
      await sql`
        INSERT INTO outbox_events (id, tenant_id, type, payload)
        VALUES (gen_random_uuid(), ${row.tenant_id}, 'report.export_requested',
                ${sql.json({ exportId: row.id })})`;
      return rows;
    });
    expect((await finished(broken?.id ?? '')).status).toBe('failed');
    const { items } = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(items.find((item) => item.type === 'report.failed')?.params).toEqual({
      report: 'trial_balance',
      format: 'xlsx',
    });
  });
});
```

The whole way of an export with a real MinIO and the real worker: the file's type and name in the download's
headers, `PK` (a zip) for Excel and `%PDF-` for PDF, the bell's notifications, the query checked by the report's
own schema, 409 while pending, 404 for a colleague and for another tenant, and the give-up path (a broken row and
event written with the superuser, past the API).

**File: `apps/api/src/reports/reports.tenant-leak.int.spec.ts`** (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  branchSchema,
  fiscalYearListSchema,
  fiscalYearOf,
  profitAndLossSchema,
  reportExportPageSchema,
  setupSchema,
  shiftIsoDate,
  todayIn,
  trialBalanceSchema,
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
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// Two workspaces with books of their own. A report is one big SUM over the journal: a single
// missing tenant filter would add B's money into A's totals. Every number A sees must be A's.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let branchOfB: string;
let exportOfB: string;

const today = todayIn('Asia/Dhaka');
const thisYear = fiscalYearOf(today, 7);
const lastYear = fiscalYearOf(shiftIsoDate(thisYear.start, -1), 7);

function as(who: SignedIn, method: 'GET' | 'POST', url: string, payload?: object) {
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
  const [, chartOfB] = await Promise.all([setUp(tenantA, 'garments'), setUp(tenantB, 'pharma')]);

  // Only B has books: last year's sales and this year's, on a branch of B's
  branchOfB = branchSchema.parse(
    (
      await as(tenantB, 'POST', '/branches', {
        code: 'MYM',
        name: 'Mymensingh depot',
        phone: '',
        address: '',
      })
    ).json(),
  ).id;
  for (const date of [lastYear.start, thisYear.start]) {
    const res = await as(tenantB, 'POST', '/journal-entries', {
      date,
      narration: 'Sales at the depot',
      lines: [
        {
          accountId: idIn(chartOfB, '1110'),
          branchId: branchOfB,
          description: '',
          debit: '900000',
          credit: '',
        },
        {
          accountId: idIn(chartOfB, '4110'),
          branchId: branchOfB,
          description: '',
          debit: '',
          credit: '900000',
        },
      ],
      post: true,
    });
    expect(res.statusCode).toBe(201);
  }

  // A finished export of B's, written straight into the table: no storage is needed to ask for it
  const sql = postgres(pg.superuserUrl, { max: 1 });
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO report_exports (id, tenant_id, requested_by, report, format, query, status,
                                file_name, content_type, size_bytes, storage_key, finished_at)
    SELECT gen_random_uuid(), m.tenant_id, m.user_id, 'trial_balance', 'pdf',
           ${sql.json({ from: thisYear.start, to: today })}, 'ready', 'trial-balance.pdf',
           'application/pdf', 1024, 'tenants/b/report-exports/x.pdf', now()
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE u.email = 'karim@karimpharma.com'
    RETURNING id`;
  await sql.end();
  exportOfB = row?.id ?? '';
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('report isolation over HTTP', () => {
  it("adds none of tenant B's money into tenant A's reports", async () => {
    const tb = trialBalanceSchema.parse(
      (
        await as(tenantA, 'GET', `/reports/trial-balance?from=${lastYear.start}&to=${today}`)
      ).json(),
    );
    expect(tb.rows).toEqual([]);
    expect(tb.totals.closingDebit).toBe('0.0000');
    // Even with B's own branch as the filter
    const pl = profitAndLossSchema.parse(
      (
        await as(
          tenantA,
          'GET',
          `/reports/profit-and-loss?from=${lastYear.start}&to=${today}&branchId=${branchOfB}`,
        )
      ).json(),
    );
    expect(pl.netProfit).toBe('0.0000');
    expect(pl.income.rows).toEqual([]);
    // B sees its own sales, so the books above were really there
    const own = trialBalanceSchema.parse(
      (
        await as(tenantB, 'GET', `/reports/trial-balance?from=${lastYear.start}&to=${today}`)
      ).json(),
    );
    expect(own.totals.closingDebit).toBe('1800000.0000');
  });

  it("does not list tenant B's years, and cannot close them", async () => {
    const years = fiscalYearListSchema.parse((await as(tenantA, 'GET', '/fiscal-years')).json());
    // A has no entries: only the current year, with nothing in it
    expect(years.items.map((year) => [year.start, year.netProfit])).toEqual([
      [thisYear.start, '0.0000'],
    ]);
    const close = await as(tenantA, 'POST', '/fiscal-years/close', { end: lastYear.end });
    expect(close.statusCode).toBe(409);
    // B's year is untouched: still open
    const ofB = fiscalYearListSchema.parse((await as(tenantB, 'GET', '/fiscal-years')).json());
    expect(ofB.items.find((year) => year.end === lastYear.end)?.status).toBe('open');
  });

  it("never lists or downloads tenant B's exports", async () => {
    const { items } = reportExportPageSchema.parse(
      (await as(tenantA, 'GET', '/report-exports')).json(),
    );
    expect(items).toEqual([]);
    expect((await as(tenantA, 'GET', `/report-exports/${exportOfB}/download`)).statusCode).toBe(
      404,
    );
  });
});
```

A report is one big `SUM`: a missing tenant filter would add B's money into A's totals without any error. Only B
has books here, so A's reports must be exactly zero — even with B's own branch as the filter.

**File: `apps/api/src/reports/export/document.spec.ts`** (new)

```ts
import type { BalanceSheet, ReportSection, TrialBalance } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { buildDocument, type DocCell, type DocumentContext, fileStem } from './document.js';

const context: DocumentContext = {
  language: 'en',
  company: 'Rahman Garments Ltd.',
  currency: 'BDT',
  timeZone: 'Asia/Dhaka',
  branchName: null,
  madeAt: new Date('2026-10-01T08:05:00Z'),
};

// A cell as it reads: the text, the amount, or '' for an empty cell
function read(cell: DocCell | undefined): string {
  if (cell === undefined || cell.kind === 'empty') return '';
  return cell.kind === 'money' ? cell.amount : cell.text;
}

const id = (n: number) => `01939d1c-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('the document of a trial balance', () => {
  const data: TrialBalance = {
    rows: [
      {
        accountId: id(1),
        code: '1110',
        name: 'Cash in hand',
        type: 'asset',
        opening: '0.0000',
        debit: '0.0000',
        credit: '185000.0000',
        closing: '-185000.0000',
      },
    ],
    totals: {
      openingDebit: '0.0000',
      openingCredit: '0.0000',
      debit: '0.0000',
      credit: '185000.0000',
      closingDebit: '0.0000',
      closingCredit: '185000.0000',
    },
  };

  it('puts a balance in its Dr or Cr column, and leaves what did not move empty', () => {
    const doc = buildDocument(
      { report: 'trial_balance', query: { from: '2026-07-01', to: '2026-09-30' }, data },
      context,
    );
    expect(doc.landscape).toBe(true);
    expect(doc.rows[0]?.cells.map(read)).toEqual([
      '1110',
      'Cash in hand',
      '',
      '',
      '',
      '185000.0000',
      '',
      '185000.0000',
    ]);
    expect(doc.lines).toEqual([
      '1 Jul 2026 – 30 Sep 2026',
      'Amounts in BDT',
      'Made on 1 Oct 2026, 14:05',
    ]);
  });

  it('names the file by the report and its dates, in ASCII', () => {
    expect(
      fileStem({ report: 'trial_balance', query: { from: '2026-07-01', to: '2026-09-30' }, data }),
    ).toBe('trial-balance-2026-07-01-to-2026-09-30');
  });
});

describe('the document of a balance sheet', () => {
  const section = (type: ReportSection['type'], total: string): ReportSection => ({
    type,
    rows: [],
    total,
    compareTotal: null,
  });
  const data: BalanceSheet = {
    asset: section('asset', '965000.0000'),
    liability: section('liability', '0.0000'),
    equity: section('equity', '0.0000'),
    profitNotClosed: '965000.0000',
    compareProfitNotClosed: null,
    liabilitiesAndEquity: '965000.0000',
    compareLiabilitiesAndEquity: null,
  };

  it('ends equity with the profit not closed yet, inside the equity total', () => {
    const doc = buildDocument(
      { report: 'balance_sheet', query: { asOf: '2026-09-30' }, data },
      { ...context, language: 'bn' },
    );
    expect(doc.title).toBe('ব্যালান্স শিট');
    expect(doc.rows.slice(-3).map((row) => [row.style, ...row.cells.map(read)])).toEqual([
      ['normal', 'যে লাভ এখনো রিটেইনড আর্নিংসে যায়নি', '965000.0000'],
      ['total', 'মোট মালিকানা স্বত্ব', '965000.0000'],
      ['grand', 'মোট দায় ও মালিকানা স্বত্ব', '965000.0000'],
    ]);
  });
});
```

A unit test (no containers): the Dr/Cr columns of the trial balance, the empty cells for what did not move, the
file name, and the Bangla balance sheet's last three rows.

**File: `apps/api/src/setup/setup.int.spec.ts`** (change)

```diff
@@ -132,6 +132,7 @@ describe('starting the setup', () => {
           'accounting.journal.post',
           'accounting.journal.read',
           'accounting.period.close',
+          'accounting.report.read',
           'core.audit.read',
           'core.user.read',
         ],
```

---

## 11.8 — `packages/i18n`: the texts

**File: `packages/i18n/src/locales/en.ts`** (change)

```diff
@@ -47,6 +47,12 @@ export const en = {
     journal: 'Journal',
     ledger: 'Ledger',
     openingBalances: 'Opening balances',
+    yearEnd: 'Year-end close',
+    reports: 'Reports',
+    trialBalance: 'Trial balance',
+    profitAndLoss: 'Profit and loss',
+    balanceSheet: 'Balance sheet',
+    exports: 'Exports',
   },
   auth: {
     workspace: 'Workspace',
@@ -343,6 +349,7 @@ export const en = {
       manual: 'Written by hand',
       opening_balance: 'Opening balances',
       reversal: 'Reversal',
+      year_close: 'Year-end close',
     },
     draftSaved: 'Draft saved',
     posted: '{{number}} posted',
@@ -405,6 +412,149 @@ export const en = {
       'Ask a workspace owner for the accounting.journal.post permission to change the opening balances.',
     loadFailed: "Couldn't load the opening balances. Refresh the page to try again.",
   },
+  reports: {
+    kinds: {
+      trial_balance: 'Trial balance',
+      profit_and_loss: 'Profit and loss',
+      balance_sheet: 'Balance sheet',
+    },
+    formats: { xlsx: 'Excel', pdf: 'PDF' },
+    sections: {
+      asset: 'Assets',
+      liability: 'Liabilities',
+      equity: 'Equity',
+      income: 'Income',
+      expense: 'Expenses',
+    },
+    totalOf: {
+      asset: 'Total assets',
+      liability: 'Total liabilities',
+      equity: 'Total equity',
+      income: 'Total income',
+      expense: 'Total expenses',
+    },
+    period: 'Period',
+    from: 'From',
+    to: 'To',
+    presets: {
+      this_year: 'This fiscal year',
+      last_year: 'Last fiscal year',
+      this_quarter: 'This quarter',
+      last_quarter: 'Last quarter',
+      this_month: 'This month',
+      last_month: 'Last month',
+      custom: 'Custom dates',
+    },
+    compare: 'Compare with',
+    compareModes: {
+      none: 'Nothing',
+      previous_period: 'Period before',
+      previous_year: 'Last year',
+    },
+    asOf: 'As at',
+    compareAsOfModes: {
+      none: 'Nothing',
+      year_end: 'Last year end',
+      previous_year: 'A year before',
+    },
+    branch: 'Branch',
+    allBranches: 'All branches',
+    account: 'Account',
+    total: 'Total',
+    range: '{{from}} – {{to}}',
+    asAt: 'As at {{date}}',
+    balanced: 'Balanced',
+    outBy: 'Out by {{amount}}',
+    vs: 'vs {{amount}}',
+    openLedger: 'Open the ledger of {{name}}',
+    loadFailed: "Couldn't load the report. Refresh the page to try again.",
+    export: {
+      button: 'Export',
+      xlsx: 'Excel (.xlsx)',
+      pdf: 'PDF',
+      started: "Preparing the {{format}} file. The bell tells you when it's ready.",
+    },
+    trialBalance: {
+      title: 'Trial balance',
+      description:
+        "Each account's opening balance, what moved in the period, and its closing balance",
+      opening: 'Opening',
+      debit: 'Debit',
+      credit: 'Credit',
+      closing: 'Closing',
+      emptyTitle: 'Nothing posted in these dates',
+      emptyBody: 'Pick other dates, or post the first entries from the journal.',
+    },
+    profitAndLoss: {
+      title: 'Profit and loss',
+      description: 'Income and expenses of a period, and the profit they leave',
+      netProfit: 'Net profit',
+      emptyTitle: 'No income or expenses in these dates',
+      emptyBody: 'Pick other dates, or post sales and costs from the journal.',
+    },
+    balanceSheet: {
+      title: 'Balance sheet',
+      description: 'What the company owns and owes on a day',
+      profitNotClosed: 'Profit not yet closed',
+      profitNotClosedHint: 'Income minus expenses since the last year-end close',
+      liabilitiesAndEquity: 'Total liabilities and equity',
+      emptyTitle: 'Nothing on the books on this day',
+      emptyBody: 'Pick a later day, or post the opening balances first.',
+    },
+  },
+  exports: {
+    title: 'Exports',
+    description: 'Files you exported from the reports, newest first',
+    columns: {
+      report: 'Report',
+      format: 'File',
+      status: 'Status',
+      created: 'Asked for',
+    },
+    statuses: {
+      pending: 'Preparing',
+      ready: 'Ready',
+      failed: 'Failed',
+    },
+    download: 'Download',
+    downloadFailed: "Couldn't get the file. Try again in a moment.",
+    emptyTitle: 'No exports yet',
+    emptyBody: 'Open a report, like the trial balance, and choose Export. The file shows up here.',
+    loadFailed: "Couldn't load your exports. Refresh the page to try again.",
+  },
+  yearEnd: {
+    title: 'Year-end close',
+    description: "Move each year's profit into retained earnings and close its dates",
+    lockedUntil: 'Books closed up to {{date}}',
+    label: 'FY {{label}}',
+    columns: {
+      year: 'Fiscal year',
+      profit: 'Net profit',
+      status: 'Status',
+    },
+    statuses: {
+      open: 'Open',
+      closed: 'Closed',
+    },
+    endsOn: 'Ends {{date}}',
+    drafts_one: '{{count}} draft dated in this year',
+    drafts_other: '{{count}} drafts dated in this year',
+    closingEntry: 'Closing entry {{number}}',
+    close: 'Close year',
+    reopen: 'Reopen',
+    closeTitle: 'Close FY {{label}}',
+    closeBody:
+      'A closing entry moves the net profit of {{amount}} into retained earnings, and the books close up to {{date}}. You can reopen the year later.',
+    confirmClose: 'Close year',
+    reopenTitle: 'Reopen FY {{label}}',
+    reopenBody:
+      'The closing entry {{number}} is reversed on its own date, and the books open again from {{date}}.',
+    confirmReopen: 'Reopen year',
+    closed: 'FY {{label}} closed',
+    reopened: 'FY {{label}} reopened',
+    readOnly: 'Ask a workspace owner for the accounting.period.close permission to close a year.',
+    loadFailed: "Couldn't load the fiscal years. Refresh the page to try again.",
+  },
   team: {
     title: 'Team',
     description: 'People with access to this workspace, and the roles they have',
@@ -518,7 +668,8 @@ export const en = {
         create: 'Write and edit draft entries',
         post: 'Post and reverse entries, set opening balances',
       },
-      period: { close: 'Close the books up to a date' },
+      period: { close: 'Close the books up to a date, and close fiscal years' },
+      report: { read: 'See the reports and export them' },
     },
   },
   invite: {
@@ -616,7 +767,11 @@ export const en = {
         reversed: 'Reversed a journal entry',
         opening_balances_saved: 'Posted the opening balances',
       },
-      books: { lock_date_changed: 'Changed the lock date' },
+      books: {
+        lock_date_changed: 'Changed the lock date',
+        year_closed: 'Closed a fiscal year',
+        year_reopened: 'Reopened a fiscal year',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -650,6 +805,7 @@ export const en = {
       lockDate: 'Lock date',
       goLiveDate: 'First day on Omnivo',
       entry: 'Entry',
+      year: 'Fiscal year',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -720,6 +876,11 @@ export const en = {
       invitation: {
         failed: "The invitation email to {{email}} couldn't be sent. Resend it from the Team page.",
       },
+      // {{report}} and {{format}} arrive as keys (trial_balance, xlsx); the bell puts their words in
+      report: {
+        ready: '{{report}} ({{format}}) is ready to download.',
+        failed: "{{report}} ({{format}}) couldn't be made. Try the export again.",
+      },
     },
   },
   // API-র error code → লেখা। satisfies: contracts-এর ERROR_CODES-এ নতুন code এলে এখানে না লেখা
@@ -812,6 +973,20 @@ export const en = {
     opening_account_twice: 'Enter each account once.',
     period_lock_future: 'Pick today or an earlier date.',
     base_currency_locked: "Entries are posted in this currency, so it can't change any more.",
+    journal_is_year_close:
+      'A closing entry is undone by reopening its year on the Year-end close page.',
+    report_range_invalid: 'Pick an end date on or after the start date.',
+    report_compare_incomplete: 'Pick both dates of the comparison, or neither.',
+    year_end_invalid: 'Pick the last day of a fiscal year.',
+    year_not_ended: "This year hasn't ended yet. Close it after its last day.",
+    year_already_closed: 'This year is closed already. Reload to see it.',
+    year_not_closed: "This year isn't closed. Reload to see it.",
+    year_has_drafts: 'Drafts dated in this year: {{count}}. Post or delete them first.',
+    year_nothing_to_close:
+      'Nothing was posted to income or expenses, so there is nothing to close.',
+    year_earlier_open: 'Close the earlier fiscal year first.',
+    year_later_closed: 'Reopen the later fiscal year first.',
+    export_not_ready: "The file isn't ready yet. Wait for the notification, then try again.",
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- **`reports.kinds` and `reports.formats`** are what the bell and the Exports page put in place of the keys.
- **The comparison options are short** ("Last year", "Period before"): in the five-field filter row the longer
  first wording ("Same period last year") was cut off in its select (seen on the 1280px screenshot).
- **`yearEnd.drafts_one`/`_other`**: i18next picks the form by `count`. An error text cannot do that
  (`errors.*` is one string per code), so `year_has_drafts` is worded to read right for 1 and for 3.
- **Two decimals everywhere money shows** on these pages (step 10's decision 10).

**File: `packages/i18n/src/locales/bn.ts`** (change)

```diff
@@ -47,6 +47,12 @@ export const bn: Messages = {
     journal: 'জার্নাল',
     ledger: 'লেজার',
     openingBalances: 'ওপেনিং ব্যালান্স',
+    yearEnd: 'বছর শেষের ক্লোজিং',
+    reports: 'রিপোর্ট',
+    trialBalance: 'ট্রায়াল ব্যালান্স',
+    profitAndLoss: 'লাভ-ক্ষতি',
+    balanceSheet: 'ব্যালান্স শিট',
+    exports: 'এক্সপোর্ট',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -339,6 +345,7 @@ export const bn: Messages = {
       manual: 'হাতে লেখা',
       opening_balance: 'ওপেনিং ব্যালান্স',
       reversal: 'রিভার্সাল',
+      year_close: 'বছর শেষের ক্লোজিং',
     },
     draftSaved: 'ড্রাফট সেভ হয়েছে',
     posted: '{{number}} পোস্ট হয়েছে',
@@ -400,6 +407,150 @@ export const bn: Messages = {
       'ওপেনিং ব্যালান্স বদলাতে ওয়ার্কস্পেস মালিকের কাছে accounting.journal.post অনুমতি চান।',
     loadFailed: 'ওপেনিং ব্যালান্স আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  reports: {
+    kinds: {
+      trial_balance: 'ট্রায়াল ব্যালান্স',
+      profit_and_loss: 'লাভ-ক্ষতির হিসাব',
+      balance_sheet: 'ব্যালান্স শিট',
+    },
+    formats: { xlsx: 'Excel', pdf: 'PDF' },
+    sections: {
+      asset: 'সম্পদ',
+      liability: 'দায়',
+      equity: 'মালিকানা স্বত্ব',
+      income: 'আয়',
+      expense: 'ব্যয়',
+    },
+    totalOf: {
+      asset: 'মোট সম্পদ',
+      liability: 'মোট দায়',
+      equity: 'মোট মালিকানা স্বত্ব',
+      income: 'মোট আয়',
+      expense: 'মোট ব্যয়',
+    },
+    period: 'সময়কাল',
+    from: 'থেকে',
+    to: 'পর্যন্ত',
+    presets: {
+      this_year: 'এই অর্থবছর',
+      last_year: 'গত অর্থবছর',
+      this_quarter: 'এই কোয়ার্টার',
+      last_quarter: 'গত কোয়ার্টার',
+      this_month: 'এই মাস',
+      last_month: 'গত মাস',
+      custom: 'নিজের বাছা তারিখ',
+    },
+    compare: 'তুলনা',
+    compareModes: {
+      none: 'কিছুর সাথে না',
+      previous_period: 'আগের সময়কাল',
+      previous_year: 'গত বছর',
+    },
+    asOf: 'যে তারিখে',
+    compareAsOfModes: {
+      none: 'কিছুর সাথে না',
+      year_end: 'গত অর্থবছরের শেষ',
+      previous_year: 'এক বছর আগে',
+    },
+    branch: 'ব্রাঞ্চ',
+    allBranches: 'সব ব্রাঞ্চ',
+    account: 'অ্যাকাউন্ট',
+    total: 'মোট',
+    range: '{{from}} – {{to}}',
+    asAt: '{{date}} তারিখে',
+    balanced: 'মিলেছে',
+    outBy: '{{amount}} গরমিল',
+    vs: 'তুলনায় {{amount}}',
+    openLedger: '{{name}}-এর লেজার খুলুন',
+    loadFailed: 'রিপোর্ট আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    export: {
+      button: 'এক্সপোর্ট',
+      xlsx: 'Excel (.xlsx)',
+      pdf: 'PDF',
+      started: '{{format}} ফাইল তৈরি হচ্ছে। তৈরি হলে বেল-এ জানানো হবে।',
+    },
+    trialBalance: {
+      title: 'ট্রায়াল ব্যালান্স',
+      description:
+        'প্রতিটা অ্যাকাউন্টের প্রারম্ভিক ব্যালান্স, সময়কালের লেনদেন আর সমাপনী ব্যালান্স',
+      opening: 'প্রারম্ভিক',
+      debit: 'ডেবিট',
+      credit: 'ক্রেডিট',
+      closing: 'সমাপনী',
+      emptyTitle: 'এই তারিখগুলোতে কিছু পোস্ট হয়নি',
+      emptyBody: 'অন্য তারিখ বাছুন, অথবা জার্নাল থেকে প্রথম এন্ট্রিগুলো পোস্ট করুন।',
+    },
+    profitAndLoss: {
+      title: 'লাভ-ক্ষতির হিসাব',
+      description: 'একটা সময়কালের আয় আর ব্যয়, আর তাতে কত লাভ থাকল',
+      netProfit: 'নিট লাভ',
+      emptyTitle: 'এই তারিখগুলোতে কোনো আয় বা ব্যয় নেই',
+      emptyBody: 'অন্য তারিখ বাছুন, অথবা জার্নাল থেকে বিক্রি আর খরচ পোস্ট করুন।',
+    },
+    balanceSheet: {
+      title: 'ব্যালান্স শিট',
+      description: 'একটা দিনে কোম্পানির কী আছে আর কী দেনা',
+      profitNotClosed: 'যে লাভ এখনো ক্লোজ হয়নি',
+      profitNotClosedHint: 'শেষ বছর-শেষের ক্লোজিংয়ের পর থেকে আয় বাদ ব্যয়',
+      liabilitiesAndEquity: 'মোট দায় ও মালিকানা স্বত্ব',
+      emptyTitle: 'এই দিনে বইয়ে কিছু নেই',
+      emptyBody: 'পরের একটা দিন বাছুন, অথবা আগে ওপেনিং ব্যালান্স পোস্ট করুন।',
+    },
+  },
+  exports: {
+    title: 'এক্সপোর্ট',
+    description: 'রিপোর্ট থেকে এক্সপোর্ট করা আপনার ফাইল, নতুনগুলো আগে',
+    columns: {
+      report: 'রিপোর্ট',
+      format: 'ফাইল',
+      status: 'অবস্থা',
+      created: 'চাওয়া হয়েছে',
+    },
+    statuses: {
+      pending: 'তৈরি হচ্ছে',
+      ready: 'তৈরি',
+      failed: 'ব্যর্থ',
+    },
+    download: 'ডাউনলোড',
+    downloadFailed: 'ফাইলটা পাওয়া যায়নি। একটু পরে আবার চেষ্টা করুন।',
+    emptyTitle: 'এখনো কোনো এক্সপোর্ট নেই',
+    emptyBody:
+      'একটা রিপোর্ট খুলুন, যেমন ট্রায়াল ব্যালান্স, আর এক্সপোর্ট বাছুন। ফাইলটা এখানে আসবে।',
+    loadFailed: 'এক্সপোর্টগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  yearEnd: {
+    title: 'বছর শেষের ক্লোজিং',
+    description: 'প্রতিটা বছরের লাভ রিটেইনড আর্নিংসে নিন আর সেই বছরের তারিখগুলো বন্ধ করুন',
+    lockedUntil: '{{date}} পর্যন্ত বই বন্ধ',
+    label: 'অর্থবছর {{label}}',
+    columns: {
+      year: 'অর্থবছর',
+      profit: 'নিট লাভ',
+      status: 'অবস্থা',
+    },
+    statuses: {
+      open: 'খোলা',
+      closed: 'ক্লোজড',
+    },
+    endsOn: '{{date}} শেষ হবে',
+    drafts_one: 'এই বছরের তারিখে {{count}}টা ড্রাফট আছে',
+    drafts_other: 'এই বছরের তারিখে {{count}}টা ড্রাফট আছে',
+    closingEntry: 'ক্লোজিং এন্ট্রি {{number}}',
+    close: 'বছর ক্লোজ করুন',
+    reopen: 'আবার খুলুন',
+    closeTitle: 'অর্থবছর {{label}} ক্লোজ করুন',
+    closeBody:
+      'একটা ক্লোজিং এন্ট্রি {{amount}} নিট লাভ রিটেইনড আর্নিংসে নেবে, আর {{date}} পর্যন্ত বই বন্ধ হবে। পরে চাইলে বছরটা আবার খোলা যাবে।',
+    confirmClose: 'বছর ক্লোজ করুন',
+    reopenTitle: 'অর্থবছর {{label}} আবার খুলুন',
+    reopenBody:
+      'ক্লোজিং এন্ট্রি {{number}} তার নিজের তারিখেই রিভার্স হবে, আর {{date}} থেকে বই আবার খুলবে।',
+    confirmReopen: 'বছর আবার খুলুন',
+    closed: 'অর্থবছর {{label}} ক্লোজ হয়েছে',
+    reopened: 'অর্থবছর {{label}} আবার খোলা হয়েছে',
+    readOnly: 'বছর ক্লোজ করতে ওয়ার্কস্পেস মালিকের কাছে accounting.period.close অনুমতি চান।',
+    loadFailed: 'অর্থবছরগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   team: {
     title: 'টিম',
     description: 'এই ওয়ার্কস্পেসে যাঁদের অ্যাক্সেস আছে, আর তাঁদের রোল',
@@ -511,7 +662,8 @@ export const bn: Messages = {
         create: 'ড্রাফট এন্ট্রি লেখা আর বদলানো',
         post: 'এন্ট্রি পোস্ট আর রিভার্স, ওপেনিং ব্যালান্স দেওয়া',
       },
-      period: { close: 'একটা তারিখ পর্যন্ত বই বন্ধ করা' },
+      period: { close: 'একটা তারিখ পর্যন্ত বই বন্ধ করা, আর অর্থবছর ক্লোজ করা' },
+      report: { read: 'রিপোর্ট দেখা আর এক্সপোর্ট করা' },
     },
   },
   invite: {
@@ -607,7 +759,11 @@ export const bn: Messages = {
         reversed: 'জার্নাল এন্ট্রি রিভার্স করেছেন',
         opening_balances_saved: 'ওপেনিং ব্যালান্স পোস্ট করেছেন',
       },
-      books: { lock_date_changed: 'লক তারিখ বদলেছেন' },
+      books: {
+        lock_date_changed: 'লক তারিখ বদলেছেন',
+        year_closed: 'একটা অর্থবছর ক্লোজ করেছেন',
+        year_reopened: 'একটা অর্থবছর আবার খুলেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -640,6 +796,7 @@ export const bn: Messages = {
       lockDate: 'লক তারিখ',
       goLiveDate: 'Omnivo-তে প্রথম দিন',
       entry: 'এন্ট্রি',
+      year: 'অর্থবছর',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -707,6 +864,10 @@ export const bn: Messages = {
       invitation: {
         failed: '{{email}}-এ আমন্ত্রণের ইমেইল পাঠানো যায়নি। Team পেজ থেকে আবার পাঠান।',
       },
+      report: {
+        ready: '{{report}} ({{format}}) ডাউনলোডের জন্য তৈরি।',
+        failed: '{{report}} ({{format}}) তৈরি করা যায়নি। আবার এক্সপোর্ট করুন।',
+      },
     },
   },
   errors: {
@@ -798,6 +959,19 @@ export const bn: Messages = {
     opening_account_twice: 'প্রতিটা অ্যাকাউন্ট একবার দিন।',
     period_lock_future: 'আজ বা তার আগের একটা তারিখ বাছুন।',
     base_currency_locked: 'এই মুদ্রায় এন্ট্রি পোস্ট হয়েছে, তাই এটা আর বদলানো যায় না।',
+    journal_is_year_close: 'ক্লোজিং এন্ট্রি উল্টাতে বছর শেষের ক্লোজিং পেজ থেকে বছরটা আবার খুলুন।',
+    report_range_invalid: 'শুরুর তারিখের দিন বা তার পরের একটা শেষ তারিখ বাছুন।',
+    report_compare_incomplete: 'তুলনার দুটো তারিখই বাছুন, অথবা কোনোটাই না।',
+    year_end_invalid: 'একটা অর্থবছরের শেষ দিন বাছুন।',
+    year_not_ended: 'এই বছর এখনো শেষ হয়নি। শেষ দিনের পরে ক্লোজ করুন।',
+    year_already_closed: 'এই বছর আগেই ক্লোজ হয়েছে। দেখতে পেজটা রিলোড করুন।',
+    year_not_closed: 'এই বছর ক্লোজ করা নেই। দেখতে পেজটা রিলোড করুন।',
+    year_has_drafts:
+      'এই বছরের তারিখে ড্রাফট আছে: {{count}}টা। আগে সেগুলো পোস্ট করুন বা মুছে ফেলুন।',
+    year_nothing_to_close: 'আয় বা ব্যয়ে কিছু পোস্ট হয়নি, তাই ক্লোজ করার কিছু নেই।',
+    year_earlier_open: 'আগের অর্থবছরটা আগে ক্লোজ করুন।',
+    year_later_closed: 'পরের অর্থবছরটা আগে আবার খুলুন।',
+    export_not_ready: 'ফাইলটা এখনো তৈরি হয়নি। নোটিফিকেশনের জন্য অপেক্ষা করে আবার চেষ্টা করুন।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

The office terms people say in English stay in English letters where the app already does (লেজার, ব্যালান্স
শিট, রিটেইনড আর্নিংস). The file's type is `Messages`: a key missing here does not compile.

---

## 11.9 — `apps/app`: the report pages

### Helpers

**File: `apps/app/src/lib/reports.ts`** (new)

```ts
import { fiscalYearOf, shiftIsoDate } from '@omnivo/contracts';

// The report pages' dates, as ISO strings worked out from their parts. Never a Date in the local
// time zone: new Date('2026-07-01') is midnight UTC, which is still 30 June west of Greenwich.

export interface DateRange {
  from: string;
  to: string;
}

export const PERIOD_PRESETS = [
  'this_year',
  'last_year',
  'this_quarter',
  'last_quarter',
  'this_month',
  'last_month',
  'custom',
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const COMPARE_MODES = ['none', 'previous_period', 'previous_year'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export const COMPARE_AS_OF_MODES = ['none', 'year_end', 'previous_year'] as const;
export type CompareAsOfMode = (typeof COMPARE_AS_OF_MODES)[number];

function parts(iso: string): { year: number; month: number; day: number } {
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

function iso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

// Days since 1970, for counting the days of a range
function dayNumber(date: string): number {
  const { year, month, day } = parts(date);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function lastDayOf(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// The same day `months` months away; a day the target month does not have becomes its last day
// (31 March − 1 month = 28 or 29 February, not 3 March)
export function shiftMonths(date: string, months: number): string {
  const { year, month, day } = parts(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  return iso(targetYear, targetMonth, Math.min(day, lastDayOf(targetYear, targetMonth)));
}

function monthStart(date: string): string {
  const { year, month } = parts(date);
  return iso(year, month, 1);
}

function monthEnd(date: string): string {
  const { year, month } = parts(date);
  return iso(year, month, lastDayOf(year, month));
}

// The fiscal quarter that holds `date`: three-month blocks from the first month of the fiscal
// year (July–September is the first quarter of a July year)
function quarterStart(date: string, startMonth: number): string {
  const yearStart = fiscalYearOf(date, startMonth).start;
  const { year, month } = parts(date);
  const { year: y0, month: m0 } = parts(yearStart);
  const monthsIn = (year - y0) * 12 + (month - m0);
  return shiftMonths(yearStart, monthsIn - (monthsIn % 3));
}

// The dates of a preset on `today`. A period that is still running ends today, not on its last
// day: a report of days that have not happened yet only shows zeros.
export function presetRange(
  preset: Exclude<PeriodPreset, 'custom'>,
  today: string,
  startMonth: number,
): DateRange {
  switch (preset) {
    case 'this_year':
      return { from: fiscalYearOf(today, startMonth).start, to: today };
    case 'last_year': {
      const year = fiscalYearOf(
        shiftIsoDate(fiscalYearOf(today, startMonth).start, -1),
        startMonth,
      );
      return { from: year.start, to: year.end };
    }
    case 'this_quarter':
      return { from: quarterStart(today, startMonth), to: today };
    case 'last_quarter': {
      const from = shiftMonths(quarterStart(today, startMonth), -3);
      return { from, to: shiftIsoDate(shiftMonths(from, 3), -1) };
    }
    case 'this_month':
      return { from: monthStart(today), to: today };
    case 'last_month': {
      const from = shiftMonths(monthStart(today), -1);
      return { from, to: monthEnd(from) };
    }
  }
}

// The second column of a profit and loss.
// - previous_year: the same days a year earlier.
// - previous_period: the block of the same size just before. A range that starts on the first of
//   a month moves back by whole months (July–September → April–June, 1–15 October → 1–15
//   September), because months are not all the same length; any other range moves back by its
//   own number of days.
export function compareRange(range: DateRange, mode: CompareMode): DateRange | null {
  if (mode === 'none') return null;
  if (mode === 'previous_year') {
    return { from: shiftMonths(range.from, -12), to: shiftMonths(range.to, -12) };
  }
  const from = parts(range.from);
  if (from.day === 1) {
    const to = parts(range.to);
    const months = (to.year - from.year) * 12 + (to.month - from.month) + 1;
    const start = shiftMonths(range.from, -months);
    // A range that ends on a month's last day compares with a range that does too
    const end =
      range.to === monthEnd(range.to)
        ? monthEnd(shiftMonths(range.to, -months))
        : shiftMonths(range.to, -months);
    return { from: start, to: end };
  }
  const days = dayNumber(range.to) - dayNumber(range.from);
  const to = shiftIsoDate(range.from, -1);
  return { from: shiftIsoDate(to, -days), to };
}

// The second column of a balance sheet: the last day of the fiscal year before, or the same day
// a year earlier
export function compareAsOf(
  asOf: string,
  mode: CompareAsOfMode,
  startMonth: number,
): string | null {
  if (mode === 'none') return null;
  if (mode === 'year_end') return shiftIsoDate(fiscalYearOf(asOf, startMonth).start, -1);
  return shiftMonths(asOf, -12);
}
```

- **Every date from its parts, in UTC**, for the reason in `fiscalYearOf()`.
- **`shiftMonths()` keeps the day, or takes the month's last day**: 31 March minus a month is the end of
  February, not 3 March (what `Date.UTC` overflow would give).
- **A period that is still running ends today**, not on its last day: a report of days that have not happened
  shows only zeros.
- **Quarters count from the fiscal year's first month**: July–September is the first quarter of a July year.
- **"The period before" moves whole months when the range starts on the 1st**: July–September compares with
  April–June, and 1–15 October with 1–15 September. Months are not all the same length, so moving back by the
  number of days would compare 1 Jul–30 Sep with 2 Apr–30 Jun. Any other range moves back by its own length.

**File: `apps/app/src/lib/reports.spec.ts`** (new)

```ts
import { describe, expect, it } from 'vitest';

import { compareAsOf, compareRange, presetRange, shiftMonths } from './reports';

describe('shifting by months', () => {
  it('keeps the day, or takes the last day of a shorter month', () => {
    expect(shiftMonths('2026-09-23', -1)).toBe('2026-08-23');
    expect(shiftMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(shiftMonths('2028-03-31', -1)).toBe('2028-02-29');
    expect(shiftMonths('2026-01-15', -12)).toBe('2025-01-15');
    expect(shiftMonths('2026-11-30', 3)).toBe('2027-02-28');
  });
});

describe('period presets', () => {
  // 23 September 2026, a July–June fiscal year
  const today = '2026-09-23';

  it('runs this year, quarter and month up to today', () => {
    expect(presetRange('this_year', today, 7)).toEqual({ from: '2026-07-01', to: today });
    expect(presetRange('this_quarter', today, 7)).toEqual({ from: '2026-07-01', to: today });
    expect(presetRange('this_month', today, 7)).toEqual({ from: '2026-09-01', to: today });
  });

  it('gives whole periods for last year, quarter and month', () => {
    expect(presetRange('last_year', today, 7)).toEqual({ from: '2025-07-01', to: '2026-06-30' });
    expect(presetRange('last_quarter', today, 7)).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    });
    expect(presetRange('last_month', today, 7)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('counts quarters from the first month of the fiscal year', () => {
    // A July year: November is in its second quarter, October–December
    expect(presetRange('this_quarter', '2026-11-05', 7).from).toBe('2026-10-01');
    // A calendar year: the first quarter of 2027 is January–March
    expect(presetRange('last_quarter', '2027-02-10', 1)).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
    });
  });
});

describe('comparison periods', () => {
  it('compares a quarter with the quarter before, month end with month end', () => {
    expect(compareRange({ from: '2026-07-01', to: '2026-09-30' }, 'previous_period')).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    });
    expect(compareRange({ from: '2026-03-01', to: '2026-03-31' }, 'previous_period')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('compares a month so far with the same days of the month before', () => {
    expect(compareRange({ from: '2026-10-01', to: '2026-10-15' }, 'previous_period')).toEqual({
      from: '2026-09-01',
      to: '2026-09-15',
    });
  });

  it('moves any other range back by its own number of days', () => {
    expect(compareRange({ from: '2026-09-10', to: '2026-09-19' }, 'previous_period')).toEqual({
      from: '2026-08-31',
      to: '2026-09-09',
    });
  });

  it('compares with the same days a year earlier, and with nothing', () => {
    expect(compareRange({ from: '2026-07-01', to: '2026-09-23' }, 'previous_year')).toEqual({
      from: '2025-07-01',
      to: '2025-09-23',
    });
    expect(compareRange({ from: '2026-07-01', to: '2026-09-23' }, 'none')).toBeNull();
  });

  it('compares a balance sheet with the last year end, or the same day last year', () => {
    expect(compareAsOf('2026-09-23', 'year_end', 7)).toBe('2026-06-30');
    expect(compareAsOf('2028-02-29', 'previous_year', 7)).toBe('2027-02-28');
    expect(compareAsOf('2026-09-23', 'none', 7)).toBeNull();
  });
});
```

(The first run of these tests found a real bug: "last fiscal year" returned the fiscal year's `{ start, end }`
instead of `{ from, to }`. vitest does not type-check; the type check would have caught it too.)

**File: `apps/app/src/lib/queries.ts`** (change)

```diff
@@ -1,4 +1,12 @@
-import { type BranchStatus, type JournalStatus, type MemberSort, routes } from '@omnivo/contracts';
+import {
+  type BalanceSheetQuery,
+  type BranchStatus,
+  type JournalStatus,
+  type MemberSort,
+  type ProfitAndLossQuery,
+  routes,
+  type TrialBalanceQuery,
+} from '@omnivo/contracts';
 import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
 
 import { call } from './api';
@@ -165,3 +173,48 @@ export function periodLockQuery(tenantId: string) {
     queryFn: () => call(routes.periodLock.get),
   });
 }
+
+// The reports read the journal, so they live under ['journal', tenantId] too: posting, reversing
+// or closing a year refreshes every open report. keepPreviousData: changing a date keeps the old
+// numbers on screen until the new ones arrive, instead of an empty table in between.
+export function trialBalanceQuery(tenantId: string, query: TrialBalanceQuery) {
+  return queryOptions({
+    queryKey: ['journal', tenantId, 'trial-balance', query],
+    queryFn: () => call(routes.reports.trialBalance, { query }),
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function profitAndLossQuery(tenantId: string, query: ProfitAndLossQuery) {
+  return queryOptions({
+    queryKey: ['journal', tenantId, 'profit-and-loss', query],
+    queryFn: () => call(routes.reports.profitAndLoss, { query }),
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function balanceSheetQuery(tenantId: string, query: BalanceSheetQuery) {
+  return queryOptions({
+    queryKey: ['journal', tenantId, 'balance-sheet', query],
+    queryFn: () => call(routes.reports.balanceSheet, { query }),
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function fiscalYearsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['journal', tenantId, 'fiscal-years'],
+    queryFn: () => call(routes.fiscalYears.list),
+  });
+}
+
+// "My exports". The worker writes a file a few seconds after the click: while any export is still
+// being prepared, ask again every 2 seconds, and stop once none is (like the invitations' email).
+export function reportExportsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['report-exports', tenantId],
+    queryFn: async () => (await call(routes.reportExports.list, { query: { limit: 50 } })).items,
+    refetchInterval: (query) =>
+      query.state.data?.some((item) => item.status === 'pending') ? 2_000 : false,
+  });
+}
```

The reports live under `['journal', tenantId]`, so step 10's "after a save, refresh the journal" refreshes every
open report too, and so does a year-end close. `keepPreviousData` keeps the old numbers on screen while new
dates load, instead of an empty table between them. The exports poll every 2 seconds only while one is still
being prepared, like step 8's invitations.

### Shared pieces

**File: `apps/app/src/components/report-parts.tsx`** (new)

```tsx
import {
  Alert02Icon,
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  FileDownloadIcon,
  Pdf01Icon,
  Xls01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  DEFAULT_SETTINGS,
  type ExportFormat,
  isZeroMoney,
  type ReportExportInput,
  type ReportSection,
  routes,
  todayIn,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  DatePicker,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  Pill,
  SelectField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';

import { call } from '../lib/api';
import { balanceSide } from '../lib/journal';
import { settingsQuery } from '../lib/queries';
import { type DateRange, PERIOD_PRESETS, type PeriodPreset, presetRange } from '../lib/reports';
import { useSession } from '../lib/session-store';
import { failureOf } from './journal-parts';

// Shared by the three report pages. Here, not in a route file: each route is its own lazy chunk,
// and importing from one would pull that whole page into the others.

// Today and the fiscal year's first month, on the company's clock (not the browser's): the
// presets are worked out from them
export function useReportCalendar(): { today: string; startMonth: number } {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const settings = useQuery(settingsQuery(tenantId)).data;
  return {
    today: todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone),
    startMonth: settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
  };
}

// A report's period: a preset ("This fiscal year") until someone picks a date by hand, then
// "Custom dates" with what they picked. The preset's dates follow the settings once they load.
export function usePeriod(initial: Exclude<PeriodPreset, 'custom'> = 'this_year') {
  const { today, startMonth } = useReportCalendar();
  const [preset, setPreset] = useState<PeriodPreset>(initial);
  const [custom, setCustom] = useState<DateRange | null>(null);
  const range =
    preset === 'custom' && custom !== null
      ? custom
      : presetRange(preset === 'custom' ? initial : preset, today, startMonth);
  return {
    preset,
    range,
    // The API refuses a range that ends before it starts; the page says so under "To" instead
    // of asking
    valid: range.from !== '' && range.to !== '' && range.from <= range.to,
    choosePreset: (next: PeriodPreset) => {
      setPreset(next);
      setCustom(next === 'custom' ? range : null);
    },
    chooseRange: (next: DateRange) => {
      setPreset('custom');
      setCustom(next);
    },
  };
}

// "৳18,42,600.50": 2 decimals, so a statement's totals visibly add up (CLAUDE.md → Money)
export function useAmount(): (value: string) => string {
  const { format } = useLocale();
  return (value: string) => format.money(value, { decimals: 2 });
}

// The period: a preset, and the two dates it stands for. Changing a date makes it "Custom dates".
export function PeriodFields({
  preset,
  range,
  onPreset,
  onRange,
}: {
  preset: PeriodPreset;
  range: DateRange;
  onPreset: (preset: PeriodPreset) => void;
  onRange: (range: DateRange) => void;
}) {
  const { t } = useLocale();
  return (
    <>
      <SelectField
        label={t('reports.period')}
        value={preset}
        options={PERIOD_PRESETS.map((value) => ({ value, label: t(`reports.presets.${value}`) }))}
        onChange={(event) => {
          const next = PERIOD_PRESETS.find((value) => value === event.target.value);
          if (next) onPreset(next);
        }}
      />
      <Field id="report-from" label={t('reports.from')}>
        <DatePicker
          id="report-from"
          value={range.from}
          onChange={(from) => {
            onRange({ ...range, from });
          }}
        />
      </Field>
      <Field
        id="report-to"
        label={t('reports.to')}
        error={range.to !== '' && range.from > range.to ? 'report_range_invalid' : undefined}
      >
        <DatePicker
          id="report-to"
          value={range.to}
          onChange={(to) => {
            onRange({ ...range, to });
          }}
        />
      </Field>
    </>
  );
}

// Export → Excel or PDF. The click only asks; the worker writes the file and the bell says when
// it is ready, so a large report never holds the page.
export function ExportMenu({ request }: { request: (format: ExportFormat) => ReportExportInput }) {
  const { t, errorText } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: (format: ExportFormat) =>
      call(routes.reportExports.create, { body: request(format) }),
    onSuccess: async (_saved, format) => {
      toast(t('reports.export.started', { format: t(`reports.formats.${format}`) }));
      await queryClient.invalidateQueries({ queryKey: ['report-exports', tenantId] });
    },
    onError: (error) => {
      toast(errorText(failureOf(error) ?? 'unknown_error'));
    },
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" disabled={create.isPending}>
          <HugeiconsIcon icon={FileDownloadIcon} size={17} strokeWidth={1.5} />
          {t('reports.export.button')}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={16}
            strokeWidth={1.5}
            className="text-ink-3"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          icon={Xls01Icon}
          onSelect={() => {
            create.mutate('xlsx');
          }}
        >
          {t('reports.export.xlsx')}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={Pdf01Icon}
          onSelect={() => {
            create.mutate('pdf');
          }}
        >
          {t('reports.export.pdf')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// "Balanced" when the two sides are equal, "Out by ৳x" when not. The journal's rules make the
// second one impossible; the page still says it, because that is what a trial balance is for.
export function BalancePill({ difference }: { difference: string }) {
  const { t } = useLocale();
  const amount = useAmount();
  return isZeroMoney(difference) ? (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('reports.balanced')}
    </Pill>
  ) : (
    <Pill tone="crit" icon={Alert02Icon}>
      {t('reports.outBy', { amount: amount(balanceSide(difference).amount) })}
    </Pill>
  );
}

// CLAUDE.md → KPI strip: one card split by rules, a caption, a 26px value and an optional line
export function KpiStrip({
  cells,
}: {
  cells: { label: string; value: string; sub?: string | undefined }[];
}) {
  return (
    <Card className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      {cells.map((cell) => (
        <div key={cell.label} className="grid gap-1 px-5 py-4">
          <span className="text-caption text-ink-3">{cell.label}</span>
          <span className="text-kpi tracking-[-0.03em] tabular-nums">{cell.value}</span>
          {cell.sub !== undefined && (
            <span className="text-caption text-ink-3 tabular-nums">{cell.sub}</span>
          )}
        </div>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The statement table: a real <table> (screen readers read rows and column headers), inside a card
// that scrolls sideways on its own when the columns do not fit (CLAUDE.md → Page gutters). The
// account column stays put while the amounts scroll.

export interface StatementRow {
  key: string;
  // A ledger account's row links to its ledger; a group's does not
  accountId?: string | undefined;
  code?: string | undefined;
  name: string;
  depth: number;
  style: 'normal' | 'group' | 'heading' | 'total' | 'grand';
  hint?: string | undefined;
  // One cell per amount column: text as shown, or null for an empty cell
  cells: (ReactNode | null)[];
}

// The rows of one report section: the heading, its accounts and groups, and the total
export function sectionRows(
  section: ReportSection,
  labels: { heading: string; total: string },
  amount: (value: string) => string,
  withCompare: boolean,
): StatementRow[] {
  const cells = (value: string, compare: string | null) =>
    withCompare ? [amount(value), amount(compare ?? '0')] : [amount(value)];
  return [
    { key: `${section.type}-heading`, name: labels.heading, depth: 0, style: 'heading', cells: [] },
    ...section.rows.map((row): StatementRow => ({
      key: row.accountId,
      accountId: row.isGroup ? undefined : row.accountId,
      code: row.code,
      name: row.name,
      depth: row.depth + 1,
      style: row.isGroup ? 'group' : 'normal',
      cells: cells(row.amount, row.compareAmount),
    })),
    {
      key: `${section.type}-total`,
      name: labels.total,
      depth: 0,
      style: 'total',
      cells: cells(section.total, section.compareTotal),
    },
  ];
}

export function StatementTable({
  label,
  columns,
  rows,
  ledgerRange,
  empty,
}: {
  label: string;
  // The amount columns' headers; the first column is always "Account"
  columns: string[];
  rows: StatementRow[];
  // The dates the ledger opens with when an account is clicked
  ledgerRange: DateRange;
  empty?: ReactNode;
}) {
  const { t } = useLocale();
  if (empty && !rows.some((row) => row.style === 'normal' || row.style === 'group')) {
    return <>{empty}</>;
  }
  const footer = rows.filter((row) => row.style === 'grand');
  const body = rows.filter((row) => row.style !== 'grand');
  const sticky = 'sticky left-0 z-[1]';
  const row = (item: StatementRow) => {
    const strong = item.style !== 'normal';
    const background =
      item.style === 'total' || item.style === 'grand' ? 'bg-subtle' : 'bg-surface';
    return (
      <tr key={item.key} className={cn('border-t border-line', background)}>
        <th
          scope="row"
          className={cn(
            sticky,
            background,
            // Narrower on a phone, so the first amount still shows next to the name
            'min-w-[10rem] py-2.5 pr-4 text-left text-body-sm font-normal sm:min-w-[14rem]',
            item.style === 'heading' ? 'pt-4 text-caption font-medium text-ink-3' : 'text-ink-2',
            strong && item.style !== 'heading' && 'font-medium text-ink',
          )}
          // 20px, then 16px per level: the tree list's step (CLAUDE.md → Tree list)
          style={{ paddingLeft: 20 + item.depth * 16 }}
        >
          {item.accountId ? (
            <Link
              to="/ledger"
              search={{ account: item.accountId, from: ledgerRange.from, to: ledgerRange.to }}
              aria-label={t('reports.openLedger', { name: item.name })}
              className="underline-offset-3 hover:text-brand hover:underline"
            >
              <span className="font-mono text-ink-3 tabular-nums">{item.code}</span> {item.name}
            </Link>
          ) : (
            <>
              {item.code && <span className="font-mono text-ink-3 tabular-nums">{item.code} </span>}
              {item.name}
            </>
          )}
          {item.hint && (
            <span className="block text-caption font-normal text-ink-3">{item.hint}</span>
          )}
        </th>
        {item.cells.map((cell, index) => (
          <td
            key={index}
            className={cn(
              'min-w-[8.5rem] px-4 py-2.5 text-right text-body-sm whitespace-nowrap tabular-nums sm:px-5',
              strong ? 'font-medium text-ink' : 'text-ink-2',
            )}
          >
            {cell}
          </td>
        ))}
      </tr>
    );
  };
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-sm">
      <table className="w-full border-collapse">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="bg-subtle">
            <th
              scope="col"
              className={cn(
                sticky,
                'bg-subtle py-2.5 pr-4 pl-5 text-left text-caption font-medium text-ink-3',
              )}
            >
              {t('reports.account')}
            </th>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="px-5 py-2.5 text-right text-caption font-medium whitespace-nowrap text-ink-3"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{body.map(row)}</tbody>
        {footer.length > 0 && <tfoot>{footer.map(row)}</tfoot>}
      </table>
    </div>
  );
}
```

- **Here, not in a route file**: each route is its own lazy chunk; importing from one would pull that whole
  page into the others (the same reason as step 10's `journal-parts.tsx`).
- **`usePeriod()`**: a preset until someone picks a date by hand, then "Custom dates" with what they picked.
  `null` for "not picked yet", so the preset follows the settings (time zone, fiscal year) once they load.
  `valid` stops the query when `from` is after `to`; the "To" field shows `report_range_invalid` instead.
- **`ExportMenu`**: the click only asks. The toast says the bell will tell; the Exports list is refreshed.
- **`BalancePill`**: "Balanced" or "Out by ৳x" — never colour alone (CLAUDE.md: icon and label).
- **`KpiStrip`**: CLAUDE.md's KPI strip — one card split by rules, a 26px value, a caption. It stacks on a phone.
- **`StatementTable`** is a new component for this design system (proposed for CLAUDE.md in 11.13). Why not
  the DataTable: a statement is a tree with section headings, totals inside the table (`<tfoot>`) and no
  sorting, and its columns are few enough to stay a table on a phone. It is a real `<table>` (screen readers
  read row and column headers); it scrolls sideways **inside its card** when the columns do not fit, with the
  account column sticky (CLAUDE.md → Page gutters). The account column is narrower on a phone (`min-w-[10rem]`)
  so the first amount still shows next to the name (seen on the 390px screenshot). Indent is 16px per level,
  the tree list's step. A ledger account's name is a link to its ledger with the report's dates.

### The pages

**File: `apps/app/src/routes/trial-balance.tsx`** (new)

```tsx
import { TableIcon } from '@hugeicons/core-free-icons';
import { ACCOUNT_TYPES, isZeroMoney, subtractMoney, type TrialBalance } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';

import { useIsoDate } from '../components/journal-parts';
import {
  BalancePill,
  ExportMenu,
  PeriodFields,
  type StatementRow,
  StatementTable,
  useAmount,
  usePeriod,
} from '../components/report-parts';
import { balanceSide } from '../lib/journal';
import { useCan } from '../lib/permissions';
import { trialBalanceQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// The rows of the table: one heading per account type, then its accounts in code order. The
// totals row shows both sides of the opening and closing balances, one above the other.
function useRows(): (report: TrialBalance) => StatementRow[] {
  const { t } = useLocale();
  const amount = useAmount();
  // "৳1,200.00 Cr", or empty for zero
  const balance = (value: string) => {
    const { amount: size, side } = balanceSide(value);
    if (side === null) return null;
    return t(side === 'debit' ? 'ledger.debitBalance' : 'ledger.creditBalance', {
      amount: amount(size),
    });
  };
  const moved = (value: string) => (isZeroMoney(value) ? null : amount(value));
  const pair = (debit: string, credit: string) => (
    <span className="grid">
      <span>{t('ledger.debitBalance', { amount: amount(debit) })}</span>
      <span>{t('ledger.creditBalance', { amount: amount(credit) })}</span>
    </span>
  );
  return (report) => [
    ...ACCOUNT_TYPES.flatMap((type): StatementRow[] => {
      const rows = report.rows.filter((row) => row.type === type);
      if (rows.length === 0) return [];
      return [
        {
          key: `${type}-heading`,
          name: t(`reports.sections.${type}`),
          depth: 0,
          style: 'heading',
          cells: [],
        },
        ...rows.map((row): StatementRow => ({
          key: row.accountId,
          accountId: row.accountId,
          code: row.code,
          name: row.name,
          depth: 0,
          style: 'normal',
          cells: [balance(row.opening), moved(row.debit), moved(row.credit), balance(row.closing)],
        })),
      ];
    }),
    {
      key: 'total',
      name: t('reports.total'),
      depth: 0,
      style: 'grand',
      cells: [
        pair(report.totals.openingDebit, report.totals.openingCredit),
        amount(report.totals.debit),
        amount(report.totals.credit),
        pair(report.totals.closingDebit, report.totals.closingCredit),
      ],
    },
  ];
}

export function TrialBalancePage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.report.read');
  const showDate = useIsoDate();
  const period = usePeriod();
  const query = { from: period.range.from, to: period.range.to };
  const { data, isError } = useQuery({
    ...trialBalanceQuery(tenantId, query),
    enabled: canRead && period.valid,
  });
  const rowsOf = useRows();

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('reports.trialBalance.title')}
        description={t('reports.trialBalance.description')}
        actions={
          canRead && (
            <ExportMenu request={(format) => ({ report: 'trial_balance', format, query })} />
          )
        }
      />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.report.read' })}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <PeriodFields
              preset={period.preset}
              range={period.range}
              onPreset={period.choosePreset}
              onRange={period.chooseRange}
            />
          </div>
          {isError && <p className="text-body-sm text-crit">{t('reports.loadFailed')}</p>}
          {data && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-label text-ink-3 tabular-nums">
                  {t('reports.range', {
                    from: showDate(query.from),
                    to: showDate(query.to),
                  })}
                </p>
                {data.rows.length > 0 && (
                  <BalancePill
                    difference={subtractMoney(data.totals.closingDebit, data.totals.closingCredit)}
                  />
                )}
              </div>
              <StatementTable
                label={t('reports.trialBalance.title')}
                columns={[
                  t('reports.trialBalance.opening'),
                  t('reports.trialBalance.debit'),
                  t('reports.trialBalance.credit'),
                  t('reports.trialBalance.closing'),
                ]}
                rows={rowsOf(data)}
                ledgerRange={query}
                empty={
                  <EmptyState
                    icon={TableIcon}
                    title={t('reports.trialBalance.emptyTitle')}
                    description={t('reports.trialBalance.emptyBody')}
                  />
                }
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
```

Grouped by type (assets, liabilities…). The totals row shows both sides of the opening and the closing balances,
one above the other, and the movement totals: an accountant checks that each pair is equal. The pill checks the
closing pair.

**File: `apps/app/src/routes/profit-and-loss.tsx`** (new)

```tsx
import { ChartIncreaseIcon } from '@hugeicons/core-free-icons';
import type { ProfitAndLossQuery } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState, PageHeader, SelectField } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useIsoDate } from '../components/journal-parts';
import {
  ExportMenu,
  KpiStrip,
  PeriodFields,
  sectionRows,
  StatementTable,
  useAmount,
  usePeriod,
} from '../components/report-parts';
import { useCan } from '../lib/permissions';
import { branchesQuery, profitAndLossQuery } from '../lib/queries';
import { COMPARE_MODES, type CompareMode, compareRange } from '../lib/reports';
import { useSession } from '../lib/session-store';

export function ProfitAndLossPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.report.read');
  const showDate = useIsoDate();
  const amount = useAmount();
  const period = usePeriod();
  const [compare, setCompare] = useState<CompareMode>('none');
  // '' = every branch; the select's own empty value
  const [branchId, setBranchId] = useState('');
  const branches = useQuery({ ...branchesQuery(tenantId, 'active'), enabled: canRead }).data;

  const second = compareRange(period.range, compare);
  // Only the parts that are set: an absent key, not `undefined`, is what the contract allows
  // (exactOptionalPropertyTypes), and it keeps the query key short
  const query: ProfitAndLossQuery = {
    from: period.range.from,
    to: period.range.to,
    ...(second && { compareFrom: second.from, compareTo: second.to }),
    ...(branchId !== '' && { branchId }),
  };
  const { data, isError } = useQuery({
    ...profitAndLossQuery(tenantId, query),
    enabled: canRead && period.valid,
  });
  const label = (range: { from: string; to: string }) =>
    t('reports.range', { from: showDate(range.from), to: showDate(range.to) });
  const versus = (value: string | null) =>
    value === null ? undefined : t('reports.vs', { amount: amount(value) });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('reports.profitAndLoss.title')}
        description={t('reports.profitAndLoss.description')}
        actions={
          canRead && (
            <ExportMenu request={(format) => ({ report: 'profit_and_loss', format, query })} />
          )
        }
      />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.report.read' })}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 xl:grid-cols-5">
            <PeriodFields
              preset={period.preset}
              range={period.range}
              onPreset={period.choosePreset}
              onRange={period.chooseRange}
            />
            <SelectField
              label={t('reports.compare')}
              value={compare}
              options={COMPARE_MODES.map((value) => ({
                value,
                label: t(`reports.compareModes.${value}`),
              }))}
              onChange={(event) => {
                const next = COMPARE_MODES.find((value) => value === event.target.value);
                if (next) setCompare(next);
              }}
            />
            <SelectField
              label={t('reports.branch')}
              value={branchId}
              options={[
                { value: '', label: t('reports.allBranches') },
                ...(branches ?? []).map((branch) => ({
                  value: branch.id,
                  label: `${branch.code} · ${branch.name}`,
                })),
              ]}
              onChange={(event) => {
                setBranchId(event.target.value);
              }}
            />
          </div>
          {isError && <p className="text-body-sm text-crit">{t('reports.loadFailed')}</p>}
          {data && (
            <>
              <KpiStrip
                cells={[
                  {
                    label: t('reports.totalOf.income'),
                    value: amount(data.income.total),
                    sub: versus(data.income.compareTotal),
                  },
                  {
                    label: t('reports.totalOf.expense'),
                    value: amount(data.expense.total),
                    sub: versus(data.expense.compareTotal),
                  },
                  {
                    label: t('reports.profitAndLoss.netProfit'),
                    value: amount(data.netProfit),
                    sub: versus(data.compareNetProfit),
                  },
                ]}
              />
              <StatementTable
                label={t('reports.profitAndLoss.title')}
                columns={[label(period.range), ...(second ? [label(second)] : [])]}
                rows={[
                  ...sectionRows(
                    data.income,
                    { heading: t('reports.sections.income'), total: t('reports.totalOf.income') },
                    amount,
                    second !== null,
                  ),
                  ...sectionRows(
                    data.expense,
                    {
                      heading: t('reports.sections.expense'),
                      total: t('reports.totalOf.expense'),
                    },
                    amount,
                    second !== null,
                  ),
                  {
                    key: 'net-profit',
                    name: t('reports.profitAndLoss.netProfit'),
                    depth: 0,
                    style: 'grand',
                    cells: [
                      amount(data.netProfit),
                      ...(second ? [amount(data.compareNetProfit ?? '0')] : []),
                    ],
                  },
                ]}
                ledgerRange={period.range}
                empty={
                  <EmptyState
                    icon={ChartIncreaseIcon}
                    title={t('reports.profitAndLoss.emptyTitle')}
                    description={t('reports.profitAndLoss.emptyBody')}
                  />
                }
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
```

The query object holds only the parts that are set (`exactOptionalPropertyTypes`: an absent key is not the same
as `undefined`), which also keeps the query key short. The KPI strip shows the comparison as "vs ৳x".

**File: `apps/app/src/routes/balance-sheet.tsx`** (new)

```tsx
import { PieChartIcon } from '@hugeicons/core-free-icons';
import { addMoney, type BalanceSheetQuery, fiscalYearOf, subtractMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DatePicker, EmptyState, Field, PageHeader, SelectField } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useIsoDate } from '../components/journal-parts';
import {
  BalancePill,
  ExportMenu,
  KpiStrip,
  sectionRows,
  type StatementRow,
  StatementTable,
  useAmount,
  useReportCalendar,
} from '../components/report-parts';
import { useCan } from '../lib/permissions';
import { balanceSheetQuery } from '../lib/queries';
import { COMPARE_AS_OF_MODES, type CompareAsOfMode, compareAsOf } from '../lib/reports';
import { useSession } from '../lib/session-store';

export function BalanceSheetPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.report.read');
  const showDate = useIsoDate();
  const amount = useAmount();
  const { today, startMonth } = useReportCalendar();
  // null = today, which follows the company's clock once the settings arrive
  const [picked, setPicked] = useState<string | null>(null);
  const [compare, setCompare] = useState<CompareAsOfMode>('none');
  const asOf = picked ?? today;
  const second = compareAsOf(asOf, compare, startMonth);
  const query: BalanceSheetQuery = { asOf, ...(second !== null && { compareAsOf: second }) };
  const { data, isError } = useQuery({
    ...balanceSheetQuery(tenantId, query),
    enabled: canRead && asOf !== '',
  });
  const asAt = (date: string) => t('reports.asAt', { date: showDate(date) });
  const withCompare = second !== null;
  const cells = (value: string, other: string | null) =>
    withCompare ? [amount(value), amount(other ?? '0')] : [amount(value)];
  const versus = (value: string | null) =>
    value === null ? undefined : t('reports.vs', { amount: amount(value) });
  // Equity ends with the profit no year-end close has moved in yet, and its total includes it
  const equityTotal = data ? addMoney(data.equity.total, data.profitNotClosed) : '0';
  const equityCompare = data?.equity.compareTotal ?? null;
  const profitCompare = data?.compareProfitNotClosed ?? null;
  const compareEquityTotal =
    equityCompare === null || profitCompare === null
      ? null
      : addMoney(equityCompare, profitCompare);

  const rows = (): StatementRow[] => {
    if (!data) return [];
    const equity = sectionRows(
      data.equity,
      { heading: t('reports.sections.equity'), total: t('reports.totalOf.equity') },
      amount,
      withCompare,
    );
    return [
      ...sectionRows(
        data.asset,
        { heading: t('reports.sections.asset'), total: t('reports.totalOf.asset') },
        amount,
        withCompare,
      ),
      ...sectionRows(
        data.liability,
        { heading: t('reports.sections.liability'), total: t('reports.totalOf.liability') },
        amount,
        withCompare,
      ),
      ...equity.slice(0, -1),
      {
        key: 'profit-not-closed',
        name: t('reports.balanceSheet.profitNotClosed'),
        hint: t('reports.balanceSheet.profitNotClosedHint'),
        depth: 1,
        style: 'normal',
        cells: cells(data.profitNotClosed, data.compareProfitNotClosed),
      },
      {
        key: 'equity-total',
        name: t('reports.totalOf.equity'),
        depth: 0,
        style: 'total',
        cells: cells(equityTotal, compareEquityTotal),
      },
      {
        key: 'liabilities-and-equity',
        name: t('reports.balanceSheet.liabilitiesAndEquity'),
        depth: 0,
        style: 'grand',
        cells: cells(data.liabilitiesAndEquity, data.compareLiabilitiesAndEquity),
      },
    ];
  };

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('reports.balanceSheet.title')}
        description={t('reports.balanceSheet.description')}
        actions={
          canRead && (
            <ExportMenu request={(format) => ({ report: 'balance_sheet', format, query })} />
          )
        }
      />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.report.read' })}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field id="report-as-of" label={t('reports.asOf')}>
              <DatePicker id="report-as-of" value={asOf} onChange={setPicked} />
            </Field>
            <SelectField
              label={t('reports.compare')}
              value={compare}
              options={COMPARE_AS_OF_MODES.map((value) => ({
                value,
                label: t(`reports.compareAsOfModes.${value}`),
              }))}
              onChange={(event) => {
                const next = COMPARE_AS_OF_MODES.find((value) => value === event.target.value);
                if (next) setCompare(next);
              }}
            />
          </div>
          {isError && <p className="text-body-sm text-crit">{t('reports.loadFailed')}</p>}
          {data && (
            <>
              <KpiStrip
                cells={[
                  {
                    label: t('reports.totalOf.asset'),
                    value: amount(data.asset.total),
                    sub: versus(data.asset.compareTotal),
                  },
                  {
                    label: t('reports.totalOf.liability'),
                    value: amount(data.liability.total),
                    sub: versus(data.liability.compareTotal),
                  },
                  {
                    label: t('reports.totalOf.equity'),
                    value: amount(equityTotal),
                    sub: versus(compareEquityTotal),
                  },
                ]}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-label text-ink-3 tabular-nums">{asAt(asOf)}</p>
                <BalancePill
                  difference={subtractMoney(data.asset.total, data.liabilitiesAndEquity)}
                />
              </div>
              <StatementTable
                label={t('reports.balanceSheet.title')}
                columns={[asAt(asOf), ...(second === null ? [] : [asAt(second)])]}
                rows={rows()}
                // An account's ledger from the start of the fiscal year up to the day
                ledgerRange={{ from: fiscalYearOf(asOf, startMonth).start, to: asOf }}
                empty={
                  <EmptyState
                    icon={PieChartIcon}
                    title={t('reports.balanceSheet.emptyTitle')}
                    description={t('reports.balanceSheet.emptyBody')}
                  />
                }
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
```

`picked` is `null` until a date is chosen, so "today" follows the company's time zone once the settings arrive.
The equity totals are worked out once and used by both the strip and the table, so the two can never disagree.
An account's ledger opens from the start of the fiscal year up to the day.

**File: `apps/app/src/routes/report-exports.tsx`** (new)

```tsx
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Download04Icon,
  FileDownloadIcon,
  Pdf01Icon,
  Xls01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  DEFAULT_SETTINGS,
  isExportFormat,
  isReportKind,
  type ReportExport,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  Pill,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useIsoDate } from '../components/journal-parts';
import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { reportExportsQuery, settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<ReportExport>();

function StatusPill({ status }: { status: ReportExport['status'] }) {
  const { t } = useLocale();
  if (status === 'ready') {
    return (
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {t('exports.statuses.ready')}
      </Pill>
    );
  }
  if (status === 'failed') {
    return (
      <Pill tone="crit" icon={Alert02Icon}>
        {t('exports.statuses.failed')}
      </Pill>
    );
  }
  return (
    <Pill tone="warn" icon={Clock01Icon}>
      {t('exports.statuses.pending')}
    </Pill>
  );
}

export function ReportExportsPage() {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.report.read');
  const showDate = useIsoDate();
  const { data, isError } = useQuery({ ...reportExportsQuery(tenantId), enabled: canRead });
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;

  // A fresh short-lived link each time, so a link from an old page never lasts. A click on a
  // hidden <a download>, not a page change: the storage sends the file as an attachment under its
  // own name, and the page stays where it is (the mock's same-origin blob takes the name from the
  // download attribute instead).
  const download = useMutation({
    mutationFn: async (item: ReportExport) => ({
      item,
      signed: await call(routes.reportExports.download, { params: { id: item.id } }),
    }),
    onSuccess: ({ item, signed }) => {
      const link = document.createElement('a');
      link.href = signed.url;
      link.download = item.fileName ?? '';
      link.click();
    },
    onError: () => {
      toast(t('exports.downloadFailed'));
    },
  });

  const columns = useMemo(() => {
    // "1 Jul 2026 – 30 Sep 2026" or "As at 30 Sep 2026", from the query the page sent
    const period = (query: Record<string, string>) => {
      if (query.asOf !== undefined) return t('reports.asAt', { date: showDate(query.asOf) });
      if (query.from !== undefined && query.to !== undefined) {
        return t('reports.range', { from: showDate(query.from), to: showDate(query.to) });
      }
      return '';
    };
    return column.columns([
      column.accessor('report', {
        header: t('exports.columns.report'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-medium text-ink">
              {/* A report this app does not know yet (a newer server): its raw name */}
              {isReportKind(row.original.report)
                ? t(`reports.kinds.${row.original.report}`)
                : row.original.report}
            </span>
            <span className="text-caption text-ink-3 tabular-nums">
              {period(row.original.query)}
            </span>
          </span>
        ),
      }),
      column.accessor('format', {
        header: t('exports.columns.format'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ getValue }) => {
          const value = getValue();
          return (
            <span className="inline-flex items-center gap-1.5">
              <HugeiconsIcon
                icon={value === 'pdf' ? Pdf01Icon : Xls01Icon}
                size={16}
                strokeWidth={1.5}
                className="text-ink-3"
              />
              {isExportFormat(value) ? t(`reports.formats.${value}`) : value}
            </span>
          );
        },
      }),
      column.accessor('createdAt', {
        header: t('exports.columns.created'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => (
          <span className="tabular-nums">{format.dateTime(new Date(getValue()), timeZone)}</span>
        ),
      }),
      column.accessor('status', {
        header: t('exports.columns.status'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ getValue }) => <StatusPill status={getValue()} />,
      }),
      column.display({
        id: 'download',
        header: () => <span className="sr-only">{t('exports.download')}</span>,
        // On a phone's card: top right, where an action needs no label
        meta: { align: 'end', card: 'trailing' },
        cell: ({ row }) =>
          row.original.status === 'ready' ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={download.isPending}
              onClick={() => {
                download.mutate(row.original);
              }}
            >
              <HugeiconsIcon icon={Download04Icon} size={16} strokeWidth={1.5} />
              {t('exports.download')}
            </Button>
          ) : null,
      }),
    ]);
  }, [t, format, showDate, timeZone, download]);

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader title={t('exports.title')} description={t('exports.description')} />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.report.read' })}
        </p>
      ) : (
        <>
          {isError && <p className="text-body-sm text-crit">{t('exports.loadFailed')}</p>}
          {data && (
            <DataTable
              label={t('exports.title')}
              data={data}
              columns={columns}
              getRowId={(item) => item.id}
              empty={
                <EmptyState
                  icon={FileDownloadIcon}
                  title={t('exports.emptyTitle')}
                  description={t('exports.emptyBody')}
                />
              }
            />
          )}
        </>
      )}
    </div>
  );
}
```

- **A fresh signed link per click**: a link copied from an old page never lasts.
- **An `<a download>` click, not a page change.** The storage sends the file as an attachment, so the page stays
  put; the mock's blob link (same origin) takes the name from the `download` attribute. Playwright sees both as
  a download.
- **On a phone's card the Download button is the card's trailing slot.** As a "detail" it showed its column id
  ("download") as a label, because its header is not text (seen on the 390px screenshot).

**File: `apps/app/src/routes/year-end.tsx`** (new)

```tsx
import {
  CalendarLock01Icon,
  CheckmarkCircle02Icon,
  SquareUnlock02Icon,
} from '@hugeicons/core-free-icons';
import { type FiscalYear, routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  PageHeader,
  Pill,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { useIsoDate } from '../components/journal-parts';
import { useAmount, useReportCalendar } from '../components/report-parts';
import { ApiRequestError, call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { fiscalYearsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<FiscalYear>();

interface Action {
  kind: 'close' | 'reopen';
  year: FiscalYear;
}

// The question before a close or a reopen, and the server's answer if it says no. The errors
// that carry a number (drafts dated in the year) are shown with it.
function ConfirmYear({ action, onDone }: { action: Action; onDone: () => void }) {
  const { t, errorText } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const amount = useAmount();
  const showDate = useIsoDate();
  const { year, kind } = action;
  const run = useMutation({
    mutationFn: () =>
      call(kind === 'close' ? routes.fiscalYears.close : routes.fiscalYears.reopen, {
        body: { end: year.end },
      }),
    onSuccess: async () => {
      // The closing entry, the lock date and every report change: refresh the whole journal
      await queryClient.invalidateQueries({ queryKey: ['journal', tenantId] });
      toast(t(kind === 'close' ? 'yearEnd.closed' : 'yearEnd.reopened', { label: year.label }));
      onDone();
    },
  });
  const failure =
    run.error instanceof ApiRequestError
      ? errorText(run.error.code, run.error.problem.params)
      : run.error
        ? errorText('unknown_error')
        : undefined;
  return (
    <DialogContent
      title={t(kind === 'close' ? 'yearEnd.closeTitle' : 'yearEnd.reopenTitle', {
        label: year.label,
      })}
      description={
        kind === 'close'
          ? t('yearEnd.closeBody', { amount: amount(year.netProfit), date: showDate(year.end) })
          : t('yearEnd.reopenBody', {
              number: year.closingEntry?.number ?? '',
              date: showDate(year.start),
            })
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={run.isPending}
            onClick={() => {
              run.mutate();
            }}
          >
            {run.isPending
              ? t('common.saving')
              : t(kind === 'close' ? 'yearEnd.confirmClose' : 'yearEnd.confirmReopen')}
          </Button>
        </>
      }
    >
      {failure !== undefined && <FormAlert message={failure} />}
    </DialogContent>
  );
}

export function YearEndPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const can = useCan();
  const canRead = can('accounting.journal.read');
  const canClose = can('accounting.period.close');
  const showDate = useIsoDate();
  const amount = useAmount();
  const { today } = useReportCalendar();
  const { data, isError } = useQuery({ ...fiscalYearsQuery(tenantId), enabled: canRead });
  const [action, setAction] = useState<Action | null>(null);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('label', {
          header: t('yearEnd.columns.year'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-medium text-ink">
                {t('yearEnd.label', { label: row.original.label })}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {t('reports.range', {
                  from: showDate(row.original.start),
                  to: showDate(row.original.end),
                })}
              </span>
            </span>
          ),
        }),
        column.accessor('netProfit', {
          header: t('yearEnd.columns.profit'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => amount(getValue()),
        }),
        column.accessor('status', {
          header: t('yearEnd.columns.status'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => {
            const year = row.original;
            return (
              <span className="grid justify-items-start gap-1">
                {year.status === 'closed' ? (
                  <Pill tone="good" icon={CheckmarkCircle02Icon}>
                    {t('yearEnd.statuses.closed')}
                  </Pill>
                ) : (
                  <Pill tone="neutral" icon={SquareUnlock02Icon}>
                    {t('yearEnd.statuses.open')}
                  </Pill>
                )}
                {year.closingEntry && (
                  <Link
                    to="/journal/$entryId"
                    params={{ entryId: year.closingEntry.id }}
                    className="text-caption font-medium text-brand underline-offset-3 hover:underline"
                  >
                    {t('yearEnd.closingEntry', { number: year.closingEntry.number })}
                  </Link>
                )}
                {year.status === 'open' && year.end >= today && (
                  <span className="text-caption text-ink-3">
                    {t('yearEnd.endsOn', { date: showDate(year.end) })}
                  </span>
                )}
                {year.drafts > 0 && (
                  <span className="text-caption text-warn">
                    {t('yearEnd.drafts', { count: year.drafts })}
                  </span>
                )}
              </span>
            );
          },
        }),
        column.display({
          id: 'action',
          header: () => <span className="sr-only">{t('yearEnd.close')}</span>,
          // On a phone's card: top right, where an action needs no label
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => {
            const year = row.original;
            if (!canClose) return null;
            // Only a year that is over can close; the server says if an earlier one must go first
            if (year.status === 'open' && year.end < today) {
              return (
                <Button
                  size="sm"
                  onClick={() => {
                    setAction({ kind: 'close', year });
                  }}
                >
                  {t('yearEnd.close')}
                </Button>
              );
            }
            if (year.status === 'closed') {
              return (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setAction({ kind: 'reopen', year });
                  }}
                >
                  {t('yearEnd.reopen')}
                </Button>
              );
            }
            return null;
          },
        }),
      ]),
    [t, showDate, amount, today, canClose],
  );

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader
        title={t('yearEnd.title')}
        description={
          data?.lockDate
            ? `${t('yearEnd.description')} · ${t('yearEnd.lockedUntil', { date: showDate(data.lockDate) })}`
            : t('yearEnd.description')
        }
      />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.journal.read' })}
        </p>
      ) : (
        <>
          {!canClose && <p className="text-body-sm text-ink-3">{t('yearEnd.readOnly')}</p>}
          {isError && <p className="text-body-sm text-crit">{t('yearEnd.loadFailed')}</p>}
          {data && (
            <DataTable
              label={t('yearEnd.title')}
              data={data.items}
              columns={columns}
              getRowId={(year) => year.end}
              empty={
                <EmptyState
                  icon={CalendarLock01Icon}
                  title={t('yearEnd.title')}
                  description={t('yearEnd.description')}
                />
              }
            />
          )}
        </>
      )}
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
      >
        {action && (
          <ConfirmYear
            // A new dialog per year: no error from the last one carries over
            key={`${action.kind}-${action.year.end}`}
            action={action}
            onDone={() => {
              setAction(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

- **Close shows on every open year that is over**; the server says when an earlier one must go first. Reopen
  shows on every closed year; the server says when a later one is in the way. The page does not repeat the
  rules, it shows the answer.
- **The error with a number** (`year_has_drafts`) is shown with its params (`errorText(code, params)`);
  `FormAlert` alone would show "{{count}}".
- **`key` per year and action**: a new dialog per click, so an error from the last one never carries over.
- **The action is the card's trailing slot on a phone**, for the same reason as the Download button.

### The pages around them

**File: `apps/app/src/routes/ledger.tsx`** (change)

```diff
@@ -42,16 +42,19 @@ function useBalanceText(): (value: string) => string {
 export function LedgerPage() {
   const { t, format } = useLocale();
   const navigate = useNavigate();
-  const { account: accountId = '' } = useSearch({ strict: false });
+  const { account: accountId = '', from: fromParam, to: toParam } = useSearch({ strict: false });
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
   const canRead = useCan()('accounting.journal.read');
   const showDate = useIsoDate();
   const balanceText = useBalanceText();
   const accounts = useQuery({ ...accountsQuery(tenantId), enabled: canRead }).data;
   const settings = useQuery(settingsQuery(tenantId)).data;
-  // Until the person picks dates: from the start of this fiscal year to today, in the company's
-  // time zone. null = "not picked", so the default follows the settings once they arrive.
-  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
+  // Until the person picks dates: the dates in the address (a report's link), or else from the
+  // start of this fiscal year to today, in the company's time zone. null = "not picked", so the
+  // default follows the settings once they arrive.
+  const [range, setRange] = useState<{ from: string; to: string } | null>(
+    fromParam !== undefined && toParam !== undefined ? { from: fromParam, to: toParam } : null,
+  );
   const today = todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone);
   const { from, to } = range ?? {
     from: fiscalYearStart(
```

**File: `apps/app/src/router.tsx`** (change)

```diff
@@ -135,12 +135,19 @@ const journalEntryRoute = createRoute({
 });
 
 // ?account=<id>: an entry's line links straight to its account's ledger, and the address can be
-// bookmarked. Anything else in the query string is dropped, not trusted.
+// bookmarked. ?from=&to=: a report's account opens with the report's own dates (step 11).
+// Anything else in the query string is dropped, and a date that is not a date is not trusted.
+const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
 const ledgerRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/ledger',
-  validateSearch: (search: Record<string, unknown>): { account?: string } =>
-    typeof search.account === 'string' ? { account: search.account } : {},
+  validateSearch: (
+    search: Record<string, unknown>,
+  ): { account?: string; from?: string; to?: string } => ({
+    ...(typeof search.account === 'string' && { account: search.account }),
+    ...(typeof search.from === 'string' && ISO_DATE.test(search.from) && { from: search.from }),
+    ...(typeof search.to === 'string' && ISO_DATE.test(search.to) && { to: search.to }),
+  }),
   component: lazyRouteComponent(() => import('./routes/ledger'), 'LedgerPage'),
 });
 
@@ -150,6 +157,36 @@ const openingBalancesRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/opening-balances'), 'OpeningBalancesPage'),
 });
 
+const yearEndRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/year-end',
+  component: lazyRouteComponent(() => import('./routes/year-end'), 'YearEndPage'),
+});
+
+const trialBalanceRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/trial-balance',
+  component: lazyRouteComponent(() => import('./routes/trial-balance'), 'TrialBalancePage'),
+});
+
+const profitAndLossRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/profit-and-loss',
+  component: lazyRouteComponent(() => import('./routes/profit-and-loss'), 'ProfitAndLossPage'),
+});
+
+const balanceSheetRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/balance-sheet',
+  component: lazyRouteComponent(() => import('./routes/balance-sheet'), 'BalanceSheetPage'),
+});
+
+const reportExportsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/exports',
+  component: lazyRouteComponent(() => import('./routes/report-exports'), 'ReportExportsPage'),
+});
+
 const teamRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/team',
@@ -196,6 +233,11 @@ const routeTree = rootRoute.addChildren([
     journalEntryRoute,
     ledgerRoute,
     openingBalancesRoute,
+    yearEndRoute,
+    trialBalanceRoute,
+    profitAndLossRoute,
+    balanceSheetRoute,
+    reportExportsRoute,
     teamRoute,
     rolesRoute,
     auditLogRoute,
```

`from` and `to` must look like dates, or they are dropped: the address is input from outside.

**File: `apps/app/src/routes/app-shell.tsx`** (change)

```diff
@@ -2,14 +2,19 @@ import {
   BalanceScaleIcon,
   Book02Icon,
   BookOpen02Icon,
+  CalendarLock01Icon,
+  ChartIncreaseIcon,
   DashboardSquare01Icon,
+  FileDownloadIcon,
   LayoutGridIcon,
   LeftToRightListNumberIcon,
   Logout01Icon,
   Notebook02Icon,
+  PieChartIcon,
   SecurityCheckIcon,
   Settings02Icon,
   Store01Icon,
+  TableIcon,
   UnfoldMoreIcon,
   UserCircleIcon,
   UserGroupIcon,
@@ -250,9 +255,29 @@ export function AppShell() {
                 <NavLink to="/opening-balances" icon={BalanceScaleIcon}>
                   {t('nav.openingBalances')}
                 </NavLink>
+                <NavLink to="/year-end" icon={CalendarLock01Icon}>
+                  {t('nav.yearEnd')}
+                </NavLink>
               </>
             )}
           </NavGroup>
+          {/* The statements: for anyone with the report permission, journal or not (a director) */}
+          {can('accounting.report.read') && (
+            <NavGroup label={t('nav.reports')}>
+              <NavLink to="/reports/trial-balance" icon={TableIcon}>
+                {t('nav.trialBalance')}
+              </NavLink>
+              <NavLink to="/reports/profit-and-loss" icon={ChartIncreaseIcon}>
+                {t('nav.profitAndLoss')}
+              </NavLink>
+              <NavLink to="/reports/balance-sheet" icon={PieChartIcon}>
+                {t('nav.balanceSheet')}
+              </NavLink>
+              <NavLink to="/reports/exports" icon={FileDownloadIcon}>
+                {t('nav.exports')}
+              </NavLink>
+            </NavGroup>
+          )}
           <NavGroup label={t('nav.workspace')}>
             {(can('core.user.read') || can('core.user.invite')) && (
               <NavLink to="/team" icon={UserGroupIcon}>
```

"Year-end close" sits in the Accounting group (it is the journal's work); the reports get their own group, shown
to anyone with `accounting.report.read` — journal or not.

**File: `apps/app/src/components/notification-bell.tsx`** (change)

```diff
@@ -2,8 +2,11 @@ import { Notification03Icon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
   DEFAULT_SETTINGS,
+  isExportFormat,
   isNotificationType,
+  isReportKind,
   type Notification,
+  type NotificationParams,
   type NotificationType,
   routes,
 } from '@omnivo/contracts';
@@ -23,6 +26,8 @@ const TARGET = {
   'workspace.ready': '/roles',
   'member.joined': '/team',
   'invitation.failed': '/team',
+  'report.ready': '/reports/exports',
+  'report.failed': '/reports/exports',
 } as const satisfies Record<NotificationType, string>;
 
 // The badge stops at 9+: a two-digit count would not fit the 18px circle, and past nine the exact
@@ -31,6 +36,22 @@ function badgeText(count: number): string {
   return count > 9 ? '9+' : String(count);
 }
 
+// An export's report and format arrive as keys (trial_balance, xlsx): their words go into the text.
+// A key this app does not know (a newer server) stays as it is.
+function useWords() {
+  const { t } = useLocale();
+  return (params: NotificationParams): NotificationParams => {
+    const { report, format } = params;
+    return {
+      ...params,
+      ...(typeof report === 'string' &&
+        isReportKind(report) && { report: t(`reports.kinds.${report}`) }),
+      ...(typeof format === 'string' &&
+        isExportFormat(format) && { format: t(`reports.formats.${format}`) }),
+    };
+  };
+}
+
 function Item({
   notification,
   timeZone,
@@ -41,6 +62,7 @@ function Item({
   onOpen: () => void;
 }) {
   const { t, format } = useLocale();
+  const words = useWords();
   const unread = notification.readAt === null;
   return (
     <li>
@@ -59,7 +81,7 @@ function Item({
         <span className="min-w-0">
           {unread && <span className="sr-only">{t('notifications.unread')}: </span>}
           <span className={cn('block text-body-sm', unread ? 'text-ink' : 'text-ink-2')}>
-            {t(`notifications.types.${notification.type}`, notification.params)}
+            {t(`notifications.types.${notification.type}`, words(notification.params))}
           </span>
           <span className="block text-caption text-ink-3 tabular-nums">
             {format.dateTime(new Date(notification.createdAt), timeZone)}
```

**File: `apps/app/src/components/journal-entry-view.tsx`** (change)

```diff
@@ -131,11 +131,13 @@ export function EntryView({
     },
   });
 
+  // A closing entry is undone by reopening its year (the Year-end close page), not from here
   const canReverse =
     canPost &&
     entry.status === 'posted' &&
     entry.reversedBy === null &&
-    entry.source !== 'reversal';
+    entry.source !== 'reversal' &&
+    entry.source !== 'year_close';
   const failure = failureOf(post.error);
   const amount = (value: string) =>
     value === '0.0000' ? '' : format.money(value, { decimals: 2 });
```

The Reverse button is not offered on a closing entry; the API would refuse it (decision 8).

---

## 11.10 — MSW: the reports in the mocks

**File: `apps/app/src/mocks/report-data.ts`** (new)

```ts
import {
  absMoney,
  type BalanceSheet,
  type BalanceSheetQuery,
  compareCodes,
  type FiscalYear,
  fiscalYearLabel,
  type FiscalYearList,
  fiscalYearOf,
  isNegativeMoney,
  isReportKind,
  isZeroMoney,
  type JournalEntry,
  naturalAmount,
  type ProfitAndLoss,
  type ProfitAndLossQuery,
  type ReportExport,
  type ReportExportInput,
  type ReportKind,
  reportSection,
  shiftIsoDate,
  subtractMoney,
  sumMoney,
  todayIn,
  type TrialBalance,
  type TrialBalanceQuery,
} from '@omnivo/contracts';

import { postNew, reverseEntry } from './journal-data';
import { MockProblem } from './mock';
import { record, type WorkspaceData } from './workspace-data';

// The reports, the year-end close and the exports on the mock's arrays: the API's rules
// (report-queries.ts, fiscal-years.service.ts) written again, so `pnpm dev:mock` and the e2e
// tests see the same numbers and the same refusals. The sections are built by the contracts'
// reportSection(), the same function the API uses.

interface PostedLine {
  entry: JournalEntry;
  accountId: string;
  type: string;
  branchId: string | null;
  debit: string;
  credit: string;
}

function postedLines(data: WorkspaceData): PostedLine[] {
  const typeOf = new Map(data.accounts.map((account) => [account.id, account.type]));
  return data.journal.entries
    .filter((entry) => entry.status === 'posted')
    .flatMap((entry) =>
      entry.lines.map((line) => ({
        entry,
        accountId: line.accountId,
        type: typeOf.get(line.accountId) ?? '',
        branchId: line.branchId,
        debit: line.debit,
        credit: line.credit,
      })),
    );
}

// A closing entry, or the reversal that reopened its year: not income or expense of any period
function isClosing(data: WorkspaceData, entry: JournalEntry): boolean {
  if (entry.source === 'year_close') return true;
  const original = entry.reversalOf;
  return (
    original !== null &&
    data.journal.entries.some((item) => item.id === original.id && item.source === 'year_close')
  );
}

// debit − credit per account of the lines that pass `keep`
function signedByAccount(
  lines: readonly PostedLine[],
  keep: (line: PostedLine) => boolean,
): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of lines) {
    if (!keep(line)) continue;
    sums.set(
      line.accountId,
      sumMoney([sums.get(line.accountId) ?? '0', subtractMoney(line.debit, line.credit)]),
    );
  }
  return sums;
}

// The same amounts in each account type's natural sign (income positive on the credit side…)
function natural(data: WorkspaceData, signed: Map<string, string>): Map<string, string> {
  const typeOf = new Map(data.accounts.map((account) => [account.id, account.type]));
  return new Map(
    [...signed].flatMap(([id, value]) => {
      const type = typeOf.get(id);
      return type ? [[id, naturalAmount(type, value)]] : [];
    }),
  );
}

function sides(values: readonly string[]): { debit: string; credit: string } {
  return {
    debit: sumMoney(values.filter((value) => !isNegativeMoney(value))),
    credit: sumMoney(values.filter(isNegativeMoney).map(absMoney)),
  };
}

export function trialBalanceOf(data: WorkspaceData, query: TrialBalanceQuery): TrialBalance {
  const lines = postedLines(data).filter((line) => line.entry.date <= query.to);
  const rows = data.accounts
    .filter((account) => !account.isGroup)
    .map((account) => {
      const own = lines.filter((line) => line.accountId === account.id);
      const before = own.filter((line) => line.entry.date < query.from);
      const inRange = own.filter((line) => line.entry.date >= query.from);
      const net = (items: PostedLine[]) =>
        subtractMoney(
          sumMoney(items.map((line) => line.debit)),
          sumMoney(items.map((line) => line.credit)),
        );
      return {
        accountId: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
        opening: net(before),
        debit: sumMoney(inRange.map((line) => line.debit)),
        credit: sumMoney(inRange.map((line) => line.credit)),
        closing: net(own),
      };
    })
    .filter((row) => [row.opening, row.debit, row.credit, row.closing].some((v) => !isZeroMoney(v)))
    .sort((a, b) => compareCodes(a.code, b.code));
  const opening = sides(rows.map((row) => row.opening));
  const closing = sides(rows.map((row) => row.closing));
  return {
    rows,
    totals: {
      openingDebit: opening.debit,
      openingCredit: opening.credit,
      debit: sumMoney(rows.map((row) => row.debit)),
      credit: sumMoney(rows.map((row) => row.credit)),
      closingDebit: closing.debit,
      closingCredit: closing.credit,
    },
  };
}

export function profitAndLossOf(data: WorkspaceData, query: ProfitAndLossQuery): ProfitAndLoss {
  const lines = postedLines(data).filter(
    (line) =>
      (line.type === 'income' || line.type === 'expense') &&
      !isClosing(data, line.entry) &&
      (query.branchId === undefined || line.branchId === query.branchId),
  );
  const within = (from: string, to: string) => (line: PostedLine) =>
    line.entry.date >= from && line.entry.date <= to;
  const current = natural(data, signedByAccount(lines, within(query.from, query.to)));
  const compare =
    query.compareFrom !== undefined && query.compareTo !== undefined
      ? natural(data, signedByAccount(lines, within(query.compareFrom, query.compareTo)))
      : null;
  const income = reportSection('income', data.accounts, current, compare);
  const expense = reportSection('expense', data.accounts, current, compare);
  return {
    income,
    expense,
    netProfit: subtractMoney(income.total, expense.total),
    compareNetProfit:
      income.compareTotal === null || expense.compareTotal === null
        ? null
        : subtractMoney(income.compareTotal, expense.compareTotal),
  };
}

export function balanceSheetOf(data: WorkspaceData, query: BalanceSheetQuery): BalanceSheet {
  const lines = postedLines(data);
  const upTo = (day: string) => (line: PostedLine) => line.entry.date <= day;
  const onSheet = (line: PostedLine) => line.type !== 'income' && line.type !== 'expense';
  const profitUpTo = (day: string) =>
    naturalAmount(
      'income',
      sumMoney([...signedByAccount(lines, (line) => upTo(day)(line) && !onSheet(line)).values()]),
    );
  const current = natural(
    data,
    signedByAccount(lines, (line) => upTo(query.asOf)(line) && onSheet(line)),
  );
  const second = query.compareAsOf;
  const compare =
    second === undefined
      ? null
      : natural(
          data,
          signedByAccount(lines, (line) => upTo(second)(line) && onSheet(line)),
        );
  const asset = reportSection('asset', data.accounts, current, compare);
  const liability = reportSection('liability', data.accounts, current, compare);
  const equity = reportSection('equity', data.accounts, current, compare);
  const profitNotClosed = profitUpTo(query.asOf);
  const compareProfit = second === undefined ? null : profitUpTo(second);
  return {
    asset,
    liability,
    equity,
    profitNotClosed,
    compareProfitNotClosed: compareProfit,
    liabilitiesAndEquity: sumMoney([liability.total, equity.total, profitNotClosed]),
    compareLiabilitiesAndEquity:
      compareProfit === null || liability.compareTotal === null || equity.compareTotal === null
        ? null
        : sumMoney([liability.compareTotal, equity.compareTotal, compareProfit]),
  };
}

// ---------------------------------------------------------------------------------------------
// Fiscal years

function closingEntries(data: WorkspaceData): JournalEntry[] {
  return data.journal.entries.filter(
    (entry) =>
      entry.source === 'year_close' && entry.status === 'posted' && entry.reversedBy === null,
  );
}

// Income and expense balances up to a day, closings included: what a close on that day empties
function profitAndLossBalances(data: WorkspaceData, upTo: string): Map<string, string> {
  const balances = signedByAccount(
    postedLines(data),
    (line) => (line.type === 'income' || line.type === 'expense') && line.entry.date <= upTo,
  );
  return new Map([...balances].filter(([, value]) => !isZeroMoney(value)));
}

function yearsOf(data: WorkspaceData): FiscalYear[] {
  const startMonth = data.settings.fiscalYearStartMonth;
  const current = fiscalYearOf(todayIn(data.settings.timezone), startMonth);
  const dates = data.journal.entries.map((entry) => entry.date).sort();
  const first = fiscalYearOf(dates[0] ?? current.start, startMonth);
  const last = fiscalYearOf(dates.at(-1) ?? current.start, startMonth);
  const lines = postedLines(data).filter(
    (line) => (line.type === 'income' || line.type === 'expense') && !isClosing(data, line.entry),
  );
  const closings = closingEntries(data);
  const items: FiscalYear[] = [];
  let start = last.start > current.start ? last.start : current.start;
  const stop = first.start < current.start ? first.start : current.start;
  for (;;) {
    const year = fiscalYearOf(start, startMonth);
    const closing = closings.find((entry) => entry.date === year.end);
    const inYear = (date: string) => date >= year.start && date <= year.end;
    items.push({
      start: year.start,
      end: year.end,
      label: fiscalYearLabel(year.start, startMonth),
      status: closing ? 'closed' : 'open',
      closingEntry: closing?.number ? { id: closing.id, number: closing.number } : null,
      netProfit: naturalAmount(
        'income',
        sumMoney(
          lines
            .filter((line) => inYear(line.entry.date))
            .map((line) => subtractMoney(line.debit, line.credit)),
        ),
      ),
      drafts: data.journal.entries.filter((entry) => entry.status === 'draft' && inYear(entry.date))
        .length,
    });
    if (year.start <= stop) break;
    start = shiftIsoDate(year.start, -1);
  }
  return items;
}

export function fiscalYearsOf(data: WorkspaceData): FiscalYearList {
  return { items: yearsOf(data), lockDate: data.journal.lockDate };
}

function yearEndingOn(data: WorkspaceData, end: string) {
  const year = fiscalYearOf(end, data.settings.fiscalYearStartMonth);
  if (year.end !== end)
    throw new MockProblem(409, 'year_end_invalid', { end: ['year_end_invalid'] });
  return year;
}

function yearOf(data: WorkspaceData, end: string): FiscalYear {
  const found = yearsOf(data).find((item) => item.end === end);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function closeYear(data: WorkspaceData, end: string): FiscalYear {
  const year = yearEndingOn(data, end);
  if (end >= todayIn(data.settings.timezone)) throw new MockProblem(409, 'year_not_ended');
  if (closingEntries(data).some((entry) => entry.date === end)) {
    throw new MockProblem(409, 'year_already_closed');
  }
  const drafts = data.journal.entries.filter(
    (entry) => entry.status === 'draft' && entry.date >= year.start && entry.date <= end,
  ).length;
  if (drafts > 0) throw new MockProblem(409, 'year_has_drafts', undefined, { count: drafts });
  if (profitAndLossBalances(data, shiftIsoDate(year.start, -1)).size > 0) {
    throw new MockProblem(409, 'year_earlier_open');
  }
  if (data.journal.lockDate !== null && end <= data.journal.lockDate) {
    throw new MockProblem(409, 'journal_period_locked');
  }
  const balances = profitAndLossBalances(data, end);
  if (balances.size === 0) throw new MockProblem(409, 'year_nothing_to_close');
  const retained = data.accounts.find((account) => account.purpose === 'retained_earnings');
  if (!retained) throw new Error('The mock chart has no retained earnings account');
  const lines = [...balances].map(([accountId, balance]) => ({
    accountId,
    branchId: null,
    description: null,
    debit: isNegativeMoney(balance) ? absMoney(balance) : '0',
    credit: isNegativeMoney(balance) ? '0' : balance,
  }));
  const profit = naturalAmount('income', sumMoney([...balances.values()]));
  if (!isZeroMoney(profit)) {
    lines.push({
      accountId: retained.id,
      branchId: null,
      description: null,
      debit: isNegativeMoney(profit) ? absMoney(profit) : '0',
      credit: isNegativeMoney(profit) ? '0' : profit,
    });
  }
  const label = fiscalYearLabel(year.start, data.settings.fiscalYearStartMonth);
  const entry = postNew(
    data,
    { date: end, narration: `Year-end close ${label}`, lines },
    'year_close',
  );
  data.journal.lockDate = end;
  data.journal.lockVersion += 1;
  record(data, 'books.year_closed', 'workspace', crypto.randomUUID(), {
    year: { from: null, to: label },
    entry: { from: null, to: entry.number },
  });
  return yearOf(data, end);
}

export function reopenYear(data: WorkspaceData, end: string): FiscalYear {
  const year = yearEndingOn(data, end);
  const closings = closingEntries(data);
  const closing = closings.find((entry) => entry.date === end);
  if (!closing) throw new MockProblem(409, 'year_not_closed');
  if (closings.some((entry) => entry.date > end)) throw new MockProblem(409, 'year_later_closed');
  if (data.journal.lockDate !== null && data.journal.lockDate >= year.start) {
    data.journal.lockDate = shiftIsoDate(year.start, -1);
    data.journal.lockVersion += 1;
  }
  const reversal = reverseEntry(data, closing, end, { allowYearClose: true });
  record(data, 'books.year_reopened', 'workspace', crypto.randomUUID(), {
    year: { from: null, to: fiscalYearLabel(year.start, data.settings.fiscalYearStartMonth) },
    reversal: { from: null, to: reversal.number },
  });
  return yearOf(data, end);
}

// ---------------------------------------------------------------------------------------------
// Exports: the pretend worker "finishes" a file a moment after it was asked for, like the setup

const EXPORT_DELAY_MS = 1_500;

export interface MockExport extends ReportExport {
  readyAt: number;
}

const STEMS = {
  trial_balance: 'trial-balance',
  profit_and_loss: 'profit-and-loss',
  balance_sheet: 'balance-sheet',
} satisfies Record<ReportKind, string>;

export function createExport(data: WorkspaceData, input: ReportExportInput): ReportExport {
  const query: Record<string, string> = Object.fromEntries(
    Object.entries<string | undefined>(input.query).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
  const item: MockExport = {
    id: crypto.randomUUID(),
    report: input.report,
    format: input.format,
    query,
    status: 'pending',
    fileName: null,
    sizeBytes: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    readyAt: Date.now() + EXPORT_DELAY_MS,
  };
  data.exports.unshift(item);
  return toExport(item);
}

// The contract's shape: everything but the mock's own timer
export function toExport(item: MockExport): ReportExport {
  return {
    id: item.id,
    report: item.report,
    format: item.format,
    query: item.query,
    status: item.status,
    fileName: item.fileName,
    sizeBytes: item.sizeBytes,
    createdAt: item.createdAt,
    finishedAt: item.finishedAt,
  };
}

// Called on every read, like settleSetup: what the worker would have done by now
export function settleExports(data: WorkspaceData): void {
  for (const item of data.exports) {
    if (item.status !== 'pending' || Date.now() < item.readyAt) continue;
    const dates = item.query.asOf ?? `${item.query.from ?? ''}-to-${item.query.to ?? ''}`;
    const stem = isReportKind(item.report) ? STEMS[item.report] : item.report;
    Object.assign(item, {
      status: 'ready',
      fileName: `${stem}-${dates}.${item.format}`,
      sizeBytes: 2048,
      finishedAt: new Date().toISOString(),
    });
    data.notifications.unshift({
      id: crypto.randomUUID(),
      type: 'report.ready',
      params: { report: item.report, format: item.format },
      readAt: null,
      createdAt: new Date().toISOString(),
    });
  }
}

// The mock has no storage: the "file" is a short text in a blob URL, enough to see the download
export function exportUrl(item: ReportExport): string {
  const text = `Omnivo mock export: ${item.report}, ${JSON.stringify(item.query)}\n`;
  return URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
}
```

The API's rules on the mock's arrays, so `pnpm dev:mock` and the e2e tests see the same numbers and the same
refusals. The sections come from the contracts' `reportSection()` — the API's own function. The pretend worker
finishes an export 1.5 seconds after the click, on the first read after that (like the setup job's
`settleSetup()`), and adds the bell's notification. The mock has no storage: the downloaded "file" is a short
text in a blob link.

**File: `apps/app/src/mocks/journal-data.ts`** (change)

```diff
@@ -2,6 +2,7 @@ import {
   absMoney,
   addMoney,
   defaultNumberFormat,
+  fiscalYearOf,
   formatDocumentNumber,
   isNegativeMoney,
   isZeroMoney,
@@ -184,7 +185,7 @@ export function postDraft(data: WorkspaceData, entry: JournalEntry): void {
   const debits = sumMoney(entry.lines.map((line) => line.debit));
   const credits = sumMoney(entry.lines.map((line) => line.credit));
   if (debits !== credits) throw new MockProblem(409, 'journal_unbalanced');
-  checkLines(data, entry.lines, entry.source === 'reversal');
+  checkLines(data, entry.lines, entry.source === 'reversal' || entry.source === 'year_close');
   Object.assign(entry, {
     status: 'posted',
     number: nextNumber(data, entry.date),
@@ -194,9 +195,18 @@ export function postDraft(data: WorkspaceData, entry: JournalEntry): void {
   });
 }
 
-export function reverseEntry(data: WorkspaceData, entry: JournalEntry, date: string): JournalEntry {
+// allowYearClose: only the year-end reopen (report-data.ts) may reverse a closing entry
+export function reverseEntry(
+  data: WorkspaceData,
+  entry: JournalEntry,
+  date: string,
+  { allowYearClose = false }: { allowYearClose?: boolean } = {},
+): JournalEntry {
   if (entry.status !== 'posted') throw new MockProblem(409, 'journal_not_posted');
   if (entry.source === 'reversal') throw new MockProblem(409, 'journal_is_reversal');
+  if (entry.source === 'year_close' && !allowYearClose) {
+    throw new MockProblem(409, 'journal_is_year_close');
+  }
   if (entry.reversedBy !== null) throw new MockProblem(409, 'journal_already_reversed');
   if (date < entry.date) {
     throw new MockProblem(409, 'journal_reversal_date', { date: ['journal_reversal_date'] });
@@ -390,9 +400,13 @@ export function setLockDate(data: WorkspaceData, lockDate: string | null, versio
   data.journal.lockVersion += 1;
 }
 
-// The garments workspace's first weeks on Omnivo: capital, rent, petty cash, a DESCO bill at the
-// factory, salaries — and one draft still waiting. Dated in the last three weeks, but never before
+// The garments workspace's books: last fiscal year in four entries (a sale, interest, the cost
+// of the order, salaries — open, so the year-end close has a year to close), then this year's
+// first weeks: capital, rent, petty cash, a DESCO bill at the factory, salaries, an export sale —
+// and one draft still waiting. This year's are dated in the last three weeks, but never before
 // the fiscal year started, so the ledger's default range (this fiscal year) always shows them.
+// Last year's entries are numbered in last year's series (JV-2025-26-…), so this year's numbers
+// run JV-…-0001 to 0006.
 export function seedJournal(data: WorkspaceData): void {
   const today = todayIn(data.settings.timezone);
   const startMonth = String(data.settings.fiscalYearStartMonth).padStart(2, '0');
@@ -419,6 +433,29 @@ export function seedJournal(data: WorkspaceData): void {
     credit,
   });
 
+  const lastYear = fiscalYearOf(shiftIsoDate(fiscalStart, -1), data.settings.fiscalYearStartMonth);
+  const lastYearDay = (days: number) => shiftIsoDate(lastYear.start, days);
+  postNew(data, {
+    date: lastYearDay(45),
+    narration: 'Export sale to H&M, Stockholm',
+    lines: [line('1140', '3850000', '0'), line('4110', '0', '3850000')],
+  });
+  postNew(data, {
+    date: lastYearDay(120),
+    narration: 'Interest on the export retention quota account',
+    lines: [line('1121', '54000', '0'), line('4210', '0', '54000')],
+  });
+  postNew(data, {
+    date: lastYearDay(150),
+    narration: 'Fabrics and yarn used for the H&M order',
+    lines: [line('5110', '2100000', '0'), line('2110', '0', '2100000')],
+  });
+  postNew(data, {
+    date: lastYearDay(300),
+    narration: 'Factory salaries for the year',
+    lines: [line('5210', '900000', '0'), line('2140', '0', '900000')],
+  });
+
   postNew(data, {
     date: day(20),
     narration: 'Share capital paid in by the directors',
@@ -444,6 +481,11 @@ export function seedJournal(data: WorkspaceData): void {
     narration: 'Salaries for the month, payable on the 7th',
     lines: [line('5210', '1240000', '0'), line('2140', '0', '1240000')],
   });
+  postNew(data, {
+    date: day(3),
+    narration: 'Export sale to Primark, Dublin',
+    lines: [line('1140', '2450000', '0', factory), line('4110', '0', '2450000', factory)],
+  });
   writeDraft(data, {
     date: day(2),
     narration: 'LC opening charges, Dutch-Bangla Bank',
```

- **Last fiscal year in four entries** (profit 9,04,000), open, so the year-end page has a year to close. They
  are numbered in last year's series, so step 10's numbers this year do not move.
- **An export sale this year at the Gazipur factory**, so this year's profit and loss has income and the branch
  filter has something to show. It is posted after the salaries, so the five entries step 10's tests know keep
  their numbers, and the next one is `JV-…-0007`.
- **`reverseEntry()`** refuses a closing entry unless the reopen asks (`allowYearClose`), like the API.

**File: `apps/app/src/mocks/workspace-data.ts`** (change)

```diff
@@ -25,6 +25,7 @@ import { OWNER, type Workspace } from './fixtures';
 import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
 import { type People, seedPeople } from './people-data';
+import type { MockExport } from './report-data';
 
 // mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
 // নিয়মগুলো আসল API-র মতো (version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) — UI-র error-পথ mock দিয়েও দেখা যায়
@@ -40,6 +41,8 @@ export interface WorkspaceData {
   notifications: Notification[];
   accounts: Account[];
   journal: MockJournal;
+  // "My exports", newest first; the pretend worker finishes them (report-data.ts)
+  exports: MockExport[];
 }
 
 function now(): string {
@@ -91,6 +94,7 @@ function seed(workspace: Workspace): WorkspaceData {
     notifications: garments ? seedNotifications() : [],
     accounts: seedAccounts(garments ? 'garments' : 'pharma'),
     journal: emptyJournal(),
+    exports: [],
   };
   if (garments) seedJournal(data);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
@@ -148,6 +152,7 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   // A new workspace has no chart until its setup job runs (settleSetup)
   data.accounts = [];
   data.journal = emptyJournal();
+  data.exports = [];
   store.set(workspace.tenantId, data);
 }
```

**File: `apps/app/src/mocks/mock.ts`** (change)

```diff
@@ -32,6 +32,8 @@ export class MockProblem extends Error {
     readonly status: number,
     readonly code: ErrorCode,
     readonly fieldErrors?: Record<string, ErrorCode[]>,
+    // The values inside the text, like the API's: "Drafts dated in this year: {{count}}"
+    readonly params?: Record<string, string | number>,
   ) {
     super(code);
   }
@@ -42,6 +44,7 @@ export function problem(
   status: number,
   code: ErrorCode,
   fieldErrors?: Record<string, ErrorCode[]>,
+  params?: Record<string, string | number>,
 ): Response {
   const body: Problem = {
     title: 'Mocked error',
@@ -50,6 +53,7 @@ export function problem(
     code,
     requestId: crypto.randomUUID(),
     ...(fieldErrors && { fieldErrors }),
+    ...(params && { params }),
   };
   return Response.json(body, { status, headers: { 'content-type': 'application/problem+json' } });
 }
```

A mock error can carry params now, like the API's: "Drafts dated in this year: 2" instead of "{{count}}".

**File: `apps/app/src/mocks/handlers.ts`** (change)

```diff
@@ -46,6 +46,18 @@ import {
   summaryOf,
   writeDraft,
 } from './journal-data';
+import {
+  balanceSheetOf,
+  closeYear,
+  createExport,
+  exportUrl,
+  fiscalYearsOf,
+  profitAndLossOf,
+  reopenYear,
+  settleExports,
+  toExport,
+  trialBalanceOf,
+} from './report-data';
 import { settleSetup, startSetup } from './setup-data';
 import {
   assertCodeFree,
@@ -67,10 +79,12 @@ let preferences: Preferences = { language: null, theme: 'system' };
 const uploads = new Map<string, { contentType: string; sizeBytes: number; url?: string }>();
 const MOCK_STORAGE = `${API_URL}/mock-storage`;
 
-// settleSetup: a started setup "finishes" on the first read after its delay, like the worker would
+// settleSetup / settleExports: a started setup or an asked-for export "finishes" on the first read
+// after its delay, like the worker would
 function current() {
   const data = dataOf(workspace);
   settleSetup(data);
+  settleExports(data);
   return data;
 }
 
@@ -86,7 +100,9 @@ function guarded(resolver: HttpResponseResolver): HttpResponseResolver {
     try {
       return await resolver(info);
     } catch (error) {
-      if (error instanceof MockProblem) return problem(error.status, error.code, error.fieldErrors);
+      if (error instanceof MockProblem) {
+        return problem(error.status, error.code, error.fieldErrors, error.params);
+      }
       throw error;
     }
   };
@@ -858,6 +874,74 @@ export const handlers = [
     }),
   ),
 
+  mock(routes.reports.trialBalance, ({ request }) =>
+    reply(
+      routes.reports.trialBalance,
+      trialBalanceOf(current(), readQuery(routes.reports.trialBalance.query, request)),
+    ),
+  ),
+
+  mock(routes.reports.profitAndLoss, ({ request }) =>
+    reply(
+      routes.reports.profitAndLoss,
+      profitAndLossOf(current(), readQuery(routes.reports.profitAndLoss.query, request)),
+    ),
+  ),
+
+  mock(routes.reports.balanceSheet, ({ request }) =>
+    reply(
+      routes.reports.balanceSheet,
+      balanceSheetOf(current(), readQuery(routes.reports.balanceSheet.query, request)),
+    ),
+  ),
+
+  mock(routes.fiscalYears.list, () => reply(routes.fiscalYears.list, fiscalYearsOf(current()))),
+
+  mock(
+    routes.fiscalYears.close,
+    guarded(async ({ request }) => {
+      const { end } = await readBody(routes.fiscalYears.close.body, request);
+      return reply(routes.fiscalYears.close, closeYear(current(), end));
+    }),
+  ),
+
+  mock(
+    routes.fiscalYears.reopen,
+    guarded(async ({ request }) => {
+      const { end } = await readBody(routes.fiscalYears.reopen.body, request);
+      return reply(routes.fiscalYears.reopen, reopenYear(current(), end));
+    }),
+  ),
+
+  mock(
+    routes.reportExports.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.reportExports.create.body, request);
+      return reply(routes.reportExports.create, createExport(current(), body));
+    }),
+  ),
+
+  mock(routes.reportExports.list, () =>
+    reply(routes.reportExports.list, {
+      items: current().exports.map(toExport),
+      nextCursor: null,
+    }),
+  ),
+
+  mock(
+    routes.reportExports.download,
+    guarded(({ params }) => {
+      const { id } = routes.reportExports.download.params.parse(params);
+      const item = current().exports.find((candidate) => candidate.id === id);
+      if (!item) throw new MockProblem(404, 'not_found');
+      if (item.status !== 'ready') throw new MockProblem(409, 'export_not_ready');
+      return reply(routes.reportExports.download, {
+        url: exportUrl(item),
+        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
+      });
+    }),
+  ),
+
   mock(routes.numberSeries.list, () =>
     reply(routes.numberSeries.list, { items: seriesList(current()) }),
   ),
```

---

## 11.11 — Playwright

**File: `apps/app/e2e/reports.e2e.ts`** (new)

```ts
import { expect, test } from '@playwright/test';

import { expectNoSideScroll, openFromNav, readOnlyItem } from './helpers.js';

// The mock garments workspace has last fiscal year in four entries (sales 38,50,000, interest
// 54,000, cost of goods 21,00,000, salaries 9,00,000: profit 9,04,000, not closed yet) and this
// year's first weeks. The numbers checked here do not depend on the day the test runs.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test("shows a trial balance that balances, and opens an account's ledger from it", async ({
  page,
}) => {
  await openFromNav(page, 'Trial balance');
  await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
  // Last year's balances are this year's opening: both sides of the totals row
  await expect(page.getByText('৳69,04,000.00 Dr')).toBeVisible();
  await expect(page.getByText('৳69,04,000.00 Cr')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('link', { name: 'Open the ledger of Accounts receivable' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ledger' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Account' })).toHaveValue(/.+/);
  // 38,50,000 from last year + 24,50,000 this year
  await expect(page.getByText('৳63,00,000.00 Dr').first()).toBeVisible();
});

test("shows last year's profit, and one branch's profit this year", async ({ page }) => {
  await openFromNav(page, 'Profit and loss');
  await page.getByLabel('Period').selectOption({ label: 'Last fiscal year' });
  const table = page.getByRole('table', { name: 'Profit and loss' });
  await expect(table.getByRole('row', { name: /^Net profit/ })).toContainText('৳9,04,000.00');
  await expect(table.getByRole('row', { name: /^Total income/ })).toContainText('৳39,04,000.00');

  // This year at the Gazipur factory: the Primark sale less the DESCO bill
  await page.getByLabel('Period').selectOption({ label: 'This fiscal year' });
  await page.getByLabel('Branch').selectOption({ label: 'GZP · Gazipur factory' });
  await expect(table.getByRole('row', { name: /^Net profit/ })).toContainText('৳24,31,549.50');
  await expectNoSideScroll(page);
});

test('shows a balance sheet whose two sides are equal', async ({ page }) => {
  await openFromNav(page, 'Balance sheet');
  await page.getByLabel('Compare with').selectOption({ label: 'Last year end' });
  await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
  const table = page.getByRole('table', { name: 'Balance sheet' });
  // At the last year end: receivable 38,50,000 + bank 54,000 = payables 30,00,000 + profit 9,04,000
  await expect(table.getByRole('row', { name: /^Total liabilities and equity/ })).toContainText(
    '৳39,04,000.00',
  );
  await expectNoSideScroll(page);
});

test('closes last year into retained earnings, and reopens it', async ({ page }) => {
  await openFromNav(page, 'Year-end close');
  await page.getByRole('button', { name: 'Close year' }).click();
  const dialog = page.getByRole('dialog', { name: /^Close FY \d{4}-\d{2}$/ });
  await expect(dialog).toContainText('৳9,04,000.00');
  await dialog.getByRole('button', { name: 'Close year' }).click();
  await expect(page.getByText(/^FY \d{4}-\d{2} closed$/)).toBeVisible();
  await expect(page.getByText(/Books closed up to /)).toBeVisible();

  // The closing entry is in the journal, and it is undone only from this page
  await page.getByRole('link', { name: /^Closing entry JV-/ }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: /^JV-\d{4}-\d{2}-0005$/ }),
  ).toBeVisible();
  await expect(page.getByText('Year-end close', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reverse' })).toBeHidden();

  // The profit and loss of the closed year still shows its profit
  await openFromNav(page, 'Profit and loss');
  await page.getByLabel('Period').selectOption({ label: 'Last fiscal year' });
  await expect(
    page.getByRole('table', { name: 'Profit and loss' }).getByRole('row', { name: /^Net profit/ }),
  ).toContainText('৳9,04,000.00');

  await openFromNav(page, 'Year-end close');
  await page.getByRole('button', { name: 'Reopen' }).click();
  await page
    .getByRole('dialog', { name: /^Reopen FY/ })
    .getByRole('button', { name: 'Reopen year' })
    .click();
  await expect(page.getByText(/^FY \d{4}-\d{2} reopened$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close year' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('exports a report to PDF and downloads it when the bell says it is ready', async ({
  page,
}) => {
  await openFromNav(page, 'Profit and loss');
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: 'PDF' }).click();
  await expect(
    page.getByText("Preparing the PDF file. The bell tells you when it's ready."),
  ).toBeVisible();

  // The pretend worker takes 1.5 seconds; the bell's list is read fresh when it opens
  await page.waitForTimeout(1_600);
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Profit and loss \(PDF\) is ready to download/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Exports' })).toBeVisible();
  await expect(readOnlyItem(page, /Profit and loss/)).toContainText('Ready');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^profit-and-loss-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.pdf$/,
  );
  await expectNoSideScroll(page);
});
```

Every number checked here is one that does not depend on the day the test runs: last fiscal year's figures,
this year's Gazipur branch, and the totals that must be equal. On a phone the export cards cannot be clicked
(no `role="button"`), so the test finds them with `readOnlyItem()`.

**File: `apps/app/e2e/journal.e2e.ts`** (change)

```diff
@@ -9,7 +9,8 @@ test.beforeEach(async ({ page }) => {
 const line = (page: Page, number: number) =>
   page.getByRole('group', { name: `Line ${String(number)}` });
 
-// The mock garments workspace has five posted entries (JV-…-0001 to 0005) and one draft
+// The mock garments workspace has six posted entries this year (JV-…-0001 to 0006) and one draft;
+// last year's are numbered in last year's series
 test('writes an entry and posts it only once the debits and credits are equal', async ({
   page,
 }) => {
@@ -32,9 +33,9 @@ test('writes an entry and posts it only once the debits and credits are equal',
   await expectNoSideScroll(page);
   await post.click();
 
-  await expect(page.getByText(/^JV-\d{4}-\d{2}-0006 posted$/)).toBeVisible();
+  await expect(page.getByText(/^JV-\d{4}-\d{2}-0007 posted$/)).toBeVisible();
   await expect(
-    page.getByRole('heading', { level: 1, name: /^JV-\d{4}-\d{2}-0006$/ }),
+    page.getByRole('heading', { level: 1, name: /^JV-\d{4}-\d{2}-0007$/ }),
   ).toBeVisible();
   await expect(page.getByRole('link', { name: '1110 Cash in hand' })).toBeVisible();
   await expectNoSideScroll(page);
@@ -47,7 +48,7 @@ test('finishes a waiting draft, and deletes a new one in two clicks', async ({ p
   await listItem(page, /LC opening charges/).click();
   await expect(page.getByRole('heading', { level: 1, name: 'Draft entry' })).toBeVisible();
   await page.getByRole('button', { name: 'Post entry' }).click();
-  await expect(page.getByText(/^JV-\d{4}-\d{2}-0006 posted$/)).toBeVisible();
+  await expect(page.getByText(/^JV-\d{4}-\d{2}-0007 posted$/)).toBeVisible();
 
   await page.getByRole('link', { name: 'Back to the journal' }).click();
   await page.getByRole('button', { name: 'New entry' }).click();
@@ -59,6 +60,10 @@ test('finishes a waiting draft, and deletes a new one in two clicks', async ({ p
   await page.getByRole('button', { name: 'Save draft' }).click();
   await expect(page.getByText('Draft saved')).toBeVisible();
   await expect(page.getByRole('heading', { level: 1, name: 'Draft entry' })).toBeVisible();
+  // On a phone the toast sits over "Delete draft", and the pointer that just clicked "Save draft"
+  // rests on it — and a toast does not close while the pointer is over it. Move away and let it go.
+  await page.mouse.move(0, 0);
+  await expect(page.getByText('Draft saved')).toBeHidden();
 
   await page.getByRole('button', { name: 'Delete draft' }).click();
   await expect(page.getByText('This cannot be undone.')).toBeVisible();
```

Two changes to step 10's test:

- **0006 → 0007**: the mock posts one more entry this year (11.10).
- **A flaky test, fixed.** "finishes a waiting draft" failed about once in eight runs on a phone — on step 10's
  own code too (checked on a copy of step 10), so this step did not cause it. The trace showed why: on a phone
  the "Draft saved" toast sits over "Delete draft", and the pointer that just clicked "Save draft" rests on the
  toast. A toast does not close while the pointer is over it, and each retry of the click moved the pointer
  back onto it — for 30 seconds. Moving the pointer away and waiting for the toast to go fixed it: 16 of 16
  runs passed after.

---

## 11.12 — Root files

No new `.env` line, no change to `.gitignore` or the CI workflow. `pnpm-lock.yaml` changes with the packages in
11.6.

```bash
pnpm gen:openapi      # openapi.json — 56 paths (48 before); commit it
```

---

## 11.13 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Components", after "KPI strip":

> - **Statement table (trial balance, profit and loss, balance sheet):** a real `<table>` in a card (`surface`,
>   1px `line`, radius 14px, `shadow-sm`), not the DataTable: section headings as `ink-3` caption rows, accounts
>   indented 16px per level (code in `Geist Mono` `ink-3`), groups and totals at weight 500, total rows on
>   `subtle`, the report's own total in `<tfoot>`. Amounts right-aligned, `tabular-nums`, 2 decimals. It stays a
>   table on phones: it scrolls sideways inside its card with the account column sticky. A ledger account's
>   name links to its ledger with the report's dates.
> - **Balance check pill:** `good` "Balanced" or `crit` "Out by ৳x", next to the report's dates.

Under "Content and formatting" → "Money", extend step 10's sentence: "…journal entries, ledgers, opening
balances and the financial statements show 2 decimals…".

**build-plan.bn.md** — step 11's text: Trial Balance, P&L, Balance Sheet (কাঁচা SQL-এ, API আর worker একই
query), ধাপ ১০-এর `postNew()` দিয়ে বছর শেষের ক্লোজিং এন্ট্রি + lock date (ক্রমে ক্লোজ, উল্টো ক্রমে reopen), Excel/PDF
এক্সপোর্ট worker-এ (S3 + বেল), আলাদা permission `accounting.report.read`। Cash flow পরে।

**COMMANDS.md** — in the database section:

````markdown
```sh
# exports: per person and status (a 'pending' one older than a minute means the worker is not running)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT u.email, x.report, x.format, x.status, x.created_at FROM report_exports x JOIN users u ON u.id = x.requested_by ORDER BY x.id DESC LIMIT 20"
# closing entries in force (one per closed year)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, e.number, e.date FROM journal_entries e JOIN tenants t ON t.id = e.tenant_id WHERE e.source = 'year_close' AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reversal_of_id = e.id)"
```
````

---

## 11.14 — Run it

```bash
pnpm install                                  # the packages from 11.6
pnpm db:migrate                               # 0017 + 0018, and the new permission
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it, the worker too: it now opens storage
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = 'report_exports';   -- t
SELECT key FROM permissions WHERE key LIKE 'accounting.%';                           -- six keys
```

### What you will see

1. **Your existing roles do not have `accounting.report.read` yet.** As the owner you have it. For your
   Accountant: Roles → tick it.
2. A new sidebar group **Reports**: Trial balance, Profit and loss, Balance sheet, Exports. And **Year-end
   close** in Accounting.
3. **Trial balance** → this fiscal year: every account with a balance, grouped by type, and "Balanced". Click an
   account → its ledger, with the same dates.
4. **Profit and loss** → Compare with: Last year → a second column; Branch: Gazipur factory → only its lines.
5. **Balance sheet** → "Profit not yet closed" inside equity; the last line equals total assets.
6. **Export → PDF** → "Preparing the PDF file…" → a few seconds later the bell: "Profit and loss (PDF) is ready
   to download." → Exports → Download. Mailpit is not involved; the file is in MinIO
   (http://localhost:9001, bucket `omnivo`, folder `tenants/<id>/report-exports`).
7. **Year-end close**: a year that is over shows "Close year" (if you have entries dated last fiscal year). Close
   → "FY 2025-26 closed", a "Closing entry JV-…" link, and "Books closed up to 30 Jun 2026". The entry has no
   Reverse button. The profit and loss of that year still shows its profit; the balance sheet's retained
   earnings has it now. **Reopen** puts everything back.
8. **Bangla**: ট্রায়াল ব্যালান্স, লাভ-ক্ষতির হিসাব, ব্যালান্স শিট; a Bangla PDF with Bangla digits.
9. DevTools at 390px: the filters stack, the statements scroll sideways inside their card with the account names
   fixed, and the page itself never scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 167: contracts 58 + api 42 + app 30 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 153 — 25 new
pnpm test:tenant-leak        # 35 — 3 new
pnpm test:e2e                # 64: 32 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 187.5 KB gz; year-end 81.3, balance sheet 59.1, P&L 58.8, TB 58.7, exports 40.2
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **`exceljs` brings an `npm audit` warning** (an old `uuid`) and nine dependencies. `write-excel-file` has one.
- **"৳" floated above the digits in the PDF.** The two fonts have different heights above the baseline; drawing
  each run on the alphabetic baseline lined them up.
- **Cutting a long Bangla name with `[...text]` could split a letter.** `Intl.Segmenter` cuts by grapheme; the
  lint rule `no-misused-spread` pointed at it.
- **The API and the worker raced to create the dev bucket** on an empty MinIO, and the loser would have stopped at
  start. Checked with two `CreateBucket` calls at once; the second gets `BucketAlreadyOwnedByYou`, now ignored.
- **The lock order of the year-end close** (caught while writing it, not by a test): its own posting takes
  step 10's lock shared, and moving the lock date needs it exclusive. Shared first, then exclusive, would let two
  closes wait for each other forever; it takes the exclusive lock first (11.4).
- **A report that counted drafts passed every test**, until a draft was added to the test's books. Always break
  the guard and watch the test fail.
- **"Last fiscal year" returned `{ start, end }`** — the unit test caught it (vitest does not type-check).
- **The PDF printed "0.00" where the page left a cell empty** (a trial balance account that did not move): the
  document now leaves it empty too.
- **Three layout details on the screenshots**: a cut-off comparison label (shorter texts), the statement's first
  amount hidden behind a wide account column on a phone (narrower there), and a card label showing a column id
  ("action", "download") on a phone (the buttons moved to the card's trailing slot).
- **A step 10 e2e test that failed about once in eight runs on a phone** — a toast that never closed under the
  pointer (11.11).
- **The integration suite's 5-second limit**, once, for a long year-end test while every file started its
  containers: split in two.

---

## Notes left for later steps

**Step 12 onwards:**

- **Every new journal source** (`sales_invoice`, `supplier_bill`…) is income or expense for the profit and loss
  automatically — only `year_close` and its reversals are left out. Add the source to `JOURNAL_SOURCES` and
  `journal.sources.*` as usual.
- **Exports pile up in storage.** Add a daily job (like step 8's outbox cleanup) that deletes files and rows
  older than, say, 30 days, or a "Delete" on the Exports page. The key is `tenants/<tenant>/report-exports/<id>`.
- **A new report** = a query in `report-queries.ts`, a route, a `report_exports` kind (`REPORT_KINDS`, the
  discriminated union, `reportData()` in the handler, `copy.ts`, `document.ts`), a page and the mock.

**Cash flow (when you want it):**

- Add a `cash_flow` category to `ledger_accounts` (operating / investing / financing), set it in the templates,
  and build the indirect method from the profit and the change in each balance sheet account between two days —
  `balanceSheet()` already returns both days.

**Notes for any step:**

- **Never post into a closed year by moving the lock date by hand** without reopening the year: the closing entry
  would stay, and the year's new income would never reach retained earnings. Reopen, post, close again.
- **A production deploy must give the worker the `S3_*` settings** (and a bucket it may write to).
- **Reports are read in one transaction** each; at millions of lines, a trial balance over years will want a
  monthly balance table (system design §5). Not before it is measured.
- **The busy-machine timeouts** from step 10's notes are still possible in step 6–10 files; this step's long
  test was split, the others were not touched.
