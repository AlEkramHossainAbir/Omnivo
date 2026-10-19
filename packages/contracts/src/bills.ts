import { z } from 'zod';

import { documentApprovalSchema } from './approvals.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { INVOICE_PAYMENT_FILTERS, type PaymentStatus } from './invoices.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { compareMoney, isZeroMoney, subtractMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { positiveAmountSchema } from './receipts.js';
import {
  documentRefSchema,
  type LineAmounts,
  lineAmounts,
  salesLineFieldsSchema,
  salesLineRules,
  salesLineSchema,
  taxRateRefSchema,
} from './sales.js';
import {
  documentSerialRules,
  MAX_SERIALS_PER_LINE,
  MAX_STOCK_LINES,
  optionalDateSchema,
  optionalIdSchema,
  serialNumberSchema,
  stockLineRules,
} from './stock.js';

// A supplier's bill (step 17c): what a supplier asks the company to pay. The accountant types it
// from the supplier's own bill (its number is required, once per supplier, you chose this), and
// posting it books what the company owes: Dr Goods received not billed (for goods a goods receipt
// already brought in) / Dr the expense account (for services and other costs) / Dr VAT input /
// Cr Accounts payable (with the supplier). A posted bill is never changed or deleted: a debit note
// corrects it (17d), and the bill keeps its number and its entry.
//
// Each line bills one of these (the same three as a sales invoice, plus costs with no product):
//   a receipt line   receiptLineId: goods accepted on a posted goods receipt (step 17b). Billed
//                    whole and once, in any unit of the item. Its price starts at the order's and
//                    may differ (you chose this): the difference goes to the "Purchase price
//                    difference" account, never into the stock's value, because the goods receipt
//                    already took them in at the order's price.
//   an order service orderLineId: a dyeing or transport charge on an approved purchase order. A
//                    service is never received, so it is billed straight from the order.
//   neither          a line of its own. A goods line is received by the bill itself: posting it
//                    posts a goods receipt into the bill's warehouse in the same transaction (a
//                    shop buying from a wholesaler with no order), so the stock and its value
//                    still come in through one kind of document. A service line goes to its
//                    expense account.
//   an expense       expenses[]: no product at all. Rent, electricity, a repair: an expense
//                    account, a description and an amount (you chose this).
//
// It needs an approval like a purchase order (approvals.ts, levels by its total with VAT), and the
// last approval posts it (you chose this): there is no "approved but not posted". With no level
// for its total, "Post" posts it at once.
//   draft      being written, or sent back by a rejection or a reopen
//   pending    submitted, waiting for an approval
//   posted     in the books; payments (supplier-payments.ts) settle it
//   cancelled  will not be booked: a bill that was submitted once and turned out wrong
// It gets its number (BILL-2026-27-0001) when it is first submitted, like a purchase order: the
// approvers need a number to talk about. A draft nobody submitted is deleted instead.
export const BILL_STATUSES = ['draft', 'pending', 'posted', 'cancelled'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

// A bill for a month of deliveries of a garments accessory supplier bills every receipt line of
// the month. A bill's own goods lines become one goods receipt, so the limit is a receipt's.
export const MAX_BILL_LINES = MAX_STOCK_LINES;

// Costs without a product on one bill: a utility bill has a few, a contractor's bill a few dozen
export const MAX_BILL_EXPENSES = 100;

// What the company still owes on a bill: its total less what payments applied. Worked out, never
// stored, like an invoice's amountDueOf. Debit notes (17d) will settle it the same way.
interface BillAmounts {
  total: string;
  amountPaid: string;
}

export function billAmountDueOf(bill: BillAmounts): string {
  return subtractMoney(bill.total, bill.amountPaid);
}

// unpaid / partly_paid / paid, the invoice's words (invoices.ts → PAYMENT_STATUSES)
export function billPaymentStatusOf(bill: BillAmounts): PaymentStatus {
  // A ৳0 bill (a free sample billed for the record) owes nothing
  if (compareMoney(bill.amountPaid, bill.total) >= 0) return 'paid';
  return isZeroMoney(bill.amountPaid) ? 'unpaid' : 'partly_paid';
}

// Overdue: posted, not paid in full, and its due date is before today (the workspace's today). On
// the due date itself it is still on time, like an invoice.
export function isBillOverdue(
  bill: { status: string; dueDate: string } & BillAmounts,
  today: string,
): boolean {
  return bill.status === 'posted' && billPaymentStatusOf(bill) !== 'paid' && bill.dueDate < today;
}

// An expense line is one amount: worked out like a sales line of one unit with no discount, so its
// VAT is rounded exactly as an item line's is, whether the bill's prices include VAT or not. The
// bill's totals are documentTotals() (sales.ts) of both kinds of lines together.
export function expenseLineAmounts(
  expense: { amount: string; rate: string },
  pricesIncludeVat: boolean,
): LineAmounts {
  return lineAmounts(
    {
      quantity: '1',
      unitPrice: expense.amount,
      discountType: 'amount',
      discount: '0',
      rate: expense.rate,
    },
    pricesIncludeVat,
  );
}

// What a receipt line's price changed by: the line's net less what the goods receipt booked at the
// order's price. Positive = the supplier billed more than the order said.
export function priceDifferenceOf(line: { net: string; orderValue: string | null }): string {
  return line.orderValue === null ? '0.0000' : subtractMoney(line.net, line.orderValue);
}

// The bill list's payment filter, the invoice list's words: open (posted and not paid in full,
// what a payment can be applied to), overdue, paid. Open and overdue list the oldest due date first.
export const BILL_PAYMENT_FILTERS = INVOICE_PAYMENT_FILTERS;
export type BillPaymentFilter = (typeof BILL_PAYMENT_FILTERS)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const billSummarySchema = z.object({
  id: z.uuid(),
  // null until it is first submitted
  number: z.string().nullable(),
  // The day it is booked on: the supplier's bill date, unless that is in a locked period
  date: z.iso.date(),
  dueDate: z.iso.date(),
  supplier: partyRefSchema,
  // The number on the supplier's own bill (INV-0412): once per supplier, so the same bill is never
  // booked, and paid, twice
  supplierBillNumber: z.string(),
  // The supplier's VAT invoice (Mushak 6.3), when it gave one: its number and date. The VAT return
  // (a later step) needs them to claim the input VAT.
  mushakNumber: z.string().nullable(),
  mushakDate: z.iso.date().nullable(),
  // Whose purchase it is: the payable, the VAT and the expense lines carry this branch. A receipt
  // line's Goods received not billed line carries its goods receipt's branch, where it was owed.
  branchId: z.uuid(),
  status: z.enum(BILL_STATUSES),
  net: z.string(),
  vat: z.string(),
  // What the company owes the supplier for it, and what the approval levels are chosen by
  total: z.string(),
  // What posted payments applied to it. billAmountDueOf() is what is still owed.
  amountPaid: z.string(),
  lineCount: z.number().int(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type BillSummary = z.infer<typeof billSummarySchema>;

// An item line: a sales line's shape, like a purchase order's, so the bill shows to the paisa what
// the order showed
export const billLineSchema = salesLineSchema.extend({
  // The goods receipt line it bills, and that receipt's number; null for an order's service line
  // and for a line of its own until the bill is posted (posting points it at the line it made)
  receiptLineId: z.uuid().nullable(),
  receiptNumber: z.string().nullable(),
  // The order line behind it: through the receipt line, or an order's service line
  orderLineId: z.uuid().nullable(),
  orderNumber: z.string().nullable(),
  // A service line's expense account; null on a goods line
  accountId: z.uuid().nullable(),
  // What the goods receipt booked the line's goods at: the order's price (step 17b). null when no
  // order priced it (a service, a line of its own). net − orderValue is the price difference.
  orderValue: z.string().nullable(),
  // The lot and serial numbers the goods came with: the receipt line's, or what a line of its own
  // brought in
  batchId: z.uuid().nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: z.iso.date().nullable(),
  manufacturedOn: z.iso.date().nullable(),
  serialNumbers: z.array(z.string()),
});
export type BillLine = z.infer<typeof billLineSchema>;

// A cost with no product
export const billExpenseSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  description: z.string(),
  // As typed: with or without VAT, as the bill's prices are
  amount: z.string(),
  taxRate: taxRateRefSchema,
  // expenseLineAmounts() at the time it was saved
  net: z.string(),
  vat: z.string(),
  total: z.string(),
});
export type BillExpense = z.infer<typeof billExpenseSchema>;

// Money a payment applied to this bill
export const billPaymentSchema = z.object({
  paymentId: z.uuid(),
  paymentNumber: z.string(),
  date: z.iso.date(),
  amount: z.string(),
});
export type BillPayment = z.infer<typeof billPaymentSchema>;

// A posted payment to the same supplier with money not applied yet: an advance the person may put
// on this bill. The ones paid against an order this bill bills come first (you chose this).
export const billAdvanceSchema = z.object({
  paymentId: z.uuid(),
  paymentNumber: z.string(),
  date: z.iso.date(),
  // The purchase order it was paid against; null for an advance with no order
  order: documentRefSchema.nullable(),
  unapplied: z.string(),
});
export type BillAdvance = z.infer<typeof billAdvanceSchema>;

export const billSchema = billSummarySchema.extend({
  // The orders' setting when the bill bills orders, else the bill's own
  pricesIncludeVat: z.boolean(),
  discount: z.string(),
  // Where the bill's own goods lines come in; null when it has none
  warehouseId: z.uuid().nullable(),
  note: z.string().nullable(),
  lines: z.array(billLineSchema),
  expenses: z.array(billExpenseSchema),
  // The sum of the receipt lines' price differences (priceDifferenceOf): what goes to the
  // "Purchase price difference" account. Not zero = the page shows a warn notice.
  priceDifference: z.string(),
  // The goods receipts it bills (or made, for its own goods lines), and the orders behind its lines
  receipts: z.array(documentRefSchema),
  orders: z.array(documentRefSchema),
  payments: z.array(billPaymentSchema),
  // Only while it is posted and not paid in full; empty otherwise
  advances: z.array(billAdvanceSchema),
  // What it booked; null until posted, and for a bill of ৳0
  entry: entryRefSchema.nullable(),
  // Every time it was submitted, newest first
  approval: documentApprovalSchema,
});
export type Bill = z.infer<typeof billSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

interface BillLineFields {
  receiptLineId: string | null;
  orderLineId: string | null;
  accountId: string | null;
  lotNumber: string | null;
  expiresOn: string | null;
  manufacturedOn: string | null;
  serialNumbers: readonly string[];
}

// A line bills one thing. A receipt line is goods, so it has no expense account, and it came in
// with its own lot and serial numbers, like an order's service line has none. Which product is a
// service only the server knows, so it checks the rest (bill_account_required on a service,
// bill_account_not_allowed on goods of its own).
function billLineRules<T extends BillLineFields>(line: T, ctx: z.RefinementCtx<T>): void {
  if (line.receiptLineId !== null && line.orderLineId !== null) {
    ctx.addIssue({ code: 'custom', path: ['orderLineId'], message: errorCode('bill_line_source') });
  }
  if (line.receiptLineId !== null && line.accountId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['accountId'],
      message: errorCode('bill_account_not_allowed'),
    });
  }
  if (line.receiptLineId === null && line.orderLineId === null) return;
  const stockFields = [
    ['lotNumber', line.lotNumber !== null],
    ['expiresOn', line.expiresOn !== null],
    ['manufacturedOn', line.manufacturedOn !== null],
    ['serialNumbers', line.serialNumbers.length > 0],
  ] as const;
  for (const [field, filled] of stockFields) {
    if (filled) {
      ctx.addIssue({ code: 'custom', path: [field], message: errorCode('bill_stock_not_allowed') });
    }
  }
}

const billLineInputSchema = salesLineFieldsSchema
  .extend({
    // '' = not a receipt line
    receiptLineId: optionalIdSchema,
    // '' = not an order's service line. A receipt line leaves it empty: the server reads the
    // order line from the receipt line.
    orderLineId: optionalIdSchema,
    // A service line's expense account. '' = the "Purchased services" account of Settings →
    // Purchase (purchase-accounts.ts); with none chosen there, bill_account_required.
    accountId: optionalIdSchema,
    // A goods line of its own brings stock in, so it says which lot, like a goods receipt line
    lotNumber: optionalText(40),
    expiresOn: optionalDateSchema,
    manufacturedOn: optionalDateSchema,
    serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
  })
  .superRefine((line, ctx) => {
    salesLineRules(line, ctx);
    stockLineRules(line, ctx);
    billLineRules(line, ctx);
  });
export type BillLineInput = z.infer<typeof billLineInputSchema>;
export type BillLineFormValues = z.input<typeof billLineInputSchema>;

const billExpenseInputSchema = z.object({
  // Any active expense or asset account that is not a group: a repair is an expense, a new
  // sewing machine an asset. The server refuses the accounts only the system posts to (the
  // inventory, the payable, VAT) with bill_account_invalid.
  accountId: z.uuid(errorCode('bill_account_required')),
  description: z.string().trim().min(2, errorCode('bill_expense_description_required')).max(300),
  amount: positiveAmountSchema('bill_expense_amount_required'),
  taxRateId: z.uuid(errorCode('tax_rate_invalid')),
});
export type BillExpenseInput = z.infer<typeof billExpenseInputSchema>;
export type BillExpenseFormValues = z.input<typeof billExpenseInputSchema>;

const billFieldsSchema = z.object({
  supplierId: z.uuid(errorCode('purchase_supplier_required')),
  date: z.iso.date(errorCode('purchase_date_required')),
  // '' = the date plus the payment terms: the order's when the bill bills an order, else the
  // supplier's
  dueDate: optionalDateSchema,
  supplierBillNumber: z.string().trim().min(1, errorCode('bill_supplier_number_required')).max(40),
  mushakNumber: optionalText(40),
  mushakDate: optionalDateSchema,
  branchId: z.uuid(errorCode('purchase_branch_invalid')),
  // Needed only when a goods line is a line of its own (bill_warehouse_required). '' = none.
  warehouseId: optionalIdSchema,
  // The form starts it from the orders it bills, else off: a supplier bills before VAT
  pricesIncludeVat: z.boolean(),
  note: optionalText(500),
  lines: z.array(billLineInputSchema).max(MAX_BILL_LINES),
  expenses: z.array(billExpenseInputSchema).max(MAX_BILL_EXPENSES),
  // true = save and submit in one step, or nothing at all: posted at once when no approval level
  // applies to its total, else waiting for the first level
  submit: z.boolean(),
});

type BillRuleInput = z.output<typeof billFieldsSchema>;

function billRules(input: BillRuleInput, ctx: z.RefinementCtx<BillRuleInput>) {
  // A bill bills something: an item line or an expense
  if (input.lines.length === 0 && input.expenses.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['lines'],
      message: errorCode('purchase_lines_required'),
    });
  }
  if (input.dueDate !== null && input.dueDate < input.date) {
    ctx.addIssue({ code: 'custom', path: ['dueDate'], message: errorCode('bill_due_date') });
  }
  // A Mushak 6.3 date says when the VAT invoice was issued; without its number it claims nothing
  if (input.mushakDate !== null && input.mushakNumber === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['mushakNumber'],
      message: errorCode('bill_mushak_number_required'),
    });
  }
  // A receipt line or an order line twice on one bill would bill it twice. Ids of the two kinds
  // never meet (UUIDs of different tables), so one set holds both.
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    const pairs = [
      ['receiptLineId', line.receiptLineId],
      ['orderLineId', line.orderLineId],
    ] as const;
    for (const [field, id] of pairs) {
      if (id === null) continue;
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', index, field],
          message: errorCode('bill_line_twice'),
        });
      }
      seen.add(id);
    }
  });
  documentSerialRules(input, ctx);
}

export const billInputSchema = billFieldsSchema.superRefine(billRules);
export type BillInput = z.infer<typeof billInputSchema>;

export const updateBillInputSchema = billFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(billRules);
export type UpdateBillInput = z.infer<typeof updateBillInputSchema>;
export type BillFormValues = z.input<typeof updateBillInputSchema>;

export const billVersionInputSchema = z.object({ version: versionSchema });

export const deleteBillQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const billListQuerySchema = pageQuerySchema.extend({
  status: z.enum(BILL_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  payment: z.enum(BILL_PAYMENT_FILTERS).optional(),
});
export type BillListQuery = z.input<typeof billListQuerySchema>;

export const billPageSchema = pageOf(billSummarySchema);
export type BillPage = z.infer<typeof billPageSchema>;

const billParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every purchase document. Writing, submitting, reopening and
// cancelling need purchase.bill.manage (the accountant); approving needs the level's role.
export const billRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/bills',
    summary: 'Supplier bills, newest date first (open and overdue: oldest due date first)',
    auth: 'bearer',
    status: 200,
    query: billListQuerySchema,
    response: billPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/bills/:id',
    summary: 'One bill with its lines, payments and approval history',
    auth: 'bearer',
    status: 200,
    params: billParamsSchema,
    response: billSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/bills',
    summary: 'Write a bill as a draft, or write and submit it in one step',
    auth: 'bearer',
    permission: 'purchase.bill.manage',
    status: 201,
    body: billInputSchema,
    response: billSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/bills/:id',
    summary: 'Change a draft bill, and optionally submit it',
    auth: 'bearer',
    permission: 'purchase.bill.manage',
    status: 200,
    params: billParamsSchema,
    body: updateBillInputSchema,
    response: billSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/bills/:id',
    summary: 'Delete a draft bill that was never submitted',
    auth: 'bearer',
    permission: 'purchase.bill.manage',
    status: 204,
    params: billParamsSchema,
    query: deleteBillQuerySchema,
    response: z.void(),
  }),
  // The first submit gives the number. With no level for its total it is posted at once.
  submit: defineRoute({
    method: 'POST',
    path: '/bills/:id/submit',
    summary: 'Submit a draft bill: posted at once, or when its last approval is given',
    auth: 'bearer',
    permission: 'purchase.bill.manage',
    status: 200,
    params: billParamsSchema,
    body: billVersionInputSchema,
    response: billSchema,
  }),
  reopen: defineRoute({
    method: 'POST',
    path: '/bills/:id/reopen',
    summary: 'Take a bill waiting for approval back to draft',
    auth: 'bearer',
    permission: 'purchase.bill.manage',
    status: 200,
    params: billParamsSchema,
    body: billVersionInputSchema,
    response: billSchema,
  }),
  cancel: defineRoute({
    method: 'POST',
    path: '/bills/:id/cancel',
    summary: 'Cancel a numbered bill that was not posted',
    auth: 'bearer',
    permission: 'purchase.bill.manage',
    status: 200,
    params: billParamsSchema,
    body: billVersionInputSchema,
    response: billSchema,
  }),
};
