import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import {
  PAYMENT_METHODS,
  positiveAmountSchema,
  RECEIPT_STATUSES,
  voidReceiptInputSchema,
} from './receipts.js';
import { optionalIdSchema } from './stock.js';

// A refund (RF-2026-27-0001) is money paid back to a customer out of a cash, bank or wallet account
// (you chose this): Dr Accounts receivable (with the customer) / Cr the account. Like a money
// receipt, saving posts it, and a mistake is voided (its entry reversed on the void date).
//
// It pays back the customer's own advance, from ONE place: the money of a receipt or of a credit
// note that is not applied to an invoice. That money is then used up (receipts.refunded,
// credit_notes.refunded), so it cannot also be applied to an invoice later. Paying back from two
// places is two refunds. Because it only ever pays back what the customer already paid or was
// credited, it never needs a credit limit check.
//
//   posted  in the books
//   voided  reversed, and its money is the source's advance again
export const REFUND_STATUSES = RECEIPT_STATUSES;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

// Where the money it pays back came from
export const REFUND_SOURCE_TYPES = ['receipt', 'credit_note'] as const;
export type RefundSourceType = (typeof REFUND_SOURCE_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const refundSourceSchema = z.object({
  type: z.enum(REFUND_SOURCE_TYPES),
  id: z.uuid(),
  // A receipt is numbered when saved and a credit note pays back only once posted, so never null
  number: z.string(),
});
export type RefundSource = z.infer<typeof refundSourceSchema>;

export const refundSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  customer: partyRefSchema,
  amount: z.string(),
  method: z.enum(PAYMENT_METHODS),
  // The cheque number, the bKash TrxID of the money sent
  reference: z.string().nullable(),
  // The money account it was paid out of
  accountId: z.uuid(),
  branchId: z.uuid(),
  source: refundSourceSchema,
  status: z.enum(REFUND_STATUSES),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type RefundSummary = z.infer<typeof refundSummarySchema>;

export const refundSchema = refundSummarySchema.extend({
  note: z.string().nullable(),
  entry: entryRefSchema,
  // The reversal that voided it, its date and why; null while posted
  voidEntry: entryRefSchema.nullable(),
  voidDate: z.iso.date().nullable(),
  voidReason: z.string().nullable(),
});
export type Refund = z.infer<typeof refundSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

export const refundInputSchema = z
  .object({
    customerId: z.uuid(errorCode('sales_customer_required')),
    date: z.iso.date(errorCode('sales_date_required')),
    // Not more than the source has left (refund_over_source, checked by the server)
    amount: positiveAmountSchema('refund_amount_required'),
    accountId: z.uuid(errorCode('refund_account_invalid')),
    method: z.enum(PAYMENT_METHODS),
    reference: optionalText(60),
    branchId: z.uuid(errorCode('sales_branch_invalid')),
    note: optionalText(300),
    // Exactly one of the two: '' = not this kind
    receiptId: optionalIdSchema,
    creditNoteId: optionalIdSchema,
  })
  .superRefine((input, ctx) => {
    // Neither or both: the error sits on the first box, where the form shows the source picker
    if ((input.receiptId === null) === (input.creditNoteId === null)) {
      ctx.addIssue({ code: 'custom', path: ['receiptId'], message: errorCode('refund_source') });
    }
  });
export type RefundInput = z.infer<typeof refundInputSchema>;
export type RefundFormValues = z.input<typeof refundInputSchema>;

// The same as a receipt's: the day it turned out wrong, and why
export const voidRefundInputSchema = voidReceiptInputSchema;
export type VoidRefundInput = z.infer<typeof voidRefundInputSchema>;

export const refundListQuerySchema = pageQuerySchema.extend({
  status: z.enum(REFUND_STATUSES).optional(),
  customerId: z.uuid().optional(),
});
export type RefundListQuery = z.input<typeof refundListQuerySchema>;

export const refundPageSchema = pageOf(refundSummarySchema);
export type RefundPage = z.infer<typeof refundPageSchema>;

const refundParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like the receipts. Paying money out needs sales.refund.manage, its
// own key: taking money in (sales.receipt.manage) does not let anyone hand it out.
export const refundRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/refunds',
    summary: 'Refunds, newest date first',
    auth: 'bearer',
    status: 200,
    query: refundListQuerySchema,
    response: refundPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/refunds/:id',
    summary: 'One refund',
    auth: 'bearer',
    status: 200,
    params: refundParamsSchema,
    response: refundSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/refunds',
    summary: "Pay a customer's advance back; it is posted at once",
    auth: 'bearer',
    permission: 'sales.refund.manage',
    status: 201,
    body: refundInputSchema,
    response: refundSchema,
  }),
  void: defineRoute({
    method: 'POST',
    path: '/refunds/:id/void',
    summary: 'Void a refund: reverse its entry and give the money back to its source',
    auth: 'bearer',
    permission: 'sales.refund.manage',
    status: 200,
    params: refundParamsSchema,
    body: voidRefundInputSchema,
    response: refundSchema,
  }),
};
