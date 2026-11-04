import { z } from 'zod';

import { defineRoute } from './http.js';
import { shiftIsoDate } from './journal.js';
import { isZeroMoney, percentOfWhole, subtractMoney } from './money.js';
import type { PermissionKey } from './permissions.js';
import { reorderItemSchema, variantRefSchema } from './stock.js';
import { unitSchema } from './units.js';

// The dashboard (step 21a): the home page's numbers, in one answer.
//
// - Sales are the books' sales: the account with the 'sales' purpose, less the Sales returns
//   account of Settings → Sales when one is chosen, net and before VAT. Invoices and POS sales both
//   post there, so the dashboard and the profit and loss always say the same. The API reads them
//   from account_day_totals (step 21a.2), one row per day, branch and account.
// - Each part has its own permission (DASHBOARD_CARD_PERMISSIONS). A part the person may not see is
//   null in the answer, never left for the screen to hide: the answer is kept on the device for
//   offline (decision 7), and what is not in it cannot leak from there.
// - A branch filters what was sold (sales, margin, top products). Cash, dues and low stock are the
//   whole workspace's: a bank account or a customer's balance belongs to no one branch.

// The sales chart's days, today included
export const DASHBOARD_TREND_DAYS = 30;
// The top products are of the same days
export const DASHBOARD_TOP_PRODUCTS = 5;
export const DASHBOARD_LOW_STOCK_ITEMS = 5;

export const DASHBOARD_CARDS = [
  'sales',
  'margin',
  'cash',
  'topProducts',
  'receivables',
  'payables',
  'lowStock',
] as const;
export type DashboardCard = (typeof DASHBOARD_CARDS)[number];

// Every permission listed is needed. The margin shows what was sold, so it needs the sales
// report's permission too, not only the stock value's.
export const DASHBOARD_CARD_PERMISSIONS = {
  sales: ['sales.report.read'],
  margin: ['sales.report.read', 'inventory.stock.value'],
  cash: ['accounting.report.read'],
  topProducts: ['sales.report.read'],
  receivables: ['sales.customer.balance'],
  payables: ['purchase.supplier.balance'],
  lowStock: ['inventory.report.read'],
} as const satisfies Record<DashboardCard, readonly PermissionKey[]>;

// The cards a person may see, in the screen's order. It takes plain strings: me.permissions is
// z.string()[] on the wire (a newer server's key must not break an older client).
export function dashboardCardsFor(permissions: readonly string[]): DashboardCard[] {
  const held = new Set(permissions);
  return DASHBOARD_CARDS.filter((card) =>
    DASHBOARD_CARD_PERMISSIONS[card].every((key) => held.has(key)),
  );
}

// ---------------------------------------------------------------------------------------------
// The days the numbers cover, all from the workspace's today (todayIn() in numbering.ts)

export interface DashboardPeriods {
  today: string;
  yesterday: string;
  // The 1st of this month: this month so far is monthStart … today
  monthStart: string;
  // The same days of last month, to compare with: 1–2 Oct on 2 Nov. On 31 Mar it is the whole of
  // February, never "1–31 Feb", which would run into March.
  lastMonthStart: string;
  lastMonthEnd: string;
  // The first day of the sales chart and the top products: DASHBOARD_TREND_DAYS days up to today
  trendStart: string;
}

// It reads the parts of the string, never a Date, so no time zone can move the day (the same rule
// as fiscalYearOf in reports.ts)
export function dashboardPeriods(today: string): DashboardPeriods {
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthLastDay = shiftIsoDate(monthStart, -1);
  const lastMonthStart = `${lastMonthLastDay.slice(0, 7)}-01`;
  const day = Math.min(Number(today.slice(8, 10)), Number(lastMonthLastDay.slice(8, 10)));
  return {
    today,
    yesterday: shiftIsoDate(today, -1),
    monthStart,
    lastMonthStart,
    lastMonthEnd: `${lastMonthStart.slice(0, 8)}${String(day).padStart(2, '0')}`,
    trendStart: shiftIsoDate(today, 1 - DASHBOARD_TREND_DAYS),
  };
}

// Every day from `from`, `count` days, with its amount: a day with no row is a day with no sales,
// "0.0000", so the chart has a point for every day. The API and the mock both call it.
export function everyDay(
  from: string,
  count: number,
  amounts: ReadonlyMap<string, string>,
): { date: string; amount: string }[] {
  return Array.from({ length: count }, (_, index) => {
    const date = shiftIsoDate(from, index);
    return { date, amount: amounts.get(date) ?? '0.0000' };
  });
}

// The change line of a KPI: "+12.5" percent against what it is compared with. null when there is
// nothing to compare with (no sales yesterday): the screen then shows no percent, not "+∞%".
export function changePercent(current: string, previous: string): string | null {
  return isZeroMoney(previous) ? null : percentOfWhole(subtractMoney(current, previous), previous);
}

// What was left of the sales after their cost, as a percent of the sales. null with no sales.
export function marginPercent(period: { sales: string; cost: string }): string | null {
  return isZeroMoney(period.sales)
    ? null
    : percentOfWhole(subtractMoney(period.sales, period.cost), period.sales);
}

// ---------------------------------------------------------------------------------------------
// The answer. Every amount is a decimal string with 4 places, like the reports; the screen shows
// whole taka (CLAUDE.md → Money: dashboards stay without decimals).

// No branch = the whole workspace. A branch that does not exist (or is another workspace's) is
// not an error: nothing was sold there, so its numbers are zero, like the profit and loss's.
export const dashboardQuerySchema = z.object({ branchId: z.uuid().optional() });
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export const dashboardDaySchema = z.object({ date: z.iso.date(), amount: z.string() });
export type DashboardDay = z.infer<typeof dashboardDaySchema>;

export const dashboardSalesSchema = z.object({
  today: z.string(),
  yesterday: z.string(),
  monthToDate: z.string(),
  lastMonthToDate: z.string(),
  // DASHBOARD_TREND_DAYS days, the oldest first, the last one today (everyDay())
  days: z.array(dashboardDaySchema).length(DASHBOARD_TREND_DAYS),
});
export type DashboardSales = z.infer<typeof dashboardSalesSchema>;

// cost: what the cost of goods sold account took in the same days. The sales are repeated here, so
// the margin stands on its own and marginPercent() reads one object.
const salesAndCostSchema = z.object({ sales: z.string(), cost: z.string() });

export const dashboardMarginSchema = z.object({
  monthToDate: salesAndCostSchema,
  lastMonthToDate: salesAndCostSchema,
});
export type DashboardMargin = z.infer<typeof dashboardMarginSchema>;

export const dashboardCashAccountSchema = z.object({
  accountId: z.uuid(),
  code: z.string(),
  name: z.string(),
  // Debit − credit now: below zero is an overdrawn bank account, shown with a minus
  balance: z.string(),
});
export type DashboardCashAccount = z.infer<typeof dashboardCashAccountSchema>;

export const dashboardCashSchema = z.object({
  // Every active account money is kept in (moneyAccountIds() in accounts.ts), the largest first
  accounts: z.array(dashboardCashAccountSchema),
  total: z.string(),
  // The total at the end of yesterday: the change line says what came in or went out today
  yesterday: z.string(),
});
export type DashboardCash = z.infer<typeof dashboardCashSchema>;

// The receivables (customers) or the payables (suppliers)
export const dashboardDuesSchema = z.object({
  // The receivable or payable account's balance in its natural sign: what the customers owe, less
  // what they paid in advance. Below zero when the advances are larger.
  total: z.string(),
  // Posted invoices (or bills) past their due date and not settled in full (isOverdue() in
  // invoices.ts and bills.ts): what is still due on them, and how many there are
  overdue: z.string(),
  overdueCount: z.number().int().min(0),
});
export type DashboardDues = z.infer<typeof dashboardDuesSchema>;

// What the screen needs to write a quantity ("72 pcs"), offline too, where it cannot look the
// unit up
export const dashboardUnitSchema = unitSchema.pick({ code: true, decimals: true });

export const dashboardLowStockItemSchema = reorderItemSchema.extend({
  warehouseName: z.string(),
  baseUnit: dashboardUnitSchema,
});
export type DashboardLowStockItem = z.infer<typeof dashboardLowStockItemSchema>;

export const dashboardLowStockSchema = z.object({
  // Every variant and warehouse at or below its reorder level, like the reorder report
  count: z.number().int().min(0),
  // The first DASHBOARD_LOW_STOCK_ITEMS of them, the emptiest first (the smallest share of its
  // reorder level on hand)
  items: z.array(dashboardLowStockItemSchema).max(DASHBOARD_LOW_STOCK_ITEMS),
});
export type DashboardLowStock = z.infer<typeof dashboardLowStockSchema>;

// What was sold of one variant in the chart's days: posted invoices and POS sales, before their
// returns. The largest amount first.
export const dashboardTopProductSchema = variantRefSchema.extend({
  // In the base unit
  quantity: z.string(),
  baseUnit: dashboardUnitSchema,
  // After discounts, before VAT, like the sales above
  amount: z.string(),
});
export type DashboardTopProduct = z.infer<typeof dashboardTopProductSchema>;

export const dashboardSchema = z.object({
  // The workspace's today when the answer was made: every period counts from it
  today: z.iso.date(),
  // When the answer was made: offline, the screen says "As of 10:42"
  generatedAt: z.iso.datetime(),
  branchId: z.uuid().nullable(),
  // null = no permission for that card (DASHBOARD_CARD_PERMISSIONS)
  sales: dashboardSalesSchema.nullable(),
  margin: dashboardMarginSchema.nullable(),
  cash: dashboardCashSchema.nullable(),
  topProducts: z.array(dashboardTopProductSchema).max(DASHBOARD_TOP_PRODUCTS).nullable(),
  receivables: dashboardDuesSchema.nullable(),
  payables: dashboardDuesSchema.nullable(),
  lowStock: dashboardLowStockSchema.nullable(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const dashboardRoutes = {
  // No permission on the route: everyone signed in has a home page, and each card checks its own
  get: defineRoute({
    method: 'GET',
    path: '/dashboard',
    summary: "The home page's numbers: sales, margin, cash, dues and low stock, as allowed",
    auth: 'bearer',
    status: 200,
    query: dashboardQuerySchema,
    response: dashboardSchema,
  }),
};
