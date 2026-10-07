import { taxRates } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';
import { TAX_RATES } from './templates.js';

// Gives the transaction's tenant its starting VAT rates (step 15a) and returns how many it made —
// null when the workspace already has a rate. All or nothing on purpose: a workspace that has any
// rate has made its own choices (or a first run already made them), and adding the template's rates
// next to them would bring back a rate the owner archived on purpose, or a second default.
// The callers lock the tenant row first (like seedChart), so two runs never race.
export async function seedTaxRates(tx: Transaction, tenantId: string): Promise<number | null> {
  const [any] = await tx
    .select({ id: taxRates.id })
    .from(taxRates)
    .where(eq(taxRates.tenantId, tenantId))
    .limit(1);
  if (any) return null;
  await tx.insert(taxRates).values(TAX_RATES.map((rate) => ({ tenantId, ...rate })));
  return TAX_RATES.length;
}
