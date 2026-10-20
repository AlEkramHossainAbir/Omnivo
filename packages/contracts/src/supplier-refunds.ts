import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { PAYMENT_METHODS, positiveAmountSchema, RECEIPT_STATUSES } from './receipts.js';
import { optionalIdSchema } from './stock.js';
import { voidSupplierPaymentInputSchema } from './supplier-payments.js';

// A supplier refund (SRF-2026-27-0001) is money a supplier paid back into a cash, bank or wallet
// account (you chose this): Dr the account / Cr Accounts payable (with the supplier). The refund of
// step 15d the other way round. Like it, saving posts it (it needs no approval: the money comes
// in, nothing leaves), and a mistake is voided, its entry reversed on the void date.
//
// It takes back, from ONE place, money the supplier owes the company: a posted debit note's money
// that is not applied to a bill, or a posted supplier payment's advance that is not. That money is
// then used up (debit_notes.refunded, supplier_payments.refunded), so it cannot also be applied to
// a bill later. Money back from two places is two refunds.
//
//   posted  in the books
//   voided  reversed, and its money is the source's again
export const SUPPLIER_REFUND_STATUSES = RECEIPT_STATUSES;
export type SupplierRefundStatus = (typeof SUPPLIER_REFUND_STATUSES)[number];

// Where the money it takes back was
export const SUPPLIER_REFUND_SOURCE_TYPES = ['debit_note', 'supplier_payment'] as const;
export type SupplierRefundSourceType = (typeof SUPPLIER_REFUND_SOURCE_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const supplierRefundSourceSchema = z.object({
  type: z.enum(SUPPLIER_REFUND_SOURCE_TYPES),
  id: z.uuid(),
  // Both are numbered once posted, and only a posted one has money to take back, so never null
  number: z.string(),
});
export type SupplierRefundSource = z.infer<typeof supplierRefundSourceSchema>;

export const supplierRefundSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  supplier: partyRefSchema,
  amount: z.string(),
  method: z.enum(PAYMENT_METHODS),
  // The supplier's cheque number, the BEFTN reference of the money received
  reference: z.string().nullable(),
  // The money account it came into
  accountId: z.uuid(),
  branchId: z.uuid(),
  source: supplierRefundSourceSchema,
  status: z.enum(SUPPLIER_REFUND_STATUSES),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type SupplierRefundSummary = z.infer<typeof supplierRefundSummarySchema>;

export const supplierRefundSchema = supplierRefundSummarySchema.extend({
  note: z.string().nullable(),
  entry: entryRefSchema,
  // The reversal that voided it, its date and why; null while posted
  voidEntry: entryRefSchema.nullable(),
  voidDate: z.iso.date().nullable(),
  voidReason: z.string().nullable(),
});
export type SupplierRefund = z.infer<typeof supplierRefundSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

export const supplierRefundInputSchema = z
  .object({
    supplierId: z.uuid(errorCode('purchase_supplier_required')),
    date: z.iso.date(errorCode('purchase_date_required')),
    // Not more than the source has left (supplier_refund_over_source, checked by the server)
    amount: positiveAmountSchema('supplier_refund_amount_required'),
    accountId: z.uuid(errorCode('supplier_refund_account_invalid')),
    method: z.enum(PAYMENT_METHODS),
    reference: optionalText(60),
    branchId: z.uuid(errorCode('purchase_branch_invalid')),
    note: optionalText(300),
    // Exactly one of the two: '' = not this kind
    debitNoteId: optionalIdSchema,
    paymentId: optionalIdSchema,
  })
  .superRefine((input, ctx) => {
    // Neither or both: the error sits on the first box, where the form shows the source picker
    if ((input.debitNoteId === null) === (input.paymentId === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['debitNoteId'],
        message: errorCode('supplier_refund_source'),
      });
    }
  });
export type SupplierRefundInput = z.infer<typeof supplierRefundInputSchema>;
export type SupplierRefundFormValues = z.input<typeof supplierRefundInputSchema>;

// The same as a supplier payment's: the day it turned out wrong (not before the refund's own date,
// payment_void_date), and why
export const voidSupplierRefundInputSchema = voidSupplierPaymentInputSchema;
export type VoidSupplierRefundInput = z.infer<typeof voidSupplierRefundInputSchema>;

export const supplierRefundListQuerySchema = pageQuerySchema.extend({
  status: z.enum(SUPPLIER_REFUND_STATUSES).optional(),
  supplierId: z.uuid().optional(),
});
export type SupplierRefundListQuery = z.input<typeof supplierRefundListQuerySchema>;

export const supplierRefundPageSchema = pageOf(supplierRefundSummarySchema);
export type SupplierRefundPage = z.infer<typeof supplierRefundPageSchema>;

const supplierRefundParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like the payments. Recording money back needs
// purchase.refund.manage, its own key like the customer's refund (15d): one key per document.
export const supplierRefundRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/supplier-refunds',
    summary: 'Supplier refunds, newest date first',
    auth: 'bearer',
    status: 200,
    query: supplierRefundListQuerySchema,
    response: supplierRefundPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/supplier-refunds/:id',
    summary: 'One supplier refund',
    auth: 'bearer',
    status: 200,
    params: supplierRefundParamsSchema,
    response: supplierRefundSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/supplier-refunds',
    summary: 'Record money a supplier paid back; it is posted at once',
    auth: 'bearer',
    permission: 'purchase.refund.manage',
    status: 201,
    body: supplierRefundInputSchema,
    response: supplierRefundSchema,
  }),
  void: defineRoute({
    method: 'POST',
    path: '/supplier-refunds/:id/void',
    summary: 'Void a supplier refund: reverse its entry and give the money back to its source',
    auth: 'bearer',
    permission: 'purchase.refund.manage',
    status: 200,
    params: supplierRefundParamsSchema,
    body: voidSupplierRefundInputSchema,
    response: supplierRefundSchema,
  }),
};
