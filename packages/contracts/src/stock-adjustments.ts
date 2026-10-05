import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import {
  documentSerialRules,
  MAX_STOCK_LINES,
  stockInLineFieldsSchema,
  stockLineRules,
  stockLineSchema,
} from './stock.js';

// A stock adjustment brings stock into one warehouse or takes it out, for a reason that is not a
// sale or a purchase: the opening stock on the first day, goods found in a count, a damaged carton,
// an expired batch, physician samples. Like a journal entry: a draft can be changed, a posted one
// is in the stock ledger for good, and a mistake is fixed by another adjustment.
export const ADJUSTMENT_DIRECTIONS = ['in', 'out'] as const;
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];

export const ADJUSTMENT_REASONS = [
  'opening',
  'found',
  'damaged',
  'expired',
  'lost',
  'sample',
  'internal_use',
  'correction',
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

// Which way each reason moves stock. A correction goes either way; the rest say it themselves —
// nobody "finds" stock that leaves, or "damages" stock into a warehouse.
export const REASON_DIRECTIONS = {
  opening: ['in'],
  found: ['in'],
  damaged: ['out'],
  expired: ['out'],
  lost: ['out'],
  sample: ['out'],
  internal_use: ['out'],
  correction: ['in', 'out'],
} as const satisfies Record<AdjustmentReason, readonly AdjustmentDirection[]>;

export function reasonFits(reason: AdjustmentReason, direction: AdjustmentDirection): boolean {
  const allowed: readonly AdjustmentDirection[] = REASON_DIRECTIONS[reason];
  return allowed.includes(direction);
}

export function isAdjustmentReason(value: string): value is AdjustmentReason {
  return ADJUSTMENT_REASONS.some((reason) => reason === value);
}

export function isAdjustmentDirection(value: string): value is AdjustmentDirection {
  return ADJUSTMENT_DIRECTIONS.some((direction) => direction === value);
}

export const STOCK_DOCUMENT_STATUSES = ['draft', 'posted'] as const;
export type StockDocumentStatus = (typeof STOCK_DOCUMENT_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const stockAdjustmentSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft: the number is given when it is posted, so posted numbers have no gaps
  number: z.string().nullable(),
  date: z.iso.date(),
  warehouseId: z.uuid(),
  // z.string(): the rule of every list the server may grow
  direction: z.string(),
  reason: z.string(),
  note: z.string().nullable(),
  status: z.enum(STOCK_DOCUMENT_STATUSES),
  lineCount: z.number().int(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StockAdjustmentSummary = z.infer<typeof stockAdjustmentSummarySchema>;

export const stockAdjustmentSchema = stockAdjustmentSummarySchema.extend({
  lines: z.array(stockLineSchema),
});
export type StockAdjustment = z.infer<typeof stockAdjustmentSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

const adjustmentLineInputSchema = stockInLineFieldsSchema.superRefine(stockLineRules);

const stockAdjustmentFieldsSchema = z.object({
  date: z.iso.date(errorCode('stock_date_required')),
  warehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  direction: z.enum(ADJUSTMENT_DIRECTIONS),
  reason: z.enum(ADJUSTMENT_REASONS),
  note: optionalText(300),
  lines: z
    .array(adjustmentLineInputSchema)
    .min(1, errorCode('stock_lines_required'))
    .max(MAX_STOCK_LINES),
  // true = the form's "Post": save and post in one step, or nothing at all
  post: z.boolean(),
});

type AdjustmentRuleInput = z.output<typeof stockAdjustmentFieldsSchema>;

function adjustmentRules(input: AdjustmentRuleInput, ctx: z.RefinementCtx<AdjustmentRuleInput>) {
  if (!reasonFits(input.reason, input.direction)) {
    ctx.addIssue({
      code: 'custom',
      path: ['reason'],
      message: errorCode('adjustment_reason_direction'),
    });
  }
  documentSerialRules(input, ctx);
}

export const stockAdjustmentInputSchema = stockAdjustmentFieldsSchema.superRefine(adjustmentRules);
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentInputSchema>;

export const updateStockAdjustmentInputSchema = stockAdjustmentFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(adjustmentRules);
export type UpdateStockAdjustmentInput = z.infer<typeof updateStockAdjustmentInputSchema>;
export type StockAdjustmentFormValues = z.input<typeof updateStockAdjustmentInputSchema>;

export const stockAdjustmentVersionInputSchema = z.object({ version: versionSchema });

export const deleteStockAdjustmentQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const stockAdjustmentListQuerySchema = pageQuerySchema.extend({
  status: z.enum(STOCK_DOCUMENT_STATUSES).optional(),
  warehouseId: z.uuid().optional(),
});

export const stockAdjustmentPageSchema = pageOf(stockAdjustmentSummarySchema);

const adjustmentParamsSchema = z.object({ id: z.uuid() });

export const stockAdjustmentRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/stock-adjustments',
    summary: 'Stock adjustments, newest date first',
    auth: 'bearer',
    status: 200,
    query: stockAdjustmentListQuerySchema,
    response: stockAdjustmentPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/stock-adjustments/:id',
    summary: 'One stock adjustment with its lines',
    auth: 'bearer',
    status: 200,
    params: adjustmentParamsSchema,
    response: stockAdjustmentSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/stock-adjustments',
    summary: 'Write a stock adjustment as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'inventory.stock.adjust',
    status: 201,
    body: stockAdjustmentInputSchema,
    response: stockAdjustmentSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/stock-adjustments/:id',
    summary: 'Change a draft adjustment, and optionally post it',
    auth: 'bearer',
    permission: 'inventory.stock.adjust',
    status: 200,
    params: adjustmentParamsSchema,
    body: updateStockAdjustmentInputSchema,
    response: stockAdjustmentSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/stock-adjustments/:id',
    summary: 'Delete a draft adjustment',
    auth: 'bearer',
    permission: 'inventory.stock.adjust',
    status: 204,
    params: adjustmentParamsSchema,
    query: deleteStockAdjustmentQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/stock-adjustments/:id/post',
    summary: 'Post a draft adjustment: it gets its number and moves the stock',
    auth: 'bearer',
    permission: 'inventory.stock.adjust',
    status: 200,
    params: adjustmentParamsSchema,
    body: stockAdjustmentVersionInputSchema,
    response: stockAdjustmentSchema,
  }),
};
