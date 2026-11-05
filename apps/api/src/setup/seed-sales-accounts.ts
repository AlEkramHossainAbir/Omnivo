import { ledgerAccounts, tenantSettings } from '@omnivo/db';
import { and, eq, isNull } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';
import type { AccountTemplate, IndustryTemplate } from './templates.js';

// The template's name for an income code: "4120" → "Sales returns"
function incomeName(template: IndustryTemplate, code: string): string | undefined {
  const walk = (node: AccountTemplate): string | undefined =>
    node.code === code ? node.name : (node.children ?? []).map(walk).find(Boolean);
  return walk(template.chart.income);
}

// Chooses the sales returns account (step 15d) for the transaction's tenant, from its template, and
// returns its code, or null when nothing was chosen: the template has none, one is chosen already,
// or the account at that code is not the template's own. That is the rule migration 0032 used for
// the workspaces that already existed: the code AND the name, an active income ledger. Nothing the
// owner made is ever taken over. Idempotent; the callers lock the tenant row first, like seedChart.
export async function seedSalesReturnsAccount(
  tx: Transaction,
  tenantId: string,
  template: IndustryTemplate,
): Promise<string | null> {
  const code = template.salesReturnsAccount;
  const name = code === null ? undefined : incomeName(template, code);
  if (code === null || name === undefined) return null;
  const [account] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.tenantId, tenantId),
        eq(ledgerAccounts.code, code),
        eq(ledgerAccounts.name, name),
        eq(ledgerAccounts.type, 'income'),
        eq(ledgerAccounts.isGroup, false),
        isNull(ledgerAccounts.archivedAt),
      ),
    );
  if (!account) return null;
  const chosen = await tx
    .update(tenantSettings)
    .set({ salesReturnsAccountId: account.id })
    .where(and(eq(tenantSettings.tenantId, tenantId), isNull(tenantSettings.salesReturnsAccountId)))
    .returning({ tenantId: tenantSettings.tenantId });
  return chosen.length === 0 ? null : code;
}
