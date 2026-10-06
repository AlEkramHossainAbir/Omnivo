import {
  ACCOUNT_TYPES,
  type AccountType,
  accountTypeFits,
  STOCK_ACCOUNT_USES,
  type StockAccountUse,
} from '@omnivo/contracts';
import { ledgerAccounts, stockAccounts } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';
import type { AccountTemplate, ChartTemplate, IndustryTemplate } from './templates.js';

interface Found {
  node: AccountTemplate;
  type: AccountType;
  // The group it sits under in the template
  parentCode: string;
}

// Where a code sits in a template chart: the account, its type and its group
function findInTemplate(chart: ChartTemplate, code: string): Found | undefined {
  const walk = (node: AccountTemplate, type: AccountType): Found | undefined => {
    for (const child of node.children ?? []) {
      if (child.code === code) return { node: child, type, parentCode: node.code };
      const found = walk(child, type);
      if (found) return found;
    }
    return undefined;
  };
  for (const type of ACCOUNT_TYPES) {
    const found = walk(chart[type], type);
    if (found) return found;
  }
  return undefined;
}

// Chooses the stock accounts (step 14) for the transaction's tenant, from its template, and returns
// how many uses it chose — 0 when they were all chosen already, null when the workspace has no
// chart yet (the chart's own job calls this again once it has one).
// A new workspace has every template account, so this only writes the choices. A workspace whose
// chart was made before step 14 lacks the new accounts (Goods in transit, Stock adjustments …):
// each one is added under its template group, or under the top-level group of its type if the
// owner moved or renamed that group. An account already at the template's code is used only if it
// is the template's own (the same name) and fits the use; otherwise that use stays empty for the
// owner to choose in Settings → Inventory — nothing the owner made is ever changed or taken over.
// Idempotent: a second run finds everything chosen and writes nothing. The callers lock the
// tenant row first (like seedChart), so two runs never race.
export async function seedStockAccounts(
  tx: Transaction,
  tenantId: string,
  template: IndustryTemplate,
): Promise<number | null> {
  const accounts = await tx
    .select({
      id: ledgerAccounts.id,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      type: ledgerAccounts.type,
      isGroup: ledgerAccounts.isGroup,
      purpose: ledgerAccounts.purpose,
      parentId: ledgerAccounts.parentId,
      archivedAt: ledgerAccounts.archivedAt,
    })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.tenantId, tenantId));
  if (accounts.length === 0) return null;
  const byCode = new Map(accounts.map((account) => [account.code, account]));

  const chosen = await tx
    .select({ use: stockAccounts.use })
    .from(stockAccounts)
    .where(eq(stockAccounts.tenantId, tenantId));
  const done = new Set<StockAccountUse>(chosen.map((row) => row.use));

  const choices: { use: StockAccountUse; accountId: string }[] = [];
  for (const use of STOCK_ACCOUNT_USES) {
    if (done.has(use)) continue;
    const code = template.stockAccounts[use];
    const found = findInTemplate(template.chart, code);
    if (!found) throw new Error(`Template: stock account ${code} is not in the chart`);
    let account = byCode.get(code);
    // The code is taken by an account the owner made for something else ("5290 Tea and
    // entertainment"): never use it for stock. The use stays empty for the owner to choose.
    if (account && account.name.toLowerCase() !== found.node.name.toLowerCase()) continue;
    if (!account) {
      const group = byCode.get(found.parentCode);
      const parentId =
        group?.isGroup === true && group.type === found.type && group.archivedAt === null
          ? group.id
          : accounts.find((row) => row.parentId === null && row.type === found.type)?.id;
      if (parentId === undefined) throw new Error(`No ${found.type} group for account ${code}`);
      const [row] = await tx
        .insert(ledgerAccounts)
        .values({ tenantId, parentId, code, name: found.node.name, type: found.type })
        .returning({
          id: ledgerAccounts.id,
          code: ledgerAccounts.code,
          name: ledgerAccounts.name,
          type: ledgerAccounts.type,
          isGroup: ledgerAccounts.isGroup,
          purpose: ledgerAccounts.purpose,
          parentId: ledgerAccounts.parentId,
          archivedAt: ledgerAccounts.archivedAt,
        });
      if (!row) throw new Error('Stock account insert returned no row');
      account = row;
      accounts.push(row);
      byCode.set(code, row);
    }
    const usable =
      !account.isGroup &&
      account.archivedAt === null &&
      account.purpose !== 'inventory' &&
      accountTypeFits(use, account.type);
    if (usable) choices.push({ use, accountId: account.id });
  }
  if (choices.length === 0) return 0;
  await tx
    .insert(stockAccounts)
    .values(choices.map((choice) => ({ tenantId, ...choice })))
    .onConflictDoNothing();
  return choices.length;
}
