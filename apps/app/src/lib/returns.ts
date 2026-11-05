import {
  compareMoney,
  compareQuantity,
  CREDIT_NOTE_REASONS,
  DEBIT_NOTE_REASONS,
  type CreditNoteLine,
  type CreditNoteLineFormValues,
  type CreditNoteSummary,
  defaultLineDescription,
  type DeliveryLine,
  type InvoiceLine,
  isZeroQuantity,
  plainQuantity,
  priceInUnit,
  prorateMoney,
  type ReceiptSummary,
  type RefundSourceType,
  RETURN_REASONS,
  type SalesReturn,
  type SalesReturnLine,
  type SalesReturnLineFormValues,
  subtractMoney,
  subtractQuantity,
  unappliedOf,
} from '@omnivo/contracts';

import { formDiscount } from './sales';

// The pure parts of the sales return, credit note and refund pages (step 15d), unit-tested in
// returns.spec.ts like lib/invoices.ts.

// ---------------------------------------------------------------------------------------------
// Sales returns

// A reason's key in the words. The API sends the reason as a plain string (the rule of every list
// the server may grow): one this app does not know yet reads "Other", never a raw key.
export function returnReasonKey(reason: string) {
  const known = RETURN_REASONS.find((item) => item === reason) ?? 'other';
  return `salesReturns.reasons.${known}` as const;
}

export function creditReasonKey(reason: string) {
  const known = CREDIT_NOTE_REASONS.find((item) => item === reason) ?? 'other';
  return `creditNotes.reasons.${known}` as const;
}

// Step 17d: the purchase return's and the debit note's, here with the sales ones rather than in
// lib/purchase-returns.ts: the printed pages need them, and every document page loads those, so
// they must not bring the debit note's sums (lib/bills.ts, lib/invoices.ts) along
export function purchaseReturnReasonKey(reason: string) {
  const known = RETURN_REASONS.find((item) => item === reason) ?? 'other';
  return `purchaseReturns.reasons.${known}` as const;
}

export function debitReasonKey(reason: string) {
  const known = DEBIT_NOTE_REASONS.find((item) => item === reason) ?? 'other';
  return `debitNotes.reasons.${known}` as const;
}

// What can still come back on a challan line, in the base unit: what left, less what posted
// returns brought back already. The API refuses more (return_over_delivered).
export function leftToReturn(
  line: Pick<DeliveryLine, 'baseQuantity' | 'returnedQuantity'>,
): string {
  return subtractQuantity(line.baseQuantity, line.returnedQuantity);
}

// The lines of a challan a return may still take back: something left, and not on the form
// already (a challan line once per return: return_line_twice)
export function returnableLines(
  lines: readonly DeliveryLine[],
  onForm: ReadonlySet<string>,
): DeliveryLine[] {
  return lines.filter(
    (line) => compareQuantity(line.returnedQuantity, line.baseQuantity) < 0 && !onForm.has(line.id),
  );
}

// A challan line as a return line, with everything that can still come back. Nothing came back
// yet: the challan's own unit and quantity, and its serial numbers. Some did: the base unit with
// what is left, and no serial numbers, because the line does not say which ones are still out
// there; the store keeper types the numbers on the goods. The batch stays empty: the server takes
// the challan line's own (return_batch_not_allowed otherwise).
export function challanLineToReturn(line: DeliveryLine): SalesReturnLineFormValues {
  const whole = isZeroQuantity(line.returnedQuantity);
  return {
    variantId: line.variantId,
    unitId: whole ? line.unitId : line.baseUnitId,
    quantity: plainQuantity(whole ? line.quantity : leftToReturn(line)),
    batchId: '',
    serialNumbers: whole ? line.serialNumbers : [],
    deliveryLineId: line.id,
  };
}

// A saved draft's line as the form holds it. A challan line names no batch (the API sent the
// challan's batch for the page; the contract refuses it on such a line).
export function toReturnFormLine(line: SalesReturnLine): SalesReturnLineFormValues {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    batchId: line.deliveryLineId === null ? (line.batchId ?? '') : '',
    serialNumbers: line.serialNumbers,
    deliveryLineId: line.deliveryLineId ?? '',
  };
}

// What credit notes have not given the money back for yet, in the base unit. Only a billed line
// has money to give back: an unbilled one made the invoice smaller instead.
export function leftToCreditOf(line: SalesReturnLine): string {
  return line.invoiceLineId === null
    ? '0'
    : subtractQuantity(line.baseQuantity, line.creditedQuantity);
}

// The return lines a credit note for this invoice can still give the money back for: billed on
// this invoice, not all credited, and not on the form already (credit_note_return_twice)
export function creditableReturnLines(
  salesReturn: Pick<SalesReturn, 'lines'>,
  invoiceId: string,
  onForm: ReadonlySet<string>,
): SalesReturnLine[] {
  return salesReturn.lines.filter(
    (line) =>
      line.invoiceId === invoiceId && !isZeroQuantity(leftToCreditOf(line)) && !onForm.has(line.id),
  );
}

// The invoice "Write credit note" on a return starts with: the first one with billed goods that
// are not all credited. A return can hold lines of two invoices; a credit note is for one, so the
// button stays until both are credited.
export function firstCreditableInvoice(salesReturn: Pick<SalesReturn, 'lines'>): string | null {
  return (
    salesReturn.lines.find(
      (line) => line.invoiceId !== null && !isZeroQuantity(leftToCreditOf(line)),
    )?.invoiceId ?? null
  );
}

// ---------------------------------------------------------------------------------------------
// Credit notes

// What an invoice line can still give back: its total, less what posted credit notes took. The
// money cap of 15d.1 (credit_note_over_line).
export function creditLeft(line: Pick<InvoiceLine, 'total' | 'credited'>): string {
  return subtractMoney(line.total, line.credited);
}

// A unit's size in the base unit: "1" for the base unit itself
function factorOf(
  item: { baseUnitId: string; units: readonly { unitId: string; factor: string }[] },
  unitId: string,
): string {
  if (unitId === item.baseUnitId) return '1';
  const pack = item.units.find((unit) => unit.unitId === unitId);
  if (pack === undefined) throw new Error(`The product has no unit ${unitId}`);
  return pack.factor;
}

// The price of an invoice line moved to another unit of its item: ৳504 a case is ৳21 a piece
export function priceIn(
  line: Pick<InvoiceLine, 'unitPrice' | 'unitId' | 'baseUnitId' | 'units'>,
  unitId: string,
): string {
  return priceInUnit(line.unitPrice, factorOf(line, line.unitId), factorOf(line, unitId));
}

// A return line as a credit note line: the goods that came back, at the price the invoice line
// charged. Nothing credited yet: the return's own unit and quantity. Some was: the base unit with
// what is left. An amount discount goes with the share of the invoice line that came back, like an
// order's discount on a challan line (15c).
export function returnLineToCredit(
  returnLine: SalesReturnLine,
  invoiceLine: InvoiceLine,
): CreditNoteLineFormValues {
  const whole = isZeroQuantity(returnLine.creditedQuantity);
  const unitId = whole ? returnLine.unitId : returnLine.baseUnitId;
  const left = leftToCreditOf(returnLine);
  return {
    invoiceLineId: invoiceLine.id,
    returnLineId: returnLine.id,
    unitId,
    quantity: plainQuantity(whole ? returnLine.quantity : left),
    description:
      invoiceLine.description === defaultLineDescription(invoiceLine)
        ? ''
        : invoiceLine.description,
    unitPrice: priceIn(invoiceLine, unitId),
    discountType: invoiceLine.discountType,
    discount: formDiscount(
      invoiceLine.discountType === 'percent'
        ? invoiceLine.discount
        : prorateMoney(invoiceLine.discount, left, invoiceLine.baseQuantity),
    ),
  };
}

// A credit note line from the API as the form holds it (the toFormLine() of 15b, without the item
// and the VAT rate: both are the invoice line's)
export function toCreditFormLine(
  line: Pick<
    CreditNoteLine,
    | 'invoiceLineId'
    | 'returnLineId'
    | 'unitId'
    | 'quantity'
    | 'description'
    | 'productName'
    | 'optionValues'
    | 'unitPrice'
    | 'discountType'
    | 'discount'
  >,
): CreditNoteLineFormValues {
  return {
    invoiceLineId: line.invoiceLineId,
    returnLineId: line.returnLineId ?? '',
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    description: line.description === defaultLineDescription(line) ? '' : line.description,
    unitPrice: line.unitPrice,
    discountType: line.discountType,
    discount: formDiscount(line.discount),
  };
}

// ---------------------------------------------------------------------------------------------
// Refunds

// A place money can be paid back from: a receipt's or a posted credit note's money that is not
// applied to an invoice and not paid back yet (unappliedOf)
export interface RefundSourceOption {
  type: RefundSourceType;
  id: string;
  number: string;
  date: string;
  // Where the refund starts: the branch the money came in at
  branchId: string;
  left: string;
}

// The customer's posted receipts and credit notes with money left, the oldest first: an advance
// that waited longest is usually the one paid back. A voided receipt and a draft credit note hold
// no money.
export function refundSourcesOf(
  receipts: readonly ReceiptSummary[],
  creditNotes: readonly CreditNoteSummary[],
): RefundSourceOption[] {
  const fromReceipts = receipts
    .filter((receipt) => receipt.status === 'posted')
    .map((receipt): RefundSourceOption => ({
      type: 'receipt',
      id: receipt.id,
      number: receipt.number,
      date: receipt.date,
      branchId: receipt.branchId,
      left: unappliedOf(receipt),
    }));
  const fromCreditNotes = creditNotes.flatMap((note): RefundSourceOption[] =>
    note.status === 'posted' && note.number !== null
      ? [
          {
            type: 'credit_note',
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
  return [...fromReceipts, ...fromCreditNotes]
    .filter((source) => compareMoney(source.left, '0') > 0)
    .toSorted((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
}

// The form's one select for two boxes: "receipt:<id>" or "credit_note:<id>"
export function sourceKeyOf(source: { type: RefundSourceType; id: string }): string {
  return `${source.type}:${source.id}`;
}

// The two boxes the API wants from the select's value ('' for none)
export function sourceFields(key: string): { receiptId: string; creditNoteId: string } {
  const [type, id = ''] = key.split(':');
  return {
    receiptId: type === 'receipt' ? id : '',
    creditNoteId: type === 'credit_note' ? id : '',
  };
}
