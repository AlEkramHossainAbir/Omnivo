import { compareMoney, todayIn } from '@omnivo/contracts';
import { tenantSettings } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { getTenantId } from '../tenant/tenant-context.js';
import type { Transaction } from '../tenant/with-tenant.js';

// The day an allocation starts to count (step 21b, decision 25): the aging as of a past day takes
// off a document only what was applied to it by then. Two rules, for the four kinds of allocation
// (a receipt's, a credit note's, a supplier payment's and a debit note's):
// - Written with its document (a receipt made, a credit note posted): the document's date. The
//   database moves it up to the other document's date when that one is later (migration 0060).
// - Written later (money applied again): today in the workspace's time zone. A pair whose amount
//   did not change keeps the day it had: moving 5,000 from one invoice to another does not make the
//   other invoices look paid today.

// Today where the workspace is: 5 November in Dhaka is still 4 November in UTC until 6 in the morning
export async function workspaceToday(tx: Transaction): Promise<string> {
  const tenantId = getTenantId();
  const [settings] = await tx
    .select({ timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId));
  if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
  return todayIn(settings.timezone);
}

// The rows to write, each with its applied_on: the day the old row had when the same document (an
// invoice or a bill, `documentOf`) gets the same amount again, else `day`. `current` is what the
// paying document has now, read before its rows are deleted.
export function datedAllocations<T extends { amount: string }>(
  wanted: readonly T[],
  current: readonly (T & { appliedOn: string })[],
  documentOf: (row: T) => string,
  day: string,
): (T & { appliedOn: string })[] {
  const before = new Map(current.map((row) => [documentOf(row), row]));
  return wanted.map((row) => {
    const old = before.get(documentOf(row));
    const same = old !== undefined && compareMoney(old.amount, row.amount) === 0;
    return { ...row, appliedOn: same ? old.appliedOn : day };
  });
}
