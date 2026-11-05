import { z } from 'zod';

import { defineRoute } from './http.js';
import { optionalIdSchema } from './stock.js';

// The account a credit note takes the sale back from (step 15d, you chose a setting): "Sales
// returns", an income account that sits under Revenue with a debit balance, so the profit and loss
// shows the sales and what came back as two numbers, and the return rate is plain to see. A
// setting the owner changes in Settings → Sales; the pharmacy and retail templates fill it with
// their 4120 Sales returns.
//   returns  null = no account chosen: a credit note takes the sale back from the Sales account
//            itself (the account with the 'sales' purpose), and the profit and loss shows net sales
// The server checks the account is an active income account that is not a group
// (sales_account_invalid), like the stock accounts of step 14.
export const salesAccountsSchema = z.object({
  returns: z.uuid().nullable(),
});
export type SalesAccounts = z.infer<typeof salesAccountsSchema>;

// The form's empty select sends '': back to the Sales account
export const updateSalesAccountsInputSchema = z.object({
  returns: optionalIdSchema,
});
export type UpdateSalesAccountsInput = z.infer<typeof updateSalesAccountsInputSchema>;
export type SalesAccountsFormValues = z.input<typeof updateSalesAccountsInputSchema>;

export const salesAccountRoutes = {
  // Reading needs no permission: the settings page shows it to everyone who opens it
  get: defineRoute({
    method: 'GET',
    path: '/sales-accounts',
    summary: 'The account credit notes take sales back from',
    auth: 'bearer',
    status: 200,
    response: salesAccountsSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/sales-accounts',
    summary: 'Choose the account credit notes take sales back from',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    body: updateSalesAccountsInputSchema,
    response: salesAccountsSchema,
  }),
};
