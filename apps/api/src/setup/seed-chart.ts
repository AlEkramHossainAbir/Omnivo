import { ACCOUNT_TYPES, type AccountType } from '@omnivo/contracts';
import { ledgerAccounts } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';
import type { AccountTemplate, ChartTemplate } from './templates.js';

interface Pending {
  node: AccountTemplate;
  type: AccountType;
  parentId: string | null;
}

// Creates a template chart in the transaction's tenant and returns how many accounts it made.
// Makes nothing (returns 0) if the workspace already has any account: a chart is created whole
// or not at all, so "one account exists" means "the chart was made". That is what makes the two
// jobs that call this idempotent — and they lock the tenant row first, so they never race.
export async function seedChart(
  tx: Transaction,
  tenantId: string,
  chart: ChartTemplate,
): Promise<number> {
  const [existing] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.tenantId, tenantId))
    .limit(1);
  if (existing) return 0;

  // One level at a time: a child row needs its parent's id, which Postgres makes on insert. The
  // deepest template is four levels, so four inserts — not one per account.
  let level: Pending[] = ACCOUNT_TYPES.map((type) => ({ node: chart[type], type, parentId: null }));
  let created = 0;
  while (level.length > 0) {
    const inserted = await tx
      .insert(ledgerAccounts)
      .values(
        level.map(({ node, type, parentId }) => ({
          tenantId,
          parentId,
          code: node.code,
          name: node.name,
          type,
          isGroup: node.children !== undefined,
          purpose: node.purpose ?? null,
        })),
      )
      .returning({ id: ledgerAccounts.id, code: ledgerAccounts.code });
    created += inserted.length;

    // Codes are unique in a template (templates.spec.ts), so the code finds the new row's id
    const idOf = new Map(inserted.map((row) => [row.code, row.id]));
    level = level.flatMap(({ node, type }) => {
      const parentId = idOf.get(node.code);
      if (parentId === undefined) throw new Error(`Chart template: ${node.code} was not created`);
      return (node.children ?? []).map((child) => ({ node: child, type, parentId }));
    });
  }
  return created;
}
