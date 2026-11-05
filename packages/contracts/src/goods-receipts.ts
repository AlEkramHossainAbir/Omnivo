import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { DELIVERY_RETURN_STATES } from './deliveries.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import {
  addQuantity,
  isQuantityOrZero,
  isZeroQuantity,
  receivedQuantitySchema,
  subtractQuantity,
} from './quantities.js';
import { documentRefSchema } from './sales.js';
import { STOCK_DOCUMENT_STATUSES } from './stock-adjustments.js';
import {
  documentSerialRules,
  MAX_STOCK_LINES,
  stockInLineFieldsSchema,
  stockLineRules,
  stockLineSchema,
} from './stock.js';

// A goods receipt (GRN, step 17b): what a supplier's truck brought in against a purchase order.
// The store keeper counts it at the gate: what came, and what was turned back (torn rolls, a
// carton of broken bottles, the wrong shade). Like a delivery: a draft can be changed, "Post"
// gives it its number (GRN-2026-27-0001), brings the accepted goods into stock and books them at
// the order's price (you chose this): Dr Inventory / Cr Goods received not billed, and the moving
// average cost (step 14) takes them in at that price. The supplier's bill (17c) later moves the
// amount to the payable. A posted receipt is not changed: what goes back to the supplier after
// that is a purchase return (17d).
//
// A person always makes it from an approved order (you chose this): its lines point at the order's
// goods lines, and an order is received in as many receipts as the supplier needs. The receipt
// carries no prices: the order line has them, so the person at the gate never types one.
//
// The other kind is made by a supplier's bill (step 17c): a bill's goods line of its own (a
// purchase without an order) is received by a goods receipt the bill posts in the same
// transaction. It has no order, its lines no order line, and it is valued at the bill's price.

// How much of a posted receipt the supplier's bills bill (step 17c). A bill bills each of its lines
// whole, so a receipt is partly billed only when a bill left some of its lines out. A draft is
// not_billed. A line that accepted nothing, or whose goods all went back before a bill billed them
// (step 17d), has nothing to bill and does not count either way.
export const GRN_BILL_STATES = ['not_billed', 'partly_billed', 'billed'] as const;
export type GrnBillState = (typeof GRN_BILL_STATES)[number];

// How much of a posted receipt went back to the supplier on posted purchase returns (step 17d), the
// challan's words: nothing, some of it, all it accepted
export const GRN_RETURN_STATES = DELIVERY_RETURN_STATES;
export type GrnReturnState = (typeof GRN_RETURN_STATES)[number];

// What the company kept of a line, in the base unit: what was accepted less what purchase returns
// sent back (step 17d). It is what can still go back, and, while no bill billed the line, what a
// bill bills: a return before the bill means the supplier is never billed for those goods.
export function keptQuantity(line: { baseQuantity: string; returnedQuantity: string }): string {
  return subtractQuantity(line.baseQuantity, line.returnedQuantity);
}

// What came off the truck for a line: what was accepted (and goes into stock) plus what was turned
// back. The form shows it under the two boxes; a person counting at the gate thinks in it.
export function receivedOf(line: { quantity: string; rejectedQuantity: string }): string {
  return addQuantity(line.quantity, line.rejectedQuantity);
}

// ---------------------------------------------------------------------------------------------
// What the API sends

export const goodsReceiptSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft: given when it is posted, so posted numbers have no gaps
  number: z.string().nullable(),
  date: z.iso.date(),
  supplier: partyRefSchema,
  // null for a receipt a bill made (step 17c)
  order: documentRefSchema.nullable(),
  // The bill that made it; null for a receipt a person made from an order
  bill: documentRefSchema.nullable(),
  warehouseId: z.uuid(),
  status: z.enum(STOCK_DOCUMENT_STATUSES),
  // The number on the supplier's delivery challan, as it was handed over at the gate: the bill
  // (17c) and any claim quote it
  supplierChallan: z.string().nullable(),
  // The truck and its driver: "Dhaka Metro-Ta 11-2233, Rahim"
  vehicle: z.string().nullable(),
  note: z.string().nullable(),
  lineCount: z.number().int(),
  billState: z.enum(GRN_BILL_STATES),
  returnState: z.enum(GRN_RETURN_STATES),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type GoodsReceiptSummary = z.infer<typeof goodsReceiptSummarySchema>;

// quantity and baseQuantity (from stockLineSchema) are what was accepted: what came into stock
export const goodsReceiptLineSchema = stockLineSchema.extend({
  // The order line it receives. Two lines may point at the same order line: two lots of the same
  // fabric on one truck. null on a receipt a bill made.
  orderLineId: z.uuid().nullable(),
  // What was turned back, in the line's unit and in the base unit; '0.0000' for none
  rejectedQuantity: z.string(),
  rejectedBaseQuantity: z.string(),
  // Why it was turned back; null when nothing was
  rejectionReason: z.string().nullable(),
  // What the accepted goods were booked at (the order's net price), once posted. null for a
  // draft, and without inventory.stock.value.
  value: z.string().nullable(),
  // Billed by a posted bill (step 17c)
  billed: z.boolean(),
  // What went back on posted purchase returns, in the base unit (step 17d), before the bill or
  // after it. keptQuantity() is what stayed.
  returnedQuantity: z.string(),
});
export type GoodsReceiptLine = z.infer<typeof goodsReceiptLineSchema>;

export const goodsReceiptSchema = goodsReceiptSummarySchema.extend({
  lines: z.array(goodsReceiptLineSchema),
  // The stock entry; null for a draft, or when the accepted goods cost nothing (a free sample, or
  // a receipt that turned everything back)
  entry: entryRefSchema.nullable(),
  // The posted bills that bill its lines (step 17c); a receipt a bill made has that one
  bills: z.array(documentRefSchema),
  // The posted purchase returns that sent some of its goods back (step 17d)
  returns: z.array(documentRefSchema),
});
export type GoodsReceipt = z.infer<typeof goodsReceiptSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// '' (an empty box) is nothing turned back
const rejectedQuantitySchema = z
  .string()
  .trim()
  .transform((value) => (value === '' ? '0' : value))
  .pipe(receivedQuantitySchema);

// A line brings stock in, so it says which lot the goods are, like an adjustment "in" (step 13).
// quantity is what was accepted, and it may be 0 when everything was turned back.
const goodsReceiptLineFieldsSchema = stockInLineFieldsSchema.extend({
  quantity: receivedQuantitySchema,
  orderLineId: z.uuid(errorCode('grn_order_line_invalid')),
  rejectedQuantity: rejectedQuantitySchema,
  rejectionReason: optionalText(200),
});

type GoodsReceiptLineRuleInput = z.output<typeof goodsReceiptLineFieldsSchema>;

function goodsReceiptLineRules(
  line: GoodsReceiptLineRuleInput,
  ctx: z.RefinementCtx<GoodsReceiptLineRuleInput>,
) {
  stockLineRules(line, ctx);
  // The boxes are checked by their own schemas; with a bad one there is nothing to compare yet
  if (!isQuantityOrZero(line.quantity) || !isQuantityOrZero(line.rejectedQuantity)) return;
  const nothingAccepted = isZeroQuantity(line.quantity);
  const nothingRejected = isZeroQuantity(line.rejectedQuantity);
  // A line where nothing came is a line nobody needed. A line may accept nothing when everything
  // that came was turned back: it stays, because the rejection is on the record.
  if (nothingAccepted && nothingRejected) {
    ctx.addIssue({ code: 'custom', path: ['quantity'], message: errorCode('grn_line_empty') });
  }
  // A rejection says why: the supplier will ask, and a claim needs it
  if (!nothingRejected && line.rejectionReason === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['rejectionReason'],
      message: errorCode('grn_rejection_reason'),
    });
  }
}

export const goodsReceiptLineInputSchema =
  goodsReceiptLineFieldsSchema.superRefine(goodsReceiptLineRules);
export type GoodsReceiptLineInput = z.infer<typeof goodsReceiptLineInputSchema>;
export type GoodsReceiptLineFormValues = z.input<typeof goodsReceiptLineInputSchema>;

const goodsReceiptFieldsSchema = z.object({
  orderId: z.uuid(errorCode('grn_order_invalid')),
  date: z.iso.date(errorCode('stock_date_required')),
  // The order's warehouse at first; the truck may unload at another one
  warehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  supplierChallan: optionalText(40),
  vehicle: optionalText(80),
  note: optionalText(300),
  lines: z
    .array(goodsReceiptLineInputSchema)
    .min(1, errorCode('stock_lines_required'))
    .max(MAX_STOCK_LINES),
  // true = "Post": save and post in one step, or nothing at all
  post: z.boolean(),
});

export const goodsReceiptInputSchema = goodsReceiptFieldsSchema.superRefine(documentSerialRules);
export type GoodsReceiptInput = z.infer<typeof goodsReceiptInputSchema>;

// A receipt keeps its order: the edit form does not send it
export const updateGoodsReceiptInputSchema = goodsReceiptFieldsSchema
  .omit({ orderId: true })
  .extend({ version: versionSchema })
  .superRefine(documentSerialRules);
export type UpdateGoodsReceiptInput = z.infer<typeof updateGoodsReceiptInputSchema>;
export type GoodsReceiptFormValues = z.input<typeof goodsReceiptInputSchema>;

export const goodsReceiptVersionInputSchema = z.object({ version: versionSchema });

export const deleteGoodsReceiptQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// to_bill: posted, with a line that kept something (keptQuantity) and no posted bill bills yet —
// what the bill form offers (step 17c). billed: every such line billed.
export const GRN_BILL_FILTERS = ['to_bill', 'billed'] as const;
export type GrnBillFilter = (typeof GRN_BILL_FILTERS)[number];

// returnable: posted, with a line that still keeps something — what the purchase return form
// offers (step 17d), the challan's filter of 15d
export const GRN_RETURN_FILTERS = ['returnable'] as const;
export type GrnReturnFilter = (typeof GRN_RETURN_FILTERS)[number];

export const goodsReceiptListQuerySchema = pageQuerySchema.extend({
  status: z.enum(STOCK_DOCUMENT_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  bill: z.enum(GRN_BILL_FILTERS).optional(),
  return: z.enum(GRN_RETURN_FILTERS).optional(),
});
export type GoodsReceiptListQuery = z.input<typeof goodsReceiptListQuerySchema>;

export const goodsReceiptPageSchema = pageOf(goodsReceiptSummarySchema);
export type GoodsReceiptPage = z.infer<typeof goodsReceiptPageSchema>;

const goodsReceiptParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every stock document. Writing and posting need
// purchase.receipt.manage: the store keeper at the gate.
export const goodsReceiptRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/goods-receipts',
    summary: 'Goods receipts, newest date first',
    auth: 'bearer',
    status: 200,
    query: goodsReceiptListQuerySchema,
    response: goodsReceiptPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/goods-receipts/:id',
    summary: 'One goods receipt with its lines',
    auth: 'bearer',
    status: 200,
    params: goodsReceiptParamsSchema,
    response: goodsReceiptSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/goods-receipts',
    summary: 'Write a goods receipt against an approved order, as a draft or posted',
    auth: 'bearer',
    permission: 'purchase.receipt.manage',
    status: 201,
    body: goodsReceiptInputSchema,
    response: goodsReceiptSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/goods-receipts/:id',
    summary: 'Change a draft goods receipt, and optionally post it',
    auth: 'bearer',
    permission: 'purchase.receipt.manage',
    status: 200,
    params: goodsReceiptParamsSchema,
    body: updateGoodsReceiptInputSchema,
    response: goodsReceiptSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/goods-receipts/:id',
    summary: 'Delete a draft goods receipt',
    auth: 'bearer',
    permission: 'purchase.receipt.manage',
    status: 204,
    params: goodsReceiptParamsSchema,
    query: deleteGoodsReceiptQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/goods-receipts/:id/post',
    summary: 'Post a draft goods receipt: it gets its number and brings the stock in',
    auth: 'bearer',
    permission: 'purchase.receipt.manage',
    status: 200,
    params: goodsReceiptParamsSchema,
    body: goodsReceiptVersionInputSchema,
    response: goodsReceiptSchema,
  }),
};
