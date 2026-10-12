import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { MAX_INVOICE_LINES, type Invoice } from './invoices.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { isZeroMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { plainQuantity } from './quantities.js';
import {
  type AllocationCodes,
  allocationsSchemaFor,
  receiptAllocationSchema,
  uniqueInvoiceRules,
} from './receipts.js';
import {
  defaultLineDescription,
  salesLineFieldsSchema,
  salesLineRules,
  salesLineSchema,
} from './sales.js';
import { optionalIdSchema } from './stock.js';

// A credit note (CN-2026-27-0001) takes back part or all of a posted invoice: goods that came back
// on a sales return, a price cut after the sale, a billing mistake. Posting it books the sale back:
// Dr Sales returns (the account chosen in Settings → Sales, or Sales itself) for the net / Dr Output
// VAT for the VAT / Cr Accounts receivable (with the customer) for the total.
//
// It is always for ONE posted invoice, and each line credits one of that invoice's lines, at that
// line's VAT rate. The Mushak 6.7 (later) names the original invoice, and the VAT taken back must be
// the VAT that was charged, so a credit note without an invoice would not be a VAT credit note.
//
// Its money (you chose this) is first applied to its own invoice, up to what the invoice still owes;
// the rest is the customer's advance, which can be applied to a later invoice or paid back with a
// refund (refunds.ts). The allocations work like a money receipt's.
//
// A draft can be changed or deleted. A posted credit note is never changed: there is no void.

export const CREDIT_NOTE_STATUSES = ['draft', 'posted'] as const;
export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUSES)[number];

// Why it was written. goods_returned is what the form starts with when it is made from a return.
export const CREDIT_NOTE_REASONS = [
  'goods_returned',
  'price_adjustment',
  'billing_error',
  'other',
] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];

// '2026-08-31' + 6 → '2027-02-28': the day of the month, or the month's last day when it is shorter.
// UTC arithmetic, so no time zone can move the day (the rule of shiftIsoDate in journal.ts).
function addMonths(isoDate: string, months: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7)) - 1 + months;
  const day = Number(isoDate.slice(8, 10));
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

// VAT law lets a credit note reduce output VAT only within 6 months of the supply. You chose a
// warning, not a block: the form shows a notice, and saving and posting still work.
export function creditNoteIsLate(invoiceDate: string, date: string): boolean {
  return date > addMonths(invoiceDate, 6);
}

// ---------------------------------------------------------------------------------------------
// What the API sends

// The invoice it credits. Posted, so it has a number.
export const creditedInvoiceSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
});
export type CreditedInvoice = z.infer<typeof creditedInvoiceSchema>;

export const creditNoteSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft
  number: z.string().nullable(),
  date: z.iso.date(),
  customer: partyRefSchema,
  invoice: creditedInvoiceSchema,
  // The invoice's branch: every line of its entry carries it, so the sale comes off where it was made
  branchId: z.uuid(),
  // z.string(): the rule of every list the server may grow
  reason: z.string(),
  status: z.enum(CREDIT_NOTE_STATUSES),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  // What is applied to invoices, and what refunds paid back. unappliedOf() (receipts.ts) is the
  // customer's advance that is left.
  applied: z.string(),
  refunded: z.string(),
  lineCount: z.number().int(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type CreditNoteSummary = z.infer<typeof creditNoteSummarySchema>;

export const creditNoteLineSchema = salesLineSchema.extend({
  // The invoice line it credits: the item and the VAT rate come from there
  invoiceLineId: z.uuid(),
  // The return line it gives the money back for, and that return's number; null for a price cut
  returnLineId: z.uuid().nullable(),
  returnNumber: z.string().nullable(),
});
export type CreditNoteLine = z.infer<typeof creditNoteLineSchema>;

export const creditNoteSchema = creditNoteSummarySchema.extend({
  // The invoice's own setting: the credit note works its lines out the same way, so crediting a line
  // in full gives back exactly what the line charged
  pricesIncludeVat: z.boolean(),
  discount: z.string(),
  note: z.string().nullable(),
  lines: z.array(creditNoteLineSchema),
  // The invoices its money is applied to (its own first)
  allocations: z.array(receiptAllocationSchema),
  // null for a draft, and for a credit note of ৳0
  entry: entryRefSchema.nullable(),
});
export type CreditNote = z.infer<typeof creditNoteSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// A line names the invoice line it credits. No item and no VAT rate: both are the invoice line's.
// The unit may be any of the item's units (3 strips back from a line of 2 boxes). A price cut is a
// line with the quantity it applies to and the cut per unit: 100 pcs at ৳2.
const creditNoteLineInputSchema = salesLineFieldsSchema
  .omit({ variantId: true, taxRateId: true })
  .extend({
    invoiceLineId: z.uuid(errorCode('credit_note_line_invalid')),
    // '' = not for a return line
    returnLineId: optionalIdSchema,
  })
  .superRefine(salesLineRules);
export type CreditNoteLineInput = z.infer<typeof creditNoteLineInputSchema>;
export type CreditNoteLineFormValues = z.input<typeof creditNoteLineInputSchema>;

const creditNoteFieldsSchema = z.object({
  invoiceId: z.uuid(errorCode('credit_note_invoice_required')),
  // Not before the invoice's date (credit_note_date, checked by the server: only it reads the
  // invoice for sure)
  date: z.iso.date(errorCode('sales_date_required')),
  reason: z.enum(CREDIT_NOTE_REASONS),
  note: optionalText(500),
  lines: z
    .array(creditNoteLineInputSchema)
    .min(1, errorCode('sales_lines_required'))
    .max(MAX_INVOICE_LINES),
  // true = "Post": save and post in one step, or nothing at all
  post: z.boolean(),
});

type CreditNoteRuleInput = z.output<typeof creditNoteFieldsSchema>;

// A return line once: two lines for it would give its money back twice. Two lines may credit one
// invoice line (a price cut and a return), so that one is not checked here; the server checks the
// sum against what the line charged.
function creditNoteRules(input: CreditNoteRuleInput, ctx: z.RefinementCtx<CreditNoteRuleInput>) {
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    if (line.returnLineId === null) return;
    if (seen.has(line.returnLineId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'returnLineId'],
        message: errorCode('credit_note_return_twice'),
      });
    }
    seen.add(line.returnLineId);
  });
}

export const creditNoteInputSchema = creditNoteFieldsSchema.superRefine(creditNoteRules);
export type CreditNoteInput = z.infer<typeof creditNoteInputSchema>;

export const updateCreditNoteInputSchema = creditNoteFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(creditNoteRules);
export type UpdateCreditNoteInput = z.infer<typeof updateCreditNoteInputSchema>;
export type CreditNoteFormValues = z.input<typeof updateCreditNoteInputSchema>;

export const creditNoteVersionInputSchema = z.object({ version: versionSchema });

const CREDIT_NOTE_ALLOCATION_CODES = {
  invoice: 'credit_note_allocation_invalid',
  required: 'credit_note_amount_required',
  twice: 'credit_note_invoice_twice',
} as const satisfies AllocationCodes;

// Apply its money again, like a receipt's (receiptAllocationsInputSchema). The server checks the
// total against the credit note's own, less what refunds paid back (credit_note_over_allocated).
export const creditNoteAllocationsInputSchema = z
  .object({
    version: versionSchema,
    allocations: allocationsSchemaFor(CREDIT_NOTE_ALLOCATION_CODES),
  })
  .superRefine(uniqueInvoiceRules(CREDIT_NOTE_ALLOCATION_CODES.twice));
export type CreditNoteAllocationsInput = z.infer<typeof creditNoteAllocationsInputSchema>;
export type CreditNoteAllocationsFormValues = z.input<typeof creditNoteAllocationsInputSchema>;

// "Credit whole invoice" (you chose this): every line of the invoice, as it was billed. The app
// saves these as a draft in one click. Worked out the same way as the invoice (the invoice's own
// pricesIncludeVat), each line gives back exactly what it charged, to the paisa. Only while no
// posted credit note exists for the invoice (canCreditWhole): after one, the full amounts would be
// more than is left to credit.
// The values are the form's, like the app's toFormLine() (15b): the API sends 4 decimals
// ("8.0000"), and the discount box takes at most 2, so trailing zeros go; a description that is
// just the product's name stays empty, so the server writes it the same way.
export function wholeInvoiceCreditLines(
  invoice: Pick<Invoice, 'lines'>,
): CreditNoteLineFormValues[] {
  return invoice.lines.map((line) => ({
    invoiceLineId: line.id,
    returnLineId: '',
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    description: line.description === defaultLineDescription(line) ? '' : line.description,
    unitPrice: line.unitPrice,
    discountType: line.discountType,
    discount: isZeroMoney(line.discount) ? '' : plainQuantity(line.discount),
  }));
}

export function canCreditWhole(invoice: Pick<Invoice, 'status' | 'creditNotes'>): boolean {
  return invoice.status === 'posted' && invoice.creditNotes.length === 0;
}

export const deleteCreditNoteQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const creditNoteListQuerySchema = pageQuerySchema.extend({
  status: z.enum(CREDIT_NOTE_STATUSES).optional(),
  customerId: z.uuid().optional(),
  invoiceId: z.uuid().optional(),
});
export type CreditNoteListQuery = z.input<typeof creditNoteListQuerySchema>;

export const creditNotePageSchema = pageOf(creditNoteSummarySchema);
export type CreditNotePage = z.infer<typeof creditNotePageSchema>;

const creditNoteParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like the invoices. Writing, posting and applying need
// sales.credit_note.manage: usually the accountant.
export const creditNoteRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/credit-notes',
    summary: 'Credit notes, newest date first',
    auth: 'bearer',
    status: 200,
    query: creditNoteListQuerySchema,
    response: creditNotePageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/credit-notes/:id',
    summary: 'One credit note with its lines and where its money went',
    auth: 'bearer',
    status: 200,
    params: creditNoteParamsSchema,
    response: creditNoteSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/credit-notes',
    summary: 'Write a credit note as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'sales.credit_note.manage',
    status: 201,
    body: creditNoteInputSchema,
    response: creditNoteSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/credit-notes/:id',
    summary: 'Change a draft credit note, and optionally post it',
    auth: 'bearer',
    permission: 'sales.credit_note.manage',
    status: 200,
    params: creditNoteParamsSchema,
    body: updateCreditNoteInputSchema,
    response: creditNoteSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/credit-notes/:id',
    summary: 'Delete a draft credit note',
    auth: 'bearer',
    permission: 'sales.credit_note.manage',
    status: 204,
    params: creditNoteParamsSchema,
    query: deleteCreditNoteQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/credit-notes/:id/post',
    summary:
      'Post a draft credit note: it gets its number, books the sale back and applies its money',
    auth: 'bearer',
    permission: 'sales.credit_note.manage',
    status: 200,
    params: creditNoteParamsSchema,
    body: creditNoteVersionInputSchema,
    response: creditNoteSchema,
  }),
  allocate: defineRoute({
    method: 'PUT',
    path: '/credit-notes/:id/allocations',
    summary: "Change which invoices a credit note's money is applied to",
    auth: 'bearer',
    permission: 'sales.credit_note.manage',
    status: 200,
    params: creditNoteParamsSchema,
    body: creditNoteAllocationsInputSchema,
    response: creditNoteSchema,
  }),
};
