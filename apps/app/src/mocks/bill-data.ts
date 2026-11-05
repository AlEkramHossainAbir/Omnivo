import {
  addMoney,
  type Bill,
  type BillAdvance,
  billAmountDueOf,
  type BillDebitNote,
  type BillInput,
  type BillLine,
  type BillOpenDebitNote,
  type BillPaymentFilter,
  billPaymentStatusOf,
  type BillStatus,
  type BillSummary,
  compareMoney,
  compareQuantity,
  documentTotals,
  type DocumentRef,
  dueDateOf,
  type EntryRef,
  type ErrorCode,
  expenseLineAmounts,
  isBillOverdue,
  isZeroMoney,
  keptQuantity,
  type LineAmounts,
  moneyAccountIds,
  overAllocated,
  type PaymentAllocation,
  priceDifferenceOf,
  shiftIsoDate,
  subtractMoney,
  sumMoney,
  type SupplierPayment,
  type SupplierPaymentInput,
  type SupplierPaymentStatus,
  type SupplierPaymentSummary,
  type SupplierRefundSourceType,
  toBaseQuantity,
  todayIn,
  unappliedOf,
  unappliedPaymentOf,
} from '@omnivo/contracts';

import { refOf, side } from './invoice-data';
import { findEntry, postNew, reverseEntry, stockAccountIds } from './journal-data';
import { MockProblem } from './mock';
import {
  type MockGoodsReceipt,
  type MockPurchaseOrder,
  receiveForBill,
  resolveReceiptLines,
  supplierOf,
} from './purchase-order-data';
import { assertWarehouse, endPendingRound, historyOf, submitRound } from './requisition-data';
import {
  fieldProblem,
  newestFirst,
  now,
  ratesOf,
  type ResolvedLine,
  resolveSalesLines,
  seriesNumber,
} from './sales-document-data';
import { bookAccounts, branchOf, decimalsOf, findVariant, issuesError } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 17c: supplier bills and supplier payments. The API's rules (bills.service.ts,
// supplier-payments.service.ts, purchase-books.service.ts) on plain arrays, shortened, so
// `pnpm dev:mock` and the e2e tests walk the same paths as the real API. Both are approved by the
// 17a engine (requisition-data.ts), and the last approval posts them (decision 7). The mock signs
// in as the Owner, whose own documents are approved at once, so "Post" and "Submit" post at once
// here; the waiting bill is the seed's.
//
// Step 17d: purchase returns, debit notes and supplier refunds (purchase-return-data.ts, which
// imports this file). This file reads them through the WorkspaceData type only: what debit notes
// settled on a bill, what went back before a bill billed it, what refunds paid back of a payment.

// A bill line as stored. The receipt's and the order's numbers and what the goods receipt booked
// (orderValue) are looked up on read, like the API's joins. A receipt line's lot and serial numbers
// are read from the receipt line too.
export type MockBillLine = Omit<BillLine, 'receiptNumber' | 'orderNumber' | 'orderValue'>;

// A bill as stored. What payments paid on it, its line count, its price difference, its receipts,
// orders, payments, advances and approval history are worked out on read: a payment posted a
// second ago shows on the bill at once. Step 17d: so are what debit notes settled and debited,
// the debit notes written for it and the supplier's open ones. Each line's `debited` is stored,
// like the API's column: a debit note's posting adds to it.
export type MockBill = Omit<
  Bill,
  | 'amountPaid'
  | 'amountDebited'
  | 'debitNoteTotal'
  | 'debitNotes'
  | 'openDebitNotes'
  | 'lineCount'
  | 'lines'
  | 'priceDifference'
  | 'receipts'
  | 'orders'
  | 'payments'
  | 'advances'
  | 'approval'
> & { lines: MockBillLine[] };

export interface MockBillAllocation {
  billId: string;
  amount: string;
}

// A payment as stored: the bills it pays (or, while a draft, plans to pay), its order and the
// supplier's bank account by id. What it applied, what refunds paid back (step 17d), the bills'
// numbers and the bank account's details are looked up on read.
export type MockSupplierPayment = Omit<
  SupplierPayment,
  'applied' | 'refunded' | 'allocations' | 'supplierBankAccount' | 'order' | 'approval'
> & {
  allocations: MockBillAllocation[];
  supplierBankAccountId: string | null;
  orderId: string | null;
};

function conflict(code: ErrorCode): MockProblem {
  return new MockProblem(409, code);
}

// 'purchase.bill' or 'purchase.payment', given at the first submit (decision 13)
function nextNumber(data: WorkspaceData, series: 'bill' | 'payment', date: string): string {
  data.purchase.counters[series] += 1;
  return seriesNumber(
    data,
    series === 'bill' ? 'purchase.bill' : 'purchase.payment',
    data.purchase.counters[series],
    date,
  );
}

// A bill's or a payment's status, with a new version: a page open somewhere must reload before
// its next action. The statuses both have.
function moveTo(
  target: MockBill | MockSupplierPayment,
  status: BillStatus & SupplierPaymentStatus,
): void {
  Object.assign(target, { status, version: target.version + 1, updatedAt: now() });
}

// An active branch, with the purchase documents' own code (the API's assertBranch). Exported for
// step 17d's debit notes and refunds, like the next three.
export function assertBranch(data: WorkspaceData, branchId: string): void {
  const branch = data.branches.find((item) => item.id === branchId);
  if (branch?.archivedAt !== null) throw fieldProblem('purchase_branch_invalid', 'branchId');
}

export function assertPeriodOpen(data: WorkspaceData, date: string): void {
  if (data.journal.lockDate !== null && date <= data.journal.lockDate) {
    throw fieldProblem('journal_period_locked', 'date');
  }
}

export function purposeAccount(data: WorkspaceData, purpose: string): string {
  const id = data.accounts.find((account) => account.purpose === purpose)?.id;
  if (id === undefined) throw new Error(`The mock chart has no ${purpose} account`);
  return id;
}

// A goods receipt line, with its receipt
export function receiptLineOf(data: WorkspaceData, receiptLineId: string) {
  for (const receipt of data.purchase.receipts) {
    const line = receipt.lines.find((item) => item.id === receiptLineId);
    if (line) return { receipt, line };
  }
  return undefined;
}

// A purchase order line, with its order
function orderLineOf(data: WorkspaceData, orderLineId: string) {
  for (const order of data.purchase.orders) {
    const line = order.lines.find((item) => item.id === orderLineId);
    if (line) return { order, line };
  }
  return undefined;
}

// --- Bills: reading -----------------------------------------------------------------------------

export function findBill(data: WorkspaceData, id: string): MockBill {
  const found = data.purchase.bills.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// What posted payments applied to it. A draft payment's plan is not money paid (decision 23), and
// a cancelled one keeps its plan as history: both are left out, like the API's trigger.
function paidOn(data: WorkspaceData, billId: string): string {
  return sumMoney(
    data.purchase.payments
      .filter((payment) => payment.status === 'posted')
      .flatMap((payment) => payment.allocations)
      .filter((allocation) => allocation.billId === billId)
      .map((allocation) => allocation.amount),
  );
}

// Step 17d: what posted debit notes applied to it, whichever debit note's money it was. Only a
// posted debit note has allocations.
function debitedOn(data: WorkspaceData, billId: string): string {
  return sumMoney(
    data.purchase.debitNotes
      .flatMap((debitNote) => debitNote.allocations)
      .filter((allocation) => allocation.billId === billId)
      .map((allocation) => allocation.amount),
  );
}

// The posted debit notes written for it, oldest first: the API's debit_note_total adds up their
// totals, wherever their money went
function debitNotesFor(data: WorkspaceData, billId: string): BillDebitNote[] {
  return data.purchase.debitNotes
    .filter((debitNote) => debitNote.status === 'posted' && debitNote.bill?.id === billId)
    .toSorted(
      (a, b) => a.date.localeCompare(b.date) || (a.number ?? '').localeCompare(b.number ?? ''),
    )
    .flatMap((debitNote) =>
      debitNote.number === null
        ? []
        : [
            {
              id: debitNote.id,
              number: debitNote.number,
              date: debitNote.date,
              total: debitNote.total,
            },
          ],
    );
}

// What it still owes: less what payments paid and what debit notes settled (step 17d). Exported
// for the debit note's posting, which applies its money up to this.
export function dueOn(data: WorkspaceData, bill: MockBill): string {
  return billAmountDueOf({
    total: bill.total,
    amountPaid: paidOn(data, bill.id),
    amountDebited: debitedOn(data, bill.id),
  });
}

// What posted supplier refunds paid back from a debit note or a payment (step 17d): the API's
// debit_notes.refunded and supplier_payments.refunded, kept by a trigger. A voided refund gave it
// back.
export function refundedFrom(
  data: WorkspaceData,
  type: SupplierRefundSourceType,
  id: string,
): string {
  return sumMoney(
    data.purchase.refunds
      .filter(
        (refund) =>
          refund.status === 'posted' && refund.source.type === type && refund.source.id === id,
      )
      .map((refund) => refund.amount),
  );
}

// Step 17d: receipt line → what posted purchase returns sent back from it before a bill billed it
// (their line names no bill line): the value those returns took back off goods received not
// billed, and their serial numbers. The bill bills what was kept, at what the receipt booked less
// this. The API's returnedBeforeBilling().
function returnedBeforeBilling(data: WorkspaceData, receiptLineId: string) {
  const lines = data.purchase.returns
    .filter((purchaseReturn) => purchaseReturn.status === 'posted')
    .flatMap((purchaseReturn) => purchaseReturn.lines)
    .filter((line) => line.receiptLineId === receiptLineId && line.billLineId === null);
  return {
    value: sumMoney(lines.map((line) => line.value ?? '0')),
    serialNumbers: new Set(lines.flatMap((line) => line.serialNumbers)),
  };
}

export function billSummaryOf(data: WorkspaceData, stored: MockBill): BillSummary {
  return {
    id: stored.id,
    number: stored.number,
    date: stored.date,
    dueDate: stored.dueDate,
    supplier: stored.supplier,
    supplierBillNumber: stored.supplierBillNumber,
    mushakNumber: stored.mushakNumber,
    mushakDate: stored.mushakDate,
    branchId: stored.branchId,
    status: stored.status,
    net: stored.net,
    vat: stored.vat,
    total: stored.total,
    amountPaid: paidOn(data, stored.id),
    amountDebited: debitedOn(data, stored.id),
    debitNoteTotal: sumMoney(debitNotesFor(data, stored.id).map((debitNote) => debitNote.total)),
    lineCount: stored.lines.length,
    postedAt: stored.postedAt,
    version: stored.version,
    updatedAt: stored.updatedAt,
  };
}

// The supplier's posted payments with money not applied yet: those paid against one of this
// bill's orders first (decision 12), then the oldest. The API's advancesFor().
function advancesFor(
  data: WorkspaceData,
  supplierId: string,
  orderIds: ReadonlySet<string>,
): BillAdvance[] {
  const linked = (advance: BillAdvance) =>
    Number(advance.order !== null && orderIds.has(advance.order.id));
  return data.purchase.payments
    .filter((payment) => payment.supplier.id === supplierId && payment.status === 'posted')
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .flatMap((payment): BillAdvance[] => {
      // Step 17d: what a supplier refund paid back is not there to apply
      const unapplied = unappliedPaymentOf(paymentSummaryOf(data, payment));
      if (payment.number === null || compareMoney(unapplied, '0') <= 0) return [];
      const order = data.purchase.orders.find((item) => item.id === payment.orderId);
      return [
        {
          paymentId: payment.id,
          paymentNumber: payment.number,
          date: payment.date,
          order: order ? { id: order.id, number: order.number } : null,
          unapplied,
        },
      ];
    })
    .toSorted((a, b) => linked(b) - linked(a));
}

// Step 17d: the supplier's posted debit notes with money not applied or paid back yet, oldest
// first: money the supplier owes the company, which the bill's page offers next to the advances.
// The API's openDebitNotesOf().
function openDebitNotesFor(data: WorkspaceData, supplierId: string): BillOpenDebitNote[] {
  return data.purchase.debitNotes
    .filter((debitNote) => debitNote.supplier.id === supplierId && debitNote.status === 'posted')
    .toSorted((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .flatMap((debitNote): BillOpenDebitNote[] => {
      const unapplied = unappliedOf({
        amount: debitNote.total,
        applied: sumMoney(debitNote.allocations.map((allocation) => allocation.amount)),
        refunded: refundedFrom(data, 'debit_note', debitNote.id),
      });
      if (debitNote.number === null || compareMoney(unapplied, '0') <= 0) return [];
      return [
        {
          debitNoteId: debitNote.id,
          debitNoteNumber: debitNote.number,
          date: debitNote.date,
          bill:
            debitNote.bill === null
              ? null
              : { id: debitNote.bill.id, number: debitNote.bill.number },
          unapplied,
        },
      ];
    });
}

export function toBill(data: WorkspaceData, stored: MockBill): Bill {
  const receipts = new Map<string, MockGoodsReceipt>();
  const orders = new Map<string, MockPurchaseOrder>();
  const lines = stored.lines.map((line): BillLine => {
    const fromReceipt =
      line.receiptLineId === null ? undefined : receiptLineOf(data, line.receiptLineId);
    const fromOrder = line.orderLineId === null ? undefined : orderLineOf(data, line.orderLineId);
    if (fromReceipt) receipts.set(fromReceipt.receipt.id, fromReceipt.receipt);
    if (fromOrder) orders.set(fromOrder.order.id, fromOrder.order);
    const received = fromReceipt?.line;
    // Step 17d: goods that went back before the bill were never billed: their value is not in
    // what the receipt booked for it, and their serial numbers are not printed on it
    const back = received ? returnedBeforeBilling(data, received.id) : undefined;
    // What a receipt from an order booked; a receipt a bill made has no order price
    const booked = received?.orderLineId === null ? null : (received?.value ?? null);
    return {
      ...line,
      receiptNumber: fromReceipt?.receipt.number ?? null,
      orderNumber: fromOrder?.order.number ?? null,
      orderValue: booked === null ? null : subtractMoney(booked, back?.value ?? '0'),
      // What the goods came with: the receipt line's, else what a line of its own will bring in
      batchId: received?.batchId ?? null,
      lotNumber: received ? received.lotNumber : line.lotNumber,
      expiresOn: received ? received.expiresOn : line.expiresOn,
      manufacturedOn: received ? received.manufacturedOn : line.manufacturedOn,
      serialNumbers: (received ? received.serialNumbers : line.serialNumbers).filter(
        (serial) => back?.serialNumbers.has(serial) !== true,
      ),
    };
  });
  const payments = data.purchase.payments
    .filter((payment) => payment.status === 'posted')
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .flatMap((payment) =>
      payment.allocations
        .filter((allocation) => allocation.billId === stored.id)
        .flatMap((allocation) =>
          payment.number === null
            ? []
            : [
                {
                  paymentId: payment.id,
                  paymentNumber: payment.number,
                  date: payment.date,
                  amount: allocation.amount,
                },
              ],
        ),
    );
  const owing = stored.status === 'posted' && compareMoney(dueOn(data, stored), '0') > 0;
  return {
    ...stored,
    ...billSummaryOf(data, stored),
    lines,
    priceDifference: sumMoney(lines.map(priceDifferenceOf)),
    receipts: [...receipts.values()]
      .toSorted((a, b) => a.date.localeCompare(b.date))
      .map((receipt): DocumentRef => ({ id: receipt.id, number: receipt.number })),
    orders: [...orders.values()]
      .toSorted((a, b) => (a.number ?? '').localeCompare(b.number ?? ''))
      .map((order): DocumentRef => ({ id: order.id, number: order.number })),
    payments,
    advances: owing ? advancesFor(data, stored.supplier.id, new Set(orders.keys())) : [],
    debitNotes: debitNotesFor(data, stored.id),
    openDebitNotes: owing ? openDebitNotesFor(data, stored.supplier.id) : [],
    approval: historyOf(data, 'bill', stored.id),
  };
}

function matchesPayment(
  bill: BillSummary,
  payment: BillPaymentFilter | undefined,
  today: string,
): boolean {
  if (payment === undefined) return true;
  if (bill.status !== 'posted') return false;
  const paid = billPaymentStatusOf(bill) === 'paid';
  if (payment === 'paid') return paid;
  if (payment === 'open') return !paid;
  return isBillOverdue(bill, today);
}

// Newest date first; "open" and "overdue" list the oldest due date first, the order a payment pays
// them in (the payment form reads this list for its suggestion). The array keeps the newest
// first, so it is reversed before the stable sort, like the invoices' list.
export function listBills(
  data: WorkspaceData,
  query: {
    status?: BillStatus | undefined;
    supplierId?: string | undefined;
    payment?: BillPaymentFilter | undefined;
  },
): BillSummary[] {
  const today = todayIn(data.settings.timezone);
  const byDue = query.payment === 'open' || query.payment === 'overdue';
  const stored = byDue
    ? data.purchase.bills.toReversed().toSorted((a, b) => a.dueDate.localeCompare(b.dueDate))
    : newestFirst(data.purchase.bills);
  return stored
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.supplierId === undefined || item.supplier.id === query.supplierId),
    )
    .map((item) => billSummaryOf(data, item))
    .filter((item) => matchesPayment(item, query.payment, today));
}

// --- Bills: what a save checks ------------------------------------------------------------------

type BillFields = Omit<BillInput, 'submit'>;

// What a line names, as the form sends it and as the bill keeps it
interface LineRefs {
  receiptLineId: string | null;
  orderLineId: string | null;
  variantId: string;
  unitId: string;
  quantity: string;
}

// What a line bills, once checked: a receipt line keeps its order line too, like the API's
interface LineSource {
  receiptLineId: string | null;
  orderLineId: string | null;
}

// A line's quantity in the item's base unit; null for a unit the item does not have
function baseQuantityOf(data: WorkspaceData, line: LineRefs): string | null {
  const found = findVariant(data, line.variantId);
  if (!found) return null;
  const { product } = found;
  const factor =
    line.unitId === product.baseUnitId
      ? '1'
      : product.units.find((pack) => pack.unitId === line.unitId)?.factor;
  if (factor === undefined) return null;
  return toBaseQuantity(line.quantity, factor, decimalsOf(data, product.baseUnitId));
}

// The service lines among the order's that another posted bill billed already
function billedElsewhere(data: WorkspaceData, billId: string | null, orderLineId: string): boolean {
  return data.purchase.bills.some(
    (bill) =>
      bill.id !== billId &&
      bill.status === 'posted' &&
      bill.lines.some((line) => line.receiptLineId === null && line.orderLineId === orderLineId),
  );
}

// The API's checkSources(): a receipt line is on a posted goods receipt of this supplier that a
// person made from an order (a receipt a bill made is that bill's), of the same item, kept
// something (step 17d: what was accepted less what posted returns sent back), is billed whole,
// that is all it kept (in any unit of the item), and is not billed yet; an order line is a
// service line of an approved, received or closed order of this supplier, billed whole, and not
// billed by another posted bill. The orders behind the lines must read prices the same way. Run
// at save, at submit and at posting: a draft holds nothing (decision 29), so another bill may have
// billed a line in between.
function checkSources(
  data: WorkspaceData,
  billId: string | null,
  supplierId: string,
  lines: readonly LineRefs[],
) {
  const issues: { path: string; code: ErrorCode }[] = [];
  const vatSettings = new Set<boolean>();
  const terms: number[] = [];
  const keptVariantIds = new Set<string>();
  const keptRateIds = new Set<string>();
  const useOrderLine = (orderLineId: string | null) => {
    const found = orderLineId === null ? undefined : orderLineOf(data, orderLineId);
    if (!found) return;
    vatSettings.add(found.order.pricesIncludeVat);
    terms.push(found.order.paymentTermsDays);
    keptRateIds.add(found.line.taxRate.id);
  };
  const sources = lines.map((line, index): LineSource => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    if (line.receiptLineId !== null) {
      const found = receiptLineOf(data, line.receiptLineId);
      const base = baseQuantityOf(data, line);
      if (
        found?.receipt.supplier.id !== supplierId ||
        found.receipt.status !== 'posted' ||
        found.receipt.billId !== null ||
        found.line.variantId !== line.variantId ||
        compareQuantity(keptQuantity(found.line), '0') === 0
      ) {
        at('receiptLineId', 'bill_receipt_line_invalid');
      } else if (base === null || compareQuantity(base, keptQuantity(found.line)) !== 0) {
        at('quantity', 'bill_receipt_line_quantity');
      } else if (found.line.billed) {
        at('receiptLineId', 'bill_receipt_line_billed');
      }
      const orderLineId = found?.line.orderLineId ?? null;
      keptVariantIds.add(line.variantId);
      useOrderLine(orderLineId);
      return { receiptLineId: line.receiptLineId, orderLineId };
    }
    if (line.orderLineId !== null) {
      const found = orderLineOf(data, line.orderLineId);
      // Goods on an order are billed through their goods receipt: only the receipt says they came
      if (
        found?.order.supplier.id !== supplierId ||
        !['approved', 'received', 'closed'].includes(found.order.status) ||
        found.line.productType !== 'service' ||
        found.line.variantId !== line.variantId ||
        found.line.unitId !== line.unitId ||
        compareQuantity(found.line.quantity, line.quantity) !== 0
      ) {
        at('orderLineId', 'bill_order_line_invalid');
      } else if (billedElsewhere(data, billId, line.orderLineId)) {
        at('orderLineId', 'bill_order_line_billed');
      }
      keptVariantIds.add(line.variantId);
      useOrderLine(line.orderLineId);
      return { receiptLineId: null, orderLineId: line.orderLineId };
    }
    return { receiptLineId: null, orderLineId: null };
  });
  if (issues.length > 0) throw issuesError(issues);
  // One bill reads its prices one way: two orders that disagree cannot share a bill
  if (vatSettings.size > 1) throw conflict('bill_vat_mixed');
  const [pricesIncludeVat] = [...vatSettings];
  return {
    sources,
    pricesIncludeVat: pricesIncludeVat ?? null,
    // The shortest: the bill is due when the first of its orders says (decision 19)
    paymentTermsDays: terms.length === 0 ? null : Math.min(...terms),
    keptVariantIds,
    keptRateIds,
  };
}

// The receipt a bill makes for its own goods names its lines lines.0, lines.1 …; on the bill they
// are, say, lines.2 and lines.5. Each problem moves under the bill line it belongs to, like the
// API's onBillLines().
function onBillLines<T>(indexes: readonly number[], fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof MockProblem) || error.fieldErrors === undefined) throw error;
    const fieldErrors = Object.fromEntries(
      Object.entries(error.fieldErrors).map(([path, codes]) => {
        const match = /^lines\.(\d+)\.(.+)$/.exec(path);
        const index = match ? indexes[Number(match[1])] : undefined;
        return [
          match && index !== undefined ? `lines.${String(index)}.${match[2] ?? ''}` : path,
          codes,
        ];
      }),
    );
    throw new MockProblem(error.status, error.code, fieldErrors, error.params);
  }
}

// A goods line of its own as a goods receipt line takes it: everything accepted
function ownGoodsInput(line: {
  variantId: string;
  unitId: string;
  quantity: string;
  lotNumber: string | null;
  expiresOn: string | null;
  manufacturedOn: string | null;
  serialNumbers: readonly string[];
}) {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    lotNumber: line.lotNumber,
    expiresOn: line.expiresOn,
    manufacturedOn: line.manufacturedOn,
    serialNumbers: [...line.serialNumbers],
  };
}

// The stock fields a line of its own keeps until its posting receives it
interface OwnStock {
  lotNumber: string | null;
  expiresOn: string | null;
  manufacturedOn: string | null;
  serialNumbers: string[];
}

const NO_STOCK: OwnStock = {
  lotNumber: null,
  expiresOn: null,
  manufacturedOn: null,
  serialNumbers: [],
};

// The API's checkOwnLines(): the lines that are neither a receipt line nor an order's service
// line, and every line's account. A goods line of its own is received by the bill when it is
// posted, so it is checked like a goods receipt line now and needs the warehouse; it takes no
// account. A service line goes to its account, or to Settings' "Purchased services" when it names
// none (decision 16), and takes no lot. A receipt line has neither.
function checkOwnLines(
  data: WorkspaceData,
  input: BillFields,
  resolved: readonly ResolvedLine[],
  sources: readonly LineSource[],
  keptWarehouseId: string | null,
): { accounts: (string | null)[]; stock: OwnStock[]; warehouseId: string | null } {
  const issues: { path: string; code: ErrorCode }[] = [];
  const goods: number[] = [];
  const accounts = resolved.map(({ line }, index): string | null => {
    const source = sources[index];
    const typed = input.lines[index];
    if (!source || !typed || source.receiptLineId !== null) return null;
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    if (line.productType === 'goods') {
      // checkSources() already refused an order's goods line
      if (source.orderLineId !== null) return null;
      if (typed.accountId !== null) at('accountId', 'bill_account_not_allowed');
      goods.push(index);
      return null;
    }
    const stockFields = [
      ['lotNumber', typed.lotNumber !== null],
      ['expiresOn', typed.expiresOn !== null],
      ['manufacturedOn', typed.manufacturedOn !== null],
      ['serialNumbers', typed.serialNumbers.length > 0],
    ] as const;
    for (const [field, filled] of stockFields) {
      if (filled) at(field, 'bill_stock_not_allowed');
    }
    const accountId = typed.accountId ?? data.purchaseAccounts.services;
    if (accountId === null) at('accountId', 'bill_account_required');
    return accountId;
  });
  if (issues.length > 0) throw issuesError(issues);
  const stock = resolved.map((): OwnStock => NO_STOCK);
  if (goods.length === 0) return { accounts, stock, warehouseId: null };
  if (input.warehouseId === null) throw fieldProblem('bill_warehouse_required', 'warehouseId');
  assertWarehouse(data, input.warehouseId, keptWarehouseId);
  const checked = onBillLines(goods, () =>
    resolveReceiptLines(
      data,
      goods.flatMap((index) => {
        const line = input.lines[index];
        return line
          ? [
              {
                ...ownGoodsInput(line),
                orderLineId: null,
                rejectedQuantity: '0',
                rejectionReason: null,
              },
            ]
          : [];
      }),
    ),
  );
  // As the goods receipt will keep them: no lot on a product without batches
  goods.forEach((index, position) => {
    const line = checked[position];
    if (!line) return;
    stock[index] = {
      lotNumber: line.lotNumber,
      expiresOn: line.expiresOn,
      manufacturedOn: line.manufacturedOn,
      serialNumbers: line.serialNumbers,
    };
  });
  return { accounts, stock, warehouseId: input.warehouseId };
}

interface ResolvedExpense {
  input: BillFields['expenses'][number];
  rate: { id: string; name: string; kind: string; rate: string };
  amounts: LineAmounts;
}

// The expenses priced like a sales line of one unit (expenseLineAmounts), each with an active VAT
// rate (or one the draft already used)
function resolveExpenses(
  data: WorkspaceData,
  expenses: BillFields['expenses'],
  pricesIncludeVat: boolean,
  keptRateIds: ReadonlySet<string>,
): ResolvedExpense[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = expenses.flatMap((expense, index): ResolvedExpense[] => {
    const rate = data.sales.taxRates.find((item) => item.id === expense.taxRateId);
    if (!rate || (rate.archivedAt !== null && !keptRateIds.has(rate.id))) {
      issues.push({ path: `expenses.${String(index)}.taxRateId`, code: 'tax_rate_invalid' });
      return [];
    }
    return [
      {
        input: expense,
        rate: { id: rate.id, name: rate.name, kind: rate.kind, rate: rate.rate },
        amounts: expenseLineAmounts({ amount: expense.amount, rate: rate.rate }, pricesIncludeVat),
      },
    ];
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

// The accounts a service line or an expense posts to (decision 40): an active expense or asset
// account that is not a group and not one only the system posts to: no purpose (the payable, VAT,
// inventory, cost of goods sold), no stock account and no money account. The API's
// checkCostAccounts(), and the form's costAccounts().
function checkCostAccounts(
  data: WorkspaceData,
  wanted: readonly { path: string; accountId: string }[],
): void {
  const money = moneyAccountIds(data.accounts);
  const stock = stockAccountIds(data);
  const usable = (id: string) => {
    const account = data.accounts.find((item) => item.id === id);
    return (
      account !== undefined &&
      (account.type === 'expense' || account.type === 'asset') &&
      !account.isGroup &&
      account.archivedAt === null &&
      account.purpose === null &&
      !money.has(id) &&
      !stock.has(id)
    );
  };
  const issues = wanted.flatMap((item) =>
    usable(item.accountId) ? [] : [{ path: item.path, code: 'bill_account_invalid' as const }],
  );
  if (issues.length > 0) throw issuesError(issues);
}

// Once per supplier, among bills that are not cancelled, ignoring case and spaces at the ends:
// the API's bills_supplier_bill_number_idx. A cancelled bill frees its number.
function assertBillNumberFree(
  data: WorkspaceData,
  supplierId: string,
  supplierBillNumber: string,
  exceptId: string | null,
): void {
  const key = supplierBillNumber.trim().toLowerCase();
  const taken = data.purchase.bills.some(
    (bill) =>
      bill.id !== exceptId &&
      bill.supplier.id === supplierId &&
      bill.status !== 'cancelled' &&
      bill.supplierBillNumber.trim().toLowerCase() === key,
  );
  if (taken) throw fieldProblem('bill_supplier_number_taken', 'supplierBillNumber');
}

// The stored lines' accounts and expenses, as checkCostAccounts() takes them
function costAccountsOf(
  lines: readonly { accountId: string | null }[],
  expenses: readonly { accountId: string }[],
) {
  return [
    ...lines.flatMap((line, index) =>
      line.accountId === null
        ? []
        : [{ path: `lines.${String(index)}.accountId`, accountId: line.accountId }],
    ),
    ...expenses.map((expense, index) => ({
      path: `expenses.${String(index)}.accountId`,
      accountId: expense.accountId,
    })),
  ];
}

// --- Bills: saving ------------------------------------------------------------------------------

// Create (no `existing`: a draft without a number) or change a draft. A numbered draft (sent back
// or reopened) keeps its supplier: the approvers saw it as this supplier's bill.
export function saveBill(data: WorkspaceData, input: BillFields, existing?: MockBill): MockBill {
  if (existing && existing.status !== 'draft') throw conflict('purchase_not_draft');
  const supplier = supplierOf(data, input.supplierId, existing?.supplier.id ?? null);
  if (existing && existing.number !== null && supplier.id !== existing.supplier.id) {
    throw fieldProblem('purchase_supplier_invalid', 'supplierId');
  }
  assertBranch(data, input.branchId);
  const checked = checkSources(data, existing?.id ?? null, supplier.id, input.lines);
  // The orders' setting when the lines bill orders (decision 15 of 17b), else the form's
  const pricesIncludeVat = checked.pricesIncludeVat ?? input.pricesIncludeVat;
  const keptRateIds = new Set([
    ...checked.keptRateIds,
    ...ratesOf(existing?.lines ?? []),
    ...(existing?.expenses.map((expense) => expense.taxRate.id) ?? []),
  ]);
  const resolved = resolveSalesLines(
    data,
    input.lines,
    pricesIncludeVat,
    keptRateIds,
    checked.keptVariantIds,
    'purchase_item_invalid',
  );
  const own = checkOwnLines(data, input, resolved, checked.sources, existing?.warehouseId ?? null);
  const expenses = resolveExpenses(data, input.expenses, pricesIncludeVat, keptRateIds);
  checkCostAccounts(
    data,
    costAccountsOf(
      own.accounts.map((accountId) => ({ accountId })),
      input.expenses,
    ),
  );
  assertBillNumberFree(data, supplier.id, input.supplierBillNumber, existing?.id ?? null);
  const terms =
    checked.paymentTermsDays ??
    data.suppliers.suppliers.find((item) => item.id === supplier.id)?.paymentTermsDays ??
    0;
  const lines = resolved.map(({ line }, index): MockBillLine => {
    const source = checked.sources[index] ?? { receiptLineId: null, orderLineId: null };
    return {
      ...line,
      receiptLineId: source.receiptLineId,
      orderLineId: source.orderLineId,
      accountId: own.accounts[index] ?? null,
      batchId: null,
      ...(own.stock[index] ?? NO_STOCK),
      // Step 17d: a debit note's posting adds to it, on a posted bill
      debited: '0.0000',
    };
  });
  const saved: MockBill = {
    id: existing?.id ?? crypto.randomUUID(),
    number: existing?.number ?? null,
    date: input.date,
    // An empty box: the date plus the orders' payment terms, else the supplier's (decision 19)
    dueDate: input.dueDate ?? dueDateOf(input.date, terms),
    supplier,
    supplierBillNumber: input.supplierBillNumber,
    mushakNumber: input.mushakNumber,
    mushakDate: input.mushakDate,
    branchId: input.branchId,
    status: 'draft',
    pricesIncludeVat,
    ...documentTotals([
      ...resolved.map((item) => item.amounts),
      ...expenses.map((item) => item.amounts),
    ]),
    // Only a bill with goods of its own receives anything
    warehouseId: own.warehouseId,
    note: input.note,
    lines,
    expenses: expenses.map((expense) => ({
      id: crypto.randomUUID(),
      accountId: expense.input.accountId,
      description: expense.input.description,
      // "2500" → "2500.0000": the way Postgres sends NUMERIC(19,4)
      amount: addMoney(expense.input.amount, '0'),
      taxRate: expense.rate,
      net: expense.amounts.net,
      vat: expense.amounts.vat,
      total: expense.amounts.total,
      debited: '0.0000',
    })),
    entry: null,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
  const { bills } = data.purchase;
  data.purchase.bills = existing
    ? bills.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...bills];
  return saved;
}

// Only a draft that was never submitted (decision 13); once numbered it is cancelled instead
export function removeBill(data: WorkspaceData, target: MockBill): void {
  if (target.status !== 'draft') throw conflict('purchase_not_draft');
  if (target.number !== null) throw conflict('purchase_was_submitted');
  data.purchase.bills = data.purchase.bills.filter((item) => item.id !== target.id);
}

// The stored bill against what is true now, without a draft's allowances: an active supplier,
// branch and warehouse, each line's source still billable, each account still usable. Returns
// the indexes of its goods lines of its own.
function recheckBill(data: WorkspaceData, bill: MockBill): number[] {
  supplierOf(data, bill.supplier.id, null);
  assertBranch(data, bill.branchId);
  checkSources(data, bill.id, bill.supplier.id, bill.lines);
  const own = bill.lines.flatMap((line, index) =>
    line.receiptLineId === null && line.orderLineId === null && line.productType === 'goods'
      ? [index]
      : [],
  );
  if (own.length > 0) {
    if (bill.warehouseId === null) throw fieldProblem('bill_warehouse_required', 'warehouseId');
    assertWarehouse(data, bill.warehouseId, null);
  }
  checkCostAccounts(data, costAccountsOf(bill.lines, bill.expenses));
  return own;
}

// Numbered the first time (decision 13), checked again as it stands now, then handed to the engine
// with its total, VAT included. The mock's Owner is approved at once, so it is posted at once.
// Returns how many steps its round has. The handler runs it in a transaction(): a refused posting
// leaves the bill a draft, with no number used.
export function submitBill(data: WorkspaceData, target: MockBill): number {
  if (target.status !== 'draft') throw conflict('purchase_not_draft');
  recheckBill(data, target);
  target.number ??= nextNumber(data, 'bill', target.date);
  moveTo(target, 'pending');
  const steps = submitRound(data, 'bill', { id: target.id, amount: target.total });
  postBill(data, target);
  return steps;
}

// A journal amount before the lines are summed: + debit, − credit. Exported with summed() and
// priceDifferenceAccount() for step 17d's debit notes, which book on the same accounts.
export interface Amount {
  accountId: string;
  branchId: string;
  partyId: string | null;
  amount: string;
}

// Summed per account, branch and party: a bill of 300 receipt lines is a five-line entry. Zero
// sums drop out.
export function summed(amounts: readonly Amount[]) {
  const sums = new Map<string, Amount>();
  for (const item of amounts) {
    const key = `${item.accountId}|${item.branchId}|${item.partyId ?? ''}`;
    const sum = sums.get(key) ?? { ...item, amount: '0' };
    sum.amount = addMoney(sum.amount, item.amount);
    sums.set(key, sum);
  }
  return [...sums.values()]
    .filter((sum) => !isZeroMoney(sum.amount))
    .map((sum) => {
      const debit = compareMoney(sum.amount, '0') > 0;
      const amount = debit ? sum.amount : subtractMoney('0', sum.amount);
      return side(
        sum.accountId,
        sum.branchId,
        sum.partyId,
        debit ? { debit: amount } : { credit: amount },
      );
    });
}

// Settings → Purchase's price difference account, or Cost of goods sold when none is chosen
// (decision 17). Asked for only when a line differs from its order.
export function priceDifferenceAccount(data: WorkspaceData): string {
  const chosen = data.purchaseAccounts.priceDifference;
  if (chosen === null) return purposeAccount(data, 'cost_of_goods_sold');
  const account = data.accounts.find((item) => item.id === chosen);
  if (!account || account.isGroup || account.archivedAt !== null) {
    throw new MockProblem(409, 'purchase_account_invalid', undefined, { use: 'price_difference' });
  }
  return chosen;
}

// The API's post(), in its order, called by submitBill() or by the engine when the last approval
// is given: the date, the bill checked again, its own goods in on a goods receipt it makes, the
// receipt lines it bills marked billed, the entry, and the bill posted last. The caller runs in a
// transaction(): a refused step leaves nothing, not even the receipt it made.
export function postBill(data: WorkspaceData, bill: MockBill): void {
  const number = bill.number;
  if (bill.status !== 'pending' || number === null) {
    throw new Error(`Bill ${bill.id} is not a numbered pending bill`);
  }
  // The date first: a closed period refuses before anything moves
  assertPeriodOpen(data, bill.date);
  const own = recheckBill(data, bill);

  // The goods of its own lines, received into the bill's warehouse at their net. The lines get
  // the receipt lines it made; those are billed from the start.
  const ownBranch = new Map<string, string>();
  const { warehouseId } = bill;
  if (own.length > 0 && warehouseId !== null) {
    const made = onBillLines(own, () =>
      receiveForBill(data, {
        billId: bill.id,
        billNumber: number,
        supplier: bill.supplier,
        date: bill.date,
        warehouseId,
        lines: own.flatMap((index) => {
          const line = bill.lines[index];
          return line ? [{ ...ownGoodsInput(line), value: line.net }] : [];
        }),
      }),
    );
    const branchId = branchOf(data, warehouseId) ?? bill.branchId;
    own.forEach((index, position) => {
      const line = bill.lines[index];
      const received = made.lines[position];
      if (!line || !received) return;
      line.receiptLineId = received.id;
      ownBranch.set(line.id, branchId);
    });
  }

  // Each receipt line billed once: false → true, never back
  for (const line of bill.lines) {
    const found = line.receiptLineId === null ? undefined : receiptLineOf(data, line.receiptLineId);
    if (found) found.line.billed = true;
  }

  // The books (decision 2): Dr Goods received not billed at what each goods receipt booked, with
  // that receipt's branch; Dr / Cr the price difference with the bill's branch; Dr each service
  // line's and expense's account; Dr VAT input; Cr Accounts payable with the supplier. A bill of
  // ৳0 has no entry.
  let entry: EntryRef | null = null;
  if (!isZeroMoney(bill.total)) {
    const amounts: Amount[] = [];
    const goods = bill.lines.flatMap((line) => {
      const found =
        line.receiptLineId === null ? undefined : receiptLineOf(data, line.receiptLineId);
      if (!found) return [];
      const branchId =
        ownBranch.get(line.id) ?? branchOf(data, found.receipt.warehouseId) ?? bill.branchId;
      // A line of its own came in at its net: no price difference. Step 17d: what the receipt
      // booked less what returns took back before this bill (the line bills what was kept).
      const orderValue = ownBranch.has(line.id)
        ? line.net
        : subtractMoney(found.line.value ?? '0', returnedBeforeBilling(data, found.line.id).value);
      return [
        { branchId, orderValue, difference: priceDifferenceOf({ net: line.net, orderValue }) },
      ];
    });
    if (goods.length > 0) {
      const notBilled = bookAccounts(data).use('received_not_billed');
      for (const line of goods) {
        amounts.push({
          accountId: notBilled,
          branchId: line.branchId,
          partyId: null,
          amount: line.orderValue,
        });
        // Only a line that differs needs the account
        if (!isZeroMoney(line.difference)) {
          amounts.push({
            accountId: priceDifferenceAccount(data),
            branchId: bill.branchId,
            partyId: null,
            amount: line.difference,
          });
        }
      }
    }
    for (const cost of [...bill.lines, ...bill.expenses]) {
      if (cost.accountId === null) continue;
      amounts.push({
        accountId: cost.accountId,
        branchId: bill.branchId,
        partyId: null,
        amount: cost.net,
      });
    }
    amounts.push(
      {
        accountId: purposeAccount(data, 'vat_input'),
        branchId: bill.branchId,
        partyId: null,
        amount: bill.vat,
      },
      {
        accountId: purposeAccount(data, 'accounts_payable'),
        branchId: bill.branchId,
        partyId: bill.supplier.id,
        amount: subtractMoney('0', bill.total),
      },
    );
    entry = refOf(
      postNew(
        data,
        { date: bill.date, narration: `Bill ${number}`, lines: summed(amounts) },
        'purchase_bill',
        { id: bill.id, number },
      ),
    );
  }
  Object.assign(bill, {
    status: 'posted',
    entry,
    postedAt: now(),
    version: bill.version + 1,
    updatedAt: now(),
  });
}

// Pending: taken back to change it, or because the supplier sent a corrected bill. A posted bill
// is never reopened: a debit note corrects it (17d).
export function reopenBill(data: WorkspaceData, target: MockBill): void {
  if (target.status !== 'pending') throw conflict('purchase_cannot_reopen');
  endPendingRound(data, 'bill', target.id);
  moveTo(target, 'draft');
}

// Will not be booked: a numbered draft, or a pending bill, whose round ends as reopened first
// (decision 31). Its supplier number is free again.
export function cancelBill(data: WorkspaceData, target: MockBill): void {
  if (target.status !== 'draft' && target.status !== 'pending') {
    throw conflict('purchase_cannot_cancel');
  }
  if (target.number === null) throw conflict('purchase_delete_instead');
  if (target.status === 'pending') endPendingRound(data, 'bill', target.id);
  moveTo(target, 'cancelled');
}

// --- Supplier payments: reading -----------------------------------------------------------------

export function findPayment(data: WorkspaceData, id: string): MockSupplierPayment {
  const found = data.purchase.payments.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// What it applies, or (a draft) plans to apply
function appliedOf(payment: MockSupplierPayment): string {
  return sumMoney(payment.allocations.map((allocation) => allocation.amount));
}

export function paymentSummaryOf(
  data: WorkspaceData,
  stored: MockSupplierPayment,
): SupplierPaymentSummary {
  const order = data.purchase.orders.find((item) => item.id === stored.orderId);
  return {
    id: stored.id,
    number: stored.number,
    date: stored.date,
    supplier: stored.supplier,
    amount: stored.amount,
    applied: appliedOf(stored),
    refunded: refundedFrom(data, 'supplier_payment', stored.id),
    method: stored.method,
    reference: stored.reference,
    accountId: stored.accountId,
    branchId: stored.branchId,
    order: order ? { id: order.id, number: order.number } : null,
    status: stored.status,
    postedAt: stored.postedAt,
    version: stored.version,
    updatedAt: stored.updatedAt,
  };
}

// The bills some money pays (or plans to), oldest due date first: the order the form suggested
// them in. Money is put only on posted bills, so each has a number. A payment's, and a debit
// note's (step 17d).
export function allocationRefs(
  data: WorkspaceData,
  allocations: readonly MockBillAllocation[],
): PaymentAllocation[] {
  return allocations
    .flatMap((allocation) => {
      const bill = data.purchase.bills.find((item) => item.id === allocation.billId);
      const number = bill?.number ?? null;
      if (!bill || number === null) return [];
      return [
        {
          billId: bill.id,
          billNumber: number,
          supplierBillNumber: bill.supplierBillNumber,
          billDate: bill.date,
          dueDate: bill.dueDate,
          billTotal: bill.total,
          amount: allocation.amount,
        },
      ];
    })
    .toSorted((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function toSupplierPayment(
  data: WorkspaceData,
  stored: MockSupplierPayment,
): SupplierPayment {
  // As the supplier has it now: an account the supplier removed is gone from the payment too,
  // like the API's ON DELETE SET NULL (decision 33)
  const bankAccount = data.suppliers.suppliers
    .find((item) => item.id === stored.supplier.id)
    ?.bankAccounts.find((account) => account.id === stored.supplierBankAccountId);
  return {
    ...paymentSummaryOf(data, stored),
    note: stored.note,
    supplierBankAccount: bankAccount ?? null,
    allocations: allocationRefs(data, stored.allocations),
    entry: stored.entry,
    voidEntry: stored.voidEntry,
    voidDate: stored.voidDate,
    voidReason: stored.voidReason,
    approval: historyOf(data, 'supplier_payment', stored.id),
  };
}

export function listPayments(
  data: WorkspaceData,
  query: {
    status?: SupplierPaymentStatus | undefined;
    supplierId?: string | undefined;
    orderId?: string | undefined;
  },
): SupplierPaymentSummary[] {
  return newestFirst(data.purchase.payments)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.supplierId === undefined || item.supplier.id === query.supplierId) &&
        (query.orderId === undefined || item.orderId === query.orderId),
    )
    .map((item) => paymentSummaryOf(data, item));
}

// --- Supplier payments: writing -----------------------------------------------------------------

type PaymentFields = Omit<SupplierPaymentInput, 'submit'>;

// The codes a row's problems get: a payment's here, a debit note's in purchase-return-data.ts
// (step 17d)
export interface BillAllocationErrors {
  // Not a posted bill of the supplier
  bill: ErrorCode;
  // More than the bill still owes
  over: ErrorCode;
}

const PAYMENT_ERRORS = {
  bill: 'payment_bill_invalid',
  over: 'payment_over_bill',
} as const satisfies BillAllocationErrors;

// The API's checkBillAllocations(): `wanted` before it replaces `current` (the rows the bills count
// now: a posted payment's; a draft's plan counts on no bill, so it passes none). Each row names a
// posted bill of the supplier and fits what it still owes (less what debit notes settled, step
// 17d), where this document's own current row counts as owed again. Every problem at once, under
// its row. Step 17d: a debit note's money is applied with it too, with its own codes.
export function checkBillAllocations(
  data: WorkspaceData,
  input: {
    supplierId: string;
    current: readonly MockBillAllocation[];
    wanted: readonly MockBillAllocation[];
    errors: BillAllocationErrors;
  },
): void {
  const had = new Map(input.current.map((allocation) => [allocation.billId, allocation.amount]));
  const issues: { path: string; code: ErrorCode }[] = [];
  input.wanted.forEach((allocation, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `allocations.${String(index)}.${field}`, code });
    };
    const bill = data.purchase.bills.find((item) => item.id === allocation.billId);
    if (bill?.supplier.id !== input.supplierId || bill.status !== 'posted') {
      at('billId', input.errors.bill);
      return;
    }
    const due = addMoney(dueOn(data, bill), had.get(bill.id) ?? '0');
    if (compareMoney(allocation.amount, due) > 0) at('amount', input.errors.over);
  });
  if (issues.length > 0) throw issuesError(issues);
}

// "2500" → "2500.0000", like the API's NUMERIC(19,4)
export function asStored(allocations: readonly MockBillAllocation[]): MockBillAllocation[] {
  return allocations.map((allocation) => ({
    billId: allocation.billId,
    amount: addMoney(allocation.amount, '0'),
  }));
}

// The API's check(): the branch, the money account, the supplier's own bank account, the order an
// advance names (an approved, received or closed order of this supplier, decision 12), and a plan
// that fits what each bill owes now. The plan holds nothing: it is checked again at submit and post.
function checkPayment(data: WorkspaceData, supplierId: string, input: PaymentFields): void {
  assertBranch(data, input.branchId);
  if (!moneyAccountIds(data.accounts).has(input.accountId)) {
    throw fieldProblem('payment_account_invalid', 'accountId');
  }
  if (input.supplierBankAccountId !== null) {
    const supplier = data.suppliers.suppliers.find((item) => item.id === supplierId);
    const found = supplier?.bankAccounts.some((item) => item.id === input.supplierBankAccountId);
    if (!found) throw fieldProblem('payment_bank_account_invalid', 'supplierBankAccountId');
  }
  if (input.orderId !== null) {
    const order = data.purchase.orders.find((item) => item.id === input.orderId);
    if (
      order?.supplier.id !== supplierId ||
      !['approved', 'received', 'closed'].includes(order.status)
    ) {
      throw fieldProblem('payment_order_invalid', 'orderId');
    }
  }
  checkBillAllocations(data, {
    supplierId,
    current: [],
    wanted: input.allocations,
    errors: PAYMENT_ERRORS,
  });
}

// Create (no `existing`) or change a draft; the plan is saved with it. A numbered draft keeps its
// supplier.
export function savePayment(
  data: WorkspaceData,
  input: PaymentFields,
  existing?: MockSupplierPayment,
): MockSupplierPayment {
  if (existing && existing.status !== 'draft') throw conflict('purchase_not_draft');
  const supplier = supplierOf(data, input.supplierId, existing?.supplier.id ?? null);
  if (existing && existing.number !== null && supplier.id !== existing.supplier.id) {
    throw fieldProblem('purchase_supplier_invalid', 'supplierId');
  }
  checkPayment(data, supplier.id, input);
  const saved: MockSupplierPayment = {
    id: existing?.id ?? crypto.randomUUID(),
    number: existing?.number ?? null,
    date: input.date,
    supplier,
    amount: addMoney(input.amount, '0'),
    method: input.method,
    reference: input.reference,
    accountId: input.accountId,
    branchId: input.branchId,
    supplierBankAccountId: input.supplierBankAccountId,
    orderId: input.orderId,
    status: 'draft',
    note: input.note,
    allocations: asStored(input.allocations),
    entry: null,
    voidEntry: null,
    voidDate: null,
    voidReason: null,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
  const { payments } = data.purchase;
  data.purchase.payments = existing
    ? payments.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...payments];
  return saved;
}

// Only a draft that was never submitted; its plan goes with it
export function removePayment(data: WorkspaceData, target: MockSupplierPayment): void {
  if (target.status !== 'draft') throw conflict('purchase_not_draft');
  if (target.number !== null) throw conflict('purchase_was_submitted');
  data.purchase.payments = data.purchase.payments.filter((item) => item.id !== target.id);
}

// The stored payment against what is true now: an active supplier, branch and money account, and
// a plan that still fits what each bill owes (a draft's plan is not on the bills yet)
function recheckPayment(data: WorkspaceData, payment: MockSupplierPayment): void {
  supplierOf(data, payment.supplier.id, null);
  assertBranch(data, payment.branchId);
  if (!moneyAccountIds(data.accounts).has(payment.accountId)) {
    throw fieldProblem('payment_account_invalid', 'accountId');
  }
  checkBillAllocations(data, {
    supplierId: payment.supplier.id,
    current: [],
    wanted: payment.allocations,
    errors: PAYMENT_ERRORS,
  });
}

// Like submitBill(): numbered the first time, checked again, then approved and posted at once for
// the mock's Owner. Returns how many steps its round has.
export function submitPayment(data: WorkspaceData, target: MockSupplierPayment): number {
  if (target.status !== 'draft') throw conflict('purchase_not_draft');
  recheckPayment(data, target);
  target.number ??= nextNumber(data, 'payment', target.date);
  moveTo(target, 'pending');
  const steps = submitRound(data, 'supplier_payment', { id: target.id, amount: target.amount });
  postPayment(data, target);
  return steps;
}

// Posting (decision 7): Dr Accounts payable (the supplier) / Cr the money account, both with the
// payment's branch, then the plan lands on the bills (they read posted payments' rows). The entry
// first: a closed period refuses there.
export function postPayment(data: WorkspaceData, payment: MockSupplierPayment): void {
  const number = payment.number;
  if (payment.status !== 'pending' || number === null) {
    throw new Error(`Supplier payment ${payment.id} is not a numbered pending payment`);
  }
  recheckPayment(data, payment);
  const entry = postNew(
    data,
    {
      date: payment.date,
      narration: `Payment ${number}`,
      lines: [
        side(purposeAccount(data, 'accounts_payable'), payment.branchId, payment.supplier.id, {
          debit: payment.amount,
        }),
        side(payment.accountId, payment.branchId, null, { credit: payment.amount }),
      ],
    },
    'purchase_payment',
    { id: payment.id, number },
  );
  Object.assign(payment, {
    status: 'posted',
    entry: refOf(entry),
    postedAt: now(),
    version: payment.version + 1,
    updatedAt: now(),
  });
}

export function reopenPayment(data: WorkspaceData, target: MockSupplierPayment): void {
  if (target.status !== 'pending') throw conflict('purchase_cannot_reopen');
  endPendingRound(data, 'supplier_payment', target.id);
  moveTo(target, 'draft');
}

// A numbered draft, or a pending payment reopened first (decision 31). Its plan stays as history.
export function cancelPayment(data: WorkspaceData, target: MockSupplierPayment): void {
  if (target.status !== 'draft' && target.status !== 'pending') {
    throw conflict('purchase_cannot_cancel');
  }
  if (target.number === null) throw conflict('purchase_delete_instead');
  if (target.status === 'pending') endPendingRound(data, 'supplier_payment', target.id);
  moveTo(target, 'cancelled');
}

function assertPosted(payment: MockSupplierPayment): void {
  if (payment.status !== 'posted') throw conflict('payment_not_posted');
}

// A posted payment's money on other bills: an advance applied to the bill that came, or moved
// from one bill to another (decision 23). Nothing in the books changes.
export function allocatePayment(
  data: WorkspaceData,
  payment: MockSupplierPayment,
  allocations: readonly MockBillAllocation[],
): void {
  assertPosted(payment);
  // Step 17d: what supplier refunds paid back is gone; only the rest can be applied
  const left = subtractMoney(payment.amount, refundedFrom(data, 'supplier_payment', payment.id));
  if (overAllocated(left, allocations)) {
    throw new MockProblem(409, 'payment_over_allocated', {
      allocations: ['payment_over_allocated'],
    });
  }
  checkBillAllocations(data, {
    supplierId: payment.supplier.id,
    current: payment.allocations,
    wanted: allocations,
    errors: PAYMENT_ERRORS,
  });
  Object.assign(payment, {
    allocations: asStored(allocations),
    version: payment.version + 1,
    updatedAt: now(),
  });
}

// A bounced cheque: its money comes off the bills, and its entry is reversed on the void date.
// The payment stays, voided, with its number. Step 17d: not while a supplier refund paid some of
// it back: that refund would pay back money that was never paid. Void the refund first.
export function voidPayment(
  data: WorkspaceData,
  payment: MockSupplierPayment,
  input: { date: string; reason: string },
): void {
  assertPosted(payment);
  if (!isZeroMoney(refundedFrom(data, 'supplier_payment', payment.id))) {
    throw conflict('payment_has_refunds');
  }
  if (input.date < payment.date) throw fieldProblem('payment_void_date', 'date');
  if (payment.entry === null) throw new Error(`Supplier payment ${payment.id} has no entry`);
  const reversal = reverseEntry(data, findEntry(data, payment.entry.id), input.date, {
    allowPurchase: true,
    narration: `Payment ${payment.number ?? ''} voided: ${input.reason}`,
  });
  Object.assign(payment, {
    allocations: [],
    status: 'voided',
    voidDate: input.date,
    voidReason: input.reason,
    voidEntry: refOf(reversal),
    version: payment.version + 1,
    updatedAt: now(),
  });
}

// --- Seed ---------------------------------------------------------------------------------------

// The garments workspace's bills (after the orders: the levels and the people are theirs). One
// bill waits for Kamal, the purchase manager: Gazipur Carton's bill for 40 cartons of mailer bags
// with no order (a direct bill, so posting it receives them into the Main store) and the truck
// that brought them. Abdul Karim, an accountant, submitted it yesterday; ৳1,41,450 reaches the
// ৳1,00,000 level. Nothing is posted: the seeded books stay as they were.
export function seedBills(data: WorkspaceData, garments: boolean): void {
  if (!garments) return;
  const [main] = data.stock.warehouses;
  const carton = data.suppliers.suppliers.find((item) => item.name.startsWith('Gazipur Carton'));
  const rate = data.sales.taxRates.find((item) => item.isDefault);
  const manager = data.people.roles.find((item) => item.name === 'Purchase manager');
  const mailers = data.catalog.products.find((item) => item.code === 'P-00004');
  const unit = data.catalog.units.find((item) => item.code === 'carton');
  const transport = data.accounts.find((item) => item.code === '5170');
  const accountant = data.people.members.find((item) => item.fullName === 'Abdul Karim');
  const variant = mailers?.variants[0];
  if (!main || !carton || !rate || !manager || !variant || !unit || !transport || !accountant) {
    return;
  }
  const today = todayIn(data.settings.timezone);
  const date = shiftIsoDate(today, -2);
  const bill = saveBill(data, {
    supplierId: carton.id,
    date,
    dueDate: null,
    supplierBillNumber: 'GCI-2026-0318',
    mushakNumber: '6.3/GCI/0318',
    mushakDate: date,
    branchId: branchOf(data, main.id) ?? '',
    warehouseId: main.id,
    pricesIncludeVat: false,
    note: '40 cartons for the H&M polo order, delivered to gate 2.',
    lines: [
      {
        variantId: variant.id,
        unitId: unit.id,
        quantity: '40',
        description: null,
        unitPrice: '3000',
        discountType: 'percent',
        discount: '0',
        taxRateId: rate.id,
        receiptLineId: null,
        orderLineId: null,
        accountId: null,
        lotNumber: null,
        expiresOn: null,
        manufacturedOn: null,
        serialNumbers: [],
      },
    ],
    expenses: [
      {
        accountId: transport.id,
        description: 'Truck rent, Board Bazar to the Main store',
        amount: '3000',
        taxRateId: rate.id,
      },
    ],
  });
  const submittedAt = new Date(Date.now() - 86_400_000).toISOString();
  data.purchase.rounds.push({
    id: crypto.randomUUID(),
    document: 'bill',
    documentId: bill.id,
    status: 'pending',
    amount: bill.total,
    submittedBy: { id: accountant.userId, name: accountant.fullName },
    submittedAt,
    closedAt: null,
    steps: [
      {
        position: 1,
        minAmount: '100000.0000',
        role: { id: manager.id, name: manager.name },
        decision: null,
        decidedBy: null,
        decidedAt: null,
        comment: null,
      },
    ],
  });
  Object.assign(bill, { number: nextNumber(data, 'bill', date), status: 'pending' });
}
