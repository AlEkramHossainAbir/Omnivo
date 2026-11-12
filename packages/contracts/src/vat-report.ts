import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { TAX_RATE_KINDS } from './tax-rates.js';

// The VAT report (step 21c): the VAT of a period, by rate. It helps the accountant prepare the
// monthly return. It is not the return itself: Mushak 9.1 comes in Phase 2.
//
// - The numbers come from the documents' lines, by the document's date. Output VAT: posted invoices
//   and POS sales, less posted credit notes and POS returns. Input VAT: posted bills (product
//   lines, account lines and expenses), less posted debit notes.
// - Each line keeps the rate it was charged at, so a rate that was renamed or changed later does
//   not move an old sale to another row.
// - Beside the report, what the books say: the 'vat_output' and 'vat_input' accounts. A journal
//   entry written by hand on one of them makes the two differ, and the page shows by how much.

// ---------------------------------------------------------------------------------------------
// The query

// Both days included, like the other reports. An invoice or a credit note counts in its own branch,
// a POS sale or return in its warehouse's, a bill or a debit note in its own.
export const vatReportFilterSchema = z
  .object({ from: z.iso.date(), to: z.iso.date(), branchId: z.uuid().optional() })
  .refine((query) => query.from <= query.to, {
    error: errorCode('report_range_invalid'),
    path: ['to'],
  });
export type VatReportFilter = z.infer<typeof vatReportFilterSchema>;

// Output is what the company charged, input is what it paid
export const VAT_REPORT_SIDES = ['output', 'input'] as const;
export type VatReportSide = (typeof VAT_REPORT_SIDES)[number];

// The filters again, because a schema with .refine() cannot be extended
export const vatDocumentQuerySchema = pageQuerySchema
  .extend({
    from: z.iso.date(),
    to: z.iso.date(),
    branchId: z.uuid().optional(),
    side: z.enum(VAT_REPORT_SIDES),
  })
  .refine((query) => query.from <= query.to, {
    error: errorCode('report_range_invalid'),
    path: ['to'],
  });
export type VatDocumentQuery = z.input<typeof vatDocumentQuerySchema>;

// ---------------------------------------------------------------------------------------------
// The answer. Every amount is a decimal string with 4 places. Credit notes, POS returns and debit
// notes are already taken off.

export const vatReportRowSchema = z.object({
  // Unique in the answer: the rate's id, its kind and its percent. A rate whose percent (or kind)
  // was changed has one row for each, because each one is a different line of the return.
  key: z.string(),
  taxRateId: z.uuid(),
  // "VAT 15%", as the page shows it next to the percent
  name: z.string(),
  // Zero-rated and exempt are both 0%, but different things in a return: never one row
  kind: z.enum(TAX_RATE_KINDS),
  // A percentage: "15.00"
  rate: z.string(),
  outputNet: z.string(),
  outputVat: z.string(),
  inputNet: z.string(),
  inputVat: z.string(),
  // outputVat − inputVat. Negative when more was paid than charged.
  netVat: z.string(),
});
export type VatReportRow = z.infer<typeof vatReportRowSchema>;

export const vatReportTotalsSchema = z.object({
  outputNet: z.string(),
  outputVat: z.string(),
  // How much of the VAT charged was taken off again: credit notes and POS returns. Positive, and
  // already left out of outputVat.
  outputVatReturned: z.string(),
  inputNet: z.string(),
  inputVat: z.string(),
  // The same for debit notes
  inputVatReturned: z.string(),
  // The VAT on posted bills with no supplier's VAT invoice (Mushak 6.3) number. It stays in
  // inputVat, as it does in the books: this only tells the accountant which bills to check.
  // Before debit notes, because a debit note does not say which part of the bill it took off.
  inputVatWithoutMushak: z.string(),
  netVat: z.string(),
});
export type VatReportTotals = z.infer<typeof vatReportTotalsSchema>;

export const vatReportSchema = z.object({
  // Standard rates first, the highest first; then reduced, zero-rated and exempt
  rows: z.array(vatReportRowSchema),
  totals: vatReportTotalsSchema,
  // What the accounts moved in the same period and branch. output: credit less debit on
  // 'vat_output'. input: debit less credit on 'vat_input'.
  books: z.object({ output: z.string(), input: z.string() }),
});
export type VatReport = z.infer<typeof vatReportSchema>;

export const VAT_DOCUMENT_KINDS = [
  'invoice',
  'pos_sale',
  'credit_note',
  'pos_return',
  'bill',
  'debit_note',
] as const;
export type VatDocumentKind = (typeof VAT_DOCUMENT_KINDS)[number];

export const vatDocumentSchema = z.object({
  // z.string(), not an enum: a newer server's new document must not break an older client. The
  // app narrows it with isVatDocumentKind().
  kind: z.string(),
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  // null for a POS sale or return with no customer (walk-in)
  partyName: z.string().nullable(),
  partyBin: z.string().nullable(),
  // A bill's and a debit note's own VAT document (Mushak 6.3, Mushak 6.7); null elsewhere
  mushakNumber: z.string().nullable(),
  // Negative for what takes VAT off: a credit note, a POS return, a debit note
  net: z.string(),
  vat: z.string(),
});
export type VatDocument = z.infer<typeof vatDocumentSchema>;

export function isVatDocumentKind(value: string): value is VatDocumentKind {
  return VAT_DOCUMENT_KINDS.some((kind) => kind === value);
}

// In date order, oldest first, like a VAT register. Not sortable.
export const vatDocumentPageSchema = pageOf(vatDocumentSchema);
export type VatDocumentPage = z.infer<typeof vatDocumentPageSchema>;

// ---------------------------------------------------------------------------------------------
// The routes. VAT belongs to the accounts, so it needs accounting.report.read.

export const vatReportRoutes = {
  summary: defineRoute({
    method: 'GET',
    path: '/reports/vat',
    summary: 'The VAT of a period by rate, with what the books say',
    auth: 'bearer',
    permission: 'accounting.report.read',
    status: 200,
    query: vatReportFilterSchema,
    response: vatReportSchema,
  }),
  documents: defineRoute({
    method: 'GET',
    path: '/reports/vat/documents',
    summary: 'The documents behind the VAT of a period, one side at a time',
    auth: 'bearer',
    permission: 'accounting.report.read',
    status: 200,
    query: vatDocumentQuerySchema,
    response: vatDocumentPageSchema,
  }),
};
