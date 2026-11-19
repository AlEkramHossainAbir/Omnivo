import { z } from 'zod';

import { ERROR_CODES, errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { TRACKING_MODES } from './products.js';
import { quantitySchema } from './quantities.js';
import { documentRefSchema } from './sales.js';
import { MAX_SERIALS_PER_LINE, optionalIdSchema, serialNumberSchema } from './stock.js';
import { storefrontImageViewSchema } from './storefront-admin.js';
import {
  SHOP_CART_MAX_LINES,
  SHOP_CART_MAX_QUANTITY,
  SHOP_ORDER_STATUSES,
  SHOP_PAYMENT_METHODS,
} from './storefront.js';

// Step 27b: the ERP's side of the shop's orders. storefront.ts is what the shop's server sends and
// gets (27a); this file is what the ERP's Shop orders screens read and send: the list, one order,
// what Packed needs, and the four moves (Packed, Shipped, Delivered, Cancelled). Reading needs
// storefront.order.read, every move storefront.order.manage (decision 9): the ERP documents a move
// makes need no sales permission of their own.

// ---------------------------------------------------------------------------------------------
// The list

// The statuses the ERP shows. A pending order (it waits for its phone code) is the shopper's, not
// the shop's: it may never be confirmed, and the sweep deletes it after an hour (27a's decision
// 19), so the ERP never lists it
export const STOREFRONT_ORDER_STATUSES = SHOP_ORDER_STATUSES.filter(
  (status): status is Exclude<(typeof SHOP_ORDER_STATUSES)[number], 'pending'> =>
    status !== 'pending',
);
export type StorefrontOrderStatus = (typeof STOREFRONT_ORDER_STATUSES)[number];

// The list's tabs. "New" is a confirmed order: nobody has packed it yet. Returned has no tab until
// step 28 brings the courier's returns; it shows under All
export const STOREFRONT_ORDER_VIEWS = [
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'all',
] as const;
export type StorefrontOrderView = (typeof STOREFRONT_ORDER_VIEWS)[number];

export const STOREFRONT_ORDER_SORTS = ['-confirmed', 'confirmed', '-total', 'total'] as const;
export type StorefrontOrderSort = (typeof STOREFRONT_ORDER_SORTS)[number];

export const storefrontOrderQuerySchema = pageQuerySchema.extend({
  // Part of the number (W-000123 or 123), the shopper's name or phone. The API drops spaces and
  // dashes from a phone, so "01786 120356" finds 01786120356
  search: z.string().trim().max(100).optional(),
  view: z.enum(STOREFRONT_ORDER_VIEWS).default('confirmed'),
  sort: z.enum(STOREFRONT_ORDER_SORTS).default('-confirmed'),
});
export type StorefrontOrderQuery = z.input<typeof storefrontOrderQuerySchema>;

export const storefrontOrderSummarySchema = z.object({
  id: z.uuid(),
  orderNo: z.string(),
  status: z.enum(STOREFRONT_ORDER_STATUSES),
  // When the shopper pressed Confirm Order, and when the code confirmed it
  placedAt: z.iso.datetime(),
  confirmedAt: z.iso.datetime(),
  customerName: z.string(),
  phone: z.string(),
  zoneName: z.string(),
  paymentMethod: z.enum(SHOP_PAYMENT_METHODS),
  // The pieces in the order (the sum of the lines' quantities), as "3 items" on a phone's card
  itemCount: z.number().int().min(1),
  total: z.string(),
  // The sales order could not be made (decision 1): the list shows a crit "Needs attention" pill
  needsAttention: z.boolean(),
});
export type StorefrontOrderSummary = z.infer<typeof storefrontOrderSummarySchema>;

export const storefrontOrderPageSchema = pageOf(storefrontOrderSummarySchema);
export type StorefrontOrderPage = z.infer<typeof storefrontOrderPageSchema>;

// The sidebar's count next to "Shop orders": the orders nobody has packed yet
export const storefrontOrderCountsSchema = z.object({
  confirmed: z.number().int().min(0),
});
export type StorefrontOrderCounts = z.infer<typeof storefrontOrderCountsSchema>;

// ---------------------------------------------------------------------------------------------
// One order

// One line as the shopper bought it (27a's copy of the listing), plus what the ERP knows of the
// variant now: its SKU and its base unit's code, so the page says "2 pcs"
export const storefrontOrderLineSchema = z.object({
  position: z.number().int().min(1).max(SHOP_CART_MAX_LINES),
  listingId: z.uuid(),
  name: z.string(),
  packSize: z.string(),
  // The listing's photo when the order was placed. null when that photo's file is gone (the
  // listing changed its photos and a later clean-up removed the old one)
  image: storefrontImageViewSchema.nullable(),
  productId: z.uuid(),
  variantId: z.uuid(),
  sku: z.string(),
  unitCode: z.string(),
  quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
  unitPrice: z.string(),
  lineTotal: z.string(),
});
export type StorefrontOrderLine = z.infer<typeof storefrontOrderLineSchema>;

export const storefrontOrderSchema = storefrontOrderSummarySchema.extend({
  address: z.string(),
  // When each step happened, oldest first, the shop's timeline's shape (shopOrderSchema.history).
  // Starts with pending at placedAt
  history: z.array(z.object({ status: z.enum(SHOP_ORDER_STATUSES), at: z.iso.datetime() })).min(2),
  lines: z.array(storefrontOrderLineSchema).min(1),
  subtotal: z.string(),
  discount: z.string(),
  couponCode: z.string().nullable(),
  deliveryCharge: z.string(),
  // What the member typed when cancelling ("Customer did not answer the phone"); null otherwise
  cancelReason: z.string().nullable(),
  // The ERP customer the phone matched or made (decision 2); null until the sales order is made
  customer: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  // The documents the order made. Each is null until its step. The page links one only when the
  // member may read that kind of document (decision 9)
  salesOrder: documentRefSchema.nullable(),
  delivery: documentRefSchema.nullable(),
  invoice: documentRefSchema.nullable(),
  salesReturn: documentRefSchema.nullable(),
  // Why the sales order could not be made (decision 1): the error the sales order's own rules
  // gave ("sales_variant_archived"). The page shows it with "Make the sales order"
  documentError: z.enum(ERROR_CODES).nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontOrder = z.infer<typeof storefrontOrderSchema>;

// ---------------------------------------------------------------------------------------------
// Packed (decision 5): the challan's lines

// One batch, or a run of serial numbers, of one line. A line of 3 pieces may take 2 from the batch
// that expires first and 1 from the next; a line of an untracked product has one pick with no
// batch
const packPickSchema = z.object({
  batchId: z.uuid().nullable(),
  quantity: z.string(),
  serialNumbers: z.array(z.string()),
});
export type StorefrontPackPick = z.infer<typeof packPickSchema>;

// A batch of the line's variant that has stock in the order's warehouse
const packBatchSchema = z.object({
  batchId: z.uuid(),
  lotNumber: z.string(),
  expiresOn: z.iso.date().nullable(),
  // On hand in that warehouse, in the base unit
  available: z.string(),
});

// What the Packed dialog opens with. The warehouse is the one the order's stock is held in (27a
// copied it onto the hold), not the shop's warehouse now
export const storefrontPackPlanSchema = z.object({
  warehouse: z.object({ id: z.uuid(), name: z.string() }),
  lines: z.array(
    z.object({
      position: z.number().int().min(1).max(SHOP_CART_MAX_LINES),
      name: z.string(),
      packSize: z.string(),
      sku: z.string(),
      unitCode: z.string(),
      // In the base unit, as on the order
      quantity: z.string(),
      tracking: z.enum(TRACKING_MODES),
      // Earliest expiry first, then the oldest batch: the order FEFO takes them in. Empty for an
      // untracked product
      batches: z.array(packBatchSchema),
      // The API's suggestion: FEFO over `batches` for a batch product, one pick with no batch for
      // an untracked one. Empty for a serial product: only the packer knows which pieces went in
      // the box, so the serial numbers are always typed or scanned
      picks: z.array(packPickSchema),
    }),
  ),
});
export type StorefrontPackPlan = z.infer<typeof storefrontPackPlanSchema>;

const packPickInputSchema = z.object({
  // '' = no batch (an untracked product)
  batchId: optionalIdSchema,
  quantity: quantitySchema,
  serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
});

const packLineInputSchema = z.object({
  position: z.number().int().min(1).max(SHOP_CART_MAX_LINES),
  // A few batches at most in real life; 20 keeps a request with a mistake in it small
  picks: z.array(packPickInputSchema).min(1).max(20),
});

// What "Mark packed" sends: every line of the order once, each split into its picks. Whether the
// picks add up to the line's quantity, and whether a batch has the stock, only the API knows: it
// has the order and the stock (storefront_order_pick_total and the challan's own stock errors)
export const packStorefrontOrderInputSchema = z
  .object({
    version: versionSchema,
    lines: z.array(packLineInputSchema).min(1).max(SHOP_CART_MAX_LINES),
  })
  .superRefine((input, ctx) => {
    // Each line once: two entries for one line would pack it twice
    const positions = new Set<number>();
    // A serial number goes in the box once, whichever line or pick it was scanned on. The same
    // rule as documentSerialRules, one level deeper (lines → picks), so the error sits on the box
    // with the second copy
    const serials = new Set<string>();
    input.lines.forEach((line, lineIndex) => {
      if (positions.has(line.position)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', lineIndex, 'position'],
          message: errorCode('storefront_order_line_twice'),
        });
      }
      positions.add(line.position);
      line.picks.forEach((pick, pickIndex) => {
        pick.serialNumbers.forEach((serial, serialIndex) => {
          if (serials.has(serial)) {
            ctx.addIssue({
              code: 'custom',
              path: ['lines', lineIndex, 'picks', pickIndex, 'serialNumbers', serialIndex],
              message: errorCode('stock_serial_twice'),
            });
          }
          serials.add(serial);
        });
      });
    });
  });
export type PackStorefrontOrderInput = z.infer<typeof packStorefrontOrderInputSchema>;
export type PackStorefrontOrderFormValues = z.input<typeof packStorefrontOrderInputSchema>;

// Shipped, Delivered and "Make the sales order": the version is all they need
export const storefrontOrderVersionInputSchema = z.object({ version: versionSchema });
export type StorefrontOrderVersionInput = z.infer<typeof storefrontOrderVersionInputSchema>;

// Cancel (decision 8): a reason is kept on the order for the staff, never sent to the shopper
export const cancelStorefrontOrderInputSchema = z.object({
  version: versionSchema,
  reason: optionalText(200),
});
export type CancelStorefrontOrderInput = z.infer<typeof cancelStorefrontOrderInputSchema>;
export type CancelStorefrontOrderFormValues = z.input<typeof cancelStorefrontOrderInputSchema>;

// ---------------------------------------------------------------------------------------------
// Routes

const idParamsSchema = z.object({ id: z.uuid() });

export const storefrontOrderRoutes = {
  listOrders: defineRoute({
    method: 'GET',
    path: '/storefront/orders',
    summary:
      "The shop's confirmed orders, a page at a time, by tab, searched and sorted on the server",
    auth: 'bearer',
    permission: 'storefront.order.read',
    status: 200,
    query: storefrontOrderQuerySchema,
    response: storefrontOrderPageSchema,
  }),
  countOrders: defineRoute({
    method: 'GET',
    path: '/storefront/orders/counts',
    summary: 'How many orders wait to be packed, for the sidebar',
    auth: 'bearer',
    permission: 'storefront.order.read',
    status: 200,
    response: storefrontOrderCountsSchema,
  }),
  getOrder: defineRoute({
    method: 'GET',
    path: '/storefront/orders/:id',
    summary: 'One order with its lines, its timeline and the ERP documents it made',
    auth: 'bearer',
    permission: 'storefront.order.read',
    status: 200,
    params: idParamsSchema,
    response: storefrontOrderSchema,
  }),
  makeSalesOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/sales-order',
    summary: 'Make the sales order again, after it failed when the order was confirmed',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontOrderVersionInputSchema,
    response: storefrontOrderSchema,
  }),
  getPackPlan: defineRoute({
    method: 'GET',
    path: '/storefront/orders/:id/pack-plan',
    summary:
      'What the Packed dialog opens with: the warehouse, the batches and the suggested picks',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    response: storefrontPackPlanSchema,
  }),
  packOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/pack',
    summary: 'Packed: post the challan (stock out, cost of goods sold) and end the stock hold',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: packStorefrontOrderInputSchema,
    response: storefrontOrderSchema,
  }),
  shipOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/ship',
    summary: 'Shipped: the parcel left the shop',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontOrderVersionInputSchema,
    response: storefrontOrderSchema,
  }),
  deliverOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/deliver',
    summary: 'Delivered: post the invoice for the challan and the delivery charge',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontOrderVersionInputSchema,
    response: storefrontOrderSchema,
  }),
  cancelOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/cancel',
    summary: 'Cancel an order before it ships; a packed one gets a sales return of its challan',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: cancelStorefrontOrderInputSchema,
    response: storefrontOrderSchema,
  }),
};
