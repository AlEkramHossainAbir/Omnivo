import { z } from 'zod';

import { documentApprovalSchema } from './approvals.js';
import { MAX_PAYMENT_TERMS_DAYS } from './customers.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { MAX_PURCHASE_LINES } from './purchase.js';
import {
  documentRefSchema,
  salesLineFieldsSchema,
  salesLineRules,
  salesLineSchema,
} from './sales.js';
import { optionalDateSchema, optionalIdSchema } from './stock.js';

// A purchase order (step 17b): what the company asks a supplier to deliver, at what price. It is
// written by a buyer, approved like a requisition (approvals.ts, levels by its total), sent to the
// supplier (a PDF, an email or a share link, step 16), and received by goods receipts
// (goods-receipts.ts) in as many deliveries as the supplier makes.
//   draft      being written, or sent back by a rejection or a reopen
//   pending    submitted, waiting for an approval
//   approved   may be sent and received; partlyReceived says whether some of it came already
//   received   every goods line came in full (set by the goods receipt that finished it)
//   closed     partly received, and the rest will not come: the mill delivered 900 of 1,000 m
//   cancelled  will not be bought: a draft that was submitted once, or an approved order before
//              anything was received
// It gets its number (PO-2026-27-0001) when it is first submitted: the approvers and the bell need
// a number to talk about, while a draft nobody submitted is only a page someone is writing, and
// deleting it leaves no gap. Once numbered it is never deleted, only cancelled, so its approval
// history stays (the rule of 17a's requisition).
// Approved is locked. "Reopen" takes it back to draft, and it is approved again from the first
// level (you chose this), until the first goods receipt is written against it: after that, close
// it and write a new order for the rest. Prices are in taka only (you chose this): an import in
// dollars comes with landed cost and the LC, in a later step.
export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'pending',
  'approved',
  'received',
  'closed',
  'cancelled',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const purchaseOrderSummarySchema = z.object({
  id: z.uuid(),
  // null until it is first submitted
  number: z.string().nullable(),
  date: z.iso.date(),
  // When the supplier should deliver; null = not agreed. The page shows a "Late" pill for an
  // approved order past it.
  expectedDate: z.iso.date().nullable(),
  supplier: partyRefSchema,
  // The supplier's own number for this deal: its quotation or proforma invoice (PI-0412)
  supplierReference: z.string().nullable(),
  // Where the goods are to be delivered. Its branch is the order's branch.
  warehouseId: z.uuid(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  // Approved, and some (not all) of it received
  partlyReceived: z.boolean(),
  net: z.string(),
  vat: z.string(),
  // What the approval levels are chosen by: what the company will pay, VAT included
  total: z.string(),
  lineCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type PurchaseOrderSummary = z.infer<typeof purchaseOrderSummarySchema>;

// The requisition line an order line buys for: its id (the form sends it back), and the
// requisition's number for the page's link
export const requisitionLineRefSchema = z.object({
  id: z.uuid(),
  requisitionId: z.uuid(),
  number: z.string(),
});
export type RequisitionLineRef = z.infer<typeof requisitionLineRefSchema>;

// A line is a sales line's shape (sales.ts): the same price, discount and VAT arithmetic (you chose
// this), so the order shows the totals the supplier's bill will show
export const purchaseOrderLineSchema = salesLineSchema.extend({
  requisitionLine: requisitionLineRefSchema.nullable(),
  // In the base unit, by posted goods receipts: what came in and was accepted. It may pass the
  // ordered quantity by the workspace's tolerance (settings.ts). A service line stays at zero: it
  // is never received, the bill (17c) takes it straight from the order.
  receivedQuantity: z.string(),
  // In the base unit, by posted goods receipts: what came and was turned back at the gate. It
  // does not count as received; the supplier still owes it.
  rejectedQuantity: z.string(),
});
export type PurchaseOrderLine = z.infer<typeof purchaseOrderLineSchema>;

// A goods receipt made against the order, as its page lists them
export const orderReceiptSchema = z.object({
  id: z.uuid(),
  number: z.string().nullable(),
  date: z.iso.date(),
  // z.string(): a goods receipt's status (goods-receipts.ts)
  status: z.string(),
});
export type OrderReceipt = z.infer<typeof orderReceiptSchema>;

export const purchaseOrderSchema = purchaseOrderSummarySchema.extend({
  // The supplier's payment terms when the order was written, or what the buyer agreed for this
  // order: the PDF prints it, and the bill (17c) starts from it
  paymentTermsDays: z.number().int(),
  pricesIncludeVat: z.boolean(),
  discount: z.string(),
  // Printed on the order: delivery instructions, packing, the buyer's style number
  note: z.string().nullable(),
  lines: z.array(purchaseOrderLineSchema),
  // The requisitions its lines buy for, by number
  requisitions: z.array(documentRefSchema),
  receipts: z.array(orderReceiptSchema),
  // Every time it was submitted, newest first
  approval: documentApprovalSchema,
});
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// A line from a requisition names its line: the requisition must be approved, for the order's
// warehouse, and the line for the same variant. The unit may differ: the store asked for 480
// pieces, the buyer orders 20 cartons of 24. The quantity may be more than the requisition asked
// for (a mill's minimum order); the order has its own approval.
export const purchaseOrderLineInputSchema = salesLineFieldsSchema
  .extend({ requisitionLineId: optionalIdSchema })
  .superRefine(salesLineRules);
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineInputSchema>;
export type PurchaseOrderLineFormValues = z.input<typeof purchaseOrderLineInputSchema>;

const purchaseOrderFieldsSchema = z.object({
  supplierId: z.uuid(errorCode('purchase_supplier_required')),
  date: z.iso.date(errorCode('purchase_date_required')),
  expectedDate: optionalDateSchema,
  warehouseId: z.uuid(errorCode('purchase_warehouse_required')),
  supplierReference: optionalText(60),
  paymentTermsDays: z.number().int().min(0).max(MAX_PAYMENT_TERMS_DAYS),
  // The form starts it off: a supplier quotes before VAT, so a buyer seldom ticks it
  pricesIncludeVat: z.boolean(),
  note: optionalText(500),
  lines: z
    .array(purchaseOrderLineInputSchema)
    .min(1, errorCode('purchase_lines_required'))
    .max(MAX_PURCHASE_LINES),
});

type PurchaseOrderRuleInput = z.output<typeof purchaseOrderFieldsSchema>;

function purchaseOrderRules(
  input: PurchaseOrderRuleInput,
  ctx: z.RefinementCtx<PurchaseOrderRuleInput>,
) {
  if (input.expectedDate !== null && input.expectedDate < input.date) {
    ctx.addIssue({
      code: 'custom',
      path: ['expectedDate'],
      message: errorCode('purchase_expected_date'),
    });
  }
  // One order line per requisition line: two would count the same request twice
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    if (line.requisitionLineId === null) return;
    if (seen.has(line.requisitionLineId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'requisitionLineId'],
        message: errorCode('purchase_requisition_line_twice'),
      });
    }
    seen.add(line.requisitionLineId);
  });
}

export const purchaseOrderInputSchema = purchaseOrderFieldsSchema.superRefine(purchaseOrderRules);
export type PurchaseOrderInput = z.infer<typeof purchaseOrderInputSchema>;

export const updatePurchaseOrderInputSchema = purchaseOrderFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(purchaseOrderRules);
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderInputSchema>;
export type PurchaseOrderFormValues = z.input<typeof updatePurchaseOrderInputSchema>;

export const purchaseOrderVersionInputSchema = z.object({ version: versionSchema });

export const deletePurchaseOrderQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// to_receive: approved, with a goods line that has not all come in — what the goods receipt form
// offers
export const PURCHASE_ORDER_RECEIPT_FILTERS = ['to_receive'] as const;
export type PurchaseOrderReceiptFilter = (typeof PURCHASE_ORDER_RECEIPT_FILTERS)[number];

export const purchaseOrderListQuerySchema = pageQuerySchema.extend({
  status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  receipt: z.enum(PURCHASE_ORDER_RECEIPT_FILTERS).optional(),
});
export type PurchaseOrderListQuery = z.input<typeof purchaseOrderListQuerySchema>;

export const purchaseOrderPageSchema = pageOf(purchaseOrderSummarySchema);
export type PurchaseOrderPage = z.infer<typeof purchaseOrderPageSchema>;

const purchaseOrderParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every other document. Writing, submitting, reopening, closing
// and cancelling need purchase.order.manage; approving needs the level's role (approvals.ts).
export const purchaseOrderRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/purchase-orders',
    summary: 'Purchase orders, newest date first',
    auth: 'bearer',
    status: 200,
    query: purchaseOrderListQuerySchema,
    response: purchaseOrderPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/purchase-orders/:id',
    summary: 'One purchase order with its lines, receipts and approval history',
    auth: 'bearer',
    status: 200,
    params: purchaseOrderParamsSchema,
    response: purchaseOrderSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/purchase-orders',
    summary: 'Write a purchase order as a draft',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 201,
    body: purchaseOrderInputSchema,
    response: purchaseOrderSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/purchase-orders/:id',
    summary: 'Change a draft purchase order',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 200,
    params: purchaseOrderParamsSchema,
    body: updatePurchaseOrderInputSchema,
    response: purchaseOrderSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/purchase-orders/:id',
    summary: 'Delete a draft purchase order that was never submitted',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 204,
    params: purchaseOrderParamsSchema,
    query: deletePurchaseOrderQuerySchema,
    response: z.void(),
  }),
  // The first submit gives the number. With no level for its total it is approved at once.
  submit: defineRoute({
    method: 'POST',
    path: '/purchase-orders/:id/submit',
    summary: 'Send a draft purchase order for approval',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 200,
    params: purchaseOrderParamsSchema,
    body: purchaseOrderVersionInputSchema,
    response: purchaseOrderSchema,
  }),
  reopen: defineRoute({
    method: 'POST',
    path: '/purchase-orders/:id/reopen',
    summary: 'Take a pending or approved order with no goods receipt back to draft',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 200,
    params: purchaseOrderParamsSchema,
    body: purchaseOrderVersionInputSchema,
    response: purchaseOrderSchema,
  }),
  close: defineRoute({
    method: 'POST',
    path: '/purchase-orders/:id/close',
    summary: 'Stop receiving a partly received order',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 200,
    params: purchaseOrderParamsSchema,
    body: purchaseOrderVersionInputSchema,
    response: purchaseOrderSchema,
  }),
  cancel: defineRoute({
    method: 'POST',
    path: '/purchase-orders/:id/cancel',
    summary: 'Cancel a draft order, or an approved one that received nothing',
    auth: 'bearer',
    permission: 'purchase.order.manage',
    status: 200,
    params: purchaseOrderParamsSchema,
    body: purchaseOrderVersionInputSchema,
    response: purchaseOrderSchema,
  }),
};
