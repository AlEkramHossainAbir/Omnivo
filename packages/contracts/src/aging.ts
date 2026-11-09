import { z } from 'zod';

import { defineRoute } from './http.js';
import { partyRefSchema } from './journal.js';
import { addMoney, subtractMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// The receivables and payables aging (step 21b): on a chosen day, what each customer still owes
// (or each supplier is still owed), split by how long it has been due.
//
// - As of D: the documents dated D or before, less what was applied to them on D or before (the
//   allocations' applied_on, step 21b.2). So the report of a past day shows that day, not today.
// - The age counts from the due date. A document due on D or later is "current".
// - Money received (or paid) and not applied to any document yet is an advance, in its own
//   column, never spread over the buckets: nobody knows yet which document it will pay.
// - Beside the report, the receivable (or payable) account's balance in the books on D. Opening
//   balances and journal entries written by hand on that account are not documents, so the two
//   can differ, and the page shows by how much.

// ---------------------------------------------------------------------------------------------
// The buckets

// The names are also the answer's fields and the sort keys
export const AGING_BUCKETS = [
  'current',
  'days1To30',
  'days31To60',
  'days61To90',
  'over90',
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

// The days from one date to another: 1 from 2026-11-04 to 2026-11-05, negative backwards. It reads
// the parts of the strings and counts in UTC, so no time zone and no summer time can move a day.
export function daysBetween(from: string, to: string): number {
  return (utcDay(to) - utcDay(from)) / 86_400_000;
}

function utcDay(isoDate: string): number {
  return Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
  );
}

// How many days past its due date a document is on asOf: 0 when it is not due yet, or due that day
export function daysOverdue(dueDate: string, asOf: string): number {
  return Math.max(0, daysBetween(dueDate, asOf));
}

export function agingBucketOf(dueDate: string, asOf: string): AgingBucket {
  const days = daysOverdue(dueDate, asOf);
  if (days === 0) return 'current';
  if (days <= 30) return 'days1To30';
  if (days <= 60) return 'days31To60';
  if (days <= 90) return 'days61To90';
  return 'over90';
}

// One party's (or the whole report's) amounts. Every amount is a decimal string with 4 places, in
// the sense of the report: what the customer owes us, or what we owe the supplier.
export const agingAmountsSchema = z.object({
  current: z.string(),
  days1To30: z.string(),
  days31To60: z.string(),
  days61To90: z.string(),
  over90: z.string(),
  // The five buckets together: what the documents still have open
  due: z.string(),
  // Received (or paid) and not applied yet. Positive.
  advances: z.string(),
  // due − advances. Negative when the advances are larger.
  balance: z.string(),
});
export type AgingAmounts = z.infer<typeof agingAmountsSchema>;

// The amounts of one party from its open documents and its advances. The mock and the party's page
// call it; the API works the same buckets out in SQL to sort and page the parties, and its tests
// check both against the same days.
export function agingAmountsOf(
  documents: readonly { dueDate: string; open: string }[],
  advances: readonly string[],
  asOf: string,
): AgingAmounts {
  const buckets: Record<AgingBucket, string> = {
    current: '0.0000',
    days1To30: '0.0000',
    days31To60: '0.0000',
    days61To90: '0.0000',
    over90: '0.0000',
  };
  let due = '0.0000';
  for (const document of documents) {
    const bucket = agingBucketOf(document.dueDate, asOf);
    buckets[bucket] = addMoney(buckets[bucket], document.open);
    due = addMoney(due, document.open);
  }
  const advance = advances.reduce((sum, amount) => addMoney(sum, amount), '0.0000');
  return { ...buckets, due, advances: advance, balance: subtractMoney(due, advance) };
}

// ---------------------------------------------------------------------------------------------
// The report: one row per party

// 'overdue' keeps the parties with anything past its due date, and shows their whole row
export const AGING_SHOWS = ['all', 'overdue'] as const;
export type AgingShow = (typeof AGING_SHOWS)[number];

export const AGING_SORTS = [
  'name',
  '-name',
  'current',
  '-current',
  'days1To30',
  '-days1To30',
  'days31To60',
  '-days31To60',
  'days61To90',
  '-days61To90',
  'over90',
  '-over90',
  'due',
  '-due',
  'advances',
  '-advances',
  'balance',
  '-balance',
] as const;
export type AgingSort = (typeof AGING_SORTS)[number];

// No branch: a receipt, an advance and a customer's balance belong to no one branch. A day after
// today is allowed: it shows what will be overdue by then if nothing is paid.
const agingFilterShape = {
  asOf: z.iso.date(),
  show: z.enum(AGING_SHOWS).default('all'),
  sort: z.enum(AGING_SORTS).default('-balance'),
};

// The filters without the page: what an export carries
export const arAgingFilterSchema = z.object({
  ...agingFilterShape,
  customerGroupId: z.uuid().optional(),
});
export type ArAgingFilter = z.infer<typeof arAgingFilterSchema>;

export const arAgingQuerySchema = pageQuerySchema.extend(arAgingFilterSchema.shape);
export type ArAgingQuery = z.input<typeof arAgingQuerySchema>;

export const apAgingFilterSchema = z.object({
  ...agingFilterShape,
  supplierGroupId: z.uuid().optional(),
});
export type ApAgingFilter = z.infer<typeof apAgingFilterSchema>;

export const apAgingQuerySchema = pageQuerySchema.extend(apAgingFilterSchema.shape);
export type ApAgingQuery = z.input<typeof apAgingQuerySchema>;

// A party with nothing open and no advance on asOf has no row
export const agingRowSchema = agingAmountsSchema.extend({ party: partyRefSchema });
export type AgingRow = z.infer<typeof agingRowSchema>;

// The same answer for both: the customer is the party in one, the supplier in the other
export const agingReportSchema = pageOf(agingRowSchema).extend({
  asOf: z.iso.date(),
  // Every row's amounts added up, not only the page's
  totals: agingAmountsSchema,
  // The receivable (or payable) account's balance in the books on asOf, for the same customers
  // (with the group filter too), in the sense of the report. null with "overdue only": the books
  // know nothing of due dates, so there is nothing to compare with.
  ledger: z.string().nullable(),
});
export type AgingReport = z.infer<typeof agingReportSchema>;

// ---------------------------------------------------------------------------------------------
// One party's page: the documents behind its row

export const agingDocumentSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  dueDate: z.iso.date(),
  total: z.string(),
  // What was still open on asOf: the total, less what was applied to it by then
  open: z.string(),
  daysOverdue: z.number().int().min(0),
  bucket: z.enum(AGING_BUCKETS),
});
export type AgingDocument = z.infer<typeof agingDocumentSchema>;

// A bill also shows the supplier's own number: the one on the paper the supplier sent
export const apAgingDocumentSchema = agingDocumentSchema.extend({
  supplierBillNumber: z.string(),
});
export type ApAgingDocument = z.infer<typeof apAgingDocumentSchema>;

// What makes up the advances: a receipt (or payment) or a credit note (or debit note) with money
// not applied yet on asOf, less what was paid back with a refund by then
export const AR_ADVANCE_KINDS = ['receipt', 'credit_note'] as const;
export const AP_ADVANCE_KINDS = ['payment', 'debit_note'] as const;

const advanceShape = {
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  // Not applied on asOf. Positive.
  amount: z.string(),
};

export const arAgingAdvanceSchema = z.object({ kind: z.enum(AR_ADVANCE_KINDS), ...advanceShape });
export type ArAgingAdvance = z.infer<typeof arAgingAdvanceSchema>;

export const apAgingAdvanceSchema = z.object({ kind: z.enum(AP_ADVANCE_KINDS), ...advanceShape });
export type ApAgingAdvance = z.infer<typeof apAgingAdvanceSchema>;

// Not paged: one party's open documents are a page's worth. The documents the oldest due date
// first, the advances the oldest first.
const agingPartyShape = {
  asOf: z.iso.date(),
  party: partyRefSchema,
  // The party's row of the report
  totals: agingAmountsSchema,
  // This party's balance in the books on asOf (the account's lines with this party)
  ledger: z.string(),
};

export const arAgingPartySchema = z.object({
  ...agingPartyShape,
  documents: z.array(agingDocumentSchema),
  advances: z.array(arAgingAdvanceSchema),
});
export type ArAgingParty = z.infer<typeof arAgingPartySchema>;

export const apAgingPartySchema = z.object({
  ...agingPartyShape,
  documents: z.array(apAgingDocumentSchema),
  advances: z.array(apAgingAdvanceSchema),
});
export type ApAgingParty = z.infer<typeof apAgingPartySchema>;

export const agingPartyQuerySchema = z.object({ asOf: z.iso.date() });
export type AgingPartyQuery = z.infer<typeof agingPartyQuerySchema>;

// ---------------------------------------------------------------------------------------------
// The routes. Only the report's permission (decision 10): the aging is a report of the module,
// not a look at one customer's balance, so sales.customer.balance is not asked for.

export const agingRoutes = {
  receivables: defineRoute({
    method: 'GET',
    path: '/reports/ar-aging',
    summary: 'What each customer owes on a day, by how long it has been due',
    auth: 'bearer',
    permission: 'sales.report.read',
    status: 200,
    query: arAgingQuerySchema,
    response: agingReportSchema,
  }),
  // A customer of another workspace, or none, is not_found
  receivablesOf: defineRoute({
    method: 'GET',
    path: '/reports/ar-aging/:customerId',
    summary: "One customer's open invoices and advances on a day",
    auth: 'bearer',
    permission: 'sales.report.read',
    status: 200,
    params: z.object({ customerId: z.uuid() }),
    query: agingPartyQuerySchema,
    response: arAgingPartySchema,
  }),
  payables: defineRoute({
    method: 'GET',
    path: '/reports/ap-aging',
    summary: 'What is owed to each supplier on a day, by how long it has been due',
    auth: 'bearer',
    permission: 'purchase.report.read',
    status: 200,
    query: apAgingQuerySchema,
    response: agingReportSchema,
  }),
  payablesOf: defineRoute({
    method: 'GET',
    path: '/reports/ap-aging/:supplierId',
    summary: "One supplier's open bills and advances on a day",
    auth: 'bearer',
    permission: 'purchase.report.read',
    status: 200,
    params: z.object({ supplierId: z.uuid() }),
    query: agingPartyQuerySchema,
    response: apAgingPartySchema,
  }),
};
