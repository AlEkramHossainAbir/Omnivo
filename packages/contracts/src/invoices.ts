import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema, shiftIsoDate } from './journal.js';
import { compareMoney, isZeroMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import {
  documentRefSchema,
  salesDocumentFieldsSchema,
  salesLineFieldsSchema,
  salesLineRules,
  salesLineSchema,
} from './sales.js';
import {
  documentSerialRules,
  MAX_SERIALS_PER_LINE,
  MAX_STOCK_LINES,
  optionalDateSchema,
  optionalIdSchema,
  serialNumberSchema,
  stockLineRules,
} from './stock.js';

// A sales invoice asks the customer for the money. A draft can be changed; "Post" gives it its
// number (INV-2026-27-0001) and books the sale: Dr Accounts receivable (with the customer) /
// Cr Sales / Cr VAT payable. The cost of the goods was booked by the challan that took them out
// (step 15b), so the invoice never touches the stock accounts itself. A posted invoice is never
// changed or deleted: a credit note corrects it (15d).
//
// Each line bills one of three things (you chose challan + direct):
//   a challan line      deliveryLineId: goods that left on a posted challan. Billed whole and once.
//   an order's service  orderLineId: a delivery charge on the order. A service is never delivered,
//                       so it is billed straight from the order.
//   neither             a line of its own. A goods line is delivered by the invoice itself: posting
//                       it posts a challan from the invoice's warehouse in the same transaction,
//                       so a shop's counter sale needs one document, and the cost is still booked
//                       once, by that challan.

// One invoice may bill a month of challans for a distributor's depot. A direct invoice's goods
// lines become one challan, so the limit is a challan's.
export const MAX_INVOICE_LINES = MAX_STOCK_LINES;

// draft → posted. Numbered at posting, so posted numbers have no gaps (the NBR asks for that).
export const INVOICE_STATUSES = ['draft', 'posted'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

// What the money receipts (receipts.ts) applied to it so far. Worked out from the total and what
// was paid, never stored, so the two can never disagree.
export const PAYMENT_STATUSES = ['unpaid', 'partly_paid', 'paid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function paymentStatusOf(invoice: { total: string; amountPaid: string }): PaymentStatus {
  // A ৳0 invoice (a free sample) owes nothing: it is paid the moment it exists
  if (compareMoney(invoice.amountPaid, invoice.total) >= 0) return 'paid';
  return isZeroMoney(invoice.amountPaid) ? 'unpaid' : 'partly_paid';
}

// Overdue: posted, not paid in full, and its due date is before today (the workspace's today,
// todayIn() in numbering.ts). On the due date itself it is still on time.
export function isOverdue(
  invoice: { status: string; dueDate: string; total: string; amountPaid: string },
  today: string,
): boolean {
  return (
    invoice.status === 'posted' && paymentStatusOf(invoice) !== 'paid' && invoice.dueDate < today
  );
}

// The due date an invoice starts with: its date plus the customer's payment terms (step 15a). 0
// days = due on receipt, the same day.
export function dueDateOf(date: string, paymentTermsDays: number): string {
  return shiftIsoDate(date, paymentTermsDays);
}

// The invoice list's payment filter. open: posted and not paid in full (what a receipt can be
// applied to); overdue: open and past its due date. Both list the oldest due date first, the order
// a receipt pays them in.
export const INVOICE_PAYMENT_FILTERS = ['open', 'overdue', 'paid'] as const;
export type InvoicePaymentFilter = (typeof INVOICE_PAYMENT_FILTERS)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const invoiceSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft
  number: z.string().nullable(),
  date: z.iso.date(),
  dueDate: z.iso.date(),
  customer: partyRefSchema,
  // The customer's own number for what is billed: a buyer's PO, a pharmacy's indent
  customerReference: z.string().nullable(),
  // Whose sale it is: every line of its journal entry carries this branch, so the profit and loss
  // by branch (step 11) shows it there
  branchId: z.uuid(),
  status: z.enum(INVOICE_STATUSES),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  // What money receipts applied to it; total − amountPaid is still due
  amountPaid: z.string(),
  lineCount: z.number().int(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

export const invoiceLineSchema = salesLineSchema.extend({
  // The challan line this line bills; null for an order's service line and for a line of its own
  // until the invoice is posted (posting points it at the challan line it made)
  deliveryLineId: z.uuid().nullable(),
  // The order line behind it: through the challan line, or an order's service line
  orderLineId: z.uuid().nullable(),
  // Their numbers, so a draft's line says "From DC-2026-27-0042" and the printed invoice can show
  // the challan of each line. A challan line's challan is posted, so it has a number; an order
  // behind a line is confirmed or later, so it has one too.
  deliveryNumber: z.string().nullable(),
  orderNumber: z.string().nullable(),
  // The batch and serial numbers the goods left with, for the printed invoice (a pharmacy's
  // invoice shows each batch and its expiry): the challan line's, or what a line of its own picked
  batchId: z.uuid().nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: z.iso.date().nullable(),
  serialNumbers: z.array(z.string()),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

// A challan the invoice bills (or made, for its own goods lines). Always posted, so it has a number.
export const invoiceDeliverySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
});
export type InvoiceDelivery = z.infer<typeof invoiceDeliverySchema>;

// Money a receipt applied to this invoice
export const invoicePaymentSchema = z.object({
  receiptId: z.uuid(),
  receiptNumber: z.string(),
  date: z.iso.date(),
  amount: z.string(),
});
export type InvoicePayment = z.infer<typeof invoicePaymentSchema>;

export const invoiceSchema = invoiceSummarySchema.extend({
  // The orders' copy of the workspace setting when the invoice bills orders, else the setting's
  pricesIncludeVat: z.boolean(),
  discount: z.string(),
  // Where the invoice's own goods lines leave from; null when every goods line is on a challan
  warehouseId: z.uuid().nullable(),
  // The customer's billing address as it was when the invoice was saved
  billingAddress: z.string().nullable(),
  note: z.string().nullable(),
  lines: z.array(invoiceLineSchema),
  deliveries: z.array(invoiceDeliverySchema),
  orders: z.array(documentRefSchema),
  payments: z.array(invoicePaymentSchema),
  // The sale in the books; null for a draft, and for an invoice of ৳0
  entry: entryRefSchema.nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

interface InvoiceLineFields {
  deliveryLineId: string | null;
  orderLineId: string | null;
  batchId: string | null;
  serialNumbers: readonly string[];
}

// A line bills one thing. Only a line of its own picks its batch and serial numbers: a challan line
// already left with its own, and a service has none.
function invoiceLineRules<T extends InvoiceLineFields>(line: T, ctx: z.RefinementCtx<T>): void {
  if (line.deliveryLineId !== null && line.orderLineId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['orderLineId'],
      message: errorCode('invoice_line_source'),
    });
  }
  if (line.deliveryLineId === null && line.orderLineId === null) return;
  if (line.batchId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['batchId'],
      message: errorCode('invoice_stock_not_allowed'),
    });
  }
  if (line.serialNumbers.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['serialNumbers'],
      message: errorCode('invoice_stock_not_allowed'),
    });
  }
}

const invoiceLineInputSchema = salesLineFieldsSchema
  .extend({
    // '' = not a challan line
    deliveryLineId: optionalIdSchema,
    // '' = not an order's service line. A challan line leaves it empty: the server reads the order
    // line from the challan line.
    orderLineId: optionalIdSchema,
    // A goods line of its own, like a challan line: the batch (FEFO in the form) or the serials
    batchId: optionalIdSchema,
    serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
  })
  .superRefine((line, ctx) => {
    salesLineRules(line, ctx);
    stockLineRules(line, ctx);
    invoiceLineRules(line, ctx);
  });
export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>;
export type InvoiceLineFormValues = z.input<typeof invoiceLineInputSchema>;

const invoiceFieldsSchema = salesDocumentFieldsSchema.extend({
  lines: z
    .array(invoiceLineInputSchema)
    .min(1, errorCode('sales_lines_required'))
    .max(MAX_INVOICE_LINES),
  // '' = the date plus the customer's payment terms (dueDateOf)
  dueDate: optionalDateSchema,
  customerReference: optionalText(60),
  branchId: z.uuid(errorCode('sales_branch_invalid')),
  // Needed only when a goods line is a line of its own: which products are goods only the server
  // knows, so it checks that (invoice_warehouse_required). '' = none.
  warehouseId: optionalIdSchema,
  // true = "Post": save and post in one step, or nothing at all
  post: z.boolean(),
  // Post even though it takes the customer over the credit limit. Only someone with
  // sales.credit.override may send true; the form sends it after the person saw the amount and
  // confirmed (credit_limit_exceeded → a dialog → the same request again with true).
  overrideCreditLimit: z.boolean().default(false),
});

type InvoiceRuleInput = z.output<typeof invoiceFieldsSchema>;

function invoiceRules(input: InvoiceRuleInput, ctx: z.RefinementCtx<InvoiceRuleInput>) {
  if (input.dueDate !== null && input.dueDate < input.date) {
    ctx.addIssue({ code: 'custom', path: ['dueDate'], message: errorCode('invoice_due_date') });
  }
  // A challan line or an order line twice on one invoice would bill it twice. Ids of the two kinds
  // never meet (they are UUIDs of different tables), so one set holds both.
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    const pairs = [
      ['deliveryLineId', line.deliveryLineId],
      ['orderLineId', line.orderLineId],
    ] as const;
    for (const [field, id] of pairs) {
      if (id === null) continue;
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', index, field],
          message: errorCode('invoice_line_twice'),
        });
      }
      seen.add(id);
    }
  });
  documentSerialRules(input, ctx);
}

export const invoiceInputSchema = invoiceFieldsSchema.superRefine(invoiceRules);
export type InvoiceInput = z.infer<typeof invoiceInputSchema>;

export const updateInvoiceInputSchema = invoiceFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(invoiceRules);
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceInputSchema>;
export type InvoiceFormValues = z.input<typeof updateInvoiceInputSchema>;

export const postInvoiceInputSchema = z.object({
  version: versionSchema,
  overrideCreditLimit: z.boolean().default(false),
});
export type PostInvoiceInput = z.infer<typeof postInvoiceInputSchema>;

export const deleteInvoiceQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const invoiceListQuerySchema = pageQuerySchema.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
  customerId: z.uuid().optional(),
  payment: z.enum(INVOICE_PAYMENT_FILTERS).optional(),
});
export type InvoiceListQuery = z.input<typeof invoiceListQuerySchema>;

export const invoicePageSchema = pageOf(invoiceSummarySchema);
export type InvoicePage = z.infer<typeof invoicePageSchema>;

const invoiceParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every sales document. Writing and posting need
// sales.invoice.manage: the accountant or the sales officer who bills.
export const invoiceRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/invoices',
    summary: 'Sales invoices, newest date first (open and overdue: oldest due date first)',
    auth: 'bearer',
    status: 200,
    query: invoiceListQuerySchema,
    response: invoicePageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/invoices/:id',
    summary: 'One invoice with its lines, challans and payments',
    auth: 'bearer',
    status: 200,
    params: invoiceParamsSchema,
    response: invoiceSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/invoices',
    summary: 'Write an invoice as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'sales.invoice.manage',
    status: 201,
    body: invoiceInputSchema,
    response: invoiceSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/invoices/:id',
    summary: 'Change a draft invoice, and optionally post it',
    auth: 'bearer',
    permission: 'sales.invoice.manage',
    status: 200,
    params: invoiceParamsSchema,
    body: updateInvoiceInputSchema,
    response: invoiceSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/invoices/:id',
    summary: 'Delete a draft invoice',
    auth: 'bearer',
    permission: 'sales.invoice.manage',
    status: 204,
    params: invoiceParamsSchema,
    query: deleteInvoiceQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/invoices/:id/post',
    summary:
      'Post a draft invoice: it gets its number, delivers its own goods lines and books the sale',
    auth: 'bearer',
    permission: 'sales.invoice.manage',
    status: 200,
    params: invoiceParamsSchema,
    body: postInvoiceInputSchema,
    response: invoiceSchema,
  }),
};
