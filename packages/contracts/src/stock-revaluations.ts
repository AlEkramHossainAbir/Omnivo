import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { MAX_STOCK_LINES, variantRefSchema } from './stock.js';

// Revaluing stock (step 14): a new average cost for some variants, without moving a piece. It is
// how the stock that came in before step 14 (at zero cost) gets its real value, and how a wrong
// cost is put right later. The difference goes to the books at once: up, Dr Inventory / Cr the
// revaluation account; down, the other way round. Posted when it is saved — there is no draft,
// because the difference depends on the stock at that moment.

// A unit cost per base unit, like the average it replaces: up to 4 decimals (a tablet costs
// ৳0.8512). Zero is allowed: goods that are worth nothing now (a damaged lot kept for a claim).
const unitCostSchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}(?:\.\d{1,4})?$/, errorCode('money_format'));

export const revaluationLineInputSchema = z.object({
  variantId: z.uuid(errorCode('stock_variant_required')),
  unitCost: unitCostSchema,
});

export const stockRevaluationInputSchema = z
  .object({
    date: z.iso.date(errorCode('stock_date_required')),
    note: optionalText(300),
    lines: z
      .array(revaluationLineInputSchema)
      .min(1, errorCode('stock_lines_required'))
      .max(MAX_STOCK_LINES),
  })
  .superRefine((input, ctx) => {
    // One new cost per variant: two lines for the same one would say two different things
    const seen = new Set<string>();
    input.lines.forEach((line, index) => {
      if (seen.has(line.variantId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', index, 'variantId'],
          message: errorCode('revaluation_variant_twice'),
        });
      }
      seen.add(line.variantId);
    });
  });
export type StockRevaluationInput = z.infer<typeof stockRevaluationInputSchema>;
export type StockRevaluationFormValues = z.input<typeof stockRevaluationInputSchema>;

export const stockRevaluationSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  note: z.string().nullable(),
  lineCount: z.number().int(),
  // The sum of the lines' differences: + the stock is worth more now, − less
  difference: z.string(),
  postedAt: z.iso.datetime(),
});
export type StockRevaluationSummary = z.infer<typeof stockRevaluationSummarySchema>;

// One variant: the stock it had then, its value before and after, and the difference
export const revaluationLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  quantity: z.string(),
  oldUnitCost: z.string().nullable(),
  oldValue: z.string(),
  unitCost: z.string(),
  newValue: z.string(),
  difference: z.string(),
});
export type RevaluationLine = z.infer<typeof revaluationLineSchema>;

export const stockRevaluationSchema = stockRevaluationSummarySchema.extend({
  lines: z.array(revaluationLineSchema),
  // null when no line changed the value (every new cost was the old one)
  entry: entryRefSchema.nullable(),
});
export type StockRevaluation = z.infer<typeof stockRevaluationSchema>;

export const stockRevaluationPageSchema = pageOf(stockRevaluationSummarySchema);

const revaluationParamsSchema = z.object({ id: z.uuid() });

// Every route needs inventory.stock.revalue: a revaluation shows costs and changes the books
export const stockRevaluationRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/stock-revaluations',
    summary: 'Stock revaluations, newest date first',
    auth: 'bearer',
    permission: 'inventory.stock.revalue',
    status: 200,
    query: pageQuerySchema,
    response: stockRevaluationPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/stock-revaluations/:id',
    summary: 'One stock revaluation with its lines',
    auth: 'bearer',
    permission: 'inventory.stock.revalue',
    status: 200,
    params: revaluationParamsSchema,
    response: stockRevaluationSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/stock-revaluations',
    summary: 'Give some variants a new average cost, and post the difference to the books',
    auth: 'bearer',
    permission: 'inventory.stock.revalue',
    status: 201,
    body: stockRevaluationInputSchema,
    response: stockRevaluationSchema,
  }),
};
