import { z } from 'zod';

import { dashboardUnitSchema, marginPercent } from './dashboard.js';
import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { subtractMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// The sales report and the purchase report (step 21b): what was sold or bought in a period, one
// row per customer, product, category, branch or month.
//
// - The numbers come from the documents' lines, net of discounts and before VAT, by the
//   document's date. Sales: posted invoices and POS sales, less posted credit notes and POS
//   returns. Purchases: posted bills (product lines, account lines and expenses), less posted
//   debit notes.
// - The sales report also says what the books say (`books`): the 'sales' account less the Sales
//   returns account, like the dashboard. A journal entry written by hand on the sales account
//   makes the two differ, and the page shows by how much.
// - Cost and margin need inventory.stock.value. Without it they are null, and sorting by them is
//   refused.
// - Rows come a page at a time, sorted on the server. The totals are of every row, not of the page.

// ---------------------------------------------------------------------------------------------
// What a row is

export const SALES_REPORT_GROUPS = ['customer', 'product', 'category', 'branch', 'month'] as const;
export type SalesReportGroup = (typeof SALES_REPORT_GROUPS)[number];

export const PURCHASE_REPORT_GROUPS = ['supplier', 'product', 'account', 'month'] as const;
export type PurchaseReportGroup = (typeof PURCHASE_REPORT_GROUPS)[number];

// 'item' is one thing of the group: a customer, a product, a branch, a month. The others stand for
// the lines that have no such thing, so that the rows always add up to the whole period:
// - walk_in: POS sales with no customer (sales, by customer)
// - no_category: products with no category (by category)
// - expenses: every account line and expense of the bills (purchases, by product)
// - products: every product line of the bills (purchases, by account)
export const TRADE_REPORT_ROW_KINDS = [
  'item',
  'walk_in',
  'no_category',
  'expenses',
  'products',
] as const;
export type TradeReportRowKind = (typeof TRADE_REPORT_ROW_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// The query

// Both days included, like the other reports. `to` before `from` shows under "To".
function checkPeriod(query: { from: string; to: string }, ctx: z.RefinementCtx): void {
  if (query.from > query.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: errorCode('report_range_invalid') });
  }
}

// A quantity adds up only inside one product (its variants share the base unit), so the quantity
// column, and sorting by it, belong to the product group only
function checkQuantitySort(query: { groupBy: string; sort: string }, ctx: z.RefinementCtx): void {
  if (query.groupBy !== 'product' && (query.sort === 'quantity' || query.sort === '-quantity')) {
    ctx.addIssue({ code: 'custom', path: ['sort'], message: errorCode('report_sort_invalid') });
  }
}

// A column name sorts up, the same name with a minus sorts down. 'name' sorts the months by date.
export const SALES_REPORT_SORTS = [
  'name',
  '-name',
  'quantity',
  '-quantity',
  'gross',
  '-gross',
  'returns',
  '-returns',
  'net',
  '-net',
  'cost',
  '-cost',
  'margin',
  '-margin',
  'marginPercent',
  '-marginPercent',
] as const;
export type SalesReportSort = (typeof SALES_REPORT_SORTS)[number];

// The sorts that read the cost: refused without inventory.stock.value, because the order of the
// rows would tell what the hidden column says
export const SALES_REPORT_COST_SORTS = [
  'cost',
  '-cost',
  'margin',
  '-margin',
  'marginPercent',
  '-marginPercent',
] as const satisfies readonly SalesReportSort[];

export function isCostSort(sort: SalesReportSort): boolean {
  return SALES_REPORT_COST_SORTS.some((item) => item === sort);
}

export const PURCHASE_REPORT_SORTS = [
  'name',
  '-name',
  'quantity',
  '-quantity',
  'gross',
  '-gross',
  'returns',
  '-returns',
  'net',
  '-net',
] as const;
export type PurchaseReportSort = (typeof PURCHASE_REPORT_SORTS)[number];

const salesReportFilterShape = {
  from: z.iso.date(),
  to: z.iso.date(),
  groupBy: z.enum(SALES_REPORT_GROUPS).default('customer'),
  // Invoices and credit notes by their own branch, POS sales and returns by their warehouse's
  branchId: z.uuid().optional(),
  customerGroupId: z.uuid().optional(),
  // This category and every category under it
  categoryId: z.uuid().optional(),
  sort: z.enum(SALES_REPORT_SORTS).default('-net'),
};

// The report's filters without the page: what an export carries (every row, in the same order)
export const salesReportFilterSchema = z
  .object(salesReportFilterShape)
  .superRefine((query, ctx) => {
    checkPeriod(query, ctx);
    checkQuantitySort(query, ctx);
  });
export type SalesReportFilter = z.infer<typeof salesReportFilterSchema>;

export const salesReportQuerySchema = pageQuerySchema
  .extend(salesReportFilterShape)
  .superRefine((query, ctx) => {
    checkPeriod(query, ctx);
    checkQuantitySort(query, ctx);
  });
export type SalesReportQuery = z.input<typeof salesReportQuerySchema>;

const purchaseReportFilterShape = {
  from: z.iso.date(),
  to: z.iso.date(),
  groupBy: z.enum(PURCHASE_REPORT_GROUPS).default('supplier'),
  branchId: z.uuid().optional(),
  supplierGroupId: z.uuid().optional(),
  // Product lines only: an account line or an expense has no category, so it drops out
  categoryId: z.uuid().optional(),
  sort: z.enum(PURCHASE_REPORT_SORTS).default('-net'),
};

export const purchaseReportFilterSchema = z
  .object(purchaseReportFilterShape)
  .superRefine((query, ctx) => {
    checkPeriod(query, ctx);
    checkQuantitySort(query, ctx);
  });
export type PurchaseReportFilter = z.infer<typeof purchaseReportFilterSchema>;

export const purchaseReportQuerySchema = pageQuerySchema
  .extend(purchaseReportFilterShape)
  .superRefine((query, ctx) => {
    checkPeriod(query, ctx);
    checkQuantitySort(query, ctx);
  });
export type PurchaseReportQuery = z.input<typeof purchaseReportQuerySchema>;

// ---------------------------------------------------------------------------------------------
// The answer. Every amount is a decimal string with 4 places, like the other reports; the page
// shows whole taka (a list), the export keeps the paisa.

const tradeReportRowBaseSchema = z.object({
  // Unique in the answer: the id, the month ('2026-09'), or the kind of a row that stands for
  // the lines with no such thing ('walk_in')
  key: z.string(),
  kind: z.enum(TRADE_REPORT_ROW_KINDS),
  // The customer, supplier, product, category, branch or account. null for a month and for a row
  // that is not an 'item'.
  id: z.uuid().nullable(),
  // The customer's, supplier's, product's, branch's or account's code. null for a category, a
  // month and a row that is not an 'item'.
  code: z.string().nullable(),
  name: z.string().nullable(),
  // The month's row only: '2026-09'
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullable(),
  // The product group only (null elsewhere): what was sold less what came back, or what was
  // billed less what went back, in the product's base unit
  quantity: z.string().nullable(),
  baseUnit: dashboardUnitSchema.nullable(),
  // Sales: invoices and POS sales. Purchases: bills.
  gross: z.string(),
  // Sales: credit notes and POS returns. Purchases: debit notes. Positive: what was taken off.
  returns: z.string(),
  // gross − returns: what the row is worth in the period
  net: z.string(),
});

// What the sold lines cost, less the cost of what came back. A line from a challan has the
// challan's cost, a direct invoice line its own stock movement's, a POS line its own: each dated
// by the invoice or the sale, so a sale and its cost always fall in the same period. (The books
// date a challan's cost by the challan, so the two can differ in a month where a challan and its
// invoice fall in different months.)
const costColumnsSchema = z.object({
  // null without inventory.stock.value
  cost: z.string().nullable(),
  // net − cost
  margin: z.string().nullable(),
  // margin as a percent of net, one decimal; null without the permission or with net zero
  marginPercent: z.string().nullable(),
});

export const salesReportRowSchema = tradeReportRowBaseSchema.extend(costColumnsSchema.shape);
export type SalesReportRow = z.infer<typeof salesReportRowSchema>;

export const purchaseReportRowSchema = tradeReportRowBaseSchema;
export type PurchaseReportRow = z.infer<typeof purchaseReportRowSchema>;

const tradeTotalsSchema = z.object({ gross: z.string(), returns: z.string(), net: z.string() });

export const salesReportTotalsSchema = tradeTotalsSchema.extend(costColumnsSchema.shape);
export type SalesReportTotals = z.infer<typeof salesReportTotalsSchema>;

// The same totals on every page: the page reads them from the first one
export const salesReportSchema = pageOf(salesReportRowSchema).extend({
  totals: salesReportTotalsSchema,
  // false without inventory.stock.value: every cost, margin and percent is null. The page draws
  // the columns from this, so they are right even when there are no rows.
  withCost: z.boolean(),
  // The books' sales of the same period and branch, net and before VAT. null with a customer
  // group or a category: the books' lines carry neither, so there is nothing to compare with.
  books: z.string().nullable(),
});
export type SalesReport = z.infer<typeof salesReportSchema>;

export const purchaseReportSchema = pageOf(purchaseReportRowSchema).extend({
  totals: tradeTotalsSchema,
});
export type PurchaseReport = z.infer<typeof purchaseReportSchema>;

// The cost columns of a row or of the totals, from its net and its cost. The API and the mock both
// call it, so the margin and its percent are worked out one way.
export function costColumns(net: string, cost: string | null): z.infer<typeof costColumnsSchema> {
  if (cost === null) return { cost: null, margin: null, marginPercent: null };
  return {
    cost,
    margin: subtractMoney(net, cost),
    marginPercent: marginPercent({ sales: net, cost }),
  };
}

// ---------------------------------------------------------------------------------------------
// The routes

export const tradeReportRoutes = {
  sales: defineRoute({
    method: 'GET',
    path: '/reports/sales',
    summary: 'Sales of a period by customer, product, category, branch or month',
    auth: 'bearer',
    permission: 'sales.report.read',
    status: 200,
    query: salesReportQuerySchema,
    response: salesReportSchema,
  }),
  purchases: defineRoute({
    method: 'GET',
    path: '/reports/purchases',
    summary: 'Purchases of a period by supplier, product, expense account or month',
    auth: 'bearer',
    permission: 'purchase.report.read',
    status: 200,
    query: purchaseReportQuerySchema,
    response: purchaseReportSchema,
  }),
};
