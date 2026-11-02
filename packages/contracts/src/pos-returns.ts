import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema, shiftIsoDate } from './journal.js';
import {
  addMoney,
  compareMoney,
  isMoneyAmount,
  prorateMoney,
  subtractMoney,
  sumMoney,
} from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import {
  MAX_POS_LINES,
  MAX_POS_PAYMENTS,
  POS_NUMBER_PADDING,
  POS_PAYMENT_METHODS,
  POS_TENDERS,
  type PosPaymentMethod,
} from './pos.js';
import {
  addQuantity,
  compareQuantity,
  isQuantity,
  quantitySchema,
  subtractQuantity,
} from './quantities.js';
import { positiveAmountSchema } from './receipts.js';
import { taxRateRefSchema } from './sales.js';
import {
  documentSerialRules,
  MAX_SERIALS_PER_LINE,
  serialNumberSchema,
  stockLineRules,
  variantRefSchema,
} from './stock.js';

// Step 20c: returns at a POS counter. A customer brings goods back with the receipt; the cashier
// scans or types its number, ticks what came back, and pays the money back. A return is a document
// of its own (POS1-R000012): the sale never changes (20a), and its page lists the returns of it.
//
//   the sale    online, any register's sale, asked from the server by its number; offline, a sale of
//               this register from the last POS_SALES_ON_DEVICE_DAYS days, from the device's copy
//               (the pos_sale rows, sync.ts), or one still in its outbox. Never more of a line than
//               it sold less what earlier returns took back, at the price it was sold for: each
//               line's own net and VAT, after its share of the bill's discount (posReturnAmounts).
//   the money   back in cash, or by a way the sale was paid (card, bKash, Nagad), split if need be,
//               always the return's whole total. Or an exchange (you chose this): the money pays
//               for a new sale at once, so it never leaves the drawer and comes back. The return and
//               its new sale are saved together at "Complete sale", the return first; the sale pays
//               with the tender `exchange`, which names the return (pos.ts), and never uses more of
//               the money than it costs: the rest is the return's refund in cash or another way.
//   the goods   back into the register's warehouse (you chose this), whatever register sold them;
//               damaged goods leave it later with a stock adjustment. At what they cost when sold.
//
// The window (you chose this): a register takes goods back for `returnDays` days after the sale
// (0 = the same day). The screen refuses an older sale; the server never does.
//
// Like a sale, a return is done when it reaches the server: the money was paid back. It comes as a
// pos_return.create command (sync.ts) and is posted then, in the shift of the register that took
// the goods back. The server never refuses it for the window, for a quantity more than is left (a
// race between two counters) or for permission: it posts it and writes the audit log. It refuses
// only what someone can put right (a register with no account for a refund's method) and bugs.

// POS1-R000012: the register's code, an R and the return's number in that register's own series,
// 6 digits like a receipt's. A series of its own (you chose this): a return never takes a sale's
// number, and the R tells the two apart on paper.
export function formatReturnNumber(registerCode: string, sequence: number): string {
  return `${registerCode}-R${String(sequence).padStart(POS_NUMBER_PADDING, '0')}`;
}

// How long the device keeps its register's sales for returns without a connection. A register
// that takes goods back for longer finds the older sales online.
export const POS_SALES_ON_DEVICE_DAYS = 30;

// The last day a sale's goods come back at a register: "Returns until 30 Oct 2026"
export function lastReturnDayOf(saleDate: string, returnDays: number): string {
  return shiftIsoDate(saleDate, returnDays);
}

// ISO dates compare as strings
export function isWithinReturnWindow(saleDate: string, today: string, returnDays: number): boolean {
  return lastReturnDayOf(saleDate, returnDays) >= today;
}

// ---------------------------------------------------------------------------------------------
// The arithmetic of a return

// What a line sold, and what earlier returns took back of it, in the line's own unit
interface SoldLine {
  quantity: string;
  net: string;
  vat: string;
  returnedQuantity: string;
}

// Never below zero: a race between two counters may have taken back more than the line sold
export function returnableQuantityOf(
  line: Pick<SoldLine, 'quantity' | 'returnedQuantity'>,
): string {
  const left = subtractQuantity(line.quantity, line.returnedQuantity);
  return compareQuantity(left, '0') > 0 ? left : '0.0000';
}

// The share of `amount` that the first `upTo` of `sold` carry, to the paisa. The whole line is the
// amount itself, not rounded: a line of ৳1,234.5678 is still that when it all comes back.
function shareUpTo(amount: string, upTo: string, sold: string): string {
  if (compareQuantity(upTo, '0') <= 0) return '0.0000';
  if (compareQuantity(upTo, sold) >= 0) return amount;
  return prorateMoney(amount, upTo, sold);
}

// What a return of `quantity` pays back for a line: its share of the line's total and of its VAT,
// as the difference between what the line carries up to the end of this return and up to the start
// of it; the net is what is left of the total after the VAT. Three returns of one piece each of a
// line of 3 at ৳100 give back 33.33, 33.34 and 33.33: they add up to the line, with no paisa lost
// to rounding and none given back twice. The total is shared, not the net and the VAT one by one:
// one shirt of two sold at ৳420 with VAT comes back at ৳420.00, where two rounded parts would make
// it ৳420.01 and the next one ৳419.99. The device works it out from what it knows was returned
// before; the server again, and writes the audit log when the two differ (another counter took
// some back first).
export function posReturnAmounts(
  line: SoldLine,
  quantity: string,
): { net: string; vat: string; total: string } {
  const before = line.returnedQuantity;
  const after = addQuantity(before, quantity);
  const shareOf = (amount: string) =>
    subtractMoney(
      shareUpTo(amount, after, line.quantity),
      shareUpTo(amount, before, line.quantity),
    );
  const total = shareOf(addMoney(line.net, line.vat));
  const vat = shareOf(line.vat);
  return { net: subtractMoney(total, vat), vat, total };
}

// ---------------------------------------------------------------------------------------------
// The sale a return comes from: what the return screen reads, from the server (online) or from
// the device's copy (offline, the pos_sale rows)

export const posReturnableLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  // 'none' | 'batch' | 'serial', z.string() like the product's own
  tracking: z.string(),
  // The line's unit; the quantities below are in it
  unitId: z.uuid(),
  quantity: z.string(),
  baseQuantity: z.string(),
  description: z.string(),
  unitPrice: z.string(),
  taxRate: taxRateRefSchema,
  // After the line's discount and its share of the bill's
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  // What the scanner read at the sale, and which of them came back since
  serialNumbers: z.array(z.string()),
  returnedSerialNumbers: z.array(z.string()),
  // What posted returns took back, in the line's unit
  returnedQuantity: z.string(),
});
export type PosReturnableLine = z.infer<typeof posReturnableLineSchema>;

export const posReturnableSaleSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  // The register it was sold on: any of the workspace's online, this one offline
  registerId: z.uuid(),
  // The day it is in the books: the window counts from it
  date: z.iso.date(),
  soldAt: z.iso.datetime(),
  // null = walk-in. The return is the same customer's.
  customer: partyRefSchema.nullable(),
  pricesIncludeVat: z.boolean(),
  total: z.string(),
  lines: z.array(posReturnableLineSchema),
  // How it was paid: a refund goes back by cash or by one of these (an exchange's money as cash)
  payments: z.array(z.object({ method: z.enum(POS_TENDERS), amount: z.string() })),
});
export type PosReturnableSale = z.infer<typeof posReturnableSaleSchema>;

// The receipt number the cashier scanned or typed: "POS1-000123", in any case
export const posSaleNumberParamsSchema = z.object({
  number: z.string().trim().toUpperCase().min(1).max(30),
});

// ---------------------------------------------------------------------------------------------
// What the device sends (inside a pos_return.create command, sync.ts)

// A device-made amount: never typed, so no empty box; 4 decimals, like the arithmetic gives it
const deviceAmountSchema = z
  .string()
  .refine((value) => isMoneyAmount(value), errorCode('money_format'));

const posReturnLineInputSchema = z
  .object({
    saleLineId: z.uuid(),
    // In the sale line's unit
    quantity: quantitySchema,
    // posReturnAmounts on the device, as the return receipt printed them. The books take these:
    // the money was paid back.
    net: deviceAmountSchema,
    vat: deviceAmountSchema,
    // A serial product: the serial numbers that came back, out of the line's (the screen ticks
    // them). A batch product sends no batch: the goods go back into the batches the line left from.
    serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
  })
  .superRefine(stockLineRules);
export type PosReturnLineInput = z.infer<typeof posReturnLineInputSchema>;

const posRefundInputSchema = z.object({
  method: z.enum(POS_TENDERS),
  amount: positiveAmountSchema('pos_refund_amount_required'),
  // The card's approval code, the bKash TrxID of the money sent back
  reference: optionalText(60),
});
export type PosRefundInput = z.infer<typeof posRefundInputSchema>;

const posReturnFieldsSchema = z.object({
  // The register that took the goods back, and the return's number in its series
  registerId: z.uuid(),
  sequence: z.number().int().min(1),
  // The shift of this register (the cash leaves its drawer), whatever shift the sale was in
  shiftId: z.uuid(),
  // The device's today and the moment, like a sale's: booked on `date`, or the first open day
  date: z.iso.date(),
  returnedAt: z.iso.datetime(),
  saleId: z.uuid(),
  lines: z
    .array(posReturnLineInputSchema)
    .min(1, errorCode('pos_return_lines_required'))
    .max(MAX_POS_LINES),
  // Empty only for a return of ৳0 (a free sample brought back)
  refunds: z.array(posRefundInputSchema).max(MAX_POS_PAYMENTS),
  // "Wrong size, exchanged for L"
  note: optionalText(200),
});

type PosReturnRuleInput = z.output<typeof posReturnFieldsSchema>;

// One line of the sale at most once; the refunds add up to the return's total exactly (there is no
// change to give back); at most one exchange. The amounts are checked only once each is complete,
// and only with a line: with none, "does not add up" would only repeat the error the lines have.
function posReturnRules(input: PosReturnRuleInput, ctx: z.RefinementCtx<PosReturnRuleInput>): void {
  documentSerialRules(input, ctx);
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    if (seen.has(line.saleLineId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'saleLineId'],
        message: errorCode('pos_return_line_twice'),
      });
    }
    seen.add(line.saleLineId);
  });
  const exchanges = input.refunds.filter((refund) => refund.method === 'exchange');
  if (exchanges.length > 1) {
    ctx.addIssue({ code: 'custom', path: ['refunds'], message: errorCode('pos_exchange_invalid') });
  }
  const complete =
    input.lines.length > 0 &&
    input.lines.every(
      (line) => isQuantity(line.quantity) && isMoneyAmount(line.net) && isMoneyAmount(line.vat),
    ) &&
    input.refunds.every((refund) => isMoneyAmount(refund.amount));
  if (!complete) return;
  const total = sumMoney(input.lines.map((line) => addMoney(line.net, line.vat)));
  const refunded = sumMoney(input.refunds.map((refund) => refund.amount));
  if (compareMoney(refunded, total) !== 0) {
    ctx.addIssue({ code: 'custom', path: ['refunds'], message: errorCode('pos_refund_mismatch') });
  }
}

export const posReturnInputSchema = posReturnFieldsSchema.superRefine(posReturnRules);
export type PosReturnInput = z.infer<typeof posReturnInputSchema>;
export type PosReturnFormValues = z.input<typeof posReturnInputSchema>;

// The methods a refund may go back by: cash always, the others only when the sale was paid so (a
// card refund goes back to the card). The money of an exchange came from a return, so it goes
// back as cash. Exchange is not in the list: it is the screen's own button. The device offers
// these; the server takes any method the register has an account for.
export function refundMethodsOf(sale: Pick<PosReturnableSale, 'payments'>): PosPaymentMethod[] {
  const paid = new Set(sale.payments.map((payment) => payment.method));
  return POS_PAYMENT_METHODS.filter((method) => method === 'cash' || paid.has(method));
}

// ---------------------------------------------------------------------------------------------
// What the API sends: the posted returns, for the managers' list and page

export const posReturnSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  register: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  shift: z.object({ id: z.uuid(), number: z.string() }),
  branchId: z.uuid(),
  // The register's warehouse: where the goods came back into
  warehouseId: z.uuid(),
  date: z.iso.date(),
  returnedAt: z.iso.datetime(),
  sale: z.object({ id: z.uuid(), number: z.string(), date: z.iso.date() }),
  // The sale's customer; null = walk-in
  customer: partyRefSchema.nullable(),
  cashier: z.object({ id: z.uuid(), fullName: z.string() }),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  lineCount: z.number().int(),
  // The sale its money paid for; null when it was all paid back
  exchangeSale: z.object({ id: z.uuid(), number: z.string() }).nullable(),
  // It came after the register's window (the server took it anyway, and the audit log says so)
  outsideWindow: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type PosReturnSummary = z.infer<typeof posReturnSummarySchema>;

export const posReturnLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  saleLineId: z.uuid(),
  unitId: z.uuid(),
  quantity: z.string(),
  baseQuantity: z.string(),
  description: z.string(),
  unitPrice: z.string(),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  // The batches it went back into: the ones the sale line left from
  batches: z.array(
    z.object({
      batchId: z.uuid(),
      lotNumber: z.string(),
      expiresOn: z.iso.date().nullable(),
      quantity: z.string(),
    }),
  ),
  serialNumbers: z.array(z.string()),
});
export type PosReturnLine = z.infer<typeof posReturnLineSchema>;

export const posRefundSchema = z.object({
  method: z.enum(POS_TENDERS),
  amount: z.string(),
  reference: z.string().nullable(),
  // The register's account for the method when the return was posted; its exchange account for
  // an exchange
  accountId: z.uuid(),
});
export type PosRefund = z.infer<typeof posRefundSchema>;

export const posReturnSchema = posReturnSummarySchema.extend({
  pricesIncludeVat: z.boolean(),
  note: z.string().nullable(),
  lines: z.array(posReturnLineSchema),
  refunds: z.array(posRefundSchema),
  device: z.object({ id: z.uuid(), name: z.string() }),
  // The money and the stock in the books; null only for a return of ৳0 that cost nothing
  entry: entryRefSchema.nullable(),
});
export type PosReturn = z.infer<typeof posReturnSchema>;

export const posReturnListQuerySchema = pageQuerySchema.extend({
  registerId: z.uuid().optional(),
  saleId: z.uuid().optional(),
  shiftId: z.uuid().optional(),
});
export type PosReturnListQuery = z.input<typeof posReturnListQuerySchema>;

export const posReturnPageSchema = pageOf(posReturnSummarySchema);
export type PosReturnPage = z.infer<typeof posReturnPageSchema>;

const idParamsSchema = z.object({ id: z.uuid() });

// A register's recent sales, read by the device that just took the register (20c.3). Bigger pages
// than a list's: a busy counter sells a few hundred times a day, and a month comes in a few pages.
export const POS_REGISTER_SALES_PAGE = 200;
export const posRegisterSalesQuerySchema = z.object({
  limit: z.coerce.number<number>().int().min(1).max(500).default(POS_REGISTER_SALES_PAGE),
  cursor: z.string().min(1).max(512).optional(),
});
export type PosRegisterSalesQuery = z.input<typeof posRegisterSalesQuerySchema>;

export const posRegisterSalesPageSchema = pageOf(posReturnableSaleSchema);
export type PosRegisterSalesPage = z.infer<typeof posRegisterSalesPageSchema>;

// Reading the returns needs no permission, like the sales. Finding a sale to take back needs
// pos.return.create: the cashier's screen asks it. A return is never written through these routes:
// it arrives as a sync command. A register's recent sales need the cashier's permission, the
// claim's: the device reads them right after it takes the register, because nothing in the change
// log brings them (they were written before this device held it); the pulls keep them up to date
// from then on.
export const posReturnRoutes = {
  registerSales: defineRoute({
    method: 'GET',
    path: '/pos/registers/:id/sales',
    summary: `A register's sales of the last ${String(POS_SALES_ON_DEVICE_DAYS)} days, oldest first`,
    auth: 'bearer',
    permission: 'pos.sale.create',
    status: 200,
    params: idParamsSchema,
    query: posRegisterSalesQuerySchema,
    response: posRegisterSalesPageSchema,
  }),
  returnableSale: defineRoute({
    method: 'GET',
    path: '/pos/sales/by-number/:number',
    summary: 'A POS sale by its receipt number, with what is left to return of each line',
    auth: 'bearer',
    permission: 'pos.return.create',
    status: 200,
    params: posSaleNumberParamsSchema,
    response: posReturnableSaleSchema,
  }),
  listReturns: defineRoute({
    method: 'GET',
    path: '/pos/returns',
    summary: 'POS returns the server has received, newest first',
    auth: 'bearer',
    status: 200,
    query: posReturnListQuerySchema,
    response: posReturnPageSchema,
  }),
  getReturn: defineRoute({
    method: 'GET',
    path: '/pos/returns/:id',
    summary: 'One POS return with its lines, refunds and entry',
    auth: 'bearer',
    status: 200,
    params: idParamsSchema,
    response: posReturnSchema,
  }),
};
