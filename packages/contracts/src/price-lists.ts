import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { priceSchema } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// A named set of prices: "Dealer", "Wholesale", "Corporate". A customer has at most one list; a
// sales line (step 15b) takes the price from it, and falls back to the product's own sale price for
// an item the list leaves out. A price is per variant and per unit, because a carton is often
// cheaper than 24 single pieces.
//
// The prices follow the workspace's "prices include VAT" setting, like the products' own prices.

export const priceListSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  // How many prices it holds, and how many customers use it (archived customers too)
  itemCount: z.number().int(),
  customerCount: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type PriceList = z.infer<typeof priceListSchema>;

export const priceListInputSchema = z.object({
  name: z.string().trim().min(2, errorCode('price_list_name_required')).max(60),
  description: optionalText(200),
});
export type PriceListInput = z.infer<typeof priceListInputSchema>;

export const updatePriceListInputSchema = priceListInputSchema.extend({ version: versionSchema });
export type UpdatePriceListInput = z.infer<typeof updatePriceListInputSchema>;

export const priceListVersionInputSchema = z.object({ version: versionSchema });

// A few lists per workspace: the whole list at once, archived ones too
export const priceListListSchema = z.object({ items: z.array(priceListSchema) });

// ---------------------------------------------------------------------------------------------
// The prices inside a list. A distributor's list can hold thousands, so they come a page at a
// time, and are saved a batch at a time.

export const priceListItemSchema = z.object({
  variantId: z.uuid(),
  unitId: z.uuid(),
  // What the row shows, so the page does not load every product: "Napa 500 mg", "NAPA-500", the
  // option values of a variant (["M", "Navy blue"]), and the product's code
  productId: z.uuid(),
  productCode: z.string(),
  productName: z.string(),
  sku: z.string(),
  optionValues: z.array(z.string()),
  // Per one of this unit: the price of a carton, not of a piece. 4 decimals, like every amount.
  price: z.string(),
  updatedAt: z.iso.datetime(),
});
export type PriceListItem = z.infer<typeof priceListItemSchema>;

export const priceListItemQuerySchema = pageQuerySchema.extend({
  // Part of the product's name or code, or a SKU
  search: z.string().trim().max(100).optional(),
});
export type PriceListItemQuery = z.input<typeof priceListItemQuerySchema>;

export const priceListItemPageSchema = pageOf(priceListItemSchema);
export type PriceListItemPage = z.infer<typeof priceListItemPageSchema>;

// The most rows one save sends: a page of edits, or one product's variants in every unit
export const MAX_PRICE_LIST_CHANGES = 500;

const priceListChangeSchema = z.object({
  variantId: z.uuid(),
  unitId: z.uuid(),
  // '' = take this price out of the list (the item falls back to the product's price)
  price: priceSchema,
});

// No version: two people can price different items of one list at the same time, and each row is
// saved on its own. The same item and unit twice in one save is a mistake in the form.
export const setPriceListItemsInputSchema = z.object({
  changes: z
    .array(priceListChangeSchema)
    .min(1)
    .max(MAX_PRICE_LIST_CHANGES)
    .superRefine((changes, ctx) => {
      const seen = new Set<string>();
      changes.forEach((change, index) => {
        const key = `${change.variantId}:${change.unitId}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'price'],
            message: errorCode('price_list_item_twice'),
          });
        }
        seen.add(key);
      });
    }),
});
export type SetPriceListItemsInput = z.infer<typeof setPriceListItemsInputSchema>;

const priceListParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission: a salesperson looks up the dealer price before quoting it
export const priceListRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/price-lists',
    summary: 'The price lists of the workspace',
    auth: 'bearer',
    status: 200,
    response: priceListListSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/price-lists/:id',
    summary: 'One price list, without its prices',
    auth: 'bearer',
    status: 200,
    params: priceListParamsSchema,
    response: priceListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/price-lists',
    summary: 'Add a price list',
    auth: 'bearer',
    permission: 'sales.price_list.manage',
    status: 201,
    body: priceListInputSchema,
    response: priceListSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/price-lists/:id',
    summary: "Change a price list's name or description",
    auth: 'bearer',
    permission: 'sales.price_list.manage',
    status: 200,
    params: priceListParamsSchema,
    body: updatePriceListInputSchema,
    response: priceListSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/price-lists/:id/archive',
    summary: "Stop using a price list; its customers fall back to the products' prices",
    auth: 'bearer',
    permission: 'sales.price_list.manage',
    status: 200,
    params: priceListParamsSchema,
    body: priceListVersionInputSchema,
    response: priceListSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/price-lists/:id/restore',
    summary: 'Bring an archived price list back',
    auth: 'bearer',
    permission: 'sales.price_list.manage',
    status: 200,
    params: priceListParamsSchema,
    body: priceListVersionInputSchema,
    response: priceListSchema,
  }),
  items: defineRoute({
    method: 'GET',
    path: '/price-lists/:id/items',
    summary: 'The prices in a list, a page at a time, by product name',
    auth: 'bearer',
    status: 200,
    params: priceListParamsSchema,
    query: priceListItemQuerySchema,
    response: priceListItemPageSchema,
  }),
  setItems: defineRoute({
    method: 'PUT',
    path: '/price-lists/:id/items',
    summary: 'Set or remove prices in a list, a batch at a time',
    auth: 'bearer',
    permission: 'sales.price_list.manage',
    status: 200,
    params: priceListParamsSchema,
    body: setPriceListItemsInputSchema,
    response: priceListSchema,
  }),
};
