import { z } from 'zod';

import { errorCode, errorCodeSchema } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { TRACKING_MODES } from './products.js';
import { quantitySchema } from './quantities.js';
import { documentRefSchema } from './sales.js';
import {
  bookShipmentInputSchema,
  collectedAmountSchema,
  courierChoicesSchema,
  courierExportSchema,
  SHIPMENT_STATUSES,
  storefrontShipmentSchema,
} from './shipping.js';
import {
  MAX_SERIALS_PER_LINE,
  MAX_STOCK_LINES,
  optionalIdSchema,
  serialNumberSchema,
} from './stock.js';
import { storefrontImageViewSchema } from './storefront-admin.js';
import {
  SHOP_CART_MAX_LINES,
  SHOP_CART_MAX_QUANTITY,
  SHOP_ORDER_STATUSES,
  SHOP_PAYMENT_METHODS,
  SHOP_PAYMENT_STATUSES,
  SHOP_PAYMENT_TRIES,
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

// The list's tabs. "New" is a confirmed order: nobody has packed it yet. Step 28b: Returned has its
// own tab now that an order can get there (Receive the return), after Cancelled
export const STOREFRONT_ORDER_VIEWS = [
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
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
  // The sales order could not be made (decision 1), or (step 28a) its parcel's booking failed five
  // times, or (step 28b) its COD receipt could not be made: the list shows a crit "Needs
  // attention" pill
  needsAttention: z.boolean(),
  // Step 28b: where the order's newest parcel is, so the Shipped tab can say which orders wait for
  // the staff: a partly delivered or returned parcel needs "Record what came back" or "Receive the
  // return" on the order's page. null: no parcel
  parcelStatus: z.enum(SHIPMENT_STATUSES).nullable(),
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

// Step 27d: one payment try of an online order, for the order page's Payments card. Every try is
// listed, the ones that did not pay too: when a shopper says "I paid", the staff see each visit to
// the gateway with its transaction id, which SSLCommerz's own panel searches by
export const storefrontOrderPaymentSchema = z.object({
  id: z.uuid(),
  // Our id for the try, sent to the gateway as tran_id (shopPaymentTranIdSchema)
  tranId: z.string(),
  status: z.enum(SHOP_PAYMENT_STATUSES),
  // The order's total when the try started: what the gateway was asked to take
  amount: z.string(),
  startedAt: z.iso.datetime(),
  // When the gateway's answer was recorded (paid, failed or cancelled). null while started
  settledAt: z.iso.datetime().nullable(),
  // What the gateway said about a paid try: the way the shopper paid ("BKASH-BKash",
  // "VISA-Dutch Bangla"), the bank's or wallet's own transaction number, and what the gateway pays
  // out after its fee (the fee is amount − storeAmount). null until it is paid
  cardType: z.string().nullable(),
  bankTranId: z.string().nullable(),
  storeAmount: z.string().nullable(),
  // The money receipt a paid try made (decision 6: posted, an advance until the invoice takes it
  // at Delivered). null before it is paid, or while it could not be made
  receipt: documentRefSchema.nullable(),
  // Why the receipt could not be made ("receipt_account_invalid": the money account was archived
  // after the gateway was saved). The page shows it with "Make the receipt", which tries again
  receiptError: errorCodeSchema.nullable(),
});
export type StorefrontOrderPayment = z.infer<typeof storefrontOrderPaymentSchema>;

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
  // The sales return of a cancelled packed order (27b); step 28b: also of a returned order (the
  // whole challan) and of a partly delivered one (what came back, made before its invoice)
  salesReturn: documentRefSchema.nullable(),
  // Why the sales order could not be made (decision 1): the error the sales order's own rules
  // gave ("sales_variant_archived"). The page shows it with "Make the sales order"
  documentError: errorCodeSchema.nullable(),
  // Step 27d: the payment tries, oldest first. Empty for a Cash on Delivery order that never tried
  // to pay online. A paid online order has one paid try; two paid ones mean the shopper paid twice
  // (a second tab), and the page says one of them is to be refunded
  payments: z.array(storefrontOrderPaymentSchema).max(SHOP_PAYMENT_TRIES),
  // Step 28a: what the rider collects at the door, a decimal string with paisa: the total less
  // what paid tries took (never below zero; "0.00" for an order paid online). The API works it
  // out, so the label, the export and the courier's booking all say the same amount
  codAmount: z.string(),
  // Step 28a: the order's parcels, oldest first. Empty until it is booked with a courier. More than
  // one only when an earlier one was cancelled or failed and the order was booked again: at most
  // one is on its way at a time (isOpenShipment)
  shipments: z.array(storefrontShipmentSchema).max(5),
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
    // Step 28a (decision 2): the courier account to book the parcel with, once the challan is
    // posted. The dialog starts with the default account; '' = "Don't book now" (a shop's own
    // rider, or a booking made later with "Book courier"). Only an active account that books by
    // API: the API refuses a manual or archived one (courier_account_not_bookable). Left out is
    // "Don't book now" too (28a.3): a page loaded before 28a, still open in a tab, packs as before
    courierAccountId: optionalIdSchema.default(null),
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

// Shipped and "Make the sales order": the version is all they need
export const storefrontOrderVersionInputSchema = z.object({ version: versionSchema });
export type StorefrontOrderVersionInput = z.infer<typeof storefrontOrderVersionInputSchema>;

// Delivered. Step 28b (decision 5): and what the rider collected, for the COD receipt, when the
// parcel's account has a COD account (the dialog asks only then, starting with what the courier
// said). '' or left out = what the courier said, else the parcel's codAmount, so a page loaded
// before 28b delivers as before
export const deliverStorefrontOrderInputSchema = z.object({
  version: versionSchema,
  collectedAmount: collectedAmountSchema.default(null),
});
export type DeliverStorefrontOrderInput = z.infer<typeof deliverStorefrontOrderInputSchema>;
export type DeliverStorefrontOrderFormValues = z.input<typeof deliverStorefrontOrderInputSchema>;

// ---------------------------------------------------------------------------------------------
// Step 28b: what came back (decisions 6 and 7)

// What the "Record what came back" dialog opens with: the challan's lines, one row per batch (a
// line packed from two batches is two rows), each with what it took and its serial numbers. The
// goods go back into the warehouse they left from, at what they cost (15d's rule)
export const storefrontReturnPlanSchema = z.object({
  warehouse: z.object({ id: z.uuid(), name: z.string() }),
  lines: z.array(
    z.object({
      deliveryLineId: z.uuid(),
      position: z.number().int().min(1).max(SHOP_CART_MAX_LINES),
      name: z.string(),
      packSize: z.string(),
      sku: z.string(),
      unitCode: z.string(),
      // What the challan line took, in the base unit
      quantity: z.string(),
      tracking: z.enum(TRACKING_MODES),
      batch: z.object({ lotNumber: z.string(), expiresOn: z.iso.date().nullable() }).nullable(),
      // The pieces in the box, for a serial product: the member ticks the ones that came back
      serialNumbers: z.array(z.string()),
    }),
  ),
});
export type StorefrontReturnPlan = z.infer<typeof storefrontReturnPlanSchema>;

// One challan line that came back, whole or in part. A serial product names its pieces, and the
// quantity is their count (15d's returnLineRules, which the sales return runs again)
const cameBackLineInputSchema = z.object({
  deliveryLineId: z.uuid(),
  quantity: quantitySchema,
  serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
});

// "Record what came back" on a shipped order the shopper kept part of (decision 6): a sales return
// of these lines before the invoice, then the invoice of the rest and the delivery charge, then the
// COD receipt for what was collected, in one transaction: the order is Delivered. Only the lines
// that came back are sent; none is storefront_order_return_nothing (that is Mark delivered), and
// every piece is storefront_order_return_everything (that is Receive the return), which only the
// API can tell: it has the challan
export const partlyDeliverStorefrontOrderInputSchema = z
  .object({
    version: versionSchema,
    lines: z
      .array(cameBackLineInputSchema)
      .min(1, errorCode('storefront_order_return_nothing'))
      .max(MAX_STOCK_LINES),
    collectedAmount: collectedAmountSchema.default(null),
    // Why it came back ("Wrong size"), kept on the sales return's note for the staff
    reason: optionalText(200),
  })
  .superRefine((input, ctx) => {
    // A challan line once, and a serial number once, as on a sales return (its own rules say the
    // same again in the API; here the error lands on the dialog's box)
    const lines = new Set<string>();
    const serials = new Set<string>();
    input.lines.forEach((line, lineIndex) => {
      if (lines.has(line.deliveryLineId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', lineIndex, 'deliveryLineId'],
          message: errorCode('return_line_twice'),
        });
      }
      lines.add(line.deliveryLineId);
      line.serialNumbers.forEach((serial, serialIndex) => {
        if (serials.has(serial)) {
          ctx.addIssue({
            code: 'custom',
            path: ['lines', lineIndex, 'serialNumbers', serialIndex],
            message: errorCode('stock_serial_twice'),
          });
        }
        serials.add(serial);
      });
    });
  });
export type PartlyDeliverStorefrontOrderInput = z.infer<
  typeof partlyDeliverStorefrontOrderInputSchema
>;
export type PartlyDeliverStorefrontOrderFormValues = z.input<
  typeof partlyDeliverStorefrontOrderInputSchema
>;

// "Receive the return" (decision 7): the whole parcel is back in the shop. A sales return of the
// whole challan, the sales order closed, the order Returned and the shopper's SMS. The member
// presses it once the goods are on the shelf, never the courier's news alone: a parcel lost on the
// way must not come back into stock
export const returnStorefrontOrderInputSchema = z.object({
  version: versionSchema,
  // Why it came back ("Customer refused the parcel"), for the staff only, like a cancel's reason
  reason: optionalText(200),
});
export type ReturnStorefrontOrderInput = z.infer<typeof returnStorefrontOrderInputSchema>;
export type ReturnStorefrontOrderFormValues = z.input<typeof returnStorefrontOrderInputSchema>;

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
const paymentParamsSchema = z.object({ id: z.uuid(), paymentId: z.uuid() });
const shipmentParamsSchema = z.object({ id: z.uuid(), shipmentId: z.uuid() });

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
  // Step 28a: declared before getOrder in the controller, like countOrders, or "courier-export"
  // would reach it as an id
  courierExport: defineRoute({
    method: 'GET',
    path: '/storefront/orders/courier-export',
    summary: "The packed orders with no parcel yet, as rows for a courier's bulk upload",
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    response: courierExportSchema,
  }),
  // Step 28a.6: the accounts the Packed dialog and Book courier offer, for a packer without
  // storefront.manage. Before getOrder too
  courierChoices: defineRoute({
    method: 'GET',
    path: '/storefront/orders/courier-choices',
    summary: 'The active courier accounts a packer can book with, and the default one',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    response: courierChoicesSchema,
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
  // Step 27d: "Make the receipt", after the receipt of a paid try could not be made
  makePaymentReceipt: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/payments/:paymentId/receipt',
    summary: 'Make the money receipt of a paid online payment again, after it failed',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: paymentParamsSchema,
    body: storefrontOrderVersionInputSchema,
    response: storefrontOrderSchema,
  }),
  // Step 28a: "Book courier" on a packed order with no parcel on its way. An API account books in
  // the worker (the answer's parcel is `booking`), a manual one takes the typed tracking code
  bookShipment: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/shipments',
    summary: 'Book courier: send a packed order with a courier account',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: bookShipmentInputSchema,
    response: storefrontOrderSchema,
  }),
  // Step 28a: "Book again" after five failed tries (decision 4). The same parcel row, so the
  // courier is asked with the same order number and cannot make a second parcel
  retryShipment: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/shipments/:shipmentId/retry',
    summary: 'Book again a parcel whose booking failed',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: shipmentParamsSchema,
    body: storefrontOrderVersionInputSchema,
    response: storefrontOrderSchema,
  }),
  // Step 28a: a booked parcel nobody has picked up yet is cancelled with the order (the API asks
  // the courier to cancel it, or says to cancel it on the courier's panel); once the courier has
  // it, the order is refused (storefront_order_parcel_on_its_way): it comes back as a return
  // (step 28b's returnOrder)
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

// Step 28b: the moves at the shopper's door, a group of their own: Delivered (27b, which 28b gives
// the collected amount), what came back, and the COD receipt. With them in the group above, its
// inferred type is more than TypeScript will write into the declaration file (TS7056, as for the
// route table in 27d): each route repeats the order's answer. Same rules: storefront.order.manage,
// the order in the answer
export const storefrontOrderDeliveryRoutes = {
  deliverOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/deliver',
    summary:
      "Delivered: post the invoice for the challan and the delivery charge, and the rider's COD receipt",
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: deliverStorefrontOrderInputSchema,
    response: storefrontOrderSchema,
  }),
  // The challan's lines for "Record what came back"
  getReturnPlan: defineRoute({
    method: 'GET',
    path: '/storefront/orders/:id/return-plan',
    summary:
      'What the "Record what came back" dialog opens with: the challan lines and their pieces',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    response: storefrontReturnPlanSchema,
  }),
  partlyDeliverOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/partly-deliver',
    summary:
      'Partly delivered: a sales return of what came back, the invoice of the rest, the COD receipt',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: partlyDeliverStorefrontOrderInputSchema,
    response: storefrontOrderSchema,
  }),
  returnOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/return',
    summary: 'Receive the return: the whole parcel came back, a sales return of the whole challan',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: returnStorefrontOrderInputSchema,
    response: storefrontOrderSchema,
  }),
  // "Make the receipt", after a delivered parcel's COD receipt could not be made
  makeCodReceipt: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/shipments/:shipmentId/receipt',
    summary: "Make a delivered parcel's COD receipt again, after it failed",
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: shipmentParamsSchema,
    body: storefrontOrderVersionInputSchema,
    response: storefrontOrderSchema,
  }),
};
