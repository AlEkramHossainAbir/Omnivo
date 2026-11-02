import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema } from './journal.js';
import {
  absMoney,
  addMoney,
  compareMoney,
  multiplyMoney,
  subtractMoney,
  sumMoney,
} from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { POS_SHIFT_STATUSES, POS_TENDERS, type PosTender } from './pos.js';
import { positiveAmountSchema } from './receipts.js';
import { optionalIdSchema } from './stock.js';

// Step 20b: shifts at a POS counter. A shift is one cashier on one device at one register, from
// the count of the drawer at the start to the count at the end. A register sells only inside a
// shift, and has one open shift at a time (you chose this).
//
//   open    the cashier counts the drawer (by notes or as a total). The count is compared with
//           what the last shift left in it (posLastShiftSchema.cashLeft); a difference posts to
//           the register's over/short account. A register's first shift has nothing to compare
//           with: its count is the float, and comes in from the account of an "in" reason the
//           cashier picks ("Float from safe", you chose this).
//   during  sales (pos.ts), and money put in or taken out with a reason (pay in, pay out). The
//           reason says which account the money comes from or goes to; the cashier never picks an
//           account. Cash sent to the bank is a pay out too: counted cash stays in the register's
//           cash account until a pay out moves it (you chose this).
//   close   the cashier counts the drawer again without seeing what it should hold (a blind
//           count). Only then does the screen show the expected cash and the difference, and the
//           close is final (you chose this). The difference posts to over/short by itself; one
//           bigger than the register's varianceAlert rings a bell to the managers.
//
// It all happens on the device, offline too, as three sync commands (sync.ts): pos_shift.open,
// pos_cash_movement.create and pos_shift.close. The device numbers its shifts itself, like its
// sales, because only the device that holds a register works on it. The server posts each command
// when it arrives and never refuses one for money or for permission: the money was counted or
// moved already. A shift that nobody can close (a lost device, a cashier gone home) is closed
// without a count: by a revoke of its device, or online by someone with pos.shift.manage.
//
// Step 20c: a return in the shift pays money back (pos-returns.ts), so the drawer should hold less
// by its cash refunds. And a shift prints two reports on the receipt printer (you chose this): the
// X report at any time while it is open, from the device's own data, offline too; the Z report
// after the close, from the close's result and from the shift's page. The X report is blind like
// the count: it says what was sold and paid back, never what the drawer should hold.

// POS1-S0042: the register's code, an S and the shift's number in that register, 4 digits (a
// receipt has 6 and no S, so the two never look alike). Like a receipt number (formatPosNumber),
// it never restarts and simply grows a digit after 9999.
export const POS_SHIFT_PADDING = 4;

export function formatShiftNumber(registerCode: string, sequence: number): string {
  return `${registerCode}-S${String(sequence).padStart(POS_SHIFT_PADDING, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Pay in and pay out reasons (Settings → POS, pos.register.manage)

// in = money put into the drawer (a float from the safe, change from the bank); out = money taken
// out (a bank deposit, tea for the staff, a delivery boy's fare)
export const POS_CASH_DIRECTIONS = ['in', 'out'] as const;
export type PosCashDirection = (typeof POS_CASH_DIRECTIONS)[number];

export const posCashReasonSchema = z.object({
  id: z.uuid(),
  // "Bank deposit", "Tea and snacks", "Float from safe"
  name: z.string(),
  // Never changes: a pay in turned into a pay out would change the meaning of every movement made
  // with it. A reason the other way is a new reason.
  direction: z.enum(POS_CASH_DIRECTIONS),
  // The other side of the cash: a bank or safe account, or an expense. It may change; a movement
  // keeps the account it was posted to.
  accountId: z.uuid(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type PosCashReason = z.infer<typeof posCashReasonSchema>;

// A shop has a handful; the whole list at once
export const posCashReasonListSchema = z.object({ items: z.array(posCashReasonSchema) });

const reasonFieldsSchema = z.object({
  name: z.string().trim().min(2, errorCode('pos_reason_name_required')).max(60),
  // The form's empty select sends '' — "not chosen", with its own message. The server checks it is
  // an active account that is not a group, and not one a document keeps per party or the inventory
  // account (pos_reason_account_invalid): a pay out names no customer and moves no stock.
  accountId: z.uuid(errorCode('pos_reason_account_invalid')),
});

export const posCashReasonInputSchema = reasonFieldsSchema.extend({
  direction: z.enum(POS_CASH_DIRECTIONS),
});
export type PosCashReasonInput = z.infer<typeof posCashReasonInputSchema>;
export type PosCashReasonFormValues = z.input<typeof posCashReasonInputSchema>;

// No direction: it never changes
export const updatePosCashReasonInputSchema = reasonFieldsSchema.extend({
  version: versionSchema,
});
export type UpdatePosCashReasonInput = z.infer<typeof updatePosCashReasonInputSchema>;
export type UpdatePosCashReasonFormValues = z.input<typeof updatePosCashReasonInputSchema>;

export const posCashReasonVersionInputSchema = z.object({ version: versionSchema });

export const POS_CASH_REASON_STATUSES = ['active', 'archived'] as const;

export const posCashReasonListQuerySchema = z.object({
  status: z.enum(POS_CASH_REASON_STATUSES).default('active'),
});
export type PosCashReasonListQuery = z.input<typeof posCashReasonListQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Counting the drawer

// The notes and coins of the taka, biggest first, as the count's boxes show them
export const CASH_DENOMINATIONS = [
  '1000',
  '500',
  '200',
  '100',
  '50',
  '20',
  '10',
  '5',
  '2',
  '1',
] as const;
export type CashDenomination = (typeof CASH_DENOMINATIONS)[number];

// A supermarket's drawer at the end of Eid shopping holds a few thousand notes of one kind at most
export const MAX_NOTES = 99_999;

// How many of each note. A count is counted, never added up like money, so it is a number.
const noteCount = z.number().int().min(0).max(MAX_NOTES);

export const cashNotesSchema = z.object({
  '1000': noteCount,
  '500': noteCount,
  '200': noteCount,
  '100': noteCount,
  '50': noteCount,
  '20': noteCount,
  '10': noteCount,
  '5': noteCount,
  '2': noteCount,
  '1': noteCount,
} satisfies Record<CashDenomination, z.ZodType>);
export type CashNotes = z.infer<typeof cashNotesSchema>;

// What the notes add up to, with 4 decimals like every amount
export function cashNotesTotal(notes: CashNotes): string {
  return sumMoney(
    CASH_DENOMINATIONS.map((denomination) =>
      multiplyMoney(String(notes[denomination]), denomination),
    ),
  );
}

// Taka with up to 2 decimals: a drawer holds no tenth of a paisa. 0 is a count (an empty drawer).
const CASH_TOTAL = /^\d{1,12}(?:\.\d{1,2})?$/;

// A count, by notes or as a total (you chose both). By notes, the device sends the notes and their
// total, and the total must be theirs; as a total, notes is null. The API sends it back the same
// way, so the shift's page shows the notes that were counted.
export const cashCountSchema = z
  .object({
    notes: cashNotesSchema.nullable(),
    total: z
      .string()
      .trim()
      .refine((value) => value !== '', errorCode('pos_count_required'))
      .refine((value) => value === '' || CASH_TOTAL.test(value), errorCode('money_format')),
  })
  .superRefine((count, ctx) => {
    if (count.notes === null || !CASH_TOTAL.test(count.total)) return;
    if (compareMoney(count.total, cashNotesTotal(count.notes)) !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['total'],
        message: errorCode('pos_count_total_mismatch'),
      });
    }
  });
export type CashCount = z.infer<typeof cashCountSchema>;
export type CashCountFormValues = z.input<typeof cashCountSchema>;

// ---------------------------------------------------------------------------------------------
// The arithmetic of a shift. The device works it out from its own sales and movements (one device
// per shift, so it has them all) for the close's result screen; the server works it out again when
// the close arrives, and its number is the one in the books.

export interface ShiftCash {
  // The opening count
  opening: string;
  // Cash the sales took in, and the change they gave back
  cashTaken: string;
  changeGiven: string;
  // Pay ins and pay outs
  paidIn: string;
  paidOut: string;
  // Step 20c: cash the returns paid back (an exchange's money never leaves the drawer)
  cashRefunded: string;
}

// What the drawer should hold. The float of a register's first shift is its opening count, not a
// pay in, so it is counted once.
export function expectedCashOf(cash: ShiftCash): string {
  return subtractMoney(
    addMoney(addMoney(cash.opening, cash.cashTaken), cash.paidIn),
    sumMoney([cash.changeGiven, cash.paidOut, cash.cashRefunded]),
  );
}

// Counted less expected: above zero = over (more cash than there should be), below = short
export function cashDifferenceOf(counted: string, expected: string): string {
  return subtractMoney(counted, expected);
}

// A difference rings the bell when it is bigger than the register's limit, either way. ৳500 short
// at a limit of ৳500 is the limit, and not over it.
export function isOverVarianceAlert(difference: string, varianceAlert: string): boolean {
  return compareMoney(absMoney(difference), varianceAlert) > 0;
}

// ---------------------------------------------------------------------------------------------
// What the device sends (inside the three commands, sync.ts)

// The held carts of a shift (decision 10: on the device only). The close drops them and says how
// many, for the audit log.
export const MAX_HELD_CARTS = 20;

// An amount the device worked out, which may be below zero only through a bug; 4 decimals
const SIGNED_MONEY = /^-?\d{1,15}(?:\.\d{1,4})?$/;

export const posShiftOpenInputSchema = z.object({
  registerId: z.uuid(),
  // Its number in the register's series (formatShiftNumber)
  sequence: z.number().int().min(1),
  // The device's today in the workspace's time zone and the moment, like a sale's: the opening
  // difference (or the float) is booked on `date`, or on the first open day after it
  date: z.iso.date(),
  openedAt: z.iso.datetime(),
  opening: cashCountSchema,
  // A register's first shift only: the "in" reason its float came by. '' or null on any later
  // shift, and on a first shift that starts with an empty drawer.
  floatReasonId: optionalIdSchema,
});
export type PosShiftOpenInput = z.infer<typeof posShiftOpenInputSchema>;
export type PosShiftOpenFormValues = z.input<typeof posShiftOpenInputSchema>;

export const posCashMovementInputSchema = z.object({
  shiftId: z.uuid(),
  // The form's empty select sends '' — "pick a reason"
  reasonId: z.uuid(errorCode('pos_reason_required')),
  amount: positiveAmountSchema('pos_cash_amount_required'),
  // "Deposit slip 0042, DBBL Dhanmondi", "Fare for the Uttara delivery"
  note: optionalText(200),
  date: z.iso.date(),
  movedAt: z.iso.datetime(),
});
export type PosCashMovementInput = z.infer<typeof posCashMovementInputSchema>;
export type PosCashMovementFormValues = z.input<typeof posCashMovementInputSchema>;

export const posShiftCloseInputSchema = z.object({
  date: z.iso.date(),
  closedAt: z.iso.datetime(),
  counted: cashCountSchema,
  // What the device expected (expectedCashOf), as its result screen showed it. The server works it
  // out again; when the two differ, the audit log says so (a sale missing from one of them).
  deviceExpected: z.string().regex(SIGNED_MONEY),
  // How many held carts the close dropped
  heldDropped: z.number().int().min(0).max(MAX_HELD_CARTS),
});
export type PosShiftCloseInput = z.infer<typeof posShiftCloseInputSchema>;
export type PosShiftCloseFormValues = z.input<typeof posShiftCloseInputSchema>;

// ---------------------------------------------------------------------------------------------
// What the API sends: the shifts, for the managers (pos.shift.manage)

const personRefSchema = z.object({ id: z.uuid(), fullName: z.string() });

export const posShiftSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  register: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  branchId: z.uuid(),
  sequence: z.number().int(),
  status: z.enum(POS_SHIFT_STATUSES),
  cashier: personRefSchema,
  // The device it ran on (its name now)
  device: z.object({ id: z.uuid(), name: z.string() }),
  // By the device's clock
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  // The opening count's total
  openingCash: z.string(),
  // What the drawer should hold: so far while the shift is open, at the close once closed
  expectedCash: z.string(),
  // The closing count's total; null while open, and for a shift closed without a count
  countedCash: z.string().nullable(),
  // Counted less expected at the close (cashDifferenceOf); null when there was no closing count
  difference: z.string().nullable(),
  // The sales the server has received in it
  saleCount: z.number().int(),
  salesTotal: z.string(),
  // Step 20c: and the returns, whatever shift their sales were in
  returnCount: z.number().int(),
  returnsTotal: z.string(),
});
export type PosShiftSummary = z.infer<typeof posShiftSummarySchema>;

export const posCashMovementSchema = z.object({
  id: z.uuid(),
  reason: z.object({ id: z.uuid(), name: z.string() }),
  direction: z.enum(POS_CASH_DIRECTIONS),
  amount: z.string(),
  note: z.string().nullable(),
  // The day in the books, and when it happened by the device's clock
  date: z.iso.date(),
  movedAt: z.iso.datetime(),
  // The reason's account when it was posted
  accountId: z.uuid(),
  entry: entryRefSchema,
});
export type PosCashMovement = z.infer<typeof posCashMovementSchema>;

const tenderAmountSchema = z.object({ method: z.enum(POS_TENDERS), amount: z.string() });

export const posShiftSchema = posShiftSummarySchema.extend({
  opening: z.object({
    count: cashCountSchema,
    date: z.iso.date(),
    // What the last shift left in the drawer; null for a register's first shift
    comparedWith: z.string().nullable(),
    // The opening count less comparedWith; null for a first shift
    difference: z.string().nullable(),
    // A first shift's float: the reason it came by
    floatReason: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    // The difference (or the float) in the books; null when there was none
    entry: entryRefSchema.nullable(),
  }),
  // null while open, and for a shift closed without a count
  closing: z
    .object({
      count: cashCountSchema,
      date: z.iso.date(),
      deviceExpected: z.string(),
      heldDropped: z.number().int(),
      // The difference in the books; null when the count matched
      entry: entryRefSchema.nullable(),
    })
    .nullable(),
  // Who closed it without a count: a manager online, or the person who revoked its device
  closedBy: personRefSchema.nullable(),
  // The parts of expectedCash (ShiftCash)
  cash: z.object({
    opening: z.string(),
    cashTaken: z.string(),
    changeGiven: z.string(),
    paidIn: z.string(),
    paidOut: z.string(),
    cashRefunded: z.string(),
  } satisfies Record<keyof ShiftCash, z.ZodType>),
  // What the sales took by each tender, every method of the register (cash before the change),
  // and exchange when a sale used one. Step 20c: what the returns paid back, the same way.
  payments: z.array(tenderAmountSchema),
  refunds: z.array(tenderAmountSchema),
  // Step 20c, for the Z report: the sales' discounts (the lines' and the bills') and VAT, and the
  // returns' VAT
  salesDiscount: z.string(),
  salesVat: z.string(),
  returnsVat: z.string(),
  movements: z.array(posCashMovementSchema),
});
export type PosShift = z.infer<typeof posShiftSchema>;

export const posShiftListQuerySchema = pageQuerySchema.extend({
  registerId: z.uuid().optional(),
  status: z.enum(POS_SHIFT_STATUSES).optional(),
});
export type PosShiftListQuery = z.input<typeof posShiftListQuerySchema>;

export const posShiftPageSchema = pageOf(posShiftSummarySchema);
export type PosShiftPage = z.infer<typeof posShiftPageSchema>;

// Why a manager closes a shift nobody can close: "Sumi went home sick, the drawer was taken to the
// safe". For the audit log.
export const posShiftCloseWithoutCountInputSchema = z.object({ note: optionalText(200) });
export type PosShiftCloseWithoutCountInput = z.infer<typeof posShiftCloseWithoutCountInputSchema>;

// ---------------------------------------------------------------------------------------------
// Step 20c: the X and Z reports, on the receipt printer. Not sent by the API: the device makes one
// from its own sales, returns and movements (packages/sync), and a shift's page from posShiftSchema,
// and both print the same sheet.

// x = while the shift is open, z = after its close
export const POS_SHIFT_REPORT_KINDS = ['x', 'z'] as const;
export type PosShiftReportKind = (typeof POS_SHIFT_REPORT_KINDS)[number];

export interface TenderAmount {
  method: PosTender;
  amount: string;
}

export interface PosShiftReport {
  kind: PosShiftReportKind;
  register: { code: string; name: string };
  shiftNumber: string;
  cashierName: string;
  openedAt: string;
  // null on an X report
  closedAt: string | null;
  // By the clock of the device that prints it
  printedAt: string;
  saleCount: number;
  // With VAT, after every discount
  salesTotal: string;
  salesDiscount: string;
  salesVat: string;
  returnCount: number;
  returnsTotal: string;
  returnsVat: string;
  // Only the tenders with an amount, in POS_TENDERS order
  taken: TenderAmount[];
  refunded: TenderAmount[];
  paidIn: string;
  paidOut: string;
  // The Z report's cash: the parts, what the drawer should have held, the count and the
  // difference. null on an X report (blind), and on the Z of a shift closed without a count,
  // which has no count to set against it.
  drawer: (ShiftCash & { expected: string; counted: string; difference: string }) | null;
}

// Sold less given back: what the shift took in the end
export function shiftNetOf(report: Pick<PosShiftReport, 'salesTotal' | 'returnsTotal'>): string {
  return subtractMoney(report.salesTotal, report.returnsTotal);
}

// The amounts per tender a report prints: the ones above zero, in the tenders' order
export function tenderAmountsOf(amounts: readonly TenderAmount[]): TenderAmount[] {
  return POS_TENDERS.flatMap((method) => {
    const amount = sumMoney(
      amounts.filter((item) => item.method === method).map((item) => item.amount),
    );
    return compareMoney(amount, '0') > 0 ? [{ method, amount }] : [];
  });
}

const idParamsSchema = z.object({ id: z.uuid() });

// The reasons are read by everyone (the settings page shows them, read-only without the
// permission) and set up with pos.register.manage, like the registers. The shifts hold what each
// cashier's drawer was short by, so even reading them needs pos.shift.manage. Shifts are opened,
// changed and closed only through sync commands.
export const posShiftRoutes = {
  listCashReasons: defineRoute({
    method: 'GET',
    path: '/pos/cash-reasons',
    summary: 'The reasons a cashier may put money into or take money out of the drawer',
    auth: 'bearer',
    status: 200,
    query: posCashReasonListQuerySchema,
    response: posCashReasonListSchema,
  }),
  createCashReason: defineRoute({
    method: 'POST',
    path: '/pos/cash-reasons',
    summary: 'Add a pay in or pay out reason with its account',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 201,
    body: posCashReasonInputSchema,
    response: posCashReasonSchema,
  }),
  updateCashReason: defineRoute({
    method: 'PUT',
    path: '/pos/cash-reasons/:id',
    summary: "Change a reason's name or account",
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: idParamsSchema,
    body: updatePosCashReasonInputSchema,
    response: posCashReasonSchema,
  }),
  archiveCashReason: defineRoute({
    method: 'POST',
    path: '/pos/cash-reasons/:id/archive',
    summary: 'Stop offering a reason at the counter',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: idParamsSchema,
    body: posCashReasonVersionInputSchema,
    response: posCashReasonSchema,
  }),
  restoreCashReason: defineRoute({
    method: 'POST',
    path: '/pos/cash-reasons/:id/restore',
    summary: 'Offer an archived reason again',
    auth: 'bearer',
    permission: 'pos.register.manage',
    status: 200,
    params: idParamsSchema,
    body: posCashReasonVersionInputSchema,
    response: posCashReasonSchema,
  }),
  listShifts: defineRoute({
    method: 'GET',
    path: '/pos/shifts',
    summary: 'POS shifts, newest first, with their counts and differences',
    auth: 'bearer',
    permission: 'pos.shift.manage',
    status: 200,
    query: posShiftListQuerySchema,
    response: posShiftPageSchema,
  }),
  getShift: defineRoute({
    method: 'GET',
    path: '/pos/shifts/:id',
    summary: 'One POS shift with its counts, cash, payments and pay ins and outs',
    auth: 'bearer',
    permission: 'pos.shift.manage',
    status: 200,
    params: idParamsSchema,
    response: posShiftSchema,
  }),
  closeWithoutCount: defineRoute({
    method: 'POST',
    path: '/pos/shifts/:id/close-without-count',
    summary: 'Close a shift nobody can close at its counter; no difference is posted',
    auth: 'bearer',
    permission: 'pos.shift.manage',
    status: 200,
    params: idParamsSchema,
    body: posShiftCloseWithoutCountInputSchema,
    response: posShiftSchema,
  }),
};
