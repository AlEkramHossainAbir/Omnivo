import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { receivedQuantitySchema } from './quantities.js';
import {
  documentSerialRules,
  MAX_SERIALS_PER_LINE,
  MAX_STOCK_LINES,
  serialNumberSchema,
  stockLineFieldsSchema,
  stockLineRules,
  stockLineSchema,
} from './stock.js';

// Stock moving between two warehouses, in two steps (you chose this): "Send" takes it out of the
// source and puts it in transit; "Receive" at the destination adds what arrived. A truck from the
// Gazipur factory to the Chattogram depot is on the road for a day — in those hours the stock is
// in neither warehouse, and the transfer says where it is. What did not arrive stays a shortage on
// the transfer (step 14 values it as a loss).
export const TRANSFER_STATUSES = ['draft', 'in_transit', 'received'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const transferLineSchema = stockLineSchema.extend({
  // Set on receipt, in the base unit; null until then
  receivedQuantity: z.string().nullable(),
  receivedSerialNumbers: z.array(z.string()).nullable(),
});
export type TransferLine = z.infer<typeof transferLineSchema>;

export const stockTransferSummarySchema = z.object({
  id: z.uuid(),
  // Given when it is sent
  number: z.string().nullable(),
  status: z.enum(TRANSFER_STATUSES),
  fromWarehouseId: z.uuid(),
  toWarehouseId: z.uuid(),
  // The day it leaves (the draft's planned day until then)
  sentOn: z.iso.date(),
  receivedOn: z.iso.date().nullable(),
  note: z.string().nullable(),
  lineCount: z.number().int(),
  // Received less than was sent, on any line
  short: z.boolean(),
  sentAt: z.iso.datetime().nullable(),
  receivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StockTransferSummary = z.infer<typeof stockTransferSummarySchema>;

export const stockTransferSchema = stockTransferSummarySchema.extend({
  lines: z.array(transferLineSchema),
});
export type StockTransfer = z.infer<typeof stockTransferSchema>;

// ---------------------------------------------------------------------------------------------
// What the forms send

const transferLineInputSchema = stockLineFieldsSchema.superRefine(stockLineRules);

const stockTransferFieldsSchema = z.object({
  fromWarehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  toWarehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  date: z.iso.date(errorCode('stock_date_required')),
  note: optionalText(300),
  lines: z
    .array(transferLineInputSchema)
    .min(1, errorCode('stock_lines_required'))
    .max(MAX_STOCK_LINES),
  // true = "Send": save and send in one step
  send: z.boolean(),
});

type TransferRuleInput = z.output<typeof stockTransferFieldsSchema>;

function transferRules(input: TransferRuleInput, ctx: z.RefinementCtx<TransferRuleInput>) {
  if (input.fromWarehouseId === input.toWarehouseId) {
    ctx.addIssue({
      code: 'custom',
      path: ['toWarehouseId'],
      message: errorCode('transfer_same_warehouse'),
    });
  }
  documentSerialRules(input, ctx);
}

export const stockTransferInputSchema = stockTransferFieldsSchema.superRefine(transferRules);
export type StockTransferInput = z.infer<typeof stockTransferInputSchema>;

export const updateStockTransferInputSchema = stockTransferFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(transferRules);
export type UpdateStockTransferInput = z.infer<typeof updateStockTransferInputSchema>;
export type StockTransferFormValues = z.input<typeof updateStockTransferInputSchema>;

// The receipt: every line once, with what arrived. In the base unit, so "9 cartons and 6 pieces"
// is one number (222 pcs), and never more than was sent.
export const receiveTransferInputSchema = z
  .object({
    version: versionSchema,
    date: z.iso.date(errorCode('stock_date_required')),
    lines: z
      .array(
        z.object({
          lineId: z.uuid(),
          receivedQuantity: receivedQuantitySchema,
          // A serial line: the serial numbers that arrived, a part of the ones sent
          serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
        }),
      )
      .min(1)
      .max(MAX_STOCK_LINES),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.lines.forEach((line, index) => {
      if (seen.has(line.lineId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', index, 'lineId'],
          message: errorCode('transfer_lines_mismatch'),
        });
      }
      seen.add(line.lineId);
    });
  });
export type ReceiveTransferInput = z.infer<typeof receiveTransferInputSchema>;
export type ReceiveTransferFormValues = z.input<typeof receiveTransferInputSchema>;

export const stockTransferVersionInputSchema = z.object({ version: versionSchema });

export const deleteStockTransferQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const stockTransferListQuerySchema = pageQuerySchema.extend({
  status: z.enum(TRANSFER_STATUSES).optional(),
  // Transfers from or to this warehouse
  warehouseId: z.uuid().optional(),
});

export const stockTransferPageSchema = pageOf(stockTransferSummarySchema);

const transferParamsSchema = z.object({ id: z.uuid() });

export const stockTransferRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/stock-transfers',
    summary: 'Stock transfers, newest first',
    auth: 'bearer',
    status: 200,
    query: stockTransferListQuerySchema,
    response: stockTransferPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/stock-transfers/:id',
    summary: 'One stock transfer with its lines',
    auth: 'bearer',
    status: 200,
    params: transferParamsSchema,
    response: stockTransferSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/stock-transfers',
    summary: 'Write a transfer as a draft, or write and send it in one step',
    auth: 'bearer',
    permission: 'inventory.stock.transfer',
    status: 201,
    body: stockTransferInputSchema,
    response: stockTransferSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/stock-transfers/:id',
    summary: 'Change a draft transfer, and optionally send it',
    auth: 'bearer',
    permission: 'inventory.stock.transfer',
    status: 200,
    params: transferParamsSchema,
    body: updateStockTransferInputSchema,
    response: stockTransferSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/stock-transfers/:id',
    summary: 'Delete a draft transfer',
    auth: 'bearer',
    permission: 'inventory.stock.transfer',
    status: 204,
    params: transferParamsSchema,
    query: deleteStockTransferQuerySchema,
    response: z.void(),
  }),
  send: defineRoute({
    method: 'POST',
    path: '/stock-transfers/:id/send',
    summary: 'Send a draft transfer: the stock leaves the source and is in transit',
    auth: 'bearer',
    permission: 'inventory.stock.transfer',
    status: 200,
    params: transferParamsSchema,
    body: stockTransferVersionInputSchema,
    response: stockTransferSchema,
  }),
  receive: defineRoute({
    method: 'POST',
    path: '/stock-transfers/:id/receive',
    summary: 'Receive a transfer at its destination: what arrived is added there',
    auth: 'bearer',
    permission: 'inventory.stock.transfer',
    status: 200,
    params: transferParamsSchema,
    body: receiveTransferInputSchema,
    response: stockTransferSchema,
  }),
};
