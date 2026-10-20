import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { RETURN_REASONS } from './sales-returns.js';
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

// A purchase return (PRN-2026-27-0001) sends goods back to a supplier: torn rolls found after the
// gate, a shade that does not match the buyer's swatch, medicines that expired on the shelf. It is
// the goods receipt the other way round, and the sales return of step 15d seen from the other side:
// a draft can be changed, "Post" numbers it, takes the stock out of one warehouse and books it at
// the cost it came in at (Dr Goods received not billed / Cr Inventory). It needs no approval (you
// chose this) and moves no money: what the supplier takes off the bill is a debit note
// (debit-notes.ts), a separate document, like the return and the credit note of 15d (you chose
// this).
//
// Every line leaves the one warehouse the return names. A line goes back from a line of a posted
// goods receipt, or on its own:
//   a receipt line   receiptLineId: it leaves at the cost per unit the receipt line came in at
//                    (you chose this), so goods received not billed is put back exactly, with the
//                    receipt line's batch and some of its serial numbers. If no bill billed the
//                    receipt line yet, the bill bills less (keptQuantity, goods-receipts.ts) and
//                    the order counts the goods as not received, so the supplier can send them
//                    again (you chose this). If a bill did, a debit note takes the money off.
//   on its own       goods that came in before the system was used. They leave at the average cost
//                    on the return's date (you chose this), and a debit note without a bill takes
//                    their money off (you chose this in 17d.1).
// Goods turned back at the gate (a receipt line's rejectedQuantity) never came into stock, so they
// are not returned: the supplier took them back off the truck.
//
// Why it went back is RETURN_REASONS (sales-returns.ts), the same words: a pharmacy sends unsold
// stock back to the distributor as a dealer sends it back to the pharmacy. It decides nothing in
// the books.

// ---------------------------------------------------------------------------------------------
// What the API sends

export const purchaseReturnSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft: given when it is posted, so posted numbers have no gaps
  number: z.string().nullable(),
  date: z.iso.date(),
  supplier: partyRefSchema,
  // Where the goods leave from
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
export type PurchaseReturnSummary = z.infer<typeof purchaseReturnSummarySchema>;

export const purchaseReturnLineSchema = stockLineSchema.extend({
  // The goods receipt line the goods came in on, and its receipt's number; null for a line on its
  // own
  receiptLineId: z.uuid().nullable(),
  receiptNumber: z.string().nullable(),
  // Whether a posted bill had billed that receipt line when the return was posted. true: the
  // company owes the supplier for the goods, so a debit note takes the money off. false: the bill
  // bills less instead, and nothing needs debiting. Always false for a draft and for a line on its
  // own.
  billed: z.boolean(),
  // The bill line that billed it, when billed: what a debit note for this line debits
  billLineId: z.uuid().nullable(),
  billId: z.uuid().nullable(),
  billNumber: z.string().nullable(),
  // What posted debit note lines already took off for this line, in the base unit
  debitedQuantity: z.string(),
  // What the goods left at, once posted (step 14's value); null for a draft, and without
  // inventory.stock.value
  value: z.string().nullable(),
});
export type PurchaseReturnLine = z.infer<typeof purchaseReturnLineSchema>;

export const purchaseReturnSchema = purchaseReturnSummarySchema.extend({
  lines: z.array(purchaseReturnLineSchema),
  // The goods receipts its lines went back from
  receipts: z.array(documentRefSchema),
  // The debit notes written for it (drafts too, so nobody writes a second one by mistake)
  debitNotes: z.array(documentRefSchema),
  // The entry that took the stock out; null for a draft, or when the goods cost nothing
  entry: entryRefSchema.nullable(),
});
export type PurchaseReturn = z.infer<typeof purchaseReturnSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

interface ReturnLineFields {
  receiptLineId: string | null;
  batchId: string | null;
}

// A line from a receipt line goes back with the receipt line's own batch (a receipt line brought
// in one lot, step 17b), so it names none. A line on its own names the batch it takes from, like
// any line that takes stock out (the form picks it first to expire, FEFO).
function returnLineRules<T extends ReturnLineFields>(line: T, ctx: z.RefinementCtx<T>): void {
  if (line.receiptLineId !== null && line.batchId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['batchId'],
      message: errorCode('purchase_return_batch_not_allowed'),
    });
  }
}

const purchaseReturnLineInputSchema = stockLineFieldsSchema
  .extend({
    // '' = a line on its own
    receiptLineId: optionalIdSchema,
  })
  .superRefine((line, ctx) => {
    stockLineRules(line, ctx);
    returnLineRules(line, ctx);
  });
export type PurchaseReturnLineInput = z.infer<typeof purchaseReturnLineInputSchema>;
export type PurchaseReturnLineFormValues = z.input<typeof purchaseReturnLineInputSchema>;

const purchaseReturnFieldsSchema = z.object({
  supplierId: z.uuid(errorCode('purchase_supplier_required')),
  date: z.iso.date(errorCode('stock_date_required')),
  // The receipt's warehouse at first; the goods may have been moved since
  warehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  reason: z.enum(RETURN_REASONS),
  note: optionalText(300),
  lines: z
    .array(purchaseReturnLineInputSchema)
    .min(1, errorCode('stock_lines_required'))
    .max(MAX_STOCK_LINES),
  // true = "Post": save and post in one step, or nothing at all
  post: z.boolean(),
});

type PurchaseReturnRuleInput = z.output<typeof purchaseReturnFieldsSchema>;

// A receipt line once per return: it has one batch, so a second line for it has no reason to
// exist, and how much can still go back is easier to read on one line
function purchaseReturnRules(
  input: PurchaseReturnRuleInput,
  ctx: z.RefinementCtx<PurchaseReturnRuleInput>,
) {
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    if (line.receiptLineId === null) return;
    if (seen.has(line.receiptLineId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'receiptLineId'],
        message: errorCode('purchase_return_line_twice'),
      });
    }
    seen.add(line.receiptLineId);
  });
  documentSerialRules(input, ctx);
}

export const purchaseReturnInputSchema =
  purchaseReturnFieldsSchema.superRefine(purchaseReturnRules);
export type PurchaseReturnInput = z.infer<typeof purchaseReturnInputSchema>;

export const updatePurchaseReturnInputSchema = purchaseReturnFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(purchaseReturnRules);
export type UpdatePurchaseReturnInput = z.infer<typeof updatePurchaseReturnInputSchema>;
export type PurchaseReturnFormValues = z.input<typeof updatePurchaseReturnInputSchema>;

export const purchaseReturnVersionInputSchema = z.object({ version: versionSchema });

export const deletePurchaseReturnQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const purchaseReturnListQuerySchema = pageQuerySchema.extend({
  status: z.enum(STOCK_DOCUMENT_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
});
export type PurchaseReturnListQuery = z.input<typeof purchaseReturnListQuerySchema>;

export const purchaseReturnPageSchema = pageOf(purchaseReturnSummarySchema);
export type PurchaseReturnPage = z.infer<typeof purchaseReturnPageSchema>;

const purchaseReturnParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every stock document. Writing and posting need
// purchase.return.manage: the store keeper who loads the goods back on the supplier's truck.
export const purchaseReturnRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/purchase-returns',
    summary: 'Purchase returns, newest date first',
    auth: 'bearer',
    status: 200,
    query: purchaseReturnListQuerySchema,
    response: purchaseReturnPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/purchase-returns/:id',
    summary: 'One purchase return with its lines',
    auth: 'bearer',
    status: 200,
    params: purchaseReturnParamsSchema,
    response: purchaseReturnSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/purchase-returns',
    summary: 'Write a purchase return as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'purchase.return.manage',
    status: 201,
    body: purchaseReturnInputSchema,
    response: purchaseReturnSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/purchase-returns/:id',
    summary: 'Change a draft purchase return, and optionally post it',
    auth: 'bearer',
    permission: 'purchase.return.manage',
    status: 200,
    params: purchaseReturnParamsSchema,
    body: updatePurchaseReturnInputSchema,
    response: purchaseReturnSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/purchase-returns/:id',
    summary: 'Delete a draft purchase return',
    auth: 'bearer',
    permission: 'purchase.return.manage',
    status: 204,
    params: purchaseReturnParamsSchema,
    query: deletePurchaseReturnQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/purchase-returns/:id/post',
    summary:
      'Post a draft purchase return: it gets its number, takes the stock out and books its cost',
    auth: 'bearer',
    permission: 'purchase.return.manage',
    status: 200,
    params: purchaseReturnParamsSchema,
    body: purchaseReturnVersionInputSchema,
    response: purchaseReturnSchema,
  }),
};
