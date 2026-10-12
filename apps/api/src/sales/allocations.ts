import { amountDueOf, compareMoney, type ErrorCode, sumMoney } from '@omnivo/contracts';
import { invoices } from '@omnivo/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { diff } from '../common/audit/audit.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { type LineIssue, linesError } from '../inventory/stock-lines.js';

// What money receipts (step 15c) and credit notes (step 15d) do the same way: put some money on a
// customer's invoices, each row no more than what the invoice still owes. Each document keeps its
// own rows (receipt_allocations, credit_note_allocations) and its own error codes; the check and
// the audit snapshot are here once.

export interface Allocation {
  invoiceId: string;
  amount: string;
}

// The document's own words for the two problems a row can have
export interface AllocationErrors {
  // Not a posted invoice of this customer
  invoice: ErrorCode;
  // More than the invoice still owes
  over: ErrorCode;
}

// An allocation's problem, under its own row of the form: allocations.2.amount
export function allocationPath(index: number, field: string): string {
  return `allocations.${String(index)}.${field}`;
}

// Checks `wanted` before it replaces `current` (the document's rows now). Every invoice of both
// lists is locked in id order before anything is read, so two documents paying one invoice take
// turns, and the second sees what the first applied. FOR NO KEY UPDATE, not FOR UPDATE: a credit
// note's own insert already holds a KEY SHARE lock on its invoice (the foreign key), and FOR UPDATE
// would wait for every other credit note being saved for that invoice, while they wait for us. Each wanted row must name a
// posted invoice of the customer and fit what it still owes after receipts and credit notes
// (amountDueOf), where this document's own current row counts as owed again: it is being replaced.
// All problems come back at once, each under its row.
export async function checkAllocations(
  tx: Transaction,
  input: {
    customerId: string;
    current: readonly Allocation[];
    wanted: readonly Allocation[];
    errors: AllocationErrors;
  },
): Promise<void> {
  const invoiceIds = [
    ...new Set([...input.current, ...input.wanted].map((allocation) => allocation.invoiceId)),
  ];
  const rows =
    invoiceIds.length === 0
      ? []
      : await tx
          .select({
            id: invoices.id,
            customerId: invoices.customerId,
            status: invoices.status,
            total: invoices.total,
            amountPaid: invoices.amountPaid,
            amountCredited: invoices.amountCredited,
          })
          .from(invoices)
          .where(and(eq(invoices.tenantId, getTenantId()), inArray(invoices.id, invoiceIds)))
          .orderBy(asc(invoices.id))
          .for('no key update');
  const byId = new Map(rows.map((row) => [row.id, row]));
  const had = new Map(input.current.map((allocation) => [allocation.invoiceId, allocation.amount]));

  const issues: LineIssue[] = [];
  input.wanted.forEach((allocation, index) => {
    const invoice = byId.get(allocation.invoiceId);
    if (invoice?.customerId !== input.customerId || invoice.status !== 'posted') {
      issues.push({ path: allocationPath(index, 'invoiceId'), code: input.errors.invoice });
      return;
    }
    const due = sumMoney([amountDueOf(invoice), had.get(allocation.invoiceId) ?? '0']);
    if (compareMoney(allocation.amount, due) > 0) {
      issues.push({ path: allocationPath(index, 'amount'), code: input.errors.over });
    }
  });
  if (issues.length > 0) throw linesError(issues);
}

// Invoice number → amount
function allocationSnapshot(
  allocations: readonly { invoiceNumber: string | null; amount: string }[],
): Record<string, string> {
  return Object.fromEntries(
    allocations.map((allocation) => [allocation.invoiceNumber ?? '', allocation.amount]),
  );
}

// What the audit log shows of the allocations: one row per invoice number, with the amount before
// and after. diff() walks the new list only, so an invoice the money was taken off is added with
// null; without that, the log would not show where the money came from.
export function allocationChanges(
  before: readonly { invoiceNumber: string | null; amount: string }[],
  after: readonly { invoiceNumber: string | null; amount: string }[],
) {
  const from = allocationSnapshot(before);
  const to: Record<string, string | null> = allocationSnapshot(after);
  for (const invoiceNumber of Object.keys(from)) to[invoiceNumber] ??= null;
  return diff(from, to);
}
