import { z } from 'zod';

import { type ErrorCode, errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import {
  addMoney,
  compareMoney,
  isMoneyAmount,
  isZeroMoney,
  subtractMoney,
  sumMoney,
} from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// A money receipt (MR-2026-27-0001) is money a customer paid: cash at the counter, a cheque, a
// bank transfer, a bKash payment. Saving it posts it at once — Dr the cash or bank account /
// Cr Accounts receivable (with the customer) — because the money is already in hand; there is
// nothing to approve.
//
// The money is applied to the customer's invoices (you chose this): the form suggests the oldest
// first, and the person may change it. What is not applied stays with the receipt — an advance,
// or money for an opening balance that has no invoice — and can be applied later, or paid back to
// the customer by a refund (refunds.ts, step 15d).
//
// A saved receipt is not edited. A bounced cheque or a typing mistake is undone by voiding it:
// its entry is reversed on the void date and its money comes off the invoices again.
//   posted  in the books
//   voided  reversed; kept, with its number, so the numbers have no gaps
export const RECEIPT_STATUSES = ['posted', 'voided'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

// How the money came. It decides nothing in the books (the account does); the receipt prints it
// and the reference says which cheque or which transaction.
export const PAYMENT_METHODS = [
  'cash',
  'bank_transfer',
  'cheque',
  'mobile_wallet',
  'card',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// What is left of a receipt's (or a credit note's) money to apply or to pay back: the amount less
// what is applied to invoices and what refunds paid back (step 15d)
export function unappliedOf(money: { amount: string; applied: string; refunded: string }): string {
  return subtractMoney(money.amount, addMoney(money.applied, money.refunded));
}

// A distributor's collection from a depot can settle a few hundred small invoices at once
export const MAX_RECEIPT_ALLOCATIONS = 200;

// An amount that must be there and above zero: a receipt of ৳0 moved no money. One error per box,
// like requiredPriceSchema: the format check leaves an empty box to the first one, and the zero
// check leaves a malformed one to the format check. `required` names the document's own code, so a
// refund or a credit note (step 15d) says "how much was paid back", not "how much was paid".
export function positiveAmountSchema(required: ErrorCode) {
  return z
    .string()
    .trim()
    .refine((value) => value !== '', errorCode(required))
    .refine((value) => value === '' || isMoneyAmount(value), errorCode('money_format'))
    .refine((value) => !isMoneyAmount(value) || !isZeroMoney(value), errorCode(required));
}

const receiptAmountSchema = positiveAmountSchema('receipt_amount_required');

// ---------------------------------------------------------------------------------------------
// What the API sends

export const receiptSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  customer: partyRefSchema,
  amount: z.string(),
  // What is applied to invoices, and what refunds paid back to the customer (step 15d).
  // unappliedOf() is what is left.
  applied: z.string(),
  refunded: z.string(),
  method: z.enum(PAYMENT_METHODS),
  // The cheque number, the bKash TrxID, the bank's transfer reference
  reference: z.string().nullable(),
  // The money account it went into (accounts.ts → moneyAccountIds)
  accountId: z.uuid(),
  branchId: z.uuid(),
  status: z.enum(RECEIPT_STATUSES),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type ReceiptSummary = z.infer<typeof receiptSummarySchema>;

// One invoice the receipt paid, with what the receipt put on it
export const receiptAllocationSchema = z.object({
  invoiceId: z.uuid(),
  invoiceNumber: z.string(),
  invoiceDate: z.iso.date(),
  dueDate: z.iso.date(),
  invoiceTotal: z.string(),
  amount: z.string(),
});
export type ReceiptAllocation = z.infer<typeof receiptAllocationSchema>;

export const receiptSchema = receiptSummarySchema.extend({
  note: z.string().nullable(),
  // Empty once voided: a voided receipt paid nothing
  allocations: z.array(receiptAllocationSchema),
  entry: entryRefSchema,
  // The reversal that voided it, its date and why; null while posted
  voidEntry: entryRefSchema.nullable(),
  voidDate: z.iso.date().nullable(),
  voidReason: z.string().nullable(),
});
export type Receipt = z.infer<typeof receiptSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// The invoices some money is applied to: a receipt's here, a credit note's in credit-notes.ts (step
// 15d). Each document names its own error codes.
export interface AllocationCodes {
  // No invoice chosen in a row
  invoice: ErrorCode;
  // An empty or zero amount in a row
  required: ErrorCode;
  // The same invoice in two rows
  twice: ErrorCode;
}

export function allocationsSchemaFor(codes: AllocationCodes) {
  return z
    .array(
      z.object({
        invoiceId: z.uuid(errorCode(codes.invoice)),
        amount: positiveAmountSchema(codes.required),
      }),
    )
    .max(MAX_RECEIPT_ALLOCATIONS);
}

interface AllocationFields {
  allocations: readonly { invoiceId: string; amount: string }[];
}

// An invoice once: two rows for one invoice is a slip. Whether each amount fits what the invoice
// still owes only the server knows (receipt_over_invoice).
export function uniqueInvoiceRules(twice: ErrorCode) {
  return <T extends AllocationFields>(input: T, ctx: z.RefinementCtx<T>): void => {
    const seen = new Set<string>();
    input.allocations.forEach((allocation, index) => {
      if (seen.has(allocation.invoiceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allocations', index, 'invoiceId'],
          message: errorCode(twice),
        });
      }
      seen.add(allocation.invoiceId);
    });
  };
}

const RECEIPT_ALLOCATION_CODES = {
  invoice: 'receipt_invoice_invalid',
  required: 'receipt_amount_required',
  twice: 'receipt_invoice_twice',
} as const satisfies AllocationCodes;

const allocationsSchema = allocationsSchemaFor(RECEIPT_ALLOCATION_CODES);
const allocationRules = uniqueInvoiceRules(RECEIPT_ALLOCATION_CODES.twice);

// What is applied never adds up to more than the receipt
export function overAllocated(amount: string, allocations: readonly { amount: string }[]): boolean {
  return compareMoney(sumMoney(allocations.map((allocation) => allocation.amount)), amount) > 0;
}

export const receiptInputSchema = z
  .object({
    customerId: z.uuid(errorCode('sales_customer_required')),
    date: z.iso.date(errorCode('sales_date_required')),
    amount: receiptAmountSchema,
    accountId: z.uuid(errorCode('receipt_account_invalid')),
    method: z.enum(PAYMENT_METHODS),
    reference: optionalText(60),
    branchId: z.uuid(errorCode('sales_branch_invalid')),
    note: optionalText(300),
    // May be empty: the whole amount is an advance
    allocations: allocationsSchema,
  })
  .superRefine((input, ctx) => {
    allocationRules(input, ctx);
    // A bad box is reported by its own schema; with one there is nothing to add up yet
    const amounts = [input.amount, ...input.allocations.map((allocation) => allocation.amount)];
    if (!amounts.every((value) => isMoneyAmount(value))) return;
    if (overAllocated(input.amount, input.allocations)) {
      ctx.addIssue({
        code: 'custom',
        path: ['allocations'],
        message: errorCode('receipt_over_allocated'),
      });
    }
  });
export type ReceiptInput = z.infer<typeof receiptInputSchema>;
export type ReceiptFormValues = z.input<typeof receiptInputSchema>;

// Apply the money again: the whole list, as the person left it. The amount is not sent, so the
// server checks the total against the receipt's own, less what refunds paid back
// (receipt_over_allocated).
export const receiptAllocationsInputSchema = z
  .object({ version: versionSchema, allocations: allocationsSchema })
  .superRefine(allocationRules);
export type ReceiptAllocationsInput = z.infer<typeof receiptAllocationsInputSchema>;
export type ReceiptAllocationsFormValues = z.input<typeof receiptAllocationsInputSchema>;

export const voidReceiptInputSchema = z.object({
  version: versionSchema,
  // The day the money turned out not to be there: the bank's return date of a bounced cheque. Not
  // before the receipt's own date (receipt_void_date, checked by the server).
  date: z.iso.date(errorCode('sales_date_required')),
  reason: z.string().trim().min(1, errorCode('receipt_void_reason_required')).max(200),
});
export type VoidReceiptInput = z.infer<typeof voidReceiptInputSchema>;

export const receiptListQuerySchema = pageQuerySchema.extend({
  status: z.enum(RECEIPT_STATUSES).optional(),
  customerId: z.uuid().optional(),
});
export type ReceiptListQuery = z.input<typeof receiptListQuerySchema>;

export const receiptPageSchema = pageOf(receiptSummarySchema);
export type ReceiptPage = z.infer<typeof receiptPageSchema>;

const receiptParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like the invoices. Writing needs sales.receipt.manage: the cashier
// or the accountant who takes the money.
export const receiptRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/receipts',
    summary: 'Money receipts, newest date first',
    auth: 'bearer',
    status: 200,
    query: receiptListQuerySchema,
    response: receiptPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/receipts/:id',
    summary: 'One money receipt with the invoices it paid',
    auth: 'bearer',
    status: 200,
    params: receiptParamsSchema,
    response: receiptSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/receipts',
    summary: 'Record money a customer paid; it is posted at once',
    auth: 'bearer',
    permission: 'sales.receipt.manage',
    status: 201,
    body: receiptInputSchema,
    response: receiptSchema,
  }),
  allocate: defineRoute({
    method: 'PUT',
    path: '/receipts/:id/allocations',
    summary: "Change which invoices a receipt's money is applied to",
    auth: 'bearer',
    permission: 'sales.receipt.manage',
    status: 200,
    params: receiptParamsSchema,
    body: receiptAllocationsInputSchema,
    response: receiptSchema,
  }),
  void: defineRoute({
    method: 'POST',
    path: '/receipts/:id/void',
    summary: 'Void a receipt: reverse its entry and take its money off the invoices',
    auth: 'bearer',
    permission: 'sales.receipt.manage',
    status: 200,
    params: receiptParamsSchema,
    body: voidReceiptInputSchema,
    response: receiptSchema,
  }),
};
