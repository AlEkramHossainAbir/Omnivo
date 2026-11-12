import {
  absMoney,
  addMoney,
  AGING_BUCKETS,
  type AgingAmounts,
  type AgingReport,
  type ApAgingFilter,
  type ArAgingFilter,
  type BalanceSheet,
  type BalanceSheetQuery,
  isNegativeMoney,
  isZeroMoney,
  type LanguageCode,
  type ProfitAndLoss,
  type ProfitAndLossQuery,
  type PurchaseReport,
  type PurchaseReportFilter,
  type PurchaseReportRow,
  type ReportKind,
  type ReportSection,
  type SalesReport,
  type SalesReportFilter,
  type SalesReportRow,
  type StockMovementFilter,
  type StockMovementReport,
  type StockMovementRow,
  type TrialBalance,
  type TrialBalanceQuery,
  type VatReport,
  type VatReportFilter,
} from '@omnivo/contracts';

import { COPY, type Copy } from './copy.js';
import {
  formatAmount,
  formatIsoDate,
  formatMoment,
  formatMonth,
  formatNumber,
  formatPercent,
} from './format.js';

// One report as a plain table: the Excel and the PDF writer both draw this, so the two files
// always hold the same rows in the same order. Amounts stay decimal strings here; each writer
// decides how a cell shows them.

// number (step 21b): a quantity or a percent, already written out ("72 pcs", "22.5%"), right-aligned
// like an amount but never added up in Excel
export type DocCell =
  | { kind: 'text'; text: string }
  | { kind: 'money'; amount: string }
  | { kind: 'number'; text: string }
  | { kind: 'empty' };

export interface DocColumn {
  header: string;
  // money and number are right-aligned
  kind: 'text' | 'money' | 'number';
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
  | { report: 'balance_sheet'; query: BalanceSheetQuery; data: BalanceSheet }
  | { report: 'sales_report'; query: SalesReportFilter; data: SalesReport }
  | { report: 'purchase_report'; query: PurchaseReportFilter; data: PurchaseReport }
  | { report: 'ar_aging'; query: ArAgingFilter; data: AgingReport }
  | { report: 'ap_aging'; query: ApAgingFilter; data: AgingReport }
  | { report: 'vat_report'; query: VatReportFilter; data: VatReport }
  | { report: 'stock_movement'; query: StockMovementFilter; data: StockMovementReport };

// The names of what the query filters by, read by the handler: a file says "Branch: Sylhet depot",
// never an id
export interface DocumentContext {
  language: LanguageCode;
  company: string;
  currency: string;
  timeZone: string;
  branchName: string | null;
  // Step 21b: the customer or supplier group, and the product category
  groupName: string | null;
  categoryName: string | null;
  // Step 21c: the stock movement report's warehouse
  warehouseName: string | null;
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

// ---------------------------------------------------------------------------------------------
// Step 21b: the sales and purchase reports and the agings. Each is one row per item and a totals
// row; the amounts keep their paisa, like the statements.

type Body = Pick<ReportDocument, 'columns' | 'rows' | 'landscape' | 'lines'>;

// What the first cell of a row says: "C-00042 Sylhet Pharmacy" (the code first, like an account),
// "October 2026", or the words for a row that is not an item
function rowName(
  row: SalesReportRow | PurchaseReportRow,
  copy: Copy,
  language: LanguageCode,
): string {
  if (row.kind !== 'item') return copy.rowKinds[row.kind];
  if (row.month !== null) return formatMonth(row.month, language);
  const name = row.name ?? '';
  return row.code === null ? name : `${row.code} ${name}`;
}

// "72 pcs", with the unit's decimals and in the file's digits
function quantityCell(row: SalesReportRow | PurchaseReportRow, language: LanguageCode): DocCell {
  if (row.quantity === null || row.baseUnit === null) return empty;
  return {
    kind: 'number',
    text: `${formatNumber(row.quantity, row.baseUnit.decimals, language)} ${row.baseUnit.code}`,
  };
}

function percentCell(percent: string | null, language: LanguageCode): DocCell {
  return percent === null
    ? empty
    : { kind: 'number', text: `${formatNumber(percent, 1, language)}%` };
}

// The lines under the title that the two trade reports share: the period, then each filter
function tradeLines(
  query: { from: string; to: string; branchId?: string | undefined },
  group: string,
  context: DocumentContext,
  copy: Copy,
  groupLine: (name: string) => string,
): string[] {
  const date = (iso: string) => formatIsoDate(iso, context.language);
  return [
    copy.range(date(query.from), date(query.to)),
    copy.groupedBy(group),
    ...(context.branchName === null ? [] : [copy.branch(context.branchName)]),
    ...(context.groupName === null ? [] : [groupLine(context.groupName)]),
    ...(context.categoryName === null ? [] : [copy.category(context.categoryName)]),
  ];
}

function salesDocument(
  query: SalesReportFilter,
  data: SalesReport,
  copy: Copy,
  context: DocumentContext,
): Body {
  const { language } = context;
  const byProduct = query.groupBy === 'product';
  const cost = data.withCost;
  const costCells = (amounts: {
    cost: string | null;
    margin: string | null;
    marginPercent: string | null;
  }) =>
    cost
      ? [
          money(amounts.cost ?? '0'),
          money(amounts.margin ?? '0'),
          percentCell(amounts.marginPercent, language),
        ]
      : [];
  return {
    landscape: cost || byProduct,
    lines: [
      ...tradeLines(query, copy.groups[query.groupBy], context, copy, copy.customerGroup),
      // The books' sales of the same period, to compare with the total (decision 2)
      ...(data.books === null ? [] : [copy.inBooks(formatAmount(data.books, language))]),
    ],
    columns: [
      { header: copy.groups[query.groupBy], kind: 'text', width: 40 },
      ...(byProduct ? [{ header: copy.quantity, kind: 'number' as const, width: 16 }] : []),
      { header: copy.sales.gross, kind: 'money', width: 18 },
      { header: copy.sales.returns, kind: 'money', width: 16 },
      { header: copy.sales.net, kind: 'money', width: 18 },
      ...(cost
        ? [
            { header: copy.sales.cost, kind: 'money' as const, width: 18 },
            { header: copy.sales.margin, kind: 'money' as const, width: 18 },
            { header: copy.sales.marginPercent, kind: 'number' as const, width: 12 },
          ]
        : []),
    ],
    rows: [
      ...data.items.map((row): DocRow => ({
        style: 'normal',
        indent: 0,
        cells: [
          text(rowName(row, copy, language)),
          ...(byProduct ? [quantityCell(row, language)] : []),
          money(row.gross),
          money(row.returns),
          money(row.net),
          ...costCells(row),
        ],
      })),
      {
        style: 'grand',
        indent: 0,
        cells: [
          text(copy.total),
          // Quantities of different products do not add up
          ...(byProduct ? [empty] : []),
          money(data.totals.gross),
          money(data.totals.returns),
          money(data.totals.net),
          ...costCells(data.totals),
        ],
      },
    ],
  };
}

function purchaseDocument(
  query: PurchaseReportFilter,
  data: PurchaseReport,
  copy: Copy,
  context: DocumentContext,
): Body {
  const { language } = context;
  const byProduct = query.groupBy === 'product';
  return {
    landscape: false,
    lines: tradeLines(query, copy.groups[query.groupBy], context, copy, copy.supplierGroup),
    columns: [
      { header: copy.groups[query.groupBy], kind: 'text', width: 40 },
      ...(byProduct ? [{ header: copy.quantity, kind: 'number' as const, width: 16 }] : []),
      { header: copy.purchases.gross, kind: 'money', width: 18 },
      { header: copy.purchases.returns, kind: 'money', width: 16 },
      { header: copy.purchases.net, kind: 'money', width: 18 },
    ],
    rows: [
      ...data.items.map((row): DocRow => ({
        style: 'normal',
        indent: 0,
        cells: [
          text(rowName(row, copy, language)),
          ...(byProduct ? [quantityCell(row, language)] : []),
          money(row.gross),
          money(row.returns),
          money(row.net),
        ],
      })),
      {
        style: 'grand',
        indent: 0,
        cells: [
          text(copy.total),
          ...(byProduct ? [empty] : []),
          money(data.totals.gross),
          money(data.totals.returns),
          money(data.totals.net),
        ],
      },
    ],
  };
}

// The five buckets, then what is due, the advances and the balance: the page's columns
function agingCells(amounts: AgingAmounts): DocCell[] {
  return [
    ...AGING_BUCKETS.map((bucket) => money(amounts[bucket])),
    money(amounts.due),
    money(amounts.advances),
    money(amounts.balance),
  ];
}

function agingDocument(
  query: ArAgingFilter | ApAgingFilter,
  data: AgingReport,
  party: 'customer' | 'supplier',
  copy: Copy,
  context: DocumentContext,
): Body {
  const { language } = context;
  const groupLine = party === 'customer' ? copy.customerGroup : copy.supplierGroup;
  return {
    landscape: true,
    lines: [
      copy.asOf(formatIsoDate(query.asOf, language)),
      ...(context.groupName === null ? [] : [groupLine(context.groupName)]),
      ...(query.show === 'overdue' ? [copy.overdueOnly] : []),
      ...(data.ledger === null ? [] : [copy.inBooks(formatAmount(data.ledger, language))]),
    ],
    columns: [
      { header: copy.groups[party], kind: 'text', width: 34 },
      ...AGING_BUCKETS.map((bucket): DocColumn => ({
        header: copy.buckets[bucket],
        kind: 'money',
        width: 15,
      })),
      { header: copy.due, kind: 'money', width: 16 },
      { header: copy.advances, kind: 'money', width: 15 },
      { header: copy.balance, kind: 'money', width: 16 },
    ],
    rows: [
      ...data.items.map((row): DocRow => ({
        style: 'normal',
        indent: 0,
        cells: [text(`${row.party.code} ${row.party.name}`), ...agingCells(row)],
      })),
      { style: 'grand', indent: 0, cells: [text(copy.total), ...agingCells(data.totals)] },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Step 21c: the VAT report (its summary by rate: the documents are on the page) and the stock
// movement report

function vatDocument(
  query: VatReportFilter,
  data: VatReport,
  copy: Copy,
  context: DocumentContext,
): Body {
  const { language } = context;
  const date = (iso: string) => formatIsoDate(iso, language);
  const amount = (value: string) => formatAmount(value, language);
  const amounts = (row: VatReport['totals'] | VatReport['rows'][number]): DocCell[] => [
    money(row.outputNet),
    money(row.outputVat),
    money(row.inputNet),
    money(row.inputVat),
    money(row.netVat),
  ];
  return {
    landscape: true,
    lines: [
      copy.range(date(query.from), date(query.to)),
      ...(context.branchName === null ? [] : [copy.branch(context.branchName)]),
      copy.vatInBooks(amount(data.books.output), amount(data.books.input)),
      // Only when something was taken off: a month without returns needs no line of zeros
      ...(isZeroMoney(data.totals.outputVatReturned) && isZeroMoney(data.totals.inputVatReturned)
        ? []
        : [
            copy.vatReturned(
              amount(data.totals.outputVatReturned),
              amount(data.totals.inputVatReturned),
            ),
          ]),
      ...(isZeroMoney(data.totals.inputVatWithoutMushak)
        ? []
        : [copy.withoutMushak(amount(data.totals.inputVatWithoutMushak))]),
    ],
    columns: [
      { header: copy.vat.rate, kind: 'text', width: 30 },
      { header: copy.vat.outputNet, kind: 'money', width: 18 },
      { header: copy.vat.outputVat, kind: 'money', width: 16 },
      { header: copy.vat.inputNet, kind: 'money', width: 18 },
      { header: copy.vat.inputVat, kind: 'money', width: 16 },
      { header: copy.vat.netVat, kind: 'money', width: 16 },
    ],
    rows: [
      ...data.rows.map((row): DocRow => ({
        style: 'normal',
        indent: 0,
        // "VAT 15% · 15%": the name and the percent, as the app shows a rate
        cells: [text(`${row.name} · ${formatPercent(row.rate, language)}%`), ...amounts(row)],
      })),
      { style: 'grand', indent: 0, cells: [text(copy.total), ...amounts(data.totals)] },
    ],
  };
}

// "Napa 500mg (Strip)": the variant's options after the product's name
function variantName(row: StockMovementRow): string {
  return row.optionValues.length === 0
    ? row.productName
    : `${row.productName} (${row.optionValues.join(', ')})`;
}

function stockMovementDocument(
  query: StockMovementFilter,
  data: StockMovementReport,
  copy: Copy,
  context: DocumentContext,
): Body {
  const { language } = context;
  // "72 pcs" with the unit's decimals; a quantity of another product's unit is never added to it
  const quantity = (row: StockMovementRow, value: string): DocCell => ({
    kind: 'number',
    text: `${formatNumber(value, row.baseUnit.decimals, language)} ${row.baseUnit.code}`,
  });
  const valueColumns: DocColumn[] = data.withValue
    ? [
        { header: copy.stock.openingValue, kind: 'money', width: 16 },
        { header: copy.stock.closingValue, kind: 'money', width: 16 },
      ]
    : [];
  return {
    landscape: true,
    lines: [
      copy.range(formatIsoDate(query.from, language), formatIsoDate(query.to, language)),
      ...(context.warehouseName === null ? [] : [copy.warehouse(context.warehouseName)]),
      ...(context.categoryName === null ? [] : [copy.category(context.categoryName)]),
      ...(query.show === 'all' ? [copy.withStockOnly] : []),
    ],
    columns: [
      { header: copy.stock.product, kind: 'text', width: 34 },
      { header: copy.stock.sku, kind: 'text', width: 14 },
      { header: copy.stock.opening, kind: 'number', width: 13 },
      { header: copy.stock.purchased, kind: 'number', width: 13 },
      { header: copy.stock.sold, kind: 'number', width: 13 },
      { header: copy.stock.transfers, kind: 'number', width: 13 },
      { header: copy.stock.adjusted, kind: 'number', width: 13 },
      { header: copy.stock.closing, kind: 'number', width: 13 },
      ...valueColumns,
    ],
    rows: [
      ...data.items.map((row): DocRow => ({
        style: 'normal',
        indent: 0,
        cells: [
          text(variantName(row)),
          text(row.sku),
          quantity(row, row.opening),
          quantity(row, row.purchased),
          quantity(row, row.sold),
          quantity(row, row.transfers),
          quantity(row, row.adjusted),
          quantity(row, row.closing),
          ...(data.withValue
            ? [money(row.openingValue ?? '0'), money(row.closingValue ?? '0')]
            : []),
        ],
      })),
      // Quantities never add up (decision 23): a total row only for the values
      ...(data.withValue
        ? [
            {
              style: 'grand' as const,
              indent: 0,
              cells: [
                text(copy.total),
                ...Array.from({ length: 7 }, () => empty),
                money(data.totals.openingValue ?? '0'),
                money(data.totals.closingValue ?? '0'),
              ],
            },
          ]
        : []),
    ],
  };
}

function bodyOf(report: ReportData, copy: Copy, context: DocumentContext): Body {
  switch (report.report) {
    case 'trial_balance':
      return trialBalanceDocument(report.query, report.data, copy, context.language);
    case 'profit_and_loss':
      return profitAndLossDocument(
        report.query,
        report.data,
        copy,
        context.language,
        context.branchName,
      );
    case 'balance_sheet':
      return balanceSheetDocument(report.query, report.data, copy, context.language);
    case 'sales_report':
      return salesDocument(report.query, report.data, copy, context);
    case 'purchase_report':
      return purchaseDocument(report.query, report.data, copy, context);
    case 'ar_aging':
      return agingDocument(report.query, report.data, 'customer', copy, context);
    case 'ap_aging':
      return agingDocument(report.query, report.data, 'supplier', copy, context);
    case 'vat_report':
      return vatDocument(report.query, report.data, copy, context);
    case 'stock_movement':
      return stockMovementDocument(report.query, report.data, copy, context);
  }
}

export function buildDocument(report: ReportData, context: DocumentContext): ReportDocument {
  const copy: Copy = COPY[context.language];
  const body = bodyOf(report, copy, context);
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
    sales_report: 'sales',
    purchase_report: 'purchases',
    ar_aging: 'receivables-aging',
    ap_aging: 'payables-aging',
    vat_report: 'vat',
    stock_movement: 'stock-movement',
  };
  // A picture of one day has its date, a period its two
  const dates =
    'asOf' in report.query ? report.query.asOf : `${report.query.from}-to-${report.query.to}`;
  return `${name[report.report]}-${dates}`;
}
