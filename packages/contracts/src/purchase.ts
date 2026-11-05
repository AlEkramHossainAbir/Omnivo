import { z } from 'zod';

import { defineRoute } from './http.js';

// What the purchase documents share (step 17): requisitions (17a), purchase orders and goods
// receipts (17b), and bills and supplier payments (17c).

// The most lines one purchase document holds: a pharmacy's monthly requisition runs to a few
// hundred items, like a distributor's sales order (MAX_SALES_LINES)
export const MAX_PURCHASE_LINES = 300;

// ---------------------------------------------------------------------------------------------
// The cost a line starts with

// Where a line's starting cost came from, in the order they are tried (step 17b):
//   supplier_price  the price on this supplier's latest purchase order or bill for the variant
//   last_price      the price on anyone's latest purchase order or bill for it
//   average_cost    the company-wide average per base unit (step 14) × the unit's factor, shown
//                   only to someone with inventory.stock.value
// A purchase price is a price people typed and agreed, so everyone who writes purchases may see
// it; the average is worked out from the books, so it keeps step 14's rule. "Latest" counts orders
// that were approved (received and closed ones too) and posted bills (step 17c: a shop that buys
// without orders learns its prices from its bills), by date; a draft is not a price anybody
// agreed to.
// The price is what one unit cost after the line's discount and before VAT (the net), moved to the
// line's unit, 4 decimals: what the goods were worth, whatever that order's VAT setting was.
export const PURCHASE_COST_SOURCES = ['supplier_price', 'last_price', 'average_cost'] as const;
export type PurchaseCostSource = (typeof PURCHASE_COST_SOURCES)[number];

export const costLookupInputSchema = z.object({
  // The order's supplier, so its own last price comes first. null = no supplier yet, or a
  // requisition (it has none).
  supplierId: z.uuid().nullable().default(null),
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
  // z.string(), not the enum: a newer server's new source must not break an older client
  source: z.string().nullable(),
  // The product's own active VAT rate, or the workspace's default (as the sales price lookup gives
  // it): what a purchase order line starts with. A requisition has no VAT and ignores it.
  taxRateId: z.uuid(),
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
