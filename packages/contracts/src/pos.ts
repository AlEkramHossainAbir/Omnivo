import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import {
  addMoney,
  compareMoney,
  includedTaxOf,
  isMoneyAmount,
  isZeroMoney,
  multiplyMoney,
  percentOfMoney,
  priceSchema,
  prorateMoney,
  subtractMoney,
  sumMoney,
} from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { isQuantity } from './quantities.js';
import { positiveAmountSchema } from './receipts.js';
import {
  DISCOUNT_TYPES,
  discountSchema,
  type DiscountType,
  type DocumentTotals,
  type LineAmountInput,
  type LineAmounts,
  salesLineFieldsSchema,
  salesLineRules,
  salesLineSchema,
} from './sales.js';
import {
  documentSerialRules,
  MAX_SERIALS_PER_LINE,
  optionalIdSchema,
  serialNumberSchema,
  stockLineRules,
  variantRefSchema,
} from './stock.js';
import { TAX_RATE_FORMAT } from './tax-rates.js';

// Step 20a: the point of sale. A shop's counter sells for cash, card, bKash or Nagad, with or
// without a connection, and prints a receipt on a thermal printer.
//
// A register is one counter: a code (POS1), the warehouse its goods leave from, and an account for
// each way of paying. A device (one browser, step 18a) works on one register at a time, and only
// one device holds a register: the device gives every sale the register's next number itself
// (POS1-000123), so two devices on one register would give the same number twice. Another device
// takes the register only after it is free (you chose this):
//
//   POST /pos/registers/:id/claim     a device takes a free register (or the one it holds)
//   POST /pos/registers/:id/release   it lets it go: its person signs out, with no sale waiting
//   moving the device to another branch, or revoking it (step 18c), frees it too
//
// A sale is made on the device and kept in its outbox (step 18b) as a pos_sale.create command,
// with the number already on it and the money already taken. The server posts it when the command
// arrives: its journal entry (the money accounts; sales and VAT; the cost of goods and the stock)
// and its stock movements. It never refuses a sale for stock (you chose this): the money was taken
// and the receipt printed, so stock that is not there goes below zero, and the sale is listed as
// "sold short" for someone to put right.

// ---------------------------------------------------------------------------------------------
// Registers

// How a customer pays at the counter. Each register has an account for each one it takes: cash
// always (the change is given in cash), the others only where the shop has the machine or the
// wallet. z.enum in the input, like receipts' methods.
export const POS_PAYMENT_METHODS = ['cash', 'card', 'bkash', 'nagad'] as const;
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];

// The thermal paper's width in millimetres: 58 mm for a small shop's printer, 80 mm for a
// supermarket's. The receipt's layout follows it (@page size).
export const POS_PAPER_WIDTHS = ['58', '80'] as const;
export type PosPaperWidth = (typeof POS_PAPER_WIDTHS)[number];

// POS1-000123: the register's code and the sale's number in it, 6 digits. The series never
// restarts (no year, you chose this), and a register that passes 999999 simply gets 7 digits.
// The device and the server both call this, so the receipt and the books hold the same number.
export const POS_NUMBER_PADDING = 6;

export function formatPosNumber(registerCode: string, sequence: number): string {
  return `${registerCode}-${String(sequence).padStart(POS_NUMBER_PADDING, '0')}`;
}

// The account per method. Cash is always there; null = this register does not take that method.
export const posRegisterAccountsSchema = z.object({
  cash: z.uuid(),
  card: z.uuid().nullable(),
  bkash: z.uuid().nullable(),
  nagad: z.uuid().nullable(),
} satisfies Record<PosPaymentMethod, z.ZodType>);
export type PosRegisterAccounts = z.infer<typeof posRegisterAccountsSchema>;

// The methods a register takes, in the order the pay screen shows them
export function registerMethods(accounts: PosRegisterAccounts): PosPaymentMethod[] {
  return POS_PAYMENT_METHODS.filter((method) => accounts[method] !== null);
}

export const posRegisterSchema = z.object({
  id: z.uuid(),
  // Upper case, part of every receipt number. Never changed after the register is made: a new
  // register with an old code would give numbers an old receipt already has.
  code: z.string(),
  // "Front counter", "Pharmacy counter"
  name: z.string(),
  // The warehouse's branch: whose sale it is in the books, and which devices may take it
  branchId: z.uuid(),
  // Where its goods leave from
  warehouseId: z.uuid(),
  accounts: posRegisterAccountsSchema,
  // The most a cashier may take off without pos.price.override, in percent with 2 places: "10.00"
  maxDiscountPercent: z.string(),
  paperWidth: z.enum(POS_PAPER_WIDTHS),
  // A line or two at the end of the receipt: "Goods once sold are exchanged within 7 days"
  receiptFooter: z.string().nullable(),
  // The device that holds it now; null = free
  deviceId: z.uuid().nullable(),
  // The highest number the server has received from it; 0 = none yet. A device that takes the
  // register goes on from here.
  lastNumber: z.number().int().min(0),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type PosRegister = z.infer<typeof posRegisterSchema>;

// A register as the settings list shows it: who holds it, by name
export const posRegisterListItemSchema = posRegisterSchema.extend({
  holder: z.object({ deviceName: z.string(), userName: z.string() }).nullable(),
});
export type PosRegisterListItem = z.infer<typeof posRegisterListItemSchema>;

// A shop has a few counters, a supermarket a few dozen: the whole list at once
export const posRegisterListSchema = z.object({ items: z.array(posRegisterListItemSchema) });

// Like a number series' prefix (numbering.ts): a capital letter first, up to 8 letters and digits,
// no hyphen, because the hyphen separates the code from the number
const registerCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,7}$/, errorCode('pos_register_code_format'));

// 0 to 100, at most 2 decimals. '' (an empty box) = 0: no discount without the permission.
const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;

const discountLimitSchema = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || (PERCENT.test(value) && compareMoney(value, '100') <= 0),
    errorCode('pos_discount_limit_format'),
  )
  .transform((value) => (value === '' ? '0' : value));

const registerFieldsSchema = z.object({
  name: z.string().trim().min(2, errorCode('pos_register_name_required')).max(60),
  // The form's empty select sends '' — "not chosen", with its own message
  warehouseId: z.uuid(errorCode('pos_register_warehouse_invalid')),
  accounts: z.object({
    cash: z.uuid(errorCode('pos_register_cash_required')),
    card: optionalIdSchema,
    bkash: optionalIdSchema,
    nagad: optionalIdSchema,
  } satisfies Record<PosPaymentMethod, z.ZodType>),
  maxDiscountPercent: discountLimitSchema,
  paperWidth: z.enum(POS_PAPER_WIDTHS),
  receiptFooter: optionalText(200),
});

export const posRegisterInputSchema = registerFieldsSchema.extend({ code: registerCodeSchema });
export type PosRegisterInput = z.infer<typeof posRegisterInputSchema>;
export type PosRegisterFormValues = z.input<typeof posRegisterInputSchema>;

// No code: it is on every receipt the register printed
export const updatePosRegisterInputSchema = registerFieldsSchema.extend({
  version: versionSchema,
});
export type UpdatePosRegisterInput = z.infer<typeof updatePosRegisterInputSchema>;
export type UpdatePosRegisterFormValues = z.input<typeof updatePosRegisterInputSchema>;

export const posRegisterVersionInputSchema = z.object({ version: versionSchema });

// The device that takes or lets go of the register: the person's own, in this workspace
export const posRegisterDeviceInputSchema = z.object({ deviceId: z.uuid() });
export type PosRegisterDeviceInput = z.infer<typeof posRegisterDeviceInputSchema>;

export const POS_REGISTER_STATUSES = ['active', 'archived'] as const;
export type PosRegisterStatus = (typeof POS_REGISTER_STATUSES)[number];

export const posRegisterListQuerySchema = z.object({
  status: z.enum(POS_REGISTER_STATUSES).default('active'),
  branchId: z.uuid().optional(),
});
export type PosRegisterListQuery = z.input<typeof posRegisterListQuerySchema>;

// ---------------------------------------------------------------------------------------------
// The arithmetic of a sale

// A sale's lines are worked out like any sales line (sales.ts → lineAmounts), with one more thing:
// a discount on the whole bill ("10% off today", "৳50 off to make it round"). It is shared out over
// the lines in proportion to what each line is after its own discount, to the paisa, so each line
// still has its own VAT. The VAT is worked out after both discounts: what the customer paid less.
//   billDiscount  the line's share of the bill's discount
//   net, vat, total  after both discounts
export interface PosLineAmounts extends LineAmounts {
  billDiscount: string;
}

export interface PosSaleTotals extends DocumentTotals {
  // discount = the lines' own discounts; billDiscount = the bill's, worked out in taka
  billDiscount: string;
}

export interface BillDiscount {
  type: DiscountType;
  // '0' for none; a percent or an amount, with at most 2 decimals
  value: string;
}

// The bill's discount in taka, before it is shared out
function billDiscountAmount(base: string, bill: BillDiscount): string {
  return bill.type === 'percent' ? percentOfMoney(base, bill.value) : sumMoney([bill.value]);
}

// `amount` shared out over `weights`, adding up to it exactly. The rounding left over goes to the
// biggest weight: on the last line it could take a paisa off a line of ৳0 and make it negative.
function shareOut(amount: string, weights: readonly string[]): string[] {
  const whole = sumMoney(weights);
  if (isZeroMoney(amount) || isZeroMoney(whole)) return weights.map(() => '0.0000');
  const shares = weights.map((weight) => prorateMoney(amount, weight, whole));
  let biggest = 0;
  weights.forEach((weight, index) => {
    if (compareMoney(weight, weights[biggest] ?? '0') > 0) biggest = index;
  });
  const others = sumMoney(shares.filter((_, index) => index !== biggest));
  shares[biggest] = subtractMoney(amount, others);
  return shares;
}

export function posSaleAmounts(
  lines: readonly LineAmountInput[],
  bill: BillDiscount,
  pricesIncludeVat: boolean,
): { lines: PosLineAmounts[]; totals: PosSaleTotals } {
  const firsts = lines.map((line) => {
    const gross = multiplyMoney(line.quantity, line.unitPrice);
    const discount =
      line.discountType === 'percent'
        ? percentOfMoney(gross, line.discount)
        : sumMoney([line.discount]);
    return { gross, discount, after: subtractMoney(gross, discount) };
  });
  const afters = firsts.map((line) => line.after);
  const shares = shareOut(billDiscountAmount(sumMoney(afters), bill), afters);
  const amounts = firsts.map((first, index): PosLineAmounts => {
    const rate = lines[index]?.rate ?? '0';
    const billDiscount = shares[index] ?? '0.0000';
    const paid = subtractMoney(first.after, billDiscount);
    const base = { gross: first.gross, discount: first.discount, billDiscount };
    if (pricesIncludeVat) {
      const vat = includedTaxOf(paid, rate);
      return { ...base, net: subtractMoney(paid, vat), vat, total: paid };
    }
    const vat = percentOfMoney(paid, rate);
    return { ...base, net: paid, vat, total: addMoney(paid, vat) };
  });
  return {
    lines: amounts,
    totals: {
      discount: sumMoney(amounts.map((line) => line.discount)),
      billDiscount: sumMoney(amounts.map((line) => line.billDiscount)),
      net: sumMoney(amounts.map((line) => line.net)),
      vat: sumMoney(amounts.map((line) => line.vat)),
      total: sumMoney(amounts.map((line) => line.total)),
    },
  };
}

interface PaymentFields {
  method: PosPaymentMethod;
  amount: string;
}

// The change given back: what was paid less the total, never below zero. Only cash gives change
// (posSaleRules), so this always comes out of the cash.
export function posChangeOf(payments: readonly PaymentFields[], total: string): string {
  const change = subtractMoney(sumMoney(payments.map((payment) => payment.amount)), total);
  return compareMoney(change, '0') > 0 ? change : '0.0000';
}

// What a cashier did that needs pos.price.override (decision 11): a price other than the one the
// line started with, or a discount above the register's limit, on a line or on the bill. The device
// asks for the permission before the sale; the server writes the same list to the audit log, and
// never refuses the sale for it (the money was taken).
export type PosOverride =
  { kind: 'price'; line: number } | { kind: 'discount'; line: number } | { kind: 'bill_discount' };

interface OverrideLine {
  quantity: string;
  unitPrice: string;
  discountType: DiscountType;
  discount: string;
  // The price the line started with on the device (startingPrice in sales.ts); null = there was
  // none and the cashier typed it, which is not an override
  startingPrice: string | null;
}

// Over the limit = more taka off than the limit's percent of what it comes off
function overLimit(off: string, of: string, limit: string): boolean {
  return compareMoney(off, percentOfMoney(of, limit)) > 0;
}

export function posOverridesOf(
  sale: { lines: readonly OverrideLine[]; billDiscountType: DiscountType; billDiscount: string },
  maxDiscountPercent: string,
): PosOverride[] {
  const overrides: PosOverride[] = [];
  const afters: string[] = [];
  sale.lines.forEach((line, index) => {
    if (line.startingPrice !== null && compareMoney(line.unitPrice, line.startingPrice) !== 0) {
      overrides.push({ kind: 'price', line: index });
    }
    const gross = multiplyMoney(line.quantity, line.unitPrice);
    const off =
      line.discountType === 'percent'
        ? percentOfMoney(gross, line.discount)
        : sumMoney([line.discount]);
    if (overLimit(off, gross, maxDiscountPercent))
      overrides.push({ kind: 'discount', line: index });
    afters.push(subtractMoney(gross, off));
  });
  const base = sumMoney(afters);
  const bill = billDiscountAmount(base, { type: sale.billDiscountType, value: sale.billDiscount });
  if (overLimit(bill, base, maxDiscountPercent)) overrides.push({ kind: 'bill_discount' });
  return overrides;
}

// ---------------------------------------------------------------------------------------------
// What the device sends (inside a pos_sale.create command, sync.ts)

// A counter sale runs to a few dozen items; a supermarket's monthly shopping to a hundred or so
export const MAX_POS_LINES = 200;

// Cash and a card, or bKash with the rest in cash: a few at most
export const MAX_POS_PAYMENTS = 6;

const posLineInputSchema = salesLineFieldsSchema
  .extend({
    // The VAT rate the device used, in percent ("15.00"): the receipt was printed with it, so the
    // server works the sale out with the same rate, also when the rate was changed meanwhile
    rate: z.string().regex(TAX_RATE_FORMAT, errorCode('tax_rate_format')),
    // The price the line started with on the device (posOverridesOf). '' or null = none.
    startingPrice: priceSchema,
    // A batch product: the batch the device took it from (FEFO from its copy). '' = none.
    batchId: optionalIdSchema,
    // A serial product: what the scanner read, one per base unit
    serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
  })
  .superRefine((line, ctx) => {
    salesLineRules(line, ctx);
    stockLineRules(line, ctx);
  });
export type PosLineInput = z.infer<typeof posLineInputSchema>;
export type PosLineFormValues = z.input<typeof posLineInputSchema>;

const posPaymentInputSchema = z.object({
  method: z.enum(POS_PAYMENT_METHODS),
  amount: positiveAmountSchema('pos_payment_amount_required'),
  // The card's last 4 digits or the approval code, the bKash or Nagad TrxID
  reference: optionalText(60),
});
export type PosPaymentInput = z.infer<typeof posPaymentInputSchema>;

const posSaleFieldsSchema = z.object({
  // The register it was sold on, and its number in that register's series (formatPosNumber)
  registerId: z.uuid(),
  sequence: z.number().int().min(1),
  // The device's today in the workspace's time zone, and the moment, by the device's clock. The
  // receipt prints them. The server books the sale on `date`, unless the date is after the server's
  // own today (a clock set ahead) or in a closed period (step 11): then on the first day it can.
  date: z.iso.date(),
  soldAt: z.iso.datetime(),
  // null = a walk-in customer (you chose this): the whole amount is paid now, so nobody owes
  // anything and the sale needs no customer. '' from the form is a walk-in too.
  customerId: optionalIdSchema,
  // The device's copy of the workspace setting when the sale was made, like an order keeps it
  pricesIncludeVat: z.boolean(),
  lines: z.array(posLineInputSchema).min(1, errorCode('sales_lines_required')).max(MAX_POS_LINES),
  billDiscountType: z.enum(DISCOUNT_TYPES),
  billDiscount: discountSchema,
  payments: z
    .array(posPaymentInputSchema)
    .min(1, errorCode('pos_payments_required'))
    .max(MAX_POS_PAYMENTS),
});

type PosSaleRuleInput = z.output<typeof posSaleFieldsSchema>;

// The rules below work the sale out, so they wait until every box they read is complete. Zod runs
// an object's refinement even when one of its fields failed a format check, and the arithmetic
// throws on "15%"; with no payment at all, "pays less than the total" would only repeat the error
// the payments already have.
function isComplete(input: PosSaleRuleInput): boolean {
  return (
    isMoneyAmount(input.billDiscount) &&
    input.payments.length > 0 &&
    input.payments.every((payment) => isMoneyAmount(payment.amount)) &&
    input.lines.every(
      (line) =>
        isQuantity(line.quantity) &&
        isMoneyAmount(line.unitPrice) &&
        isMoneyAmount(line.discount) &&
        TAX_RATE_FORMAT.test(line.rate),
    )
  );
}

// The rules of the whole sale: the bill's discount not more than the bill, the money paid at least
// the total, and change only from cash (a card is charged the exact amount). They read the device's
// own rates, so the same rules hold on the device before the sale and on the server after it.
function posSaleRules(input: PosSaleRuleInput, ctx: z.RefinementCtx<PosSaleRuleInput>): void {
  documentSerialRules(input, ctx);
  if (!isComplete(input)) return;
  const afters = input.lines.map((line) => {
    const gross = multiplyMoney(line.quantity, line.unitPrice);
    return line.discountType === 'percent'
      ? subtractMoney(gross, percentOfMoney(gross, line.discount))
      : subtractMoney(gross, line.discount);
  });
  const limit = input.billDiscountType === 'percent' ? '100' : sumMoney(afters);
  if (compareMoney(input.billDiscount, limit) > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['billDiscount'],
      message: errorCode('sales_discount_too_large'),
    });
    return;
  }
  const { totals } = posSaleAmounts(
    input.lines,
    { type: input.billDiscountType, value: input.billDiscount },
    input.pricesIncludeVat,
  );
  const paid = sumMoney(input.payments.map((payment) => payment.amount));
  if (compareMoney(paid, totals.total) < 0) {
    ctx.addIssue({ code: 'custom', path: ['payments'], message: errorCode('pos_payment_short') });
  }
  const notCash = input.payments.filter((payment) => payment.method !== 'cash');
  if (compareMoney(sumMoney(notCash.map((payment) => payment.amount)), totals.total) > 0) {
    ctx.addIssue({ code: 'custom', path: ['payments'], message: errorCode('pos_change_not_cash') });
  }
}

export const posSaleInputSchema = posSaleFieldsSchema.superRefine(posSaleRules);
export type PosSaleInput = z.infer<typeof posSaleInputSchema>;
export type PosSaleFormValues = z.input<typeof posSaleInputSchema>;

// ---------------------------------------------------------------------------------------------
// What the API sends: the posted sales, for the managers' list and page

export const posSaleSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  register: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  branchId: z.uuid(),
  warehouseId: z.uuid(),
  // The day it is in the books (see posSaleInputSchema), and when it was sold by the device's clock
  date: z.iso.date(),
  soldAt: z.iso.datetime(),
  // null = walk-in
  customer: partyRefSchema.nullable(),
  cashier: z.object({ id: z.uuid(), fullName: z.string() }),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  lineCount: z.number().int(),
  // A line went below zero when it was posted: it is on the "Sold short" list
  soldShort: z.boolean(),
  // When the server received it
  createdAt: z.iso.datetime(),
});
export type PosSaleSummary = z.infer<typeof posSaleSummarySchema>;

export const posSaleLineSchema = salesLineSchema.extend({
  // The line's share of the bill's discount (posSaleAmounts); net, vat and total are after it
  billDiscount: z.string(),
  // The price it started with on the device; differs from unitPrice when the cashier changed it
  startingPrice: z.string().nullable(),
  // The batch it left from: the device's, and the others it took when that one was short
  batches: z.array(
    z.object({
      batchId: z.uuid(),
      lotNumber: z.string(),
      expiresOn: z.iso.date().nullable(),
      quantity: z.string(),
    }),
  ),
  serialNumbers: z.array(z.string()),
  // What the warehouse did not have when it was posted, in the base unit; "0.0000" = none
  shortQuantity: z.string(),
});
export type PosSaleLine = z.infer<typeof posSaleLineSchema>;

export const posSalePaymentSchema = z.object({
  method: z.enum(POS_PAYMENT_METHODS),
  amount: z.string(),
  reference: z.string().nullable(),
  // The register's account for the method when the sale was posted
  accountId: z.uuid(),
});
export type PosSalePayment = z.infer<typeof posSalePaymentSchema>;

export const posSaleSchema = posSaleSummarySchema.extend({
  pricesIncludeVat: z.boolean(),
  // The lines' own discounts, and the bill's discount as typed and in taka
  discount: z.string(),
  billDiscountType: z.enum(DISCOUNT_TYPES),
  billDiscount: z.string(),
  billDiscountAmount: z.string(),
  // What was paid, and the change given back in cash (posChangeOf)
  paid: z.string(),
  change: z.string(),
  lines: z.array(posSaleLineSchema),
  payments: z.array(posSalePaymentSchema),
  // The device it was sold on (its name now)
  device: z.object({ id: z.uuid(), name: z.string() }),
  // The sale, its cost and its stock in the books; null only for a sale of ৳0 that cost nothing
  entry: entryRefSchema.nullable(),
});
export type PosSale = z.infer<typeof posSaleSchema>;

export const posSaleListQuerySchema = pageQuerySchema.extend({
  registerId: z.uuid().optional(),
  customerId: z.uuid().optional(),
});
export type PosSaleListQuery = z.input<typeof posSaleListQuerySchema>;

export const posSalePageSchema = pageOf(posSaleSummarySchema);
export type PosSalePage = z.infer<typeof posSalePageSchema>;

// One line that went below zero, for the "Sold short" list under Inventory: what was sold that the
// warehouse did not have, as the server saw it when the sale arrived
export const soldShortItemSchema = variantRefSchema.extend({
  // The sale's line: one sale may sell the same item short on two lines (two prices), so the list
  // needs the line to tell its rows apart (20a.6b)
  lineId: z.uuid(),
  saleId: z.uuid(),
  saleNumber: z.string(),
  date: z.iso.date(),
  warehouseId: z.uuid(),
  // In the base unit
  shortQuantity: z.string(),
  // The batch it went below zero on; null for a product without batches
  lotNumber: z.string().nullable(),
  // Serial numbers the scanner read that were not in this warehouse: they left without a serial
  serialNumbers: z.array(z.string()),
  // The variant's stock in that warehouse now: back at zero or above once someone put it right
  onHandNow: z.string(),
});
export type SoldShortItem = z.infer<typeof soldShortItemSchema>;

export const soldShortQuerySchema = pageQuerySchema.extend({ warehouseId: z.uuid().optional() });
export type SoldShortQuery = z.input<typeof soldShortQuerySchema>;

export const soldShortPageSchema = pageOf(soldShortItemSchema);
export type SoldShortPage = z.infer<typeof soldShortPageSchema>;

const posParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like warehouses and every sales document. Registers are set up with
// pos.register.manage; taking one needs pos.sale.create, the cashier's permission. Letting go has
// no permission on the route: only the device's own person may, and the service checks it.
// A sale is never written through these routes: it arrives as a sync command (sync.ts).
export const posRoutes = {
  listRegisters: defineRoute({
    method: 'GET',
    path: '/pos/registers',
    summary: 'The POS registers (counters) of the workspace',
    auth: 'bearer',
    status: 200,
    query: posRegisterListQuerySchema,
    response: posRegisterListSchema,
  }),
  getRegister: defineRoute({
    method: 'GET',
    path: '/pos/registers/:id',
    summary: 'One POS register, with its last number',
    auth: 'bearer',
    status: 200,
    params: posParamsSchema,
    response: posRegisterSchema,
  }),
  createRegister: defineRoute({
    method: 'POST',
    path: '/pos/registers',
    summary: 'Add a POS register: a counter with its warehouse and payment accounts',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 201,
    body: posRegisterInputSchema,
    response: posRegisterSchema,
  }),
  updateRegister: defineRoute({
    method: 'PUT',
    path: '/pos/registers/:id',
    summary: "Change a POS register's name, warehouse, accounts, discount limit or receipt",
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: posParamsSchema,
    body: updatePosRegisterInputSchema,
    response: posRegisterSchema,
  }),
  archiveRegister: defineRoute({
    method: 'POST',
    path: '/pos/registers/:id/archive',
    summary: 'Stop using a POS register; refused while a device holds it',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: posParamsSchema,
    body: posRegisterVersionInputSchema,
    response: posRegisterSchema,
  }),
  restoreRegister: defineRoute({
    method: 'POST',
    path: '/pos/registers/:id/restore',
    summary: 'Bring an archived POS register back',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: posParamsSchema,
    body: posRegisterVersionInputSchema,
    response: posRegisterSchema,
  }),
  claimRegister: defineRoute({
    method: 'POST',
    path: '/pos/registers/:id/claim',
    summary: 'This device takes a free register; it numbers its sales from the last number on',
    auth: 'bearer',
    permission: 'pos.sale.create',
    status: 200,
    params: posParamsSchema,
    body: posRegisterDeviceInputSchema,
    response: posRegisterSchema,
  }),
  releaseRegister: defineRoute({
    method: 'POST',
    path: '/pos/registers/:id/release',
    summary: 'This device lets go of its register, so another device can take it',
    auth: 'bearer',
    status: 200,
    params: posParamsSchema,
    body: posRegisterDeviceInputSchema,
    response: posRegisterSchema,
  }),
  listSales: defineRoute({
    method: 'GET',
    path: '/pos/sales',
    summary: 'POS sales the server has received, newest first',
    auth: 'bearer',
    status: 200,
    query: posSaleListQuerySchema,
    response: posSalePageSchema,
  }),
  getSale: defineRoute({
    method: 'GET',
    path: '/pos/sales/:id',
    summary: 'One POS sale with its lines, payments and entry',
    auth: 'bearer',
    status: 200,
    params: posParamsSchema,
    response: posSaleSchema,
  }),
  soldShort: defineRoute({
    method: 'GET',
    path: '/pos/sold-short',
    summary: 'POS sale lines that took stock below zero, newest first',
    auth: 'bearer',
    status: 200,
    query: soldShortQuerySchema,
    response: soldShortPageSchema,
  }),
};
