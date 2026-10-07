import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// The five classes of account. The class decides where an account shows up in the reports (asset,
// liability, equity → balance sheet; income, expense → profit and loss), so it never changes. Each
// class is one top-level group, and every account below it inherits the class from there.
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// Which side makes the balance grow. Double entry in one line: assets and expenses grow with a
// debit, the other three with a credit. Step 10's journal and step 11's reports read it from here.
export const NORMAL_BALANCE = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
} as const satisfies Record<AccountType, 'debit' | 'credit'>;

// Accounts the system itself will post to: a sales invoice (step 15) debits the receivable and
// credits sales and output VAT without asking which accounts. The template marks one account per
// purpose; the owner may rename or move it, but not delete or archive it. A later step that needs a
// new one adds it here and to the templates.
export const ACCOUNT_PURPOSES = [
  'cash',
  'accounts_receivable',
  'inventory',
  'vat_input',
  'accounts_payable',
  'vat_output',
  'opening_balance_equity',
  'retained_earnings',
  'sales',
  'cost_of_goods_sold',
] as const;
export type AccountPurpose = (typeof ACCOUNT_PURPOSES)[number];

// The accounts kept per party (step 15a): the receivable is one account in the chart, and every line
// on it names the customer, so the customers' balances add up to the account's balance. Step 17
// adds 'accounts_payable' for suppliers.
export const PARTY_ACCOUNT_PURPOSES = [
  'accounts_receivable',
] as const satisfies readonly AccountPurpose[];

export function isPartyAccountPurpose(value: string | null): boolean {
  return PARTY_ACCOUNT_PURPOSES.some((purpose) => purpose === value);
}

export function isAccountPurpose(value: string): value is AccountPurpose {
  return ACCOUNT_PURPOSES.some((purpose) => purpose === value);
}

export const accountSchema = z.object({
  id: z.uuid(),
  // null = one of the five top-level groups
  parentId: z.uuid().nullable(),
  code: z.string(),
  name: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  // true = a group: it only holds other accounts, and entries never post to it. Fixed at creation.
  isGroup: z.boolean(),
  // z.string(), not an enum: a newer server's new purpose must not break an older offline client
  // (the same rule as error codes). The app narrows it with isAccountPurpose().
  purpose: z.string().nullable(),
  description: z.string().nullable(),
  // null = active. An archived account is hidden from pickers but stays in old reports.
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Account = z.infer<typeof accountSchema>;

// Digits, optionally split into parts by dots or hyphens: 1110, 1-1-10, 11.10. No letters: codes
// sort and group by their digits, and every accountant in Bangladesh reads them that way.
const accountCodeSchema = z
  .string()
  .trim()
  .max(20, errorCode('account_code_format'))
  .regex(/^\d+(?:[.-]\d+)*$/, errorCode('account_code_format'));

const accountNameSchema = z.string().trim().min(2, errorCode('account_name_required')).max(120);

// A form's empty "Parent group" select sends '' — that is "not chosen", not a broken id
const parentIdSchema = z.uuid(errorCode('account_parent_required'));

export const createAccountInputSchema = z.object({
  // Every new account goes under a group, and takes its type from there. The five top-level
  // groups come from the template only.
  parentId: parentIdSchema,
  code: accountCodeSchema,
  name: accountNameSchema,
  isGroup: z.boolean(),
  description: optionalText(300),
});
export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;

// The same fields minus isGroup (fixed at creation), plus the version. A new parentId moves the
// account. A top-level group sends null and stays at the top.
export const updateAccountInputSchema = z.object({
  parentId: parentIdSchema.nullable(),
  code: accountCodeSchema,
  name: accountNameSchema,
  description: optionalText(300),
  version: versionSchema,
});
export type UpdateAccountInput = z.infer<typeof updateAccountInputSchema>;

export const accountVersionInputSchema = z.object({ version: versionSchema });

// DELETE has no body, so the version travels in the query string (like DELETE /roles/:id)
export const deleteAccountQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// A chart has tens to a few hundred accounts, so the whole list comes at once (the rule from
// branches: small master lists in one piece, endless lists in pages). Archived accounts are
// included: the tree shows them in place when asked to.
export const accountListSchema = z.object({ items: z.array(accountSchema) });

const accountParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like branches: from step 10 on, every journal line, invoice and
// bill picks an account from this list.
export const accountRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/accounts',
    summary: 'The chart of accounts of the active workspace, archived accounts included',
    auth: 'bearer',
    status: 200,
    response: accountListSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/accounts/:id',
    summary: 'One account',
    auth: 'bearer',
    status: 200,
    params: accountParamsSchema,
    response: accountSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/accounts',
    summary: 'Add an account or a group under a group',
    auth: 'bearer',
    permission: 'accounting.account.manage',
    status: 201,
    body: createAccountInputSchema,
    response: accountSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/accounts/:id',
    summary: 'Rename, recode or move an account to another group of the same type',
    auth: 'bearer',
    permission: 'accounting.account.manage',
    status: 200,
    params: accountParamsSchema,
    body: updateAccountInputSchema,
    response: accountSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/accounts/:id/archive',
    summary: 'Hide an account from new entries; its history stays',
    auth: 'bearer',
    permission: 'accounting.account.manage',
    status: 200,
    params: accountParamsSchema,
    body: accountVersionInputSchema,
    response: accountSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/accounts/:id/restore',
    summary: 'Bring an archived account back',
    auth: 'bearer',
    permission: 'accounting.account.manage',
    status: 200,
    params: accountParamsSchema,
    body: accountVersionInputSchema,
    response: accountSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/accounts/:id',
    summary: 'Delete an account that nothing uses and nothing sits under',
    auth: 'bearer',
    permission: 'accounting.account.manage',
    status: 204,
    params: accountParamsSchema,
    query: deleteAccountQuerySchema,
    response: z.void(),
  }),
};
