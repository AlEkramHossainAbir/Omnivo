import { ledgerAccounts, tenantSettings } from '@omnivo/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';
import { type AccountTemplate, type IndustryTemplate, PURCHASE_ACCOUNTS } from './templates.js';

// The template's name for an expense code: "5180" → "Purchase price difference"
function expenseName(template: IndustryTemplate, code: string): string | undefined {
  const walk = (node: AccountTemplate): string | undefined =>
    node.code === code ? node.name : (node.children ?? []).map(walk).find(Boolean);
  return walk(template.chart.expense);
}

// Chooses the two accounts of Settings → Purchase (step 17c) for the transaction's tenant, from
// its chart, like seedSalesReturnsAccount(): an account is taken only when it has the template's
// code AND name and is an active expense ledger, and only for a choice that is still empty, so
// nothing the owner made or chose is ever taken over. Returns how many were chosen. Idempotent;
// the callers lock the tenant row first. Only a new chart gets them (decision 28): an old
// workspace's price difference falls back to Cost of goods sold, and its owner chooses the rest.
export async function seedPurchaseAccounts(
  tx: Transaction,
  tenantId: string,
  template: IndustryTemplate,
): Promise<number> {
  const wanted = Object.values(PURCHASE_ACCOUNTS).flatMap((code) => {
    const name = expenseName(template, code);
    return name === undefined ? [] : [{ code, name }];
  });
  if (wanted.length === 0) return 0;
  const rows = await tx
    .select({ id: ledgerAccounts.id, code: ledgerAccounts.code, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.tenantId, tenantId),
        inArray(
          ledgerAccounts.code,
          wanted.map((account) => account.code),
        ),
        eq(ledgerAccounts.type, 'expense'),
        eq(ledgerAccounts.isGroup, false),
        isNull(ledgerAccounts.archivedAt),
      ),
    );
  const idOf = (code: string): string | undefined => {
    const name = wanted.find((account) => account.code === code)?.name;
    return rows.find((row) => row.code === code && row.name === name)?.id;
  };
  let chosen = 0;
  const priceDifference = idOf(PURCHASE_ACCOUNTS.priceDifference);
  if (priceDifference !== undefined) {
    const updated = await tx
      .update(tenantSettings)
      .set({ purchasePriceDifferenceAccountId: priceDifference })
      .where(
        and(
          eq(tenantSettings.tenantId, tenantId),
          isNull(tenantSettings.purchasePriceDifferenceAccountId),
        ),
      )
      .returning({ tenantId: tenantSettings.tenantId });
    chosen += updated.length;
  }
  const services = idOf(PURCHASE_ACCOUNTS.services);
  if (services !== undefined) {
    const updated = await tx
      .update(tenantSettings)
      .set({ purchaseServicesAccountId: services })
      .where(
        and(
          eq(tenantSettings.tenantId, tenantId),
          isNull(tenantSettings.purchaseServicesAccountId),
        ),
      )
      .returning({ tenantId: tenantSettings.tenantId });
    chosen += updated.length;
  }
  return chosen;
}
