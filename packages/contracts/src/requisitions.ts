import { z } from 'zod';

import { documentApprovalSchema } from './approvals.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { isMoneyAmount, multiplyMoney, sumMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { MAX_PURCHASE_LINES } from './purchase.js';
import { isQuantity, quantitySchema } from './quantities.js';
import { documentRefSchema } from './sales.js';
import { optionalDateSchema, stockUnitSchema, variantRefSchema } from './stock.js';

// A purchase requisition (step 17a): a request from inside the company to buy, before any supplier
// is asked. A store keeper in the Gazipur factory asks for 40 rolls of 220 GSM fabric; a pharmacy
// branch asks for its monthly medicines. It names the warehouse the goods are for and roughly what
// they will cost, so the right person can approve it. It moves no stock and posts nothing.
//
// It is numbered as soon as it is saved (PR-2026-27-0001), like a quotation: people refer to it
// while it waits. draft: being written, or sent back by a rejection · pending: submitted, waiting
// for approval · approved: may be ordered · closed: approved and partly ordered, and the rest will
// not be (step 17b) · cancelled: will not be bought.
export const REQUISITION_STATUSES = [
  'draft',
  'pending',
  'approved',
  'closed',
  'cancelled',
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

// How much of an approved requisition purchase orders took (step 17b, you chose this): a buyer
// orders its lines from different suppliers, and one order may buy for several requisitions, line
// by line. A line counts as ordered by the purchase orders that point at it: in full while the
// order is open, only what came in once the order is closed (the rest is still wanted), nothing
// once it is cancelled. ordered = every line ordered in full or more.
export const REQUISITION_ORDER_STATES = ['not_ordered', 'partly_ordered', 'ordered'] as const;
export type RequisitionOrderState = (typeof REQUISITION_ORDER_STATES)[number];

// ---------------------------------------------------------------------------------------------
// The arithmetic

// What a line is worth: quantity × estimated cost, to the paisa (multiplyMoney rounds once)
export function requisitionLineAmount(quantity: string, estimatedCost: string): string {
  return multiplyMoney(quantity, estimatedCost);
}

// The same while the line is being typed: null until both boxes hold a complete value, so the
// form's total never throws on "1." or an empty cost
export function draftRequisitionLineAmount(quantity: string, estimatedCost: string): string | null {
  const q = quantity.trim();
  const cost = estimatedCost.trim();
  return isQuantity(q) && isMoneyAmount(cost) ? requisitionLineAmount(q, cost) : null;
}

// The requisition's amount: the sum of its lines, each already rounded. The approval levels are
// chosen by this number.
export function requisitionAmount(
  lines: readonly { quantity: string; estimatedCost: string }[],
): string {
  return sumMoney(lines.map((line) => requisitionLineAmount(line.quantity, line.estimatedCost)));
}

// ---------------------------------------------------------------------------------------------
// What the API sends

const personSchema = z.object({ id: z.uuid(), name: z.string() });

export const requisitionSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  // When the goods are needed; null = no date given
  neededBy: z.iso.date().nullable(),
  // Where the goods are for. Its branch is the requisition's branch.
  warehouseId: z.uuid(),
  status: z.enum(REQUISITION_STATUSES),
  // not_ordered for every status but approved and closed
  orderState: z.enum(REQUISITION_ORDER_STATES),
  // The sum of the lines' estimated amounts
  amount: z.string(),
  lineCount: z.number().int(),
  // Who wrote it
  requestedBy: personSchema,
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type RequisitionSummary = z.infer<typeof requisitionSummarySchema>;

export const requisitionLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  // 'goods' or 'service': a repair or a service contract can be requested too
  productType: z.string(),
  units: z.array(stockUnitSchema),
  unitId: z.uuid(),
  quantity: z.string(),
  baseQuantity: z.string(),
  // What the person typed, or the product's name with its variant's options
  description: z.string(),
  // Per one of the unit, 4 decimals
  estimatedCost: z.string(),
  // requisitionLineAmount() when it was saved
  amount: z.string(),
  // In the base unit, by purchase orders (see REQUISITION_ORDER_STATES); may pass baseQuantity
  orderedQuantity: z.string(),
});
export type RequisitionLine = z.infer<typeof requisitionLineSchema>;

export const requisitionSchema = requisitionSummarySchema.extend({
  note: z.string().nullable(),
  lines: z.array(requisitionLineSchema),
  // Every time it was submitted, newest first; no rounds while it was never submitted
  approval: documentApprovalSchema,
  // The purchase orders that buy for it, cancelled ones left out (step 17b)
  orders: z.array(documentRefSchema),
});
export type Requisition = z.infer<typeof requisitionSchema>;

// A requisition line still to order, as the purchase order form offers it (step 17b): what a buyer
// picks from, across the approved requisitions of one warehouse
export const openRequisitionLineSchema = requisitionLineSchema.extend({
  requisition: z.object({
    id: z.uuid(),
    number: z.string(),
    date: z.iso.date(),
    neededBy: z.iso.date().nullable(),
  }),
  // baseQuantity − orderedQuantity, in the base unit: always more than zero here
  remainingQuantity: z.string(),
});
export type OpenRequisitionLine = z.infer<typeof openRequisitionLineSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// The cost a person expects to pay, per one of the line's unit. The form fills it in from the
// cost lookup (purchase.ts); an empty box is a cost nobody typed. ৳0 is a cost (a free sample).
const estimatedCostSchema = z
  .string()
  .trim()
  .refine((value) => value !== '', errorCode('requisition_cost_required'))
  .refine((value) => value === '' || isMoneyAmount(value), errorCode('money_format'));

export const requisitionLineInputSchema = z.object({
  variantId: z.uuid(errorCode('stock_variant_required')),
  // The base unit or one of the product's packs; the quantity and the cost are per this unit
  unitId: z.uuid(errorCode('stock_unit_invalid')),
  quantity: quantitySchema,
  // null = the product's name with its variant's options
  description: optionalText(300),
  estimatedCost: estimatedCostSchema,
});
export type RequisitionLineInput = z.infer<typeof requisitionLineInputSchema>;
export type RequisitionLineFormValues = z.input<typeof requisitionLineInputSchema>;

const requisitionFieldsSchema = z.object({
  date: z.iso.date(errorCode('purchase_date_required')),
  warehouseId: z.uuid(errorCode('purchase_warehouse_required')),
  neededBy: optionalDateSchema,
  note: optionalText(500),
  lines: z
    .array(requisitionLineInputSchema)
    .min(1, errorCode('purchase_lines_required'))
    .max(MAX_PURCHASE_LINES),
});

type RequisitionRuleInput = z.output<typeof requisitionFieldsSchema>;

// Goods cannot be needed before they were asked for. ISO dates compare as strings.
function requisitionRules(input: RequisitionRuleInput, ctx: z.RefinementCtx<RequisitionRuleInput>) {
  if (input.neededBy !== null && input.neededBy < input.date) {
    ctx.addIssue({
      code: 'custom',
      path: ['neededBy'],
      message: errorCode('requisition_needed_by'),
    });
  }
}

export const requisitionInputSchema = requisitionFieldsSchema.superRefine(requisitionRules);
export type RequisitionInput = z.infer<typeof requisitionInputSchema>;

export const updateRequisitionInputSchema = requisitionFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(requisitionRules);
export type UpdateRequisitionInput = z.infer<typeof updateRequisitionInputSchema>;
export type RequisitionFormValues = z.input<typeof updateRequisitionInputSchema>;

export const requisitionVersionInputSchema = z.object({ version: versionSchema });

export const deleteRequisitionQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// to_order: approved, with a line not ordered in full yet (step 17b)
export const REQUISITION_ORDER_FILTERS = ['to_order'] as const;
export type RequisitionOrderFilter = (typeof REQUISITION_ORDER_FILTERS)[number];

export const requisitionListQuerySchema = pageQuerySchema.extend({
  status: z.enum(REQUISITION_STATUSES).optional(),
  warehouseId: z.uuid().optional(),
  order: z.enum(REQUISITION_ORDER_FILTERS).optional(),
});
export type RequisitionListQuery = z.input<typeof requisitionListQuerySchema>;

export const requisitionPageSchema = pageOf(requisitionSummarySchema);
export type RequisitionPage = z.infer<typeof requisitionPageSchema>;

// The lines a purchase order for this warehouse may buy for, oldest requisition first (the most
// overdue request at the top). search matches the requisition's number, the product's name, code
// and SKU. requisitionId narrows it to one: "Make purchase order" on a requisition's page.
export const openRequisitionLineQuerySchema = pageQuerySchema.extend({
  warehouseId: z.uuid(),
  requisitionId: z.uuid().optional(),
  search: z.string().trim().max(100).optional(),
});
export type OpenRequisitionLineQuery = z.input<typeof openRequisitionLineQuerySchema>;

export const openRequisitionLinePageSchema = pageOf(openRequisitionLineSchema);
export type OpenRequisitionLinePage = z.infer<typeof openRequisitionLinePageSchema>;

const requisitionParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every other document. Writing, submitting, reopening and
// cancelling need purchase.requisition.manage; approving needs the level's role (approvals.ts).
export const requisitionRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/requisitions',
    summary: 'Purchase requisitions, newest date first',
    auth: 'bearer',
    status: 200,
    query: requisitionListQuerySchema,
    response: requisitionPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/requisitions/:id',
    summary: 'One requisition with its lines and its approval history',
    auth: 'bearer',
    status: 200,
    params: requisitionParamsSchema,
    response: requisitionSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/requisitions',
    summary: 'Write a requisition; it gets its number at once and stays a draft',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 201,
    body: requisitionInputSchema,
    response: requisitionSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/requisitions/:id',
    summary: 'Change a draft requisition',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 200,
    params: requisitionParamsSchema,
    body: updateRequisitionInputSchema,
    response: requisitionSchema,
  }),
  // A draft that was ever submitted keeps its approval history: it is cancelled, not deleted
  remove: defineRoute({
    method: 'DELETE',
    path: '/requisitions/:id',
    summary: 'Delete a draft requisition that was never submitted',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 204,
    params: requisitionParamsSchema,
    query: deleteRequisitionQuerySchema,
    response: z.void(),
  }),
  // The levels its amount reaches are copied onto a new round; with none it is approved at once
  submit: defineRoute({
    method: 'POST',
    path: '/requisitions/:id/submit',
    summary: 'Send a draft requisition for approval',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 200,
    params: requisitionParamsSchema,
    body: requisitionVersionInputSchema,
    response: requisitionSchema,
  }),
  // Pending: taken back to change it. Approved: changed after all, and approved again from step 1;
  // refused once a purchase order buys for it (step 17b).
  reopen: defineRoute({
    method: 'POST',
    path: '/requisitions/:id/reopen',
    summary: 'Take a pending or approved requisition back to draft',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 200,
    params: requisitionParamsSchema,
    body: requisitionVersionInputSchema,
    response: requisitionSchema,
  }),
  // Refused once a purchase order buys for it: close it instead
  cancel: defineRoute({
    method: 'POST',
    path: '/requisitions/:id/cancel',
    summary: 'Cancel a draft or approved requisition: it will not be bought',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 200,
    params: requisitionParamsSchema,
    body: requisitionVersionInputSchema,
    response: requisitionSchema,
  }),
  // Step 17b: the rest of a partly ordered requisition will not be bought
  close: defineRoute({
    method: 'POST',
    path: '/requisitions/:id/close',
    summary: 'Stop ordering a partly ordered requisition',
    auth: 'bearer',
    permission: 'purchase.requisition.manage',
    status: 200,
    params: requisitionParamsSchema,
    body: requisitionVersionInputSchema,
    response: requisitionSchema,
  }),
};

// Reading needs no permission, like the requisitions themselves
export const requisitionLineRoutes = {
  open: defineRoute({
    method: 'GET',
    path: '/requisition-lines',
    summary: 'Lines of approved requisitions still to order, for one warehouse',
    auth: 'bearer',
    status: 200,
    query: openRequisitionLineQuerySchema,
    response: openRequisitionLinePageSchema,
  }),
};
