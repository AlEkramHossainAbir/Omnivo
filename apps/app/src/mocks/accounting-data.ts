import {
  type Account,
  type AccountPurpose,
  ACCOUNT_TYPES,
  type AccountType,
  type Industry,
} from '@omnivo/contracts';

import { MockProblem } from './mock';

// A shorter copy of the API's chart templates (apps/api/src/setup/templates.ts): the mock cannot
// import server code. Same codes and purposes, fewer ordinary accounts.
interface MockNode {
  code: string;
  name: string;
  purpose?: AccountPurpose;
  children?: MockNode[];
  archived?: boolean;
}

const MAKERS: readonly Industry[] = ['garments', 'pharma', 'manufacturing'];

function template(industry: Industry): Record<AccountType, MockNode> {
  const garments = industry === 'garments';
  const stock: MockNode = MAKERS.includes(industry)
    ? {
        code: '1150',
        name: 'Inventories',
        children: [
          { code: '1151', name: garments ? 'Fabrics and yarn' : 'Raw materials' },
          { code: '1152', name: 'Work in progress' },
          {
            code: '1153',
            name: garments ? 'Finished garments' : 'Finished goods',
            purpose: 'inventory',
          },
        ],
      }
    : { code: '1150', name: 'Inventory', purpose: 'inventory' };
  return {
    asset: {
      code: '1000',
      name: 'Assets',
      children: [
        {
          code: '1100',
          name: 'Current assets',
          children: [
            { code: '1110', name: 'Cash in hand', purpose: 'cash' },
            {
              code: '1120',
              name: 'Bank accounts',
              children: [
                { code: '1121', name: 'Dutch-Bangla Bank CD A/C 1234' },
                // Closed last year: shows up with "Show archived"
                { code: '1122', name: 'Sonali Bank CD A/C 0071', archived: true },
              ],
            },
            { code: '1130', name: 'Mobile wallets (bKash, Nagad)', children: [] },
            { code: '1140', name: 'Accounts receivable', purpose: 'accounts_receivable' },
            stock,
            { code: '1170', name: 'Input VAT', purpose: 'vat_input' },
          ],
        },
        {
          code: '1200',
          name: 'Fixed assets',
          children: [
            { code: '1220', name: 'Plant and machinery' },
            { code: '1230', name: 'Furniture and fixtures' },
            { code: '1290', name: 'Accumulated depreciation' },
          ],
        },
      ],
    },
    liability: {
      code: '2000',
      name: 'Liabilities',
      children: [
        {
          code: '2100',
          name: 'Current liabilities',
          children: [
            { code: '2110', name: 'Accounts payable', purpose: 'accounts_payable' },
            { code: '2120', name: 'Output VAT', purpose: 'vat_output' },
            { code: '2130', name: 'VAT and tax deducted at source (VDS, TDS)' },
            { code: '2140', name: 'Salaries and wages payable' },
          ],
        },
      ],
    },
    equity: {
      code: '3000',
      name: 'Equity',
      children: [
        { code: '3100', name: 'Capital' },
        { code: '3200', name: 'Retained earnings', purpose: 'retained_earnings' },
        { code: '3300', name: 'Opening balance equity', purpose: 'opening_balance_equity' },
      ],
    },
    income: {
      code: '4000',
      name: 'Income',
      children: [
        {
          code: '4100',
          name: 'Revenue',
          children: [{ code: '4110', name: garments ? 'Export sales' : 'Sales', purpose: 'sales' }],
        },
        {
          code: '4200',
          name: 'Other income',
          children: [{ code: '4210', name: 'Interest income' }],
        },
      ],
    },
    expense: {
      code: '5000',
      name: 'Expenses',
      children: [
        {
          code: '5100',
          name: 'Cost of sales',
          children: [{ code: '5110', name: 'Cost of goods sold', purpose: 'cost_of_goods_sold' }],
        },
        {
          code: '5200',
          name: 'Administrative expenses',
          children: [
            { code: '5210', name: 'Salaries and allowances' },
            { code: '5220', name: 'Office rent' },
            { code: '5230', name: 'Utilities (electricity, gas, water)' },
          ],
        },
        { code: '5400', name: 'Finance costs', children: [{ code: '5410', name: 'Bank charges' }] },
      ],
    },
  };
}

export function seedAccounts(industry: Industry): Account[] {
  const now = new Date().toISOString();
  const accounts: Account[] = [];
  const add = (node: MockNode, type: AccountType, parentId: string | null): void => {
    const id = crypto.randomUUID();
    accounts.push({
      id,
      parentId,
      code: node.code,
      name: node.name,
      type,
      isGroup: node.children !== undefined,
      purpose: node.purpose ?? null,
      description: null,
      archivedAt: node.archived ? now : null,
      version: 1,
      updatedAt: now,
    });
    for (const child of node.children ?? []) add(child, type, id);
  };
  const chart = template(industry);
  for (const type of ACCOUNT_TYPES) add(chart[type], type, null);
  return accounts;
}

// The API's rules (accounts.service.ts), for the UI's error paths in `pnpm dev:mock` and e2e

export function findAccount(accounts: readonly Account[], id: string): Account {
  const found = accounts.find((account) => account.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertAccountCodeFree(
  accounts: readonly Account[],
  code: string,
  except?: string,
): void {
  if (accounts.some((other) => other.code === code && other.id !== except)) {
    throw new MockProblem(409, 'account_code_taken', { code: ['account_code_taken'] });
  }
}

function invalidParent(): MockProblem {
  return new MockProblem(409, 'account_parent_invalid', { parentId: ['account_parent_invalid'] });
}

// The group a new or moved account goes under: an active group, of the moved account's type,
// and not the moved account itself or anything under it
export function parentFor(
  accounts: readonly Account[],
  parentId: string,
  moving?: Account,
): Account {
  const parent = accounts.find((account) => account.id === parentId);
  if (!parent?.isGroup || parent.archivedAt !== null) throw invalidParent();
  if (moving) {
    if (moving.parentId === null || parent.type !== moving.type) throw invalidParent();
    // Walk up from the new group; meeting the moved account on the way means a loop
    let up: Account | undefined = parent;
    while (up) {
      if (up.id === moving.id) {
        throw new MockProblem(409, 'account_parent_loop', { parentId: ['account_parent_loop'] });
      }
      const above: string | null = up.parentId;
      up = accounts.find((account) => account.id === above);
    }
  }
  return parent;
}

export function assertNotLocked(account: Account): void {
  if (account.parentId === null || account.purpose !== null) {
    throw new MockProblem(409, 'account_locked');
  }
}

export function codeOf(accounts: readonly Account[], id: string | null): string | null {
  return accounts.find((account) => account.id === id)?.code ?? null;
}
