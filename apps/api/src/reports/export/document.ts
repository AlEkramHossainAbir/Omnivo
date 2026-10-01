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
