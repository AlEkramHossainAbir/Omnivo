import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { documentRefSchema, salesDocumentFieldsSchema, salesLineSchema } from './sales.js';
import { optionalDateSchema, optionalIdSchema } from './stock.js';

// A sales order is what the customer agreed to buy. A draft can be changed; "Confirm" gives it its
// number (SO-2026-27-0001) and from then on deliveries take goods against it. Nothing is held in
// the warehouse for it (you chose this): the stock page shows what confirmed orders still have to
// deliver, next to what is on hand.
//   draft      being written; no number
//   confirmed  waiting for deliveries, or partly delivered
//   delivered  every goods line delivered in full (set by the delivery that finished it)
//   closed     partly delivered, and the rest will not be: the customer took what was there
//   cancelled  confirmed, then called off before anything was delivered
// A confirmed order with no delivery at all (not even a draft one) can go back to draft to be
// changed; it keeps its number. A partly delivered order is not changed: close it and write a new
// one for the rest.
export const ORDER_STATUSES = ['draft', 'confirmed', 'delivered', 'closed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const salesOrderSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft
  number: z.string().nullable(),
  date: z.iso.date(),
  // When the customer expects the goods; null = not agreed
  deliveryDate: z.iso.date().nullable(),
  customer: partyRefSchema,
  // The customer's own number for this order: a buyer's PO number, a pharmacy's indent number
  customerReference: z.string().nullable(),
  // Where the goods are sent from, by default; a delivery may take them from another warehouse
  warehouseId: z.uuid(),
  status: z.enum(ORDER_STATUSES),
  // Confirmed, and some (not all) of it delivered
  partlyDelivered: z.boolean(),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  lineCount: z.number().int(),
  confirmedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type SalesOrderSummary = z.infer<typeof salesOrderSummarySchema>;

export const salesOrderLineSchema = salesLineSchema.extend({
  // In the base unit, by posted deliveries. A service line stays at zero: it is never delivered.
  deliveredQuantity: z.string(),
});
export type SalesOrderLine = z.infer<typeof salesOrderLineSchema>;

// A delivery made against the order, as its page lists them
export const orderDeliverySchema = z.object({
  id: z.uuid(),
  number: z.string().nullable(),
  date: z.iso.date(),
  // z.string(): a delivery's status (deliveries.ts)
  status: z.string(),
});
export type OrderDelivery = z.infer<typeof orderDeliverySchema>;

export const salesOrderSchema = salesOrderSummarySchema.extend({
  pricesIncludeVat: z.boolean(),
  discount: z.string(),
  // The address the goods go to: its id (to pick it again in the form) and its text as it was when
  // the order was saved, so a later change to the customer's addresses does not rewrite the order
  shippingAddressId: z.uuid().nullable(),
  shippingAddress: z.string().nullable(),
  note: z.string().nullable(),
  lines: z.array(salesOrderLineSchema),
  quotation: documentRefSchema.nullable(),
  deliveries: z.array(orderDeliverySchema),
});
export type SalesOrder = z.infer<typeof salesOrderSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

const salesOrderFieldsSchema = salesDocumentFieldsSchema.extend({
  customerReference: optionalText(60),
  deliveryDate: optionalDateSchema,
  warehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  // An address of this customer; '' = none
  shippingAddressId: optionalIdSchema,
  // true = "Confirm": save and confirm in one step, or nothing at all
  confirm: z.boolean(),
});

type OrderRuleInput = z.output<typeof salesOrderFieldsSchema>;

function orderRules(input: OrderRuleInput, ctx: z.RefinementCtx<OrderRuleInput>) {
  if (input.deliveryDate !== null && input.deliveryDate < input.date) {
    ctx.addIssue({
      code: 'custom',
      path: ['deliveryDate'],
      message: errorCode('order_delivery_date'),
    });
  }
}

// quotationId: the quotation the order is made from ("Make order" on the quotation's page). Saving
// the order accepts the quotation. Left out by a form that starts from nothing.
export const salesOrderInputSchema = salesOrderFieldsSchema
  .extend({ quotationId: z.uuid().nullable().default(null) })
  .superRefine(orderRules);
export type SalesOrderInput = z.infer<typeof salesOrderInputSchema>;

// An order keeps the quotation it was made from: the edit form does not send it
export const updateSalesOrderInputSchema = salesOrderFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(orderRules);
export type UpdateSalesOrderInput = z.infer<typeof updateSalesOrderInputSchema>;
export type SalesOrderFormValues = z.input<typeof updateSalesOrderInputSchema>;

export const salesOrderVersionInputSchema = z.object({ version: versionSchema });

export const deleteSalesOrderQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const salesOrderListQuerySchema = pageQuerySchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  customerId: z.uuid().optional(),
});
export type SalesOrderListQuery = z.input<typeof salesOrderListQuerySchema>;

export const salesOrderPageSchema = pageOf(salesOrderSummarySchema);
export type SalesOrderPage = z.infer<typeof salesOrderPageSchema>;

const salesOrderParamsSchema = z.object({ id: z.uuid() });

export const salesOrderRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/sales-orders',
    summary: 'Sales orders, newest date first',
    auth: 'bearer',
    status: 200,
    query: salesOrderListQuerySchema,
    response: salesOrderPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/sales-orders/:id',
    summary: 'One sales order with its lines and deliveries',
    auth: 'bearer',
    status: 200,
    params: salesOrderParamsSchema,
    response: salesOrderSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/sales-orders',
    summary: 'Write a sales order as a draft, or write and confirm it in one step',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 201,
    body: salesOrderInputSchema,
    response: salesOrderSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/sales-orders/:id',
    summary: 'Change a draft order, and optionally confirm it',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 200,
    params: salesOrderParamsSchema,
    body: updateSalesOrderInputSchema,
    response: salesOrderSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/sales-orders/:id',
    summary: 'Delete a draft order',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 204,
    params: salesOrderParamsSchema,
    query: deleteSalesOrderQuerySchema,
    response: z.void(),
  }),
  confirm: defineRoute({
    method: 'POST',
    path: '/sales-orders/:id/confirm',
    summary: 'Confirm a draft order: it gets its number and can be delivered',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 200,
    params: salesOrderParamsSchema,
    body: salesOrderVersionInputSchema,
    response: salesOrderSchema,
  }),
  reopen: defineRoute({
    method: 'POST',
    path: '/sales-orders/:id/reopen',
    summary: 'Take a confirmed order without deliveries back to draft, to change it',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 200,
    params: salesOrderParamsSchema,
    body: salesOrderVersionInputSchema,
    response: salesOrderSchema,
  }),
  close: defineRoute({
    method: 'POST',
    path: '/sales-orders/:id/close',
    summary: 'Stop delivering a partly delivered order',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 200,
    params: salesOrderParamsSchema,
    body: salesOrderVersionInputSchema,
    response: salesOrderSchema,
  }),
  cancel: defineRoute({
    method: 'POST',
    path: '/sales-orders/:id/cancel',
    summary: 'Call off a confirmed order that has delivered nothing',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 200,
    params: salesOrderParamsSchema,
    body: salesOrderVersionInputSchema,
    response: salesOrderSchema,
  }),
};
