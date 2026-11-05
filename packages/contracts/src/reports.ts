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
