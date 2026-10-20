import { z } from 'zod';

import { documentApprovalSchema } from './approvals.js';
import { type ErrorCode, errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { isMoneyAmount } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import {
  MAX_RECEIPT_ALLOCATIONS,
  overAllocated,
  PAYMENT_METHODS,
  positiveAmountSchema,
  unappliedOf,
} from './receipts.js';
import { documentRefSchema } from './sales.js';
import { optionalIdSchema } from './stock.js';
import { supplierBankAccountSchema } from './suppliers.js';

// A supplier payment (PV-2026-27-0001, a payment voucher): money the company paid a supplier, by
// cheque, bank transfer (BEFTN, RTGS), bKash or cash. A money receipt the other way round (step
// 15c): posting it books Dr Accounts payable (with the supplier) / Cr the cash or bank account,
// and its money is applied to the supplier's bills, the oldest first. Unlike a receipt, the money
// has not left yet when it is written, so it needs an approval (approvals.ts, levels by its
// amount), and the last approval posts it (you chose this). With no level for its amount, "Post"
// posts it at once.
//
// What is not applied to a bill stays with the payment: an advance before the goods come, or money
// for an opening balance that has no bill. An advance may name the purchase order it was paid
// against (you chose this): the order's page shows it, and that order's bills offer it first. It
// is applied later, from the payment's page or the bill's.
//
// What the supplier gives back of an advance is a supplier refund (supplier-refunds.ts, step 17d):
// that money is used up, so it is never also applied to a bill.
//
// A posted payment is not edited. A cheque that bounced or a typing mistake is undone by voiding
// it: its entry is reversed on the void date and its money comes off the bills again. A payment a
// supplier refund paid back from is not voided (payment_has_refunds): void the refund first.
//   draft      being written, or sent back by a rejection or a reopen
//   pending    submitted, waiting for an approval
//   posted     in the books
//   voided     reversed; kept, with its number, so the numbers have no gaps
//   cancelled  will not be paid: submitted once, then dropped before it was posted
// It gets its number when it is first submitted, like a bill.
export const SUPPLIER_PAYMENT_STATUSES = [
  'draft',
  'pending',
  'posted',
  'voided',
  'cancelled',
] as const;
export type SupplierPaymentStatus = (typeof SUPPLIER_PAYMENT_STATUSES)[number];

// What is left of a payment's money to apply or to get back: the amount less what is applied to
// bills and what supplier refunds paid back (step 17d). receipts.ts's unappliedOf, by its own name.
export function unappliedPaymentOf(payment: {
  amount: string;
  applied: string;
  refunded: string;
}): string {
  return unappliedOf(payment);
}

// ---------------------------------------------------------------------------------------------
// What the API sends

export const supplierPaymentSummarySchema = z.object({
  id: z.uuid(),
  // null until it is first submitted
  number: z.string().nullable(),
  date: z.iso.date(),
  supplier: partyRefSchema,
  amount: z.string(),
  // What is applied to bills, and what supplier refunds paid back (step 17d);
  // unappliedPaymentOf() is what is left. A draft's allocations are what the person planned,
  // applied only when it is posted.
  applied: z.string(),
  refunded: z.string(),
  // The receipt's methods: cash, bank_transfer, cheque, mobile_wallet, card
  method: z.enum(PAYMENT_METHODS),
  // The cheque number, the BEFTN reference, the bKash TrxID
  reference: z.string().nullable(),
  // The money account it is paid from (accounts.ts → moneyAccountIds)
  accountId: z.uuid(),
  branchId: z.uuid(),
  // The purchase order an advance was paid against; null for any other payment
  order: documentRefSchema.nullable(),
  status: z.enum(SUPPLIER_PAYMENT_STATUSES),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type SupplierPaymentSummary = z.infer<typeof supplierPaymentSummarySchema>;

// One bill the payment pays, with what the payment puts on it
export const paymentAllocationSchema = z.object({
  billId: z.uuid(),
  billNumber: z.string(),
  // The supplier's own number, which the supplier knows its bill by
  supplierBillNumber: z.string(),
  billDate: z.iso.date(),
  dueDate: z.iso.date(),
  billTotal: z.string(),
  amount: z.string(),
});
export type PaymentAllocation = z.infer<typeof paymentAllocationSchema>;

export const supplierPaymentSchema = supplierPaymentSummarySchema.extend({
  note: z.string().nullable(),
  // The supplier's bank account it went to (a transfer), as the supplier has it now; null for cash,
  // a cheque, or when nobody chose one
  supplierBankAccount: supplierBankAccountSchema.nullable(),
  // Empty once voided: a voided payment paid nothing
  allocations: z.array(paymentAllocationSchema),
  // null until it is posted
  entry: entryRefSchema.nullable(),
  // The reversal that voided it, its date and why; null unless voided
  voidEntry: entryRefSchema.nullable(),
  voidDate: z.iso.date().nullable(),
  voidReason: z.string().nullable(),
  approval: documentApprovalSchema,
});
export type SupplierPayment = z.infer<typeof supplierPaymentSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// The bills some money is applied to: a payment's here, a debit note's in debit-notes.ts (step
// 17d). Each document names its own error codes, like receipts.ts's AllocationCodes for invoices.
export interface BillAllocationCodes {
  // No bill chosen in a row
  bill: ErrorCode;
  // An empty or zero amount in a row
  required: ErrorCode;
  // The same bill in two rows
  twice: ErrorCode;
}

export function billAllocationsSchemaFor(codes: BillAllocationCodes) {
  return z
    .array(
      z.object({
        billId: z.uuid(errorCode(codes.bill)),
        amount: positiveAmountSchema(codes.required),
      }),
    )
    .max(MAX_RECEIPT_ALLOCATIONS);
}

interface AllocationFields {
  allocations: readonly { billId: string; amount: string }[];
}

// A bill once: two rows for one bill is a slip. Whether each amount fits what the bill still owes
// only the server knows (payment_over_bill, debit_note_over_bill).
export function uniqueBillRules(twice: ErrorCode) {
  return <T extends AllocationFields>(input: T, ctx: z.RefinementCtx<T>): void => {
    const seen = new Set<string>();
    input.allocations.forEach((allocation, index) => {
      if (seen.has(allocation.billId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allocations', index, 'billId'],
          message: errorCode(twice),
        });
      }
      seen.add(allocation.billId);
    });
  };
}

const PAYMENT_ALLOCATION_CODES = {
  bill: 'payment_bill_invalid',
  required: 'payment_amount_required',
  twice: 'payment_bill_twice',
} as const satisfies BillAllocationCodes;

const allocationsSchema = billAllocationsSchemaFor(PAYMENT_ALLOCATION_CODES);
const allocationRules = uniqueBillRules(PAYMENT_ALLOCATION_CODES.twice);

const supplierPaymentFieldsSchema = z.object({
  supplierId: z.uuid(errorCode('purchase_supplier_required')),
  date: z.iso.date(errorCode('purchase_date_required')),
  amount: positiveAmountSchema('payment_amount_required'),
  accountId: z.uuid(errorCode('payment_account_invalid')),
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(60),
  // One of the supplier's bank accounts (step 17a). '' = none.
  supplierBankAccountId: optionalIdSchema,
  branchId: z.uuid(errorCode('purchase_branch_invalid')),
  // An advance's order: an approved (or received, or closed) order of the same supplier. '' = none.
  orderId: optionalIdSchema,
  note: optionalText(300),
  // May be empty: the whole amount is an advance
  allocations: allocationsSchema,
  // true = save and submit in one step: posted at once when no approval level applies to its
  // amount, else waiting for the first level
  submit: z.boolean(),
});

type SupplierPaymentRuleInput = z.output<typeof supplierPaymentFieldsSchema>;

function supplierPaymentRules(
  input: SupplierPaymentRuleInput,
  ctx: z.RefinementCtx<SupplierPaymentRuleInput>,
) {
  allocationRules(input, ctx);
  // A bad box is reported by its own schema; with one there is nothing to add up yet
  const amounts = [input.amount, ...input.allocations.map((allocation) => allocation.amount)];
  if (!amounts.every((value) => isMoneyAmount(value))) return;
  if (overAllocated(input.amount, input.allocations)) {
    ctx.addIssue({
      code: 'custom',
      path: ['allocations'],
      message: errorCode('payment_over_allocated'),
    });
  }
}

export const supplierPaymentInputSchema =
  supplierPaymentFieldsSchema.superRefine(supplierPaymentRules);
export type SupplierPaymentInput = z.infer<typeof supplierPaymentInputSchema>;

export const updateSupplierPaymentInputSchema = supplierPaymentFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(supplierPaymentRules);
export type UpdateSupplierPaymentInput = z.infer<typeof updateSupplierPaymentInputSchema>;
export type SupplierPaymentFormValues = z.input<typeof updateSupplierPaymentInputSchema>;

// Apply a posted payment's money again: the whole list, as the person left it. The amount is not
// sent, so the server checks the total against the payment's own, less what supplier refunds paid
// back (payment_over_allocated).
export const paymentAllocationsInputSchema = z
  .object({ version: versionSchema, allocations: allocationsSchema })
  .superRefine(allocationRules);
export type PaymentAllocationsInput = z.infer<typeof paymentAllocationsInputSchema>;
export type PaymentAllocationsFormValues = z.input<typeof paymentAllocationsInputSchema>;

export const supplierPaymentVersionInputSchema = z.object({ version: versionSchema });

export const voidSupplierPaymentInputSchema = z.object({
  version: versionSchema,
  // The day the money turned out not to have gone: the bank's return date of a bounced cheque. Not
  // before the payment's own date (payment_void_date, checked by the server).
  date: z.iso.date(errorCode('purchase_date_required')),
  reason: z.string().trim().min(1, errorCode('payment_void_reason_required')).max(200),
});
export type VoidSupplierPaymentInput = z.infer<typeof voidSupplierPaymentInputSchema>;

export const deleteSupplierPaymentQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const supplierPaymentListQuerySchema = pageQuerySchema.extend({
  status: z.enum(SUPPLIER_PAYMENT_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  // The payments made against one purchase order: its advances
  orderId: z.uuid().optional(),
});
export type SupplierPaymentListQuery = z.input<typeof supplierPaymentListQuerySchema>;

export const supplierPaymentPageSchema = pageOf(supplierPaymentSummarySchema);
export type SupplierPaymentPage = z.infer<typeof supplierPaymentPageSchema>;

const supplierPaymentParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like the bills. Writing, submitting, applying and voiding need
// purchase.payment.manage: the accountant who pays. Approving needs the level's role.
export const supplierPaymentRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/supplier-payments',
    summary: 'Supplier payments, newest date first',
    auth: 'bearer',
    status: 200,
    query: supplierPaymentListQuerySchema,
    response: supplierPaymentPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/supplier-payments/:id',
    summary: 'One supplier payment with the bills it pays and its approval history',
    auth: 'bearer',
    status: 200,
    params: supplierPaymentParamsSchema,
    response: supplierPaymentSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/supplier-payments',
    summary: 'Write a supplier payment as a draft, or write and submit it in one step',
    auth: 'bearer',
    permission: 'purchase.payment.manage',
    status: 201,
    body: supplierPaymentInputSchema,
    response: supplierPaymentSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/supplier-payments/:id',
    summary: 'Change a draft supplier payment, and optionally submit it',
    auth: 'bearer',
    permission: 'purchase.payment.manage',
    status: 200,
    params: supplierPaymentParamsSchema,
    body: updateSupplierPaymentInputSchema,
    response: supplierPaymentSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/supplier-payments/:id',
    summary: 'Delete a draft supplier payment that was never submitted',
    auth: 'bearer',
    permission: 'purchase.payment.manage',
    status: 204,
    params: supplierPaymentParamsSchema,
    query: deleteSupplierPaymentQuerySchema,
    response: z.void(),
  }),
  submit: defineRoute({
    method: 'POST',
    path: '/supplier-payments/:id/submit',
    summary: 'Submit a draft payment: posted at once, or when its last approval is given',
    auth: 'bearer',
    permission: 'purchase.payment.manage',
    status: 200,
    params: supplierPaymentParamsSchema,
    body: supplierPaymentVersionInputSchema,
    response: supplierPaymentSchema,
  }),
  reopen: defineRoute({
    method: 'POST',
    path: '/supplier-payments/:id/reopen',
    summary: 'Take a payment waiting for approval back to draft',
    auth: 'bearer',
    permission: 'purchase.payment.manage',
    status: 200,
    params: supplierPaymentParamsSchema,
    body: supplierPaymentVersionInputSchema,
    response: supplierPaymentSchema,
  }),
  cancel: defineRoute({
    method: 'POST',
    path: '/supplier-payments/:id/cancel',
    summary: 'Cancel a numbered payment that was not posted',
    auth: 'bearer',
    permission: 'purchase.payment.manage',
    status: 200,
    params: supplierPaymentParamsSchema,
    body: supplierPaymentVersionInputSchema,
    response: supplierPaymentSchema,
  }),
  allocate: defineRoute({
    method: 'PUT',
    path: '/supplier-payments/:id/allocations',
    summary: "Change which bills a posted payment's money is applied to",
    auth: 'bearer',
    permission: 'purchase.payment.manage',
    status: 200,
    params: supplierPaymentParamsSchema,
    body: paymentAllocationsInputSchema,
    response: supplierPaymentSchema,
  }),
  void: defineRoute({
    method: 'POST',
    path: '/supplier-payments/:id/void',
    summary: 'Void a posted payment: reverse its entry and take its money off the bills',
    auth: 'bearer',
    permission: 'purchase.payment.manage',
    status: 200,
    params: supplierPaymentParamsSchema,
    body: voidSupplierPaymentInputSchema,
    response: supplierPaymentSchema,
  }),
};
