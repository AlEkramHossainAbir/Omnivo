import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { subtractQuantity } from './quantities.js';
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

// A delivery (the delivery challan that goes with the truck) takes goods out of a warehouse for a
// customer. Like a stock adjustment: a draft can be changed, "Post" gives it its number
// (DC-2026-27-0001), takes the stock out and books what it cost (you chose this: cost of goods
// sold at delivery, at the moving average cost of step 14). A posted delivery is not changed;
// what comes back is a sales return (sales-returns.ts, step 15d).
//
// It is made from a confirmed order (its lines point at the order's lines, and an order is
// delivered in as many deliveries as it takes), or on its own, for a customer who collects goods
// without an order. Its lines carry no prices: the invoice (15c) prices them.

// How much of a posted delivery is billed (step 15c). An invoice bills each of its lines whole,
// so a delivery is partly invoiced only when an invoice left some of its lines out. A draft is
// not_invoiced. A line that came back in full before it was billed (step 15d) has nothing left to
// bill, so it does not count either way.
export const DELIVERY_INVOICE_STATES = ['not_invoiced', 'partly_invoiced', 'invoiced'] as const;
export type DeliveryInvoiceState = (typeof DELIVERY_INVOICE_STATES)[number];

// How much of a posted delivery came back on posted sales returns (step 15d): nothing, some of it,
// or every line in full
export const DELIVERY_RETURN_STATES = ['none', 'partly_returned', 'returned'] as const;
export type DeliveryReturnState = (typeof DELIVERY_RETURN_STATES)[number];

// What an invoice bills on a challan line, in the base unit: what left, less what came back before
// it was billed (step 15d). An invoice line that bills the line must have exactly this quantity.
export function billableQuantity(line: { baseQuantity: string; returnedQuantity: string }): string {
  return subtractQuantity(line.baseQuantity, line.returnedQuantity);
}

// ---------------------------------------------------------------------------------------------
// What the API sends

export const deliverySummarySchema = z.object({
  id: z.uuid(),
  // null while a draft: given when it is posted, so posted numbers have no gaps
  number: z.string().nullable(),
  date: z.iso.date(),
  customer: partyRefSchema,
  order: documentRefSchema.nullable(),
  warehouseId: z.uuid(),
  status: z.enum(STOCK_DOCUMENT_STATUSES),
  // The address it went to, as it was written on the challan
  shippingAddress: z.string().nullable(),
  // The truck or van and its driver: "Dhaka Metro-Ta 11-2233, Rahim"
  vehicle: z.string().nullable(),
  note: z.string().nullable(),
  lineCount: z.number().int(),
  invoiceState: z.enum(DELIVERY_INVOICE_STATES),
  returnState: z.enum(DELIVERY_RETURN_STATES),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type DeliverySummary = z.infer<typeof deliverySummarySchema>;

export const deliveryLineSchema = stockLineSchema.extend({
  // The order line this line delivers (null on a delivery without an order). Two lines may point
  // at the same order line: one batch ran out and the rest came from the next.
  orderLineId: z.uuid().nullable(),
  // What the goods cost, once posted (step 14); null for a draft, and without inventory.stock.value
  value: z.string().nullable(),
  // Billed by a posted invoice (step 15c)
  invoiced: z.boolean(),
  // What came back on posted sales returns, in the base unit (step 15d). baseQuantity −
  // returnedQuantity can still come back.
  returnedQuantity: z.string(),
});
export type DeliveryLine = z.infer<typeof deliveryLineSchema>;

export const deliverySchema = deliverySummarySchema.extend({
  shippingAddressId: z.uuid().nullable(),
  lines: z.array(deliveryLineSchema),
  // The cost of goods sold entry; null for a draft, or when the goods cost nothing in the books
  entry: entryRefSchema.nullable(),
  // The posted invoices that bill its lines (step 15c); a direct invoice's own delivery has one
  invoices: z.array(documentRefSchema),
  // The posted sales returns that brought some of its goods back (step 15d)
  returns: z.array(documentRefSchema),
});
export type Delivery = z.infer<typeof deliverySchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

const deliveryLineInputSchema = stockLineFieldsSchema
  .extend({ orderLineId: optionalIdSchema })
  .superRefine(stockLineRules);

const deliveryFieldsSchema = z.object({
  customerId: z.uuid(errorCode('sales_customer_required')),
  // '' = a delivery without an order
  orderId: optionalIdSchema,
  date: z.iso.date(errorCode('stock_date_required')),
  warehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  shippingAddressId: optionalIdSchema,
  vehicle: optionalText(80),
  note: optionalText(300),
  lines: z
    .array(deliveryLineInputSchema)
    .min(1, errorCode('stock_lines_required'))
    .max(MAX_STOCK_LINES),
  // true = "Post": save and post in one step, or nothing at all
  post: z.boolean(),
});

type DeliveryRuleInput = z.output<typeof deliveryFieldsSchema>;

function deliveryRules(input: DeliveryRuleInput, ctx: z.RefinementCtx<DeliveryRuleInput>) {
  // A delivery from an order delivers the order's lines, and nothing else: an extra item would be
  // a sale nobody ordered. One without an order has no order lines to point at.
  input.lines.forEach((line, index) => {
    if (input.orderId !== null && line.orderLineId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'orderLineId'],
        message: errorCode('delivery_order_line_required'),
      });
    }
    if (input.orderId === null && line.orderLineId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'orderLineId'],
        message: errorCode('delivery_order_line_invalid'),
      });
    }
  });
  documentSerialRules(input, ctx);
}

export const deliveryInputSchema = deliveryFieldsSchema.superRefine(deliveryRules);
export type DeliveryInput = z.infer<typeof deliveryInputSchema>;

export const updateDeliveryInputSchema = deliveryFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(deliveryRules);
export type UpdateDeliveryInput = z.infer<typeof updateDeliveryInputSchema>;
export type DeliveryFormValues = z.input<typeof updateDeliveryInputSchema>;

export const deliveryVersionInputSchema = z.object({ version: versionSchema });

export const deleteDeliveryQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// to_invoice: posted, with a line no posted invoice bills yet and that did not all come back —
// what the invoice form offers
export const DELIVERY_INVOICE_FILTERS = ['to_invoice', 'invoiced'] as const;
export type DeliveryInvoiceFilter = (typeof DELIVERY_INVOICE_FILTERS)[number];

// returnable: posted, with a line that has not all come back yet — what the return form offers
// (step 15d)
export const DELIVERY_RETURN_FILTERS = ['returnable'] as const;
export type DeliveryReturnFilter = (typeof DELIVERY_RETURN_FILTERS)[number];

export const deliveryListQuerySchema = pageQuerySchema.extend({
  status: z.enum(STOCK_DOCUMENT_STATUSES).optional(),
  customerId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  invoice: z.enum(DELIVERY_INVOICE_FILTERS).optional(),
  return: z.enum(DELIVERY_RETURN_FILTERS).optional(),
});
export type DeliveryListQuery = z.input<typeof deliveryListQuerySchema>;

export const deliveryPageSchema = pageOf(deliverySummarySchema);
export type DeliveryPage = z.infer<typeof deliveryPageSchema>;

const deliveryParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every stock document. Writing and posting need
// sales.delivery.manage: the store keeper who loads the truck.
export const deliveryRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/deliveries',
    summary: 'Deliveries, newest date first',
    auth: 'bearer',
    status: 200,
    query: deliveryListQuerySchema,
    response: deliveryPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/deliveries/:id',
    summary: 'One delivery with its lines',
    auth: 'bearer',
    status: 200,
    params: deliveryParamsSchema,
    response: deliverySchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/deliveries',
    summary: 'Write a delivery as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'sales.delivery.manage',
    status: 201,
    body: deliveryInputSchema,
    response: deliverySchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/deliveries/:id',
    summary: 'Change a draft delivery, and optionally post it',
    auth: 'bearer',
    permission: 'sales.delivery.manage',
    status: 200,
    params: deliveryParamsSchema,
    body: updateDeliveryInputSchema,
    response: deliverySchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/deliveries/:id',
    summary: 'Delete a draft delivery',
    auth: 'bearer',
    permission: 'sales.delivery.manage',
    status: 204,
    params: deliveryParamsSchema,
    query: deleteDeliveryQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/deliveries/:id/post',
    summary: 'Post a draft delivery: it gets its number, takes the stock out and books its cost',
    auth: 'bearer',
    permission: 'sales.delivery.manage',
    status: 200,
    params: deliveryParamsSchema,
    body: deliveryVersionInputSchema,
    response: deliverySchema,
  }),
};
