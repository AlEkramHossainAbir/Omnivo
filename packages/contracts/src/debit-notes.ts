import { z } from 'zod';

import { type Bill, MAX_BILL_EXPENSES, MAX_BILL_LINES } from './bills.js';
import { CREDIT_NOTE_REASONS, CREDIT_NOTE_STATUSES } from './credit-notes.js';
import { type ErrorCode, errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { isZeroMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { plainQuantity } from './quantities.js';
import { positiveAmountSchema } from './receipts.js';
import {
  defaultLineDescription,
  salesLineFieldsSchema,
  salesLineRules,
  salesLineSchema,
  taxRateRefSchema,
} from './sales.js';
import { optionalDateSchema, optionalIdSchema } from './stock.js';
import {
  type BillAllocationCodes,
  billAllocationsSchemaFor,
  paymentAllocationSchema,
  uniqueBillRules,
} from './supplier-payments.js';

// A debit note (DN-2026-27-0001) takes money off what the company owes a supplier: goods that went
// back on a purchase return, a price the supplier agreed to cut after its bill, a billing mistake.
// It is the credit note of step 15d seen from the buyer's side. Posting it books, with the supplier
// on the payable line:
//   Dr Accounts payable                the total
//   Cr Goods received not billed       for goods that went back: what the return put back on it
//                                      (the receipt line's cost of those goods)
//   Cr Purchase price difference       the rest of a goods line's net: the bill's price less that
//                                      cost for goods that went back, the whole net for a price
//                                      cut (17c's rule: a bill's price never moves the stock's
//                                      value)
//   Cr the expense account             for a service line or an expense
//   Cr VAT input                       the VAT (you chose this: always VAT input)
// After a return and its debit note, goods received not billed for those goods is zero again.
//
// Usually it is for ONE posted bill, and each line debits one of that bill's lines (or expenses),
// at that line's VAT rate: the VAT taken off must be the VAT that was claimed. A debit note without
// a bill (you chose this in 17d.1) is for goods that came in before the system was used and went
// back on a return line of its own: each line names that return line, and its price and VAT rate
// are typed from the supplier's credit note.
//
// The supplier's own credit note (Mushak 6.7) may be noted on it, its number and date, like a
// bill's Mushak 6.3 (you chose this). Its money (you chose this) is first applied to its own bill,
// up to what the bill still owes; the rest is money the supplier owes the company, applied to a
// later bill or paid back with a supplier refund (supplier-refunds.ts). The allocations work like a
// supplier payment's.
//
// It needs no approval (you chose this). A draft can be changed or deleted; a posted debit note is
// never changed: there is no void, like a credit note.
export const DEBIT_NOTE_STATUSES = CREDIT_NOTE_STATUSES;
export type DebitNoteStatus = (typeof DEBIT_NOTE_STATUSES)[number];

// Why it was written: the credit note's words. goods_returned is what the form starts with when it
// is made from a return.
export const DEBIT_NOTE_REASONS = CREDIT_NOTE_REASONS;
export type DebitNoteReason = (typeof DEBIT_NOTE_REASONS)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

// The bill it debits. Posted, so it has a number; the supplier's own number is what the supplier
// knows it by.
export const debitedBillSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  supplierBillNumber: z.string(),
});
export type DebitedBill = z.infer<typeof debitedBillSchema>;

export const debitNoteSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft
  number: z.string().nullable(),
  date: z.iso.date(),
  supplier: partyRefSchema,
  // null for a debit note without a bill
  bill: debitedBillSchema.nullable(),
  // The bill's branch (every line of its entry carries it, so the purchase comes off where it was
  // made), or the one chosen on a debit note without a bill
  branchId: z.uuid(),
  // z.string(): the rule of every list the server may grow
  reason: z.string(),
  status: z.enum(DEBIT_NOTE_STATUSES),
  // The supplier's credit note (Mushak 6.7), when it gave one
  supplierCreditNumber: z.string().nullable(),
  supplierCreditDate: z.iso.date().nullable(),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  // What is applied to bills, and what supplier refunds paid back. unappliedOf() (receipts.ts) is
  // what the supplier still owes the company from it.
  applied: z.string(),
  refunded: z.string(),
  lineCount: z.number().int(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type DebitNoteSummary = z.infer<typeof debitNoteSummarySchema>;

export const debitNoteLineSchema = salesLineSchema.extend({
  // The bill line it debits, where the item and the VAT rate come from; null on a debit note
  // without a bill
  billLineId: z.uuid().nullable(),
  // The return line it takes the money off for, and that return's number; null for a price cut
  returnLineId: z.uuid().nullable(),
  returnNumber: z.string().nullable(),
});
export type DebitNoteLine = z.infer<typeof debitNoteLineSchema>;

// An expense of the bill, debited by money: a repair the supplier agreed to charge less for
export const debitNoteExpenseSchema = z.object({
  id: z.uuid(),
  billExpenseId: z.uuid(),
  // The expense's account and description, copied from the bill
  accountId: z.uuid(),
  description: z.string(),
  // As typed: with or without VAT, as the bill's prices are
  amount: z.string(),
  taxRate: taxRateRefSchema,
  net: z.string(),
  vat: z.string(),
  total: z.string(),
});
export type DebitNoteExpense = z.infer<typeof debitNoteExpenseSchema>;

export const debitNoteSchema = debitNoteSummarySchema.extend({
  // The bill's own setting, so debiting a line in full takes off exactly what the line charged;
  // the one chosen on a debit note without a bill
  pricesIncludeVat: z.boolean(),
  discount: z.string(),
  note: z.string().nullable(),
  lines: z.array(debitNoteLineSchema),
  expenses: z.array(debitNoteExpenseSchema),
  // The bills its money is applied to (its own first), a supplier payment's rows
  allocations: z.array(paymentAllocationSchema),
  // null for a draft, and for a debit note of ৳0
  entry: entryRefSchema.nullable(),
});
export type DebitNote = z.infer<typeof debitNoteSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// A line names the bill line it debits, with no item and no VAT rate: both are the bill line's. A
// line of a debit note without a bill names its return line instead (the item is the return
// line's) and its VAT rate, from the supplier's credit note. The unit may be any of the item's
// units. A price cut is a line with the quantity it applies to and the cut per unit: 600 m at ৳2.50.
const debitNoteLineInputSchema = salesLineFieldsSchema
  .omit({ variantId: true, taxRateId: true })
  .extend({
    // '' = none: only on a debit note without a bill
    billLineId: optionalIdSchema,
    // '' = not for a return line: a price cut
    returnLineId: optionalIdSchema,
    // '' = the bill line's rate; a debit note without a bill names one
    taxRateId: optionalIdSchema,
  })
  .superRefine(salesLineRules);
export type DebitNoteLineInput = z.infer<typeof debitNoteLineInputSchema>;
export type DebitNoteLineFormValues = z.input<typeof debitNoteLineInputSchema>;

const debitNoteExpenseInputSchema = z.object({
  billExpenseId: z.uuid(errorCode('debit_note_expense_invalid')),
  // Not more than is left to take off it (debit_note_over_line, checked by the server)
  amount: positiveAmountSchema('debit_note_amount_required'),
});
export type DebitNoteExpenseInput = z.infer<typeof debitNoteExpenseInputSchema>;
export type DebitNoteExpenseFormValues = z.input<typeof debitNoteExpenseInputSchema>;

const debitNoteFieldsSchema = z.object({
  // A bill's supplier must be this one (debit_note_bill_invalid)
  supplierId: z.uuid(errorCode('purchase_supplier_required')),
  // '' = a debit note without a bill
  billId: optionalIdSchema,
  // Not before the bill's date (debit_note_date, checked by the server: only it reads the bill for
  // sure)
  date: z.iso.date(errorCode('purchase_date_required')),
  // Read only without a bill: a debit note for a bill takes the bill's branch and setting, whatever
  // is sent, so a line debited in full gives back exactly what it charged
  branchId: optionalIdSchema,
  pricesIncludeVat: z.boolean(),
  reason: z.enum(DEBIT_NOTE_REASONS),
  supplierCreditNumber: optionalText(40),
  supplierCreditDate: optionalDateSchema,
  note: optionalText(500),
  lines: z.array(debitNoteLineInputSchema).max(MAX_BILL_LINES),
  expenses: z.array(debitNoteExpenseInputSchema).max(MAX_BILL_EXPENSES),
  // true = "Post": save and post in one step, or nothing at all
  post: z.boolean(),
});

type DebitNoteRuleInput = z.output<typeof debitNoteFieldsSchema>;

function debitNoteRules(input: DebitNoteRuleInput, ctx: z.RefinementCtx<DebitNoteRuleInput>) {
  // A debit note takes something off: a line or an expense
  if (input.lines.length === 0 && input.expenses.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['lines'],
      message: errorCode('purchase_lines_required'),
    });
  }
  // A Mushak 6.7 date without its number names no credit note, like a bill's 6.3
  if (input.supplierCreditDate !== null && input.supplierCreditNumber === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['supplierCreditNumber'],
      message: errorCode('debit_note_supplier_credit_required'),
    });
  }
  const withBill = input.billId !== null;
  if (!withBill && input.branchId === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['branchId'],
      message: errorCode('purchase_branch_invalid'),
    });
  }
  // Expenses belong to a bill: without one there is nothing to take them off
  if (!withBill && input.expenses.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['expenses'],
      message: errorCode('debit_note_expense_invalid'),
    });
  }
  const returns = new Set<string>();
  input.lines.forEach((line, index) => {
    const issue = (field: string, code: ErrorCode) => {
      ctx.addIssue({ code: 'custom', path: ['lines', index, field], message: errorCode(code) });
    };
    if (withBill) {
      // The bill line gives the item and the rate; a rate of its own would claim other VAT
      if (line.billLineId === null) issue('billLineId', 'debit_note_line_invalid');
      if (line.taxRateId !== null) issue('taxRateId', 'debit_note_tax_rate_not_allowed');
    } else {
      // Without a bill, only goods that went back on a return line of their own
      if (line.billLineId !== null) issue('billLineId', 'debit_note_line_invalid');
      if (line.returnLineId === null) issue('returnLineId', 'debit_note_return_required');
      if (line.taxRateId === null) issue('taxRateId', 'tax_rate_invalid');
    }
    // A return line once: two lines for it would take its money off twice. Two lines may debit
    // one bill line (a price cut and a return), so that one is not checked here; the server checks
    // the sum against what the line charged.
    if (line.returnLineId !== null) {
      if (returns.has(line.returnLineId)) issue('returnLineId', 'debit_note_return_twice');
      returns.add(line.returnLineId);
    }
  });
  const expenses = new Set<string>();
  input.expenses.forEach((expense, index) => {
    if (expenses.has(expense.billExpenseId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['expenses', index, 'billExpenseId'],
        message: errorCode('debit_note_expense_twice'),
      });
    }
    expenses.add(expense.billExpenseId);
  });
}

export const debitNoteInputSchema = debitNoteFieldsSchema.superRefine(debitNoteRules);
export type DebitNoteInput = z.infer<typeof debitNoteInputSchema>;

export const updateDebitNoteInputSchema = debitNoteFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(debitNoteRules);
export type UpdateDebitNoteInput = z.infer<typeof updateDebitNoteInputSchema>;
export type DebitNoteFormValues = z.input<typeof updateDebitNoteInputSchema>;

export const debitNoteVersionInputSchema = z.object({ version: versionSchema });

const DEBIT_NOTE_ALLOCATION_CODES = {
  bill: 'debit_note_allocation_invalid',
  required: 'debit_note_amount_required',
  twice: 'debit_note_bill_twice',
} as const satisfies BillAllocationCodes;

// Apply its money again, like a supplier payment's. The server checks the total against the debit
// note's own, less what supplier refunds paid back (debit_note_over_allocated).
export const debitNoteAllocationsInputSchema = z
  .object({
    version: versionSchema,
    allocations: billAllocationsSchemaFor(DEBIT_NOTE_ALLOCATION_CODES),
  })
  .superRefine(uniqueBillRules(DEBIT_NOTE_ALLOCATION_CODES.twice));
export type DebitNoteAllocationsInput = z.infer<typeof debitNoteAllocationsInputSchema>;
export type DebitNoteAllocationsFormValues = z.input<typeof debitNoteAllocationsInputSchema>;

// "Debit whole bill" (you chose this): every line and expense of the bill, as it was billed. The
// app saves these as a draft in one click. Worked out the bill's own way (its pricesIncludeVat),
// each line takes off exactly what it charged, to the paisa. Only while no posted debit note exists
// for the bill (canDebitWhole): after one, the full amounts would be more than is left to debit.
// The lines name no return line, so their whole net goes to the price difference: for goods that
// went back, write the debit note from the return instead, where each line takes the goods' cost
// off goods received not billed.
// The values are the form's, like wholeInvoiceCreditLines (credit-notes.ts): 4 decimals from the
// API lose their trailing zeros, and a description that is just the product's name stays empty.
export function wholeBillDebit(bill: Pick<Bill, 'lines' | 'expenses'>): {
  lines: DebitNoteLineFormValues[];
  expenses: DebitNoteExpenseFormValues[];
} {
  return {
    lines: bill.lines.map((line) => ({
      billLineId: line.id,
      returnLineId: '',
      taxRateId: '',
      unitId: line.unitId,
      quantity: plainQuantity(line.quantity),
      description: line.description === defaultLineDescription(line) ? '' : line.description,
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discount: isZeroMoney(line.discount) ? '' : plainQuantity(line.discount),
    })),
    expenses: bill.expenses.map((expense) => ({
      billExpenseId: expense.id,
      amount: plainQuantity(expense.amount),
    })),
  };
}

export function canDebitWhole(bill: Pick<Bill, 'status' | 'debitNotes'>): boolean {
  return bill.status === 'posted' && bill.debitNotes.length === 0;
}

export const deleteDebitNoteQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const debitNoteListQuerySchema = pageQuerySchema.extend({
  status: z.enum(DEBIT_NOTE_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  billId: z.uuid().optional(),
});
export type DebitNoteListQuery = z.input<typeof debitNoteListQuerySchema>;

export const debitNotePageSchema = pageOf(debitNoteSummarySchema);
export type DebitNotePage = z.infer<typeof debitNotePageSchema>;

const debitNoteParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like the bills. Writing, posting and applying need
// purchase.debit_note.manage: usually the accountant who books the bills.
export const debitNoteRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/debit-notes',
    summary: 'Debit notes, newest date first',
    auth: 'bearer',
    status: 200,
    query: debitNoteListQuerySchema,
    response: debitNotePageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/debit-notes/:id',
    summary: 'One debit note with its lines and where its money went',
    auth: 'bearer',
    status: 200,
    params: debitNoteParamsSchema,
    response: debitNoteSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/debit-notes',
    summary: 'Write a debit note as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'purchase.debit_note.manage',
    status: 201,
    body: debitNoteInputSchema,
    response: debitNoteSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/debit-notes/:id',
    summary: 'Change a draft debit note, and optionally post it',
    auth: 'bearer',
    permission: 'purchase.debit_note.manage',
    status: 200,
    params: debitNoteParamsSchema,
    body: updateDebitNoteInputSchema,
    response: debitNoteSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/debit-notes/:id',
    summary: 'Delete a draft debit note',
    auth: 'bearer',
    permission: 'purchase.debit_note.manage',
    status: 204,
    params: debitNoteParamsSchema,
    query: deleteDebitNoteQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/debit-notes/:id/post',
    summary:
      'Post a draft debit note: it gets its number, takes the money off and applies it to its bill',
    auth: 'bearer',
    permission: 'purchase.debit_note.manage',
    status: 200,
    params: debitNoteParamsSchema,
    body: debitNoteVersionInputSchema,
    response: debitNoteSchema,
  }),
  allocate: defineRoute({
    method: 'PUT',
    path: '/debit-notes/:id/allocations',
    summary: "Change which bills a debit note's money is applied to",
    auth: 'bearer',
    permission: 'purchase.debit_note.manage',
    status: 200,
    params: debitNoteParamsSchema,
    body: debitNoteAllocationsInputSchema,
    response: debitNoteSchema,
  }),
};
