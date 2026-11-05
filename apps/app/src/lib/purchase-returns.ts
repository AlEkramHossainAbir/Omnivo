import {
  type Bill,
  type BillExpense,
  type BillLine,
  compareMoney,
  type DebitNoteExpenseFormValues,
  type DebitNoteLine,
  type DebitNoteLineFormValues,
  type DebitNoteSummary,
  defaultLineDescription,
  type DocumentTotals,
  documentTotals,
  draftLineAmounts,
  expenseLineAmounts,
  type GoodsReceiptLine,
  isMoneyAmount,
  isZeroMoney,
  isZeroQuantity,
  keptQuantity,
  type LineAmounts,
  plainQuantity,
  prorateMoney,
  type PurchaseReturn,
  type PurchaseReturnLine,
  type PurchaseReturnLineFormValues,
  subtractMoney,
  subtractQuantity,
  type SupplierPaymentSummary,
  type SupplierRefundSourceType,
  unappliedOf,
  type VariantRef,
} from '@omnivo/contracts';

import { priceIn } from './returns';
import { formDiscount } from './sales';

// The pure parts of the purchase return, debit note and supplier refund pages (step 17d),
// unit-tested in purchase-returns.spec.ts. The sales return, credit note and refund of 15d seen
// from the buyer's side (lib/returns.ts), with a goods receipt where those have a challan and a
// bill where they have an invoice.

// ---------------------------------------------------------------------------------------------
// Purchase returns

// The lines of a goods receipt a return may still send back: something kept (accepted less what
// posted returns sent back already), and not on the form already (a receipt line once per return:
// purchase_return_line_twice). Billed or not does not matter: a billed line goes back too, and a
// debit note takes its money off.
export function returnableReceiptLines(
  lines: readonly GoodsReceiptLine[],
  onForm: ReadonlySet<string>,
): GoodsReceiptLine[] {
  return lines.filter((line) => !isZeroQuantity(keptQuantity(line)) && !onForm.has(line.id));
}

// A receipt line as a return line, with everything that can still go back. Nothing went back yet:
// the receipt's own unit and quantity, and its serial numbers. Some did: the base unit with what is
// kept, and no serial numbers, because the line does not say which ones are still here; the store
// keeper types the numbers on the goods. The batch stays empty: the server takes the receipt
// line's own (purchase_return_batch_not_allowed otherwise).
export function receiptLineToReturn(line: GoodsReceiptLine): PurchaseReturnLineFormValues {
  const whole = isZeroQuantity(line.returnedQuantity);
  return {
    variantId: line.variantId,
    unitId: whole ? line.unitId : line.baseUnitId,
    quantity: plainQuantity(whole ? line.quantity : keptQuantity(line)),
    batchId: '',
    serialNumbers: whole ? line.serialNumbers : [],
    receiptLineId: line.id,
  };
}

// A saved draft's line as the form holds it. A receipt line names no batch (the API sent the
// receipt line's batch for the page; the contract refuses it on such a line).
export function toPurchaseReturnFormLine(line: PurchaseReturnLine): PurchaseReturnLineFormValues {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    batchId: line.receiptLineId === null ? (line.batchId ?? '') : '',
    serialNumbers: line.serialNumbers,
    receiptLineId: line.receiptLineId ?? '',
  };
}

// What debit notes have not taken the money off for yet, in the base unit. Two kinds of line have
// money to take off: one a bill had billed when the return was posted, and one on its own (goods
// from before the system, a debit note without a bill, decision 9). A receipt line not billed yet
// made its bill smaller instead.
export function leftToDebitOf(
  line: Pick<
    PurchaseReturnLine,
    'receiptLineId' | 'billLineId' | 'baseQuantity' | 'debitedQuantity'
  >,
): string {
  const debitable = line.receiptLineId === null || line.billLineId !== null;
  return debitable ? subtractQuantity(line.baseQuantity, line.debitedQuantity) : '0';
}

// The return lines a debit note can still take the money off for: billed on this bill (or, for a
// debit note without a bill, `billId` null, the lines on their own), not all debited, and not on
// the form already (debit_note_return_twice)
export function debitableReturnLines(
  purchaseReturn: Pick<PurchaseReturn, 'lines'>,
  billId: string | null,
  onForm: ReadonlySet<string>,
): PurchaseReturnLine[] {
  return purchaseReturn.lines.filter(
    (line) =>
      (billId === null ? line.receiptLineId === null : line.billId === billId) &&
      !isZeroQuantity(leftToDebitOf(line)) &&
      !onForm.has(line.id),
  );
}

// Where "Write debit note" on a return starts: the first bill with goods of the return not debited
// yet, else a debit note without a bill for its lines on their own; null when nothing is left. A
// return can hold lines of two bills; a debit note is for one, so the button stays until all are
// debited.
export function debitStartOf(
  purchaseReturn: Pick<PurchaseReturn, 'lines'>,
): { billId: string | null } | null {
  const line = purchaseReturn.lines.find((item) => !isZeroQuantity(leftToDebitOf(item)));
  if (line === undefined) return null;
  return { billId: line.receiptLineId === null ? null : line.billId };
}

// ---------------------------------------------------------------------------------------------
// Debit notes

// What a bill line or expense can still take off: its total, less what posted debit notes took.
// The money cap of 17d.1 (debit_note_over_line).
export function debitLeft(line: Pick<BillLine | BillExpense, 'total' | 'debited'>): string {
  return subtractMoney(line.total, line.debited);
}

// What a line of a debit note shows and is worked out from: the item, its units, and the VAT rate
// when it is fixed (a bill line's), or null when the person picks it (a line on its own)
export type DebitItem = VariantRef & { units: readonly { unitId: string; factor: string }[] };

function itemOf(line: DebitItem): DebitItem {
  return {
    variantId: line.variantId,
    productId: line.productId,
    productCode: line.productCode,
    productName: line.productName,
    optionValues: line.optionValues,
    sku: line.sku,
    baseUnitId: line.baseUnitId,
    units: line.units,
  };
}

// A return line of a bill as a debit note line: the goods that went back, at the price the bill
// line charged. Nothing debited yet: the return's own unit and quantity. Some was: the base unit
// with what is left. An amount discount goes with the share of the bill line that went back, like
// returnLineToCredit() of 15d.
export function returnLineToDebit(
  returnLine: PurchaseReturnLine,
  billLine: BillLine,
): DebitNoteLineFormValues {
  const whole = isZeroQuantity(returnLine.debitedQuantity);
  const unitId = whole ? returnLine.unitId : returnLine.baseUnitId;
  const left = leftToDebitOf(returnLine);
  return {
    billLineId: billLine.id,
    returnLineId: returnLine.id,
    taxRateId: '',
    unitId,
    quantity: plainQuantity(whole ? returnLine.quantity : left),
    description:
      billLine.description === defaultLineDescription(billLine) ? '' : billLine.description,
    unitPrice: priceIn(billLine, unitId),
    discountType: billLine.discountType,
    discount: formDiscount(
      billLine.discountType === 'percent'
        ? billLine.discount
        : prorateMoney(billLine.discount, left, billLine.baseQuantity),
    ),
  };
}

// A return line on its own as a line of a debit note without a bill: what is left of it, with the
// price and the VAT rate empty. Nothing in the system says what the supplier charged for goods from
// before it, so both are typed from the supplier's credit note.
export function ownReturnLineToDebit(returnLine: PurchaseReturnLine): DebitNoteLineFormValues {
  const whole = isZeroQuantity(returnLine.debitedQuantity);
  return {
    billLineId: '',
    returnLineId: returnLine.id,
    taxRateId: '',
    unitId: whole ? returnLine.unitId : returnLine.baseUnitId,
    quantity: plainQuantity(whole ? returnLine.quantity : leftToDebitOf(returnLine)),
    description: '',
    unitPrice: '',
    discountType: 'percent',
    discount: '',
  };
}

// The item of a return line, for a line of a debit note without a bill
export function returnLineItem(line: PurchaseReturnLine): DebitItem {
  return itemOf(line);
}

// A debit note line from the API as the form holds it: the item and (with a bill) the VAT rate are
// the bill line's, so only the ids go back. A line without a bill sends its own rate.
export function toDebitFormLine(line: DebitNoteLine): DebitNoteLineFormValues {
  return {
    billLineId: line.billLineId ?? '',
    returnLineId: line.returnLineId ?? '',
    taxRateId: line.billLineId === null ? line.taxRate.id : '',
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    description: line.description === defaultLineDescription(line) ? '' : line.description,
    unitPrice: line.unitPrice,
    discountType: line.discountType,
    discount: formDiscount(line.discount),
  };
}

// The item of a saved line on its own (a debit note without a bill): the line carries it
export function debitLineItem(line: DebitNoteLine): DebitItem {
  return itemOf(line);
}

// A bill expense as a debit note expense, with what is left of it. Nothing debited yet: the amount
// as the bill typed it, so the whole expense comes off to the paisa. Some was: the same share of the
// typed amount as of the total, which the server checks again (debit_note_over_line); a paisa of
// rounding over is refused there, and the person lowers it.
export function expenseToDebit(expense: BillExpense): DebitNoteExpenseFormValues {
  const left = debitLeft(expense);
  return {
    billExpenseId: expense.id,
    amount: plainQuantity(
      isZeroMoney(expense.debited)
        ? expense.amount
        : prorateMoney(expense.amount, left, expense.total),
    ),
  };
}

// The bill expenses a debit note can still take money off: something left, not on the form
export function debitableExpenses(
  expenses: readonly BillExpense[],
  onForm: ReadonlySet<string>,
): BillExpense[] {
  return expenses.filter(
    (expense) => compareMoney(debitLeft(expense), '0') > 0 && !onForm.has(expense.id),
  );
}

// The VAT rate a line is worked out at: its bill line's (the VAT taken off is the VAT that was
// claimed), or on a debit note without a bill the one picked on the line. null = not known yet.
export function debitLineRate(
  line: Pick<DebitNoteLineFormValues, 'billLineId' | 'taxRateId'>,
  billLines: ReadonlyMap<string, Pick<BillLine, 'taxRate'>>,
  rateOf: (id: string) => string | null,
): string | null {
  const billLineId = line.billLineId ?? '';
  if (billLineId !== '') return billLines.get(billLineId)?.taxRate.rate ?? null;
  const taxRateId = line.taxRateId ?? '';
  return taxRateId === '' ? null : rateOf(taxRateId);
}

// The form's totals, worked out like the API: each line at its rate, each expense at its bill
// expense's rate, all the debit note's way of writing prices. A line or an expense whose boxes are
// not complete yet counts as nothing, like the bill form's.
export function debitFormTotals(
  lines: readonly DebitNoteLineFormValues[],
  expenses: readonly DebitNoteExpenseFormValues[],
  bill: Pick<Bill, 'lines' | 'expenses'> | null,
  rateOf: (id: string) => string | null,
  pricesIncludeVat: boolean,
): DocumentTotals {
  const billLines = new Map(bill?.lines.map((line) => [line.id, line]));
  const billExpenses = new Map(bill?.expenses.map((expense) => [expense.id, expense]));
  const amounts = [
    ...lines.map((line) =>
      draftLineAmounts(
        {
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountType: line.discountType,
          discount: line.discount,
        },
        debitLineRate(line, billLines, rateOf),
        pricesIncludeVat,
      ),
    ),
    ...expenses.map((expense) => {
      // draftExpenseAmounts() of lib/bills.ts, written out: importing it would bring the bill's
      // helpers into every purchase return page
      const source = billExpenses.get(expense.billExpenseId);
      const amount = expense.amount.trim();
      return source && isMoneyAmount(amount)
        ? expenseLineAmounts({ amount, rate: source.taxRate.rate }, pricesIncludeVat)
        : null;
    }),
  ];
  return documentTotals(amounts.filter((amount): amount is LineAmounts => amount !== null));
}

// ---------------------------------------------------------------------------------------------
// Supplier refunds

// A place a supplier can pay money back on: a posted debit note's or a posted payment's money that
// is not applied to a bill and not paid back yet (unappliedOf)
export interface SupplierRefundSourceOption {
  type: SupplierRefundSourceType;
  id: string;
  number: string;
  date: string;
  // Where the refund starts: the branch the money was owed at
  branchId: string;
  left: string;
}

// The supplier's posted debit notes and payments with money left, the oldest first, like
// refundSourcesOf() of 15d
export function supplierRefundSourcesOf(
  debitNotes: readonly DebitNoteSummary[],
  payments: readonly SupplierPaymentSummary[],
): SupplierRefundSourceOption[] {
  const fromDebitNotes = debitNotes.flatMap((note): SupplierRefundSourceOption[] =>
    note.status === 'posted' && note.number !== null
      ? [
          {
            type: 'debit_note',
            id: note.id,
            number: note.number,
            date: note.date,
            branchId: note.branchId,
            left: unappliedOf({
              amount: note.total,
              applied: note.applied,
              refunded: note.refunded,
            }),
          },
        ]
      : [],
  );
  const fromPayments = payments.flatMap((payment): SupplierRefundSourceOption[] =>
    payment.status === 'posted' && payment.number !== null
      ? [
          {
            type: 'supplier_payment',
            id: payment.id,
            number: payment.number,
            date: payment.date,
            branchId: payment.branchId,
            left: unappliedOf(payment),
          },
        ]
      : [],
  );
  return [...fromDebitNotes, ...fromPayments]
    .filter((source) => compareMoney(source.left, '0') > 0)
    .toSorted((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
}

// The form's one select for two boxes: "debit_note:<id>" or "supplier_payment:<id>"
export function supplierSourceKeyOf(source: {
  type: SupplierRefundSourceType;
  id: string;
}): string {
  return `${source.type}:${source.id}`;
}

// The two boxes the API wants from the select's value ('' for none)
export function supplierSourceFields(key: string): { debitNoteId: string; paymentId: string } {
  const [type, id = ''] = key.split(':');
  return {
    debitNoteId: type === 'debit_note' ? id : '',
    paymentId: type === 'supplier_payment' ? id : '',
  };
}
