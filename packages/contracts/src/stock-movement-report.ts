import { z } from 'zod';

import { dashboardUnitSchema } from './dashboard.js';
import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { type MovementKind, variantRefSchema } from './stock.js';

// The stock movement report (step 21c): for each variant, what it opened with, what came in and went
// out in a period, and what it closed with.
//
//   closing = opening + purchased − sold + transfers + adjusted
//
// - Quantities are in the product's base unit, so the rows never add up to a total: 40 pcs and
//   2.74 m are not one number. That is also why there is no "group by category".
// - The value columns need inventory.stock.value. Without them they are null, and sorting by them
//   is refused: the order of the rows would tell what the hidden column says.
// - A row opens the variant's stock card, where the single movements are.

// ---------------------------------------------------------------------------------------------
// Which column each kind of movement belongs to

export const STOCK_MOVEMENT_COLUMNS = ['purchased', 'sold', 'transfers', 'adjusted'] as const;
export type StockMovementColumn = (typeof STOCK_MOVEMENT_COLUMNS)[number];

// A return is in the column of what it undoes, so "Sold" is what really left. null: a revaluation
// moves the value, never the quantity. satisfies: a new kind of movement does not compile until it
// has a column here.
export const STOCK_MOVEMENT_COLUMN_OF = {
  purchase_receipt: 'purchased',
  purchase_return: 'purchased',
  delivery: 'sold',
  sales_return: 'sold',
  pos_sale: 'sold',
  pos_return: 'sold',
  transfer_in: 'transfers',
  transfer_out: 'transfers',
  adjustment: 'adjusted',
  revaluation: null,
} as const satisfies Record<MovementKind, StockMovementColumn | null>;

// ---------------------------------------------------------------------------------------------
// The query

// 'moved' keeps the variants with a movement in the period. 'all' adds the ones that had stock
// and did not move. A variant with no stock and no movement never has a row.
export const STOCK_MOVEMENT_SHOWS = ['moved', 'all'] as const;
export type StockMovementShow = (typeof STOCK_MOVEMENT_SHOWS)[number];

export const STOCK_MOVEMENT_SORTS = [
  'name',
  '-name',
  'sku',
  '-sku',
  'opening',
  '-opening',
  'purchased',
  '-purchased',
  'sold',
  '-sold',
  'transfers',
  '-transfers',
  'adjusted',
  '-adjusted',
  'closing',
  '-closing',
  'openingValue',
  '-openingValue',
  'closingValue',
  '-closingValue',
] as const;
export type StockMovementSort = (typeof STOCK_MOVEMENT_SORTS)[number];

export const STOCK_MOVEMENT_VALUE_SORTS = [
  'openingValue',
  '-openingValue',
  'closingValue',
  '-closingValue',
] as const satisfies readonly StockMovementSort[];

export function isStockValueSort(sort: StockMovementSort): boolean {
  return STOCK_MOVEMENT_VALUE_SORTS.some((item) => item === sort);
}

const stockMovementFilterShape = {
  from: z.iso.date(),
  to: z.iso.date(),
  warehouseId: z.uuid().optional(),
  // This category and every category under it
  categoryId: z.uuid().optional(),
  show: z.enum(STOCK_MOVEMENT_SHOWS).default('moved'),
  sort: z.enum(STOCK_MOVEMENT_SORTS).default('name'),
};

function checkPeriod(query: { from: string; to: string }, ctx: z.RefinementCtx): void {
  if (query.from > query.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: errorCode('report_range_invalid') });
  }
}

// The filters without the page: what an export carries (every row, in the same order)
export const stockMovementFilterSchema = z
  .object(stockMovementFilterShape)
  .superRefine(checkPeriod);
export type StockMovementFilter = z.infer<typeof stockMovementFilterSchema>;

export const stockMovementReportQuerySchema = pageQuerySchema
  .extend(stockMovementFilterShape)
  .superRefine(checkPeriod);
export type StockMovementReportQuery = z.input<typeof stockMovementReportQuerySchema>;

// ---------------------------------------------------------------------------------------------
// The answer. Quantities and values are decimal strings with 4 places.

export const stockMovementRowSchema = variantRefSchema.extend({
  baseUnit: dashboardUnitSchema,
  opening: z.string(),
  // Received less what went back to the supplier
  purchased: z.string(),
  // Delivered and sold at the counter, less what came back. Positive means stock went out.
  sold: z.string(),
  // In less out. With every warehouse in the report a finished transfer nets to zero, so a
  // negative number here is stock still on a truck.
  transfers: z.string(),
  // Signed: found stock is positive, damaged stock negative
  adjusted: z.string(),
  closing: z.string(),
  // null without inventory.stock.value
  openingValue: z.string().nullable(),
  closingValue: z.string().nullable(),
});
export type StockMovementRow = z.infer<typeof stockMovementRowSchema>;

export const stockMovementReportSchema = pageOf(stockMovementRowSchema).extend({
  // false without inventory.stock.value. The page draws its columns from this, so they are right
  // even when there are no rows.
  withValue: z.boolean(),
  // The same on every page: the page reads them from the first one
  totals: z.object({
    // How many rows the report has, over every page
    variants: z.number().int().min(0),
    // null without inventory.stock.value. There is no total quantity (see the top of this file).
    openingValue: z.string().nullable(),
    closingValue: z.string().nullable(),
  }),
});
export type StockMovementReport = z.infer<typeof stockMovementReportSchema>;

// ---------------------------------------------------------------------------------------------
// The route

export const stockMovementReportRoutes = {
  report: defineRoute({
    method: 'GET',
    path: '/reports/stock-movement',
    summary: 'Opening, purchased, sold, transferred, adjusted and closing stock of a period',
    auth: 'bearer',
    permission: 'inventory.report.read',
    status: 200,
    query: stockMovementReportQuerySchema,
    response: stockMovementReportSchema,
  }),
};
