import { z } from 'zod';

import { defineRoute } from './http.js';

// What the purchase documents share (step 17): requisitions now, purchase orders, goods receipts
// and bills in 17b and 17c.

// The most lines one purchase document holds: a pharmacy's monthly requisition runs to a few
// hundred items, like a distributor's sales order (MAX_SALES_LINES)
export const MAX_PURCHASE_LINES = 300;

// ---------------------------------------------------------------------------------------------
// The cost a line starts with

// Where a line's starting cost came from. average_cost: the company-wide average per base unit
// (step 14) × the unit's factor, shown only to someone with inventory.stock.value. 17b adds the
// last purchase price, which comes first (you chose this).
export const PURCHASE_COST_SOURCES = ['average_cost'] as const;
export type PurchaseCostSource = (typeof PURCHASE_COST_SOURCES)[number];

export const costLookupInputSchema = z.object({
  items: z
    .array(z.object({ variantId: z.uuid(), unitId: z.uuid() }))
    .min(1)
    .max(MAX_PURCHASE_LINES),
});
export type CostLookupInput = z.infer<typeof costLookupInputSchema>;

export const costLookupItemSchema = z.object({
  variantId: z.uuid(),
  unitId: z.uuid(),
  // Per one of the unit, 4 decimals. null = nothing to start from (a new product, a person
  // without inventory.stock.value): the person types it.
  cost: z.string().nullable(),
  // z.string(), not the enum: 17b adds a source, and an older client must still parse the answer
  source: z.string().nullable(),
});
export type CostLookupItem = z.infer<typeof costLookupItemSchema>;

// An item that is not a variant and unit of this workspace is left out
export const costLookupSchema = z.object({ items: z.array(costLookupItemSchema) });
export type CostLookup = z.infer<typeof costLookupSchema>;

// Reading needs no permission, like the sales price lookup: the server leaves out what the person
// may not see. POST, because a form asks for up to 300 items at once.
export const purchaseCostRoutes = {
  lookup: defineRoute({
    method: 'POST',
    path: '/purchase/cost-lookup',
    summary: 'The cost new purchase lines start with',
    auth: 'bearer',
    status: 200,
    body: costLookupInputSchema,
    response: costLookupSchema,
  }),
};
