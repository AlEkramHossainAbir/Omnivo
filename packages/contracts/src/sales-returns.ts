import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { documentRefSchema } from './sales.js';
import { STOCK_DOCUMENT_STATUSES } from './stock-adjustments.js';
import {
  documentSerialRules,
  MAX_STOCK_LINES,
  optionalIdSchema,
  stockLineFieldsSchema,
  stockLineRules,
  stockLineSchema,
} from './stock.js';

// A sales return (SR-2026-27-0001) brings goods a customer sent back into a warehouse. It is the
// challan the other way round: a draft can be changed, "Post" numbers it, puts the stock back and
// books its cost back (Dr Inventory / Cr Cost of goods sold). It moves no money: what the customer
// gets back is a credit note (credit-notes.ts), a separate document, like challan and invoice (you
// chose this).
//
// Every line comes back into the one warehouse the return names (you chose this): a pharmacy's
// expired strips go to the "Damage/Expiry" warehouse, and are written off later with a stock
// adjustment (step 13, reason expired).
//
// A line comes back from a line of a posted challan, or on its own:
//   a challan line   deliveryLineId: it comes back at the cost per unit it left at, so the cost of
//                    goods sold is reversed exactly, with the challan line's batch and some of its
//                    serial numbers. If the challan line was not billed yet, the invoice bills less
//                    and the order can deliver it again; if it was, a credit note gives the money
//                    back.
//   on its own       goods that left before the system was used. They come back at the average cost
//                    on the return's date.

// Why the goods came back. It decides nothing in the books; the list shows it, and the Mushak 6.7
// (later) prints it. unsold: a retailer sends back what did not sell (common with medicines and
// fast-moving goods).
export const RETURN_REASONS = [
  'damaged',
  'expired',
  'wrong_item',
  'quality',
  'unsold',
  'other',
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const salesReturnSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft: given when it is posted, so posted numbers have no gaps
  number: z.string().nullable(),
  date: z.iso.date(),
  customer: partyRefSchema,
  // Where the goods came back into
  warehouseId: z.uuid(),
  // z.string(): the rule of every list the server may grow
  reason: z.string(),
  status: z.enum(STOCK_DOCUMENT_STATUSES),
  note: z.string().nullable(),
  lineCount: z.number().int(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type SalesReturnSummary = z.infer<typeof salesReturnSummarySchema>;

export const salesReturnLineSchema = stockLineSchema.extend({
  // The challan line the goods left on, and its challan's number; null for a line on its own
  deliveryLineId: z.uuid().nullable(),
  deliveryNumber: z.string().nullable(),
  // Whether a posted invoice had billed that challan line when the return was posted. true: the
  // customer paid for the goods, so a credit note gives the money back. false: the invoice bills
  // less instead, and nothing needs crediting. Always false for a draft and for a line on its own.
  billed: z.boolean(),
  // The invoice line that billed it, when billed: what a credit note for this line credits
  invoiceLineId: z.uuid().nullable(),
  invoiceId: z.uuid().nullable(),
  invoiceNumber: z.string().nullable(),
  // What posted credit note lines already gave back for this line, in the base unit
  creditedQuantity: z.string(),
  // What the goods came back at, once posted (step 14's value); null for a draft, and without
  // inventory.stock.value
  value: z.string().nullable(),
});
export type SalesReturnLine = z.infer<typeof salesReturnLineSchema>;

export const salesReturnSchema = salesReturnSummarySchema.extend({
  lines: z.array(salesReturnLineSchema),
  // The challans its lines came back from
  deliveries: z.array(documentRefSchema),
  // The credit notes written for it (drafts too, so nobody writes a second one by mistake)
  creditNotes: z.array(documentRefSchema),
  // The entry that put the cost back; null for a draft, or when the goods cost nothing
  entry: entryRefSchema.nullable(),
});
export type SalesReturn = z.infer<typeof salesReturnSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

interface ReturnLineFields {
  deliveryLineId: string | null;
  batchId: string | null;
}

// A line from a challan comes back with the challan line's own batch (a challan line has one batch,
// step 15b), so it names none. A line on its own names the batch printed on the goods.
function returnLineRules<T extends ReturnLineFields>(line: T, ctx: z.RefinementCtx<T>): void {
  if (line.deliveryLineId !== null && line.batchId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['batchId'],
      message: errorCode('return_batch_not_allowed'),
    });
  }
}

const salesReturnLineInputSchema = stockLineFieldsSchema
  .extend({
    // '' = a line on its own
    deliveryLineId: optionalIdSchema,
  })
  .superRefine((line, ctx) => {
    stockLineRules(line, ctx);
    returnLineRules(line, ctx);
  });
export type SalesReturnLineInput = z.infer<typeof salesReturnLineInputSchema>;
export type SalesReturnLineFormValues = z.input<typeof salesReturnLineInputSchema>;

const salesReturnFieldsSchema = z.object({
  customerId: z.uuid(errorCode('sales_customer_required')),
  date: z.iso.date(errorCode('stock_date_required')),
  warehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  reason: z.enum(RETURN_REASONS),
  note: optionalText(300),
  lines: z
    .array(salesReturnLineInputSchema)
    .min(1, errorCode('stock_lines_required'))
    .max(MAX_STOCK_LINES),
  // true = "Post": save and post in one step, or nothing at all
  post: z.boolean(),
});

type SalesReturnRuleInput = z.output<typeof salesReturnFieldsSchema>;

// A challan line once per return: it has one batch, so a second line for it has no reason to exist,
// and how much can still come back is easier to read on one line
function salesReturnRules(input: SalesReturnRuleInput, ctx: z.RefinementCtx<SalesReturnRuleInput>) {
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    if (line.deliveryLineId === null) return;
    if (seen.has(line.deliveryLineId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'deliveryLineId'],
        message: errorCode('return_line_twice'),
      });
    }
    seen.add(line.deliveryLineId);
  });
  documentSerialRules(input, ctx);
}

export const salesReturnInputSchema = salesReturnFieldsSchema.superRefine(salesReturnRules);
export type SalesReturnInput = z.infer<typeof salesReturnInputSchema>;

export const updateSalesReturnInputSchema = salesReturnFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(salesReturnRules);
export type UpdateSalesReturnInput = z.infer<typeof updateSalesReturnInputSchema>;
export type SalesReturnFormValues = z.input<typeof updateSalesReturnInputSchema>;

export const salesReturnVersionInputSchema = z.object({ version: versionSchema });

export const deleteSalesReturnQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const salesReturnListQuerySchema = pageQuerySchema.extend({
  status: z.enum(STOCK_DOCUMENT_STATUSES).optional(),
  customerId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
});
export type SalesReturnListQuery = z.input<typeof salesReturnListQuerySchema>;

export const salesReturnPageSchema = pageOf(salesReturnSummarySchema);
export type SalesReturnPage = z.infer<typeof salesReturnPageSchema>;

const salesReturnParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every stock document. Writing and posting need
// sales.return.manage: the store keeper who takes the goods back in.
export const salesReturnRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/sales-returns',
    summary: 'Sales returns, newest date first',
    auth: 'bearer',
    status: 200,
    query: salesReturnListQuerySchema,
    response: salesReturnPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/sales-returns/:id',
    summary: 'One sales return with its lines',
    auth: 'bearer',
    status: 200,
    params: salesReturnParamsSchema,
    response: salesReturnSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/sales-returns',
    summary: 'Write a sales return as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'sales.return.manage',
    status: 201,
    body: salesReturnInputSchema,
    response: salesReturnSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/sales-returns/:id',
    summary: 'Change a draft sales return, and optionally post it',
    auth: 'bearer',
    permission: 'sales.return.manage',
    status: 200,
    params: salesReturnParamsSchema,
    body: updateSalesReturnInputSchema,
    response: salesReturnSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/sales-returns/:id',
    summary: 'Delete a draft sales return',
    auth: 'bearer',
    permission: 'sales.return.manage',
    status: 204,
    params: salesReturnParamsSchema,
    query: deleteSalesReturnQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/sales-returns/:id/post',
    summary:
      'Post a draft sales return: it gets its number, puts the stock back and books its cost',
    auth: 'bearer',
    permission: 'sales.return.manage',
    status: 200,
    params: salesReturnParamsSchema,
    body: salesReturnVersionInputSchema,
    response: salesReturnSchema,
  }),
};
