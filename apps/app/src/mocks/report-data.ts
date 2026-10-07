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
    // Income and expense accounts: never kept per customer
    partyId: null,
    description: null,
    debit: isNegativeMoney(balance) ? absMoney(balance) : '0',
    credit: isNegativeMoney(balance) ? '0' : balance,
  }));
  const profit = naturalAmount('income', sumMoney([...balances.values()]));
  if (!isZeroMoney(profit)) {
    lines.push({
      accountId: retained.id,
      branchId: null,
      partyId: null,
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
