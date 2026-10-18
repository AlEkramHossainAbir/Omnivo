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

// The accounts kept per party: the receivable (step 15a) and the payable (step 17a) are each one
// account in the chart, and every line on them names the party, so the customers' balances add up
// to the receivable and the suppliers' balances to the payable.
export const PARTY_ACCOUNT_PURPOSES = [
  'accounts_receivable',
  'accounts_payable',
] as const satisfies readonly AccountPurpose[];
export type PartyAccountPurpose = (typeof PARTY_ACCOUNT_PURPOSES)[number];

export function isPartyAccountPurpose(value: string | null): value is PartyAccountPurpose {
  return PARTY_ACCOUNT_PURPOSES.some((purpose) => purpose === value);
}

// Which kind of party a line on that account names: a customer owes on the receivable, the company
// owes a supplier on the payable. A party that is both has lines on both accounts.
export const PARTY_ROLES = ['customer', 'supplier'] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

export const PARTY_ROLE_OF = {
  accounts_receivable: 'customer',
  accounts_payable: 'supplier',
} as const satisfies Record<PartyAccountPurpose, PartyRole>;

// null for an account that is not kept per party: its lines name nobody
export function partyRoleOf(purpose: string | null): PartyRole | null {
  return isPartyAccountPurpose(purpose) ? PARTY_ROLE_OF[purpose] : null;
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
  // Step 15c: money is kept here — cash, a bank account, a bKash wallet. On a group it means every
  // account in it, so a new bank account under "Bank accounts" needs no tick of its own. A money
  // receipt goes into one of these (moneyAccountIds below). Asset accounts only.
  holdsMoney: z.boolean(),
  description: z.string().nullable(),
  // null = active. An archived account is hidden from pickers but stays in old reports.
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Account = z.infer<typeof accountSchema>;

type MoneyAccountFields = Pick<
  Account,
  'id' | 'parentId' | 'isGroup' | 'holdsMoney' | 'archivedAt'
>;

// The accounts money can go into: active, not a group, and flagged themselves or under a flagged
// group at any depth. The app and the API both call this on the whole chart (it is small, a few
// hundred accounts at most), so the receipt form offers exactly what the server accepts.
export function moneyAccountIds(accounts: readonly MoneyAccountFields[]): Set<string> {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const ids = new Set<string>();
  for (const account of accounts) {
    if (account.isGroup || account.archivedAt !== null) continue;
    // Up the tree to the top. The database refuses a loop (account_parent_loop); the step count
    // only keeps a broken chart from hanging the page.
    let current: MoneyAccountFields | undefined = account;
    for (let step = 0; current !== undefined && step <= accounts.length; step += 1) {
      if (current.holdsMoney) {
        ids.add(account.id);
        break;
      }
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  return ids;
}

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
  // Only on an asset account; the type comes from the parent, so the server checks it
  // (account_money_type)
  holdsMoney: z.boolean(),
  description: optionalText(300),
});
export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;

// The same fields minus isGroup (fixed at creation), plus the version. A new parentId moves the
// account. A top-level group sends null and stays at the top.
export const updateAccountInputSchema = z.object({
  parentId: parentIdSchema.nullable(),
  code: accountCodeSchema,
  name: accountNameSchema,
  holdsMoney: z.boolean(),
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
