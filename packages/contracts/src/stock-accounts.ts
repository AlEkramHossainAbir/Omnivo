import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';

// The accounts a stock document posts to besides the inventory account (step 14). Each one is a
// setting the owner may change in Settings → Inventory; the template fills them in when the chart
// is made. Two other accounts are fixed and are not here: the inventory account (the account with
// the 'inventory' purpose) and, for opening stock, opening balance equity.
//   in_transit          Goods in transit: a transfer between two branches, sent and not received
//   found … correction  The other side of an adjustment, one per reason (except opening stock)
//   transfer_shortage   What a transfer lost on the way (received short)
//   revaluation         The other side of a stock revaluation
export const STOCK_ACCOUNT_USES = [
  'in_transit',
  'found',
  'damaged',
  'expired',
  'lost',
  'sample',
  'internal_use',
  'correction',
  'transfer_shortage',
  'revaluation',
] as const;
export type StockAccountUse = (typeof STOCK_ACCOUNT_USES)[number];

export function isStockAccountUse(value: string): value is StockAccountUse {
  return STOCK_ACCOUNT_USES.some((use) => use === value);
}

// Goods in transit are still the company's goods: an asset. Every other use is a gain or a loss,
// so it belongs in the profit and loss — an income or an expense account.
export function accountTypeFits(use: StockAccountUse, type: string): boolean {
  return use === 'in_transit' ? type === 'asset' : type === 'income' || type === 'expense';
}

// One value per use. The keys are written out (not built from the list) so the type is exact
// without a cast; Record<StockAccountUse, T> makes a new use fail to compile until it is added here.
function perUse<T>(make: () => T): Record<StockAccountUse, T> {
  return {
    in_transit: make(),
    found: make(),
    damaged: make(),
    expired: make(),
    lost: make(),
    sample: make(),
    internal_use: make(),
    correction: make(),
    transfer_shortage: make(),
    revaluation: make(),
  };
}

// What the API sends: every use, with its account (null = not chosen yet; a posting that needs it
// is refused with stock_account_missing until someone chooses one)
export const stockAccountsSchema = z.object(perUse(() => z.uuid().nullable()));
export type StockAccounts = z.infer<typeof stockAccountsSchema>;

// What the form sends: an account for every use. The form's empty select sends '', which is not
// a uuid: "choose an account".
export const updateStockAccountsInputSchema = z.object(
  perUse(() => z.uuid(errorCode('stock_account_invalid'))),
);
export type UpdateStockAccountsInput = z.infer<typeof updateStockAccountsInputSchema>;
export type StockAccountsFormValues = z.input<typeof updateStockAccountsInputSchema>;

export const stockAccountRoutes = {
  // Reading them needs no permission: the settings page shows them to everyone who opens it
  get: defineRoute({
    method: 'GET',
    path: '/stock-accounts',
    summary: 'The accounts stock documents post to, besides the inventory account',
    auth: 'bearer',
    status: 200,
    response: stockAccountsSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/stock-accounts',
    summary: 'Choose the accounts stock documents post to',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    body: updateStockAccountsInputSchema,
    response: stockAccountsSchema,
  }),
};
