import { z } from 'zod';

import { defineRoute } from './http.js';
import { optionalIdSchema } from './stock.js';

// The two accounts a supplier's bill posts to besides the payable, VAT input and goods received
// not billed (step 17c). Settings → Purchase, like the sales returns account of step 15d; the
// templates fill both.
//   priceDifference  "Purchase price difference": what a bill's price differs from its order's,
//                    on goods a goods receipt already took into stock at the order's price (you
//                    chose this in step 17). An expense account: a bill above the order debits it,
//                    a bill below credits it. null = the Cost of goods sold account (the account
//                    with the 'cost_of_goods_sold' purpose), where a price difference ends up anyway.
//   services         "Purchased services": where a service line goes when the person chose no
//                    account on it (a dyeing charge, transport). null = none: each service line
//                    names its account, or the bill is refused with bill_account_required.
// The server checks each one is an active expense account that is not a group
// (purchase_account_invalid).
export const purchaseAccountsSchema = z.object({
  priceDifference: z.uuid().nullable(),
  services: z.uuid().nullable(),
});
export type PurchaseAccounts = z.infer<typeof purchaseAccountsSchema>;

// The form's empty select sends '': back to the fallback above
export const updatePurchaseAccountsInputSchema = z.object({
  priceDifference: optionalIdSchema,
  services: optionalIdSchema,
});
export type UpdatePurchaseAccountsInput = z.infer<typeof updatePurchaseAccountsInputSchema>;
export type PurchaseAccountsFormValues = z.input<typeof updatePurchaseAccountsInputSchema>;

export const purchaseAccountRoutes = {
  // Reading needs no permission: the bill form starts a service line from it
  get: defineRoute({
    method: 'GET',
    path: '/purchase-accounts',
    summary: 'The price difference and purchased services accounts bills post to',
    auth: 'bearer',
    status: 200,
    response: purchaseAccountsSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/purchase-accounts',
    summary: 'Choose the price difference and purchased services accounts',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    body: updatePurchaseAccountsInputSchema,
    response: purchaseAccountsSchema,
  }),
};
