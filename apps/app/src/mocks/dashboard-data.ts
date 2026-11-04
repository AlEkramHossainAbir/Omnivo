import {
  compareCodes,
  compareMoney,
  DASHBOARD_LOW_STOCK_ITEMS,
  DASHBOARD_TOP_PRODUCTS,
  DASHBOARD_TREND_DAYS,
  type Dashboard,
  type DashboardCard,
  type DashboardCash,
  type DashboardDues,
  type DashboardLowStock,
  type DashboardPeriods,
  type DashboardQuery,
  type DashboardTopProduct,
  dashboardPeriods,
  everyDay,
  isNegativeMoney,
  isZeroMoney,
  moneyAccountIds,
  percentOfWhole,
  subtractMoney,
  sumMoney,
  sumQuantity,
  todayIn,
} from '@omnivo/contracts';

import { dueOn as billDue } from './bill-data';
import { dueOn as invoiceDue } from './invoice-data';
import { isClosing } from './report-data';
import { findVariant, refOf, reorderReport } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// Step 21a: the Overview's answer on the mock's arrays. The API's rules (dashboard-queries.ts)
// written again, like the reports' (report-data.ts): the numbers come from the posted journal, so
// a sale posted in `pnpm dev:mock` or in a Playwright test shows on the Overview at once, as it
// does with the real server. The API reads the day totals table; the mock has no such table and
// adds the journal's lines up on every read (a few hundred lines).

interface Line {
  date: string;
  accountId: string;
  branchId: string | null;
  debit: string;
  credit: string;
  closing: boolean;
}

// Every line of a posted entry, with its entry's date. Closing entries are marked, not dropped:
// the sales leave them out (decision 25), the balances keep them.
function postedLines(data: WorkspaceData): Line[] {
  return data.journal.entries
    .filter((entry) => entry.status === 'posted')
    .flatMap((entry) => {
      const closing = isClosing(data, entry);
      return entry.lines.map((line) => ({
        date: entry.date,
        accountId: line.accountId,
        branchId: line.branchId,
        debit: line.debit,
        credit: line.credit,
        closing,
      }));
    });
}

function accountOf(data: WorkspaceData, purpose: string): string | null {
  return data.accounts.find((account) => account.purpose === purpose)?.id ?? null;
}

// debit − credit (or credit − debit) of the lines that pass `keep`
function sumSide(lines: readonly Line[], side: 'debit' | 'credit', keep: (line: Line) => boolean) {
  return sumMoney(
    lines
      .filter(keep)
      .map((line) =>
        side === 'debit'
          ? subtractMoney(line.debit, line.credit)
          : subtractMoney(line.credit, line.debit),
      ),
  );
}

// Sales and margin: the 'sales' account and the Sales returns account (decision 10), the cost of
// goods sold account, one branch or all, closing entries left out
function soldCards(
  data: WorkspaceData,
  lines: readonly Line[],
  periods: DashboardPeriods,
  branchId: string | null,
): Pick<Dashboard, 'sales' | 'margin'> {
  const salesIds = new Set(
    [accountOf(data, 'sales'), data.salesAccounts.returns].filter(
      (id): id is string => id !== null,
    ),
  );
  const costId = accountOf(data, 'cost_of_goods_sold');
  const sold = lines.filter(
    (line) => !line.closing && (branchId === null || line.branchId === branchId),
  );
  const between = (from: string, to: string) => (line: Line) =>
    line.date >= from && line.date <= to;
  const sales = (from: string, to: string) =>
    sumSide(sold, 'credit', (line) => salesIds.has(line.accountId) && between(from, to)(line));
  const cost = (from: string, to: string) =>
    sumSide(sold, 'debit', (line) => line.accountId === costId && between(from, to)(line));
  return {
    sales: {
      today: sales(periods.today, periods.today),
      yesterday: sales(periods.yesterday, periods.yesterday),
      monthToDate: sales(periods.monthStart, periods.today),
      lastMonthToDate: sales(periods.lastMonthStart, periods.lastMonthEnd),
      // The contract's days (everyDay, zeros), each given its own sum
      days: everyDay(periods.trendStart, DASHBOARD_TREND_DAYS, new Map()).map((day) => ({
        date: day.date,
        amount: sales(day.date, day.date),
      })),
    },
    margin: {
      monthToDate: {
        sales: sales(periods.monthStart, periods.today),
        cost: cost(periods.monthStart, periods.today),
      },
      lastMonthToDate: {
        sales: sales(periods.lastMonthStart, periods.lastMonthEnd),
        cost: cost(periods.lastMonthStart, periods.lastMonthEnd),
      },
    },
  };
}

// Every active money account up to today, the largest first; an account with no lines at ৳0
function cashCard(data: WorkspaceData, lines: readonly Line[], today: string): DashboardCash {
  const money = moneyAccountIds(data.accounts);
  const accounts = data.accounts
    .filter((account) => money.has(account.id))
    .map((account) => ({
      accountId: account.id,
      code: account.code,
      name: account.name,
      balance: sumSide(
        lines,
        'debit',
        (line) => line.accountId === account.id && line.date <= today,
      ),
    }))
    .sort((a, b) => compareMoney(b.balance, a.balance) || compareCodes(a.code, b.code));
  return {
    accounts,
    total: sumMoney(accounts.map((account) => account.balance)),
    yesterday: sumSide(lines, 'debit', (line) => money.has(line.accountId) && line.date < today),
  };
}

// A control account's balance up to today in its natural sign, and the documents past their due
// date with something still to pay
function duesCard(
  lines: readonly Line[],
  accountId: string | null,
  side: 'debit' | 'credit',
  today: string,
  open: readonly { status: string; dueDate: string; due: string }[],
): DashboardDues {
  const overdue = open.filter(
    (document) =>
      document.status === 'posted' && document.dueDate < today && !isZeroMoney(document.due),
  );
  return {
    total: sumSide(lines, side, (line) => line.accountId === accountId && line.date <= today),
    overdue: sumMoney(overdue.map((document) => document.due)),
    overdueCount: overdue.length,
  };
}

function unitOf(data: WorkspaceData, unitId: string) {
  const unit = data.catalog.units.find((candidate) => candidate.id === unitId);
  return { code: unit?.code ?? '', decimals: unit?.decimals ?? 0 };
}

// Posted invoices' lines and POS sales' lines of the chart's days, before returns, by variant, the
// largest amount first. A POS sale's branch is its warehouse's (decision 33).
function topProducts(
  data: WorkspaceData,
  periods: DashboardPeriods,
  branchId: string | null,
): DashboardTopProduct[] {
  const inDays = (date: string) => date >= periods.trendStart && date <= periods.today;
  const branchOfWarehouse = new Map(
    data.stock.warehouses.map((place) => [place.id, place.branchId]),
  );
  const sold = [
    ...data.billing.invoices
      .filter(
        (invoice) =>
          invoice.status === 'posted' &&
          inDays(invoice.date) &&
          (branchId === null || invoice.branchId === branchId),
      )
      .flatMap((invoice) => invoice.lines),
    ...data.pos.sales
      .filter(
        (sale) =>
          inDays(sale.date) &&
          (branchId === null || branchOfWarehouse.get(sale.warehouseId) === branchId),
      )
      .flatMap((sale) => sale.lines),
  ];
  const byVariant = new Map<string, { quantities: string[]; amounts: string[] }>();
  for (const line of sold) {
    const found = byVariant.get(line.variantId) ?? { quantities: [], amounts: [] };
    found.quantities.push(line.baseQuantity);
    found.amounts.push(line.net);
    byVariant.set(line.variantId, found);
  }
  return [...byVariant]
    .flatMap(([variantId, totals]) => {
      // The product's name and unit as they are now, like the API's join
      const found = findVariant(data, variantId);
      if (!found) return [];
      return [
        {
          ...refOf(found.product, found.variant),
          baseUnit: unitOf(data, found.product.baseUnitId),
          quantity: sumQuantity(totals.quantities),
          amount: sumMoney(totals.amounts),
        },
      ];
    })
    .sort((a, b) => compareMoney(b.amount, a.amount) || a.variantId.localeCompare(b.variantId))
    .slice(0, DASHBOARD_TOP_PRODUCTS);
}

// How empty a row is, to sort by: the share of its level on hand, as a percent with 1 decimal. The
// API divides exactly; the mock's rows never come within 0.1% of each other. A level of 0 has no
// share: below zero sorts as −100%, with the rows below zero, and empty as 0%.
function emptiness(row: { onHand: string; minQuantity: string }): string {
  if (isZeroMoney(row.minQuantity)) return isNegativeMoney(row.onHand) ? '-100.0' : '0.0';
  return percentOfWhole(row.onHand, row.minQuantity);
}

// The reorder report's rows of active warehouses and products, the emptiest first (decision 19)
function lowStockCard(data: WorkspaceData): DashboardLowStock {
  const places = new Map(data.stock.warehouses.map((place) => [place.id, place]));
  const rows = reorderReport(data, undefined).flatMap((row) => {
    const place = places.get(row.warehouseId);
    const found = findVariant(data, row.variantId);
    // An unknown or archived warehouse, product or variant is left out, as the API's joins do
    if (place?.archivedAt !== null || !found) return [];
    if (found.product.archivedAt !== null || found.variant.archivedAt !== null) return [];
    return [
      {
        ...row,
        warehouseName: place.name,
        baseUnit: unitOf(data, found.product.baseUnitId),
      },
    ];
  });
  // Then by the product's name, like the API's lower(p.name), so the order never changes on reload
  const name = (row: { productName: string }) => row.productName.toLowerCase();
  rows.sort(
    (a, b) =>
      compareMoney(emptiness(a), emptiness(b)) ||
      name(a).localeCompare(name(b)) ||
      a.variantId.localeCompare(b.variantId) ||
      a.warehouseId.localeCompare(b.warehouseId),
  );
  return { count: rows.length, items: rows.slice(0, DASHBOARD_LOW_STOCK_ITEMS) };
}

// The answer for the person's cards (dashboardCardsFor() of their permissions): a card they may
// not see is null, and its numbers are never worked out
export function dashboardOf(
  data: WorkspaceData,
  cards: readonly DashboardCard[],
  query: DashboardQuery,
): Dashboard {
  const today = todayIn(data.settings.timezone);
  const periods = dashboardPeriods(today);
  const branchId = query.branchId ?? null;
  const shows = (card: DashboardCard) => cards.includes(card);
  const lines = postedLines(data);
  const sold = shows('sales') || shows('margin') ? soldCards(data, lines, periods, branchId) : null;
  return {
    today,
    generatedAt: new Date().toISOString(),
    branchId,
    sales: shows('sales') ? (sold?.sales ?? null) : null,
    margin: shows('margin') ? (sold?.margin ?? null) : null,
    cash: shows('cash') ? cashCard(data, lines, today) : null,
    topProducts: shows('topProducts') ? topProducts(data, periods, branchId) : null,
    receivables: shows('receivables')
      ? duesCard(
          lines,
          accountOf(data, 'accounts_receivable'),
          'debit',
          today,
          data.billing.invoices.map((invoice) => ({
            status: invoice.status,
            dueDate: invoice.dueDate,
            due: invoiceDue(data, invoice),
          })),
        )
      : null,
    payables: shows('payables')
      ? duesCard(
          lines,
          accountOf(data, 'accounts_payable'),
          'credit',
          today,
          data.purchase.bills.map((bill) => ({
            status: bill.status,
            dueDate: bill.dueDate,
            due: billDue(data, bill),
          })),
        )
      : null,
    lowStock: shows('lowStock') ? lowStockCard(data) : null,
  };
}
