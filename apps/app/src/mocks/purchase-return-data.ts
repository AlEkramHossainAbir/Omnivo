import {
  addMoney,
  addQuantity,
  compareMoney,
  compareQuantity,
  type DebitNote,
  type DebitNoteInput,
  type DebitNoteLine,
  type DebitNoteStatus,
  defaultLineDescription,
  documentTotals,
  type DocumentRef,
  type EntryRef,
  type ErrorCode,
  expenseLineAmounts,
  fitsDecimals,
  isZeroMoney,
  keptQuantity,
  lineAmounts,
  type LineAmounts,
  moneyAccountIds,
  negateMoney,
  overAllocated,
  prorateMoney,
  type PurchaseReturn,
  type PurchaseReturnInput,
  type PurchaseReturnLine,
  type SalesLineInput,
  type StockDocumentStatus,
  subtractMoney,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  type SupplierRefund,
  type SupplierRefundInput,
  type SupplierRefundStatus,
  toBaseQuantity,
  unappliedOf,
  unappliedPaymentOf,
} from '@omnivo/contracts';

import {
  allocationRefs,
  type Amount,
  asStored,
  assertBranch,
  assertPeriodOpen,
  type BillAllocationErrors,
  checkBillAllocations,
  dueOn,
  type MockBill,
  type MockBillAllocation,
  paymentSummaryOf,
  priceDifferenceAccount,
  purposeAccount,
  receiptLineOf,
  refundedFrom,
  summed,
} from './bill-data';
import { refOf, side } from './invoice-data';
import { findEntry, postNew, postStockEntry, reverseEntry } from './journal-data';
import { MockProblem } from './mock';
import { supplierOf } from './purchase-order-data';
import { fieldProblem, newestFirst, now, seriesNumber } from './sales-document-data';
import {
  assertDate,
  assertWarehouses,
  averageCostOf,
  bookAccounts,
  branchOf,
  decimalsOf,
  issuesError,
  postMoves,
  resolveLines,
} from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 17d: purchase returns, debit notes and supplier refunds. The API's rules
// (purchase-returns.service.ts, debit-notes.service.ts, supplier-refunds.service.ts and their
// books) on plain arrays, shortened, so `pnpm dev:mock` and the e2e tests walk the same paths as
// the real API. None of them needs an approval (decision 5): "Post" posts.

// A return as stored. What debit notes took off each line, the goods receipts it names and the
// debit notes written for it are worked out on read, like the API's joins.
export type MockPurchaseReturnLine = Omit<PurchaseReturnLine, 'debitedQuantity'>;
export type MockPurchaseReturn = Omit<PurchaseReturn, 'lines' | 'receipts' | 'debitNotes'> & {
  lines: MockPurchaseReturnLine[];
};

// A debit note as stored: the bills its money is applied to, by id, like a supplier payment's.
// What it applied and what refunds paid back from it are worked out on read.
export type MockDebitNote = Omit<DebitNote, 'applied' | 'refunded' | 'allocations'> & {
  allocations: MockBillAllocation[];
};

function conflict(code: ErrorCode): MockProblem {
  return new MockProblem(409, code);
}

// --- Purchase returns ---------------------------------------------------------------------------

type ReturnFields = Omit<PurchaseReturnInput, 'post'>;

// What a line names, as the form sends it and as a draft keeps it
interface ReturnLineRefs {
  receiptLineId: string | null;
  variantId: string;
  unitId: string;
  quantity: string;
  batchId: string | null;
  serialNumbers: readonly string[];
}

export function findPurchaseReturn(data: WorkspaceData, id: string): MockPurchaseReturn {
  const found = data.purchase.returns.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// What posted debit note lines took off for a return line, in the base unit: the API's
// purchase_return_lines.debited_quantity
function debitedQuantityOf(data: WorkspaceData, returnLineId: string): string {
  return sumQuantity(
    data.purchase.debitNotes
      .filter((item) => item.status === 'posted')
      .flatMap((item) => item.lines)
      .filter((line) => line.returnLineId === returnLineId)
      .map((line) => line.baseQuantity),
  );
}

const byNumber = (a: DocumentRef, b: DocumentRef) => (a.number ?? '').localeCompare(b.number ?? '');

export function toPurchaseReturn(data: WorkspaceData, stored: MockPurchaseReturn): PurchaseReturn {
  const receipts = new Map<string, DocumentRef>();
  for (const line of stored.lines) {
    const found = line.receiptLineId === null ? undefined : receiptLineOf(data, line.receiptLineId);
    if (found)
      receipts.set(found.receipt.id, { id: found.receipt.id, number: found.receipt.number });
  }
  const lineIds = new Set(stored.lines.map((line) => line.id));
  // Drafts too: a second debit note for the same goods is then easy to spot
  const debitNotes = data.purchase.debitNotes
    .filter((item) =>
      item.lines.some((line) => line.returnLineId !== null && lineIds.has(line.returnLineId)),
    )
    .map((item) => ({ id: item.id, number: item.number }));
  return {
    ...stored,
    lines: stored.lines.map((line) => ({
      ...line,
      debitedQuantity: debitedQuantityOf(data, line.id),
    })),
    receipts: [...receipts.values()].toSorted(byNumber),
    debitNotes: debitNotes.toSorted(byNumber),
  };
}

export function listPurchaseReturns(
  data: WorkspaceData,
  query: {
    status?: StockDocumentStatus | undefined;
    supplierId?: string | undefined;
    warehouseId?: string | undefined;
  },
): PurchaseReturn[] {
  return newestFirst(data.purchase.returns)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.supplierId === undefined || item.supplier.id === query.supplierId) &&
        (query.warehouseId === undefined || item.warehouseId === query.warehouseId),
    )
    .map((item) => toPurchaseReturn(data, item));
}

// The API's checkLines(): a line from a receipt line is a line of a posted goods receipt of this
// supplier, of the same item (in any of its units), with the receipt line's batch, no more than it
// kept (accepted less what went back already), and only serial numbers that came in on it. A line
// on its own is a stock line that goes out (an existing batch), of an item with an average cost to
// leave at (decision 2). Every problem at once, under its own line.
function checkReturnLines(
  data: WorkspaceData,
  supplierId: string,
  lines: readonly ReturnLineRefs[],
) {
  const receiptOf = (line: ReturnLineRefs) =>
    line.receiptLineId === null ? undefined : receiptLineOf(data, line.receiptLineId);
  const issues: { path: string; code: ErrorCode }[] = [];
  lines.forEach((line, index) => {
    if (line.receiptLineId === null) return;
    const found = receiptOf(line);
    if (
      found?.receipt.supplier.id !== supplierId ||
      found.receipt.status !== 'posted' ||
      found.line.variantId !== line.variantId
    ) {
      issues.push({
        path: `lines.${String(index)}.receiptLineId`,
        code: 'purchase_return_receipt_line_invalid',
      });
    }
  });
  if (issues.length > 0) throw issuesError(issues);

  // A receipt line's goods go back in its own batch: the form sends none, and a stored draft line
  // keeps the one written when it was saved
  const resolved = resolveLines(
    data,
    lines.map((line) => ({
      variantId: line.variantId,
      unitId: line.unitId,
      quantity: line.quantity,
      batchId: receiptOf(line)?.line.batchId ?? line.batchId,
      serialNumbers: [...line.serialNumbers],
    })),
    'out',
  );
  resolved.forEach((line, index) => {
    const typed = lines[index];
    const found = typed === undefined ? undefined : receiptOf(typed);
    if (found === undefined) {
      // A line on its own leaves at the average cost: an item that never had one has nothing to
      // leave at
      if (averageCostOf(data.stock, line.variantId) === null) {
        issues.push({
          path: `lines.${String(index)}.variantId`,
          code: 'purchase_return_cost_unknown',
        });
      }
      return;
    }
    if (compareQuantity(line.baseQuantity, keptQuantity(found.line)) > 0) {
      issues.push({
        path: `lines.${String(index)}.quantity`,
        code: 'purchase_return_over_received',
      });
    }
    const came = new Set(found.line.serialNumbers);
    if (line.serialNumbers.some((serial) => !came.has(serial))) {
      issues.push({
        path: `lines.${String(index)}.serialNumbers`,
        code: 'purchase_return_serial_invalid',
      });
    }
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved.map((line, index) => {
    const typed = lines[index];
    return { line, receipt: typed === undefined ? undefined : receiptOf(typed) };
  });
}

// A new draft, or a draft changed. Its number comes at posting. A draft keeps its supplier after
// it was archived, like every draft.
export function savePurchaseReturn(
  data: WorkspaceData,
  input: ReturnFields,
  existing?: MockPurchaseReturn,
): MockPurchaseReturn {
  if (existing && existing.status !== 'draft') throw conflict('stock_not_draft');
  const supplier = supplierOf(data, input.supplierId, existing?.supplier.id ?? null);
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const checked = checkReturnLines(data, supplier.id, input.lines);
  const saved: MockPurchaseReturn = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    supplier,
    warehouseId: input.warehouseId,
    reason: input.reason,
    status: 'draft',
    note: input.note,
    lineCount: checked.length,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    lines: checked.map(({ line, receipt }) => ({
      ...line,
      receiptLineId: receipt?.line.id ?? null,
      receiptNumber: receipt?.receipt.number ?? null,
      // Set at posting, from the bill that billed the receipt line by then
      billed: false,
      billLineId: null,
      billId: null,
      billNumber: null,
      value: null,
    })),
    entry: null,
  };
  const { returns } = data.purchase;
  data.purchase.returns = existing
    ? returns.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...returns];
  return saved;
}

// Only a draft. It sent nothing back, so nothing is undone.
export function removePurchaseReturn(data: WorkspaceData, target: MockPurchaseReturn): void {
  if (target.status !== 'draft') throw conflict('stock_not_draft');
  data.purchase.returns = data.purchase.returns.filter((item) => item.id !== target.id);
}

// What `quantity` going back from a receipt line puts back on goods received not billed: its share
// of what the line came in at, counted over everything sent back from it so far, so a line that
// goes back in three goes gives back exactly its value (the API's returnValue)
function returnValue(
  line: { value: string | null; baseQuantity: string; returnedQuantity: string },
  quantity: string,
): string {
  if (line.value === null) throw new Error('A posted receipt line has no value');
  const after = addQuantity(line.returnedQuantity, quantity);
  return subtractMoney(
    prorateMoney(line.value, after, line.baseQuantity),
    prorateMoney(line.value, line.returnedQuantity, line.baseQuantity),
  );
}

// The posted bill line that billed a receipt line, with its bill
function billingOf(data: WorkspaceData, receiptLineId: string) {
  for (const bill of data.purchase.bills) {
    if (bill.status !== 'posted') continue;
    const line = bill.lines.find((item) => item.receiptLineId === receiptLineId);
    if (line) return { bill, line };
  }
  return undefined;
}

// What went back before a bill billed it comes off its order line (decision 3): the received
// quantity comes down, and a received order is approved again (partly received), so the supplier
// can send the goods again on it. An approved one gets a new version too (its page shows old
// received quantities). A closed order keeps its status and its version.
function returnOnOrder(data: WorkspaceData, orderLineId: string, quantity: string): void {
  for (const order of data.purchase.orders) {
    const line = order.lines.find((item) => item.id === orderLineId);
    if (!line) continue;
    line.receivedQuantity = subtractQuantity(line.receivedQuantity, quantity);
    if (order.status === 'received' || order.status === 'approved') {
      Object.assign(order, { status: 'approved', version: order.version + 1, updatedAt: now() });
    }
    return;
  }
}

// The API's postAndLog(), in its order: the date, the warehouse, the supplier and the lines checked
// again, the number, the stock out (a receipt line's at the cost it came in at, a line of its own
// at the average cost), the bill line of each billed receipt line, the receipt lines and the
// orders, and the cost booked back. The handler runs it in a transaction(): a refused step leaves
// nothing, not even the number.
export function postPurchaseReturn(data: WorkspaceData, draft: MockPurchaseReturn): void {
  if (draft.status !== 'draft') throw conflict('stock_not_draft');
  assertDate(data, draft.date);
  assertPeriodOpen(data, draft.date);
  assertWarehouses(data, [{ field: 'warehouseId', id: draft.warehouseId }]);
  // Active now: the return goes in the supplier's file
  supplierOf(data, draft.supplier.id, null);
  // Again: another return may have sent the same goods back since the draft was saved
  const checked = checkReturnLines(data, draft.supplier.id, draft.lines);
  const accounts = bookAccounts(data);
  const notBilled = accounts.use('received_not_billed');
  data.purchase.counters.return += 1;
  const number = seriesNumber(data, 'purchase.return', data.purchase.counters.return, draft.date);

  // What each line puts back on goods received not billed: a receipt line's cost; a line on its
  // own at the average cost (null: the stock posting works it out)
  const given = checked.map(({ line, receipt }) =>
    receipt === undefined ? null : returnValue(receipt.line, line.baseQuantity),
  );
  const moved = postMoves(
    data,
    { date: draft.date, kind: 'purchase_return', direction: 'out', documentId: draft.id, number },
    checked.map(({ line }, index) => ({
      line: index,
      warehouseId: draft.warehouseId,
      stockLine: line,
      batchId: line.batchId,
      quantity: line.baseQuantity,
      serialNumbers: line.serialNumbers,
      value: given[index] ?? null,
    })),
  );
  const values = checked.map((_, index) => given[index] ?? moved[index] ?? '0');

  const lines = draft.lines.map((line, index): MockPurchaseReturnLine => {
    const receipt = checked[index]?.receipt;
    // Billed already: a debit note takes the money off this bill line
    const billed = receipt?.line.billed === true ? billingOf(data, receipt.line.id) : undefined;
    return {
      ...line,
      billed: billed !== undefined,
      billLineId: billed?.line.id ?? null,
      billId: billed?.bill.id ?? null,
      billNumber: billed?.bill.number ?? null,
      value: values[index] ?? null,
    };
  });
  // What went back, on each receipt line; not billed yet and from an order: the order counts it
  // as not received
  checked.forEach(({ line, receipt }) => {
    if (receipt === undefined) return;
    receipt.line.returnedQuantity = addQuantity(receipt.line.returnedQuantity, line.baseQuantity);
    if (!receipt.line.billed && receipt.line.orderLineId !== null) {
      returnOnOrder(data, receipt.line.orderLineId, line.baseQuantity);
    }
  });

  // Dr Goods received not billed at the receipt's cost (the branch of the receipt's warehouse; a
  // line of its own: the return warehouse's) / Cr Inventory at what the stock gave up (the return
  // warehouse's branch). The two differ only when the stock could not give the receipt's cost
  // (decision 32); the difference goes to the price difference account.
  const inventoryBranch = branchOf(data, draft.warehouseId);
  const difference = sumMoney(
    values.map((value, index) => subtractMoney(moved[index] ?? '0', value)),
  );
  const entry = postStockEntry(data, {
    date: draft.date,
    source: 'purchase_return',
    document: { id: draft.id, number },
    narration: `Purchase return ${number}`,
    amounts: [
      ...values.map((value, index) => ({
        accountId: notBilled,
        branchId: branchOf(data, checked[index]?.receipt?.receipt.warehouseId ?? draft.warehouseId),
        amount: value,
      })),
      ...moved.map((value) => ({
        accountId: accounts.inventory,
        branchId: inventoryBranch,
        amount: negateMoney(value),
      })),
      ...(isZeroMoney(difference)
        ? []
        : [
            {
              accountId: priceDifferenceAccount(data),
              branchId: inventoryBranch,
              amount: difference,
            },
          ]),
    ],
  });
  Object.assign(draft, {
    lines,
    number,
    entry,
    status: 'posted',
    postedAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  });
}

// --- Debit notes --------------------------------------------------------------------------------

type DebitNoteFields = Omit<DebitNoteInput, 'post'>;

// What a line names, as the form sends it and as a draft keeps it
interface DebitLineRefs {
  billLineId: string | null;
  returnLineId: string | null;
  // Only on a debit note without a bill; a line of a bill takes the bill line's rate
  taxRateId: string | null;
  unitId: string;
  quantity: string;
  description: string | null;
  unitPrice: string;
  discountType: SalesLineInput['discountType'];
  discount: string;
}

const DEBIT_NOTE_ERRORS = {
  bill: 'debit_note_allocation_invalid',
  over: 'debit_note_over_bill',
} as const satisfies BillAllocationErrors;

export function findDebitNote(data: WorkspaceData, id: string): MockDebitNote {
  const found = data.purchase.debitNotes.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function toDebitNote(data: WorkspaceData, stored: MockDebitNote): DebitNote {
  const { allocations, ...debitNote } = stored;
  return {
    ...debitNote,
    applied: sumMoney(allocations.map((allocation) => allocation.amount)),
    refunded: refundedFrom(data, 'debit_note', stored.id),
    allocations: allocationRefs(data, allocations),
  };
}

export function listDebitNotes(
  data: WorkspaceData,
  query: {
    status?: DebitNoteStatus | undefined;
    supplierId?: string | undefined;
    billId?: string | undefined;
  },
): DebitNote[] {
  return newestFirst(data.purchase.debitNotes)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.supplierId === undefined || item.supplier.id === query.supplierId) &&
        (query.billId === undefined || item.bill?.id === query.billId),
    )
    .map((item) => toDebitNote(data, item));
}

// The bill a debit note debits: a posted bill of this workspace
function postedBill(data: WorkspaceData, billId: string): MockBill & { number: string } {
  const bill = data.purchase.bills.find((item) => item.id === billId);
  const number = bill?.number ?? null;
  if (bill?.status !== 'posted' || number === null) {
    throw fieldProblem('debit_note_bill_invalid', 'billId');
  }
  return Object.assign(bill, { number });
}

// A return line, with its return
function returnLineOf(data: WorkspaceData, returnLineId: string) {
  for (const purchaseReturn of data.purchase.returns) {
    const line = purchaseReturn.lines.find((item) => item.id === returnLineId);
    if (line) return { purchaseReturn, line };
  }
  return undefined;
}

// A stored line as the check reads it again at posting. A line of a bill names no rate: only a
// line without a bill keeps its own.
function storedRefs(line: DebitNoteLine): DebitLineRefs {
  return {
    billLineId: line.billLineId,
    returnLineId: line.returnLineId,
    taxRateId: line.billLineId === null ? line.taxRate.id : null,
    unitId: line.unitId,
    quantity: line.quantity,
    description: line.description,
    unitPrice: line.unitPrice,
    discountType: line.discountType,
    discount: line.discount,
  };
}

// The API's resolve(). With a bill: each line debits a line of that bill, in any unit of its item,
// at the VAT the bill line claimed and the bill's price setting, so debiting a line in full takes
// off exactly what it charged. Without a bill (decision 9): each line names a return line of its
// own of this supplier, with that line's item and a VAT rate of the workspace. The caps: no line
// more than its bill line's quantity; a return line no more than went back less what was debited;
// the lines on one bill line no more money than it charged less what posted debit notes took off.
// Every problem at once, under its own line.
function resolveDebitLines(
  data: WorkspaceData,
  supplierId: string,
  bill: MockBill | null,
  pricesIncludeVat: boolean,
  lines: readonly DebitLineRefs[],
  keptRateIds: ReadonlySet<string>,
): { line: DebitNoteLine; amounts: LineAmounts }[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = lines.flatMap((input, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const billed =
      bill === null || input.billLineId === null
        ? undefined
        : bill.lines.find((line) => line.id === input.billLineId);
    const back = input.returnLineId === null ? undefined : returnLineOf(data, input.returnLineId);
    let item: Omit<
      DebitNoteLine,
      | 'id'
      | 'unitId'
      | 'quantity'
      | 'baseQuantity'
      | 'description'
      | 'unitPrice'
      | 'discountType'
      | 'discount'
      | 'net'
      | 'vat'
      | 'total'
      | 'billLineId'
      | 'returnLineId'
      | 'returnNumber'
    >;
    if (bill !== null) {
      if (billed === undefined) {
        at('billLineId', 'debit_note_line_invalid');
        return [];
      }
      item = { ...billed, taxRate: billed.taxRate };
    } else {
      // Without a bill: a return line on its own, of a posted return of this supplier
      if (
        back?.purchaseReturn.supplier.id !== supplierId ||
        back.purchaseReturn.status !== 'posted' ||
        back.line.receiptLineId !== null
      ) {
        at('returnLineId', 'debit_note_return_invalid');
        return [];
      }
      const rate = data.sales.taxRates.find((candidate) => candidate.id === input.taxRateId);
      if (!rate || (rate.archivedAt !== null && !keptRateIds.has(rate.id))) {
        at('taxRateId', 'tax_rate_invalid');
        return [];
      }
      // Only goods go back on a return
      item = {
        ...back.line,
        productType: 'goods',
        taxRate: { id: rate.id, name: rate.name, kind: rate.kind, rate: rate.rate },
      };
    }
    // Any unit of the item: 3 strips off a line of 2 boxes
    const factor =
      input.unitId === item.baseUnitId
        ? '1'
        : item.units.find((pack) => pack.unitId === input.unitId)?.factor;
    if (factor === undefined) {
      at('unitId', 'stock_unit_invalid');
      return [];
    }
    if (!fitsDecimals(input.quantity, decimalsOf(data, input.unitId))) {
      at('quantity', 'stock_quantity_decimals');
      return [];
    }
    const baseQuantity = toBaseQuantity(input.quantity, factor, decimalsOf(data, item.baseUnitId));
    if (billed !== undefined && compareQuantity(baseQuantity, billed.baseQuantity) > 0) {
      at('quantity', 'debit_note_over_quantity');
    }
    // With a bill, the return line this bill line billed, on a posted return
    if (
      bill !== null &&
      input.returnLineId !== null &&
      (back?.line.billLineId !== billed?.id || back?.purchaseReturn.status !== 'posted')
    ) {
      at('returnLineId', 'debit_note_return_invalid');
    }
    if (
      back !== undefined &&
      compareQuantity(
        baseQuantity,
        subtractQuantity(back.line.baseQuantity, debitedQuantityOf(data, back.line.id)),
      ) > 0
    ) {
      at('quantity', 'debit_note_over_return');
    }
    const amounts = lineAmounts(
      {
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        discountType: input.discountType,
        discount: input.discount,
        rate: item.taxRate.rate,
      },
      pricesIncludeVat,
    );
    const line: DebitNoteLine = {
      variantId: item.variantId,
      productId: item.productId,
      productCode: item.productCode,
      productName: item.productName,
      optionValues: item.optionValues,
      sku: item.sku,
      baseUnitId: item.baseUnitId,
      id: crypto.randomUUID(),
      productType: item.productType,
      tracking: item.tracking,
      hasExpiry: item.hasExpiry,
      units: item.units,
      unitId: input.unitId,
      quantity: addQuantity(input.quantity, '0'),
      baseQuantity,
      description: input.description ?? defaultLineDescription(item),
      unitPrice: addMoney(input.unitPrice, '0'),
      discountType: input.discountType,
      discount: addMoney(input.discount, '0'),
      taxRate: item.taxRate,
      net: amounts.net,
      vat: amounts.vat,
      total: amounts.total,
      billLineId: billed?.id ?? null,
      returnLineId: input.returnLineId,
      returnNumber: back?.purchaseReturn.number ?? null,
    };
    return [{ line, amounts }];
  });
  if (issues.length > 0) throw issuesError(issues);

  // The money on each bill line, all of this debit note's lines on it together
  const byBillLine = new Map<string, string[]>();
  for (const { line } of resolved) {
    if (line.billLineId === null) continue;
    byBillLine.set(line.billLineId, [...(byBillLine.get(line.billLineId) ?? []), line.total]);
  }
  for (const [id, totals] of byBillLine) {
    const billed = bill?.lines.find((line) => line.id === id);
    if (billed === undefined) continue;
    if (compareMoney(sumMoney(totals), subtractMoney(billed.total, billed.debited)) <= 0) continue;
    // Under every line that takes from it: the person decides which one to lower
    lines.forEach((line, index) => {
      if (line.billLineId === id) {
        issues.push({ path: `lines.${String(index)}.unitPrice`, code: 'debit_note_over_line' });
      }
    });
  }
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

// The bill's expenses, debited by money at the expense's own VAT and the bill's price setting,
// each no more than it charged less what posted debit notes took off
function resolveDebitExpenses(
  bill: MockBill,
  expenses: readonly { billExpenseId: string; amount: string }[],
): { expense: DebitNote['expenses'][number]; amounts: LineAmounts }[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = expenses.flatMap((input, index) => {
    const billed = bill.expenses.find((expense) => expense.id === input.billExpenseId);
    if (billed === undefined) {
      issues.push({
        path: `expenses.${String(index)}.billExpenseId`,
        code: 'debit_note_expense_invalid',
      });
      return [];
    }
    const amounts = expenseLineAmounts(
      { amount: input.amount, rate: billed.taxRate.rate },
      bill.pricesIncludeVat,
    );
    if (compareMoney(amounts.total, subtractMoney(billed.total, billed.debited)) > 0) {
      issues.push({ path: `expenses.${String(index)}.amount`, code: 'debit_note_over_line' });
    }
    return [
      {
        expense: {
          id: crypto.randomUUID(),
          billExpenseId: billed.id,
          accountId: billed.accountId,
          description: billed.description,
          amount: addMoney(input.amount, '0'),
          taxRate: billed.taxRate,
          net: amounts.net,
          vat: amounts.vat,
          total: amounts.total,
        },
        amounts,
      },
    ];
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

// A debit note is written for something the bill billed, so it is not dated before it
function assertDebitDate(date: string, bill: MockBill): void {
  if (date < bill.date) throw fieldProblem('debit_note_date', 'date');
}

// A new draft, or a draft changed. With a bill: the bill's supplier, branch and price setting,
// whatever the form sent (decision 19). A draft keeps its supplier and its VAT rates after they
// were archived, like every draft.
export function saveDebitNote(
  data: WorkspaceData,
  input: DebitNoteFields,
  existing?: MockDebitNote,
): MockDebitNote {
  if (existing && existing.status !== 'draft') throw conflict('purchase_not_draft');
  const supplier = supplierOf(data, input.supplierId, existing?.supplier.id ?? null);
  const bill = input.billId === null ? null : postedBill(data, input.billId);
  if (bill !== null && bill.supplier.id !== supplier.id) {
    throw fieldProblem('debit_note_bill_invalid', 'billId');
  }
  if (bill !== null) assertDebitDate(input.date, bill);
  // The contract makes sure a debit note without a bill names a branch
  const branchId = bill?.branchId ?? input.branchId;
  if (branchId === null) throw new Error('A debit note without a bill names no branch');
  if (bill === null) assertBranch(data, branchId);
  const pricesIncludeVat = bill?.pricesIncludeVat ?? input.pricesIncludeVat;
  const keptRateIds = new Set(existing?.lines.map((line) => line.taxRate.id) ?? []);
  const lines = resolveDebitLines(
    data,
    supplier.id,
    bill,
    pricesIncludeVat,
    input.lines,
    keptRateIds,
  );
  const expenses = bill === null ? [] : resolveDebitExpenses(bill, input.expenses);
  const saved: MockDebitNote = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    supplier,
    bill:
      bill === null
        ? null
        : {
            id: bill.id,
            number: bill.number,
            date: bill.date,
            supplierBillNumber: bill.supplierBillNumber,
          },
    branchId,
    reason: input.reason,
    status: 'draft',
    supplierCreditNumber: input.supplierCreditNumber,
    supplierCreditDate: input.supplierCreditDate,
    ...documentTotals([
      ...lines.map((item) => item.amounts),
      ...expenses.map((item) => item.amounts),
    ]),
    lineCount: lines.length,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    pricesIncludeVat,
    note: input.note,
    lines: lines.map((item) => item.line),
    expenses: expenses.map((item) => item.expense),
    allocations: [],
    entry: null,
  };
  const { debitNotes } = data.purchase;
  data.purchase.debitNotes = existing
    ? debitNotes.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...debitNotes];
  return saved;
}

// Only a draft. It took nothing off, so nothing is undone.
export function removeDebitNote(data: WorkspaceData, target: MockDebitNote): void {
  if (target.status !== 'draft') throw conflict('purchase_not_draft');
  data.purchase.debitNotes = data.purchase.debitNotes.filter((item) => item.id !== target.id);
}

// Replaces its allocations with `wanted`, each row checked like a supplier payment's (decision 24)
function applyDebitAllocations(
  data: WorkspaceData,
  debitNote: MockDebitNote,
  wanted: readonly MockBillAllocation[],
): void {
  checkBillAllocations(data, {
    supplierId: debitNote.supplier.id,
    current: debitNote.allocations,
    wanted,
    errors: DEBIT_NOTE_ERRORS,
  });
  debitNote.allocations = asStored(wanted);
}

// What `quantity` of a return line takes off goods received not billed: its share of what the
// return put there, counted over everything debited from the line so far (the API's returnShare)
function returnShare(data: WorkspaceData, line: MockPurchaseReturnLine, quantity: string): string {
  if (line.value === null) throw new Error('A posted return line has no value');
  const debited = debitedQuantityOf(data, line.id);
  const after = addQuantity(debited, quantity);
  return subtractMoney(
    prorateMoney(line.value, after, line.baseQuantity),
    prorateMoney(line.value, debited, line.baseQuantity),
  );
}

// The entry (decision 1): Dr Accounts payable (the supplier) for the total / Cr Goods received not
// billed for the goods' receipt cost (the branch where the return put it back) / Cr or Dr the price
// difference for the rest of a goods line's net / Cr a service line's or an expense's account / Cr
// VAT input. Everything else on the debit note's branch. Worked out before the posting changes
// what the return lines say was debited.
function debitNoteAmounts(
  data: WorkspaceData,
  draft: MockDebitNote,
  bill: MockBill | null,
): Amount[] {
  const at = (accountId: string, amount: string, branchId = draft.branchId): Amount => ({
    accountId,
    branchId,
    partyId: null,
    amount,
  });
  const amounts: Amount[] = [
    {
      accountId: purposeAccount(data, 'accounts_payable'),
      branchId: draft.branchId,
      partyId: draft.supplier.id,
      amount: draft.total,
    },
  ];
  for (const line of draft.lines) {
    const accountId =
      line.billLineId === null
        ? null
        : (bill?.lines.find((item) => item.id === line.billLineId)?.accountId ?? null);
    if (accountId !== null) {
      amounts.push(at(accountId, negateMoney(line.net)));
      continue;
    }
    const back = line.returnLineId === null ? undefined : returnLineOf(data, line.returnLineId);
    let share = '0';
    if (back !== undefined) {
      share = returnShare(data, back.line, line.baseQuantity);
      // Where the return put it: the receipt's warehouse, or the return's for a line on its own
      const receipt =
        back.line.receiptLineId === null ? undefined : receiptLineOf(data, back.line.receiptLineId);
      const warehouseId = receipt?.receipt.warehouseId ?? back.purchaseReturn.warehouseId;
      amounts.push(
        at(
          bookAccounts(data).use('received_not_billed'),
          negateMoney(share),
          branchOf(data, warehouseId) ?? draft.branchId,
        ),
      );
    }
    const difference = subtractMoney(line.net, share);
    if (!isZeroMoney(difference)) {
      amounts.push(at(priceDifferenceAccount(data), negateMoney(difference)));
    }
  }
  for (const expense of draft.expenses) {
    amounts.push(at(expense.accountId, negateMoney(expense.net)));
  }
  amounts.push(at(purposeAccount(data, 'vat_input'), negateMoney(draft.vat)));
  return amounts;
}

// The API's postAndLog(): the date, the bill, the supplier and the lines checked again (another
// debit note may have taken off the same lines), the number, the sums on the bill's lines and
// expenses, the entry, and its money applied to its own bill up to what the bill still owes; the
// rest is money the supplier owes the company (decision 4). Returns what it applied, for the audit
// row. The handler runs it in a transaction().
export function postDebitNote(data: WorkspaceData, draft: MockDebitNote): string {
  if (draft.status !== 'draft') throw conflict('purchase_not_draft');
  assertPeriodOpen(data, draft.date);
  const bill = draft.bill === null ? null : postedBill(data, draft.bill.id);
  // Active now: the journal will not book a payable line for an archived supplier
  supplierOf(data, draft.supplier.id, null);
  if (bill !== null) assertDebitDate(draft.date, bill);
  else assertBranch(data, draft.branchId);
  const keptRateIds = new Set(draft.lines.map((line) => line.taxRate.id));
  resolveDebitLines(
    data,
    draft.supplier.id,
    bill,
    draft.pricesIncludeVat,
    draft.lines.map(storedRefs),
    keptRateIds,
  );
  if (bill !== null) resolveDebitExpenses(bill, draft.expenses);
  data.purchase.counters.debitNote += 1;
  const number = seriesNumber(
    data,
    'purchase.debit_note',
    data.purchase.counters.debitNote,
    draft.date,
  );
  const amounts = isZeroMoney(draft.total) ? [] : debitNoteAmounts(data, draft, bill);

  // What it takes off, on the bill's lines and expenses. The return lines' debited quantity is
  // read from the posted debit notes, so it goes up with the status below.
  for (const line of draft.lines) {
    const billed = bill?.lines.find((item) => item.id === line.billLineId);
    if (billed) billed.debited = addMoney(billed.debited, line.total);
  }
  for (const expense of draft.expenses) {
    const billed = bill?.expenses.find((item) => item.id === expense.billExpenseId);
    if (billed) billed.debited = addMoney(billed.debited, expense.total);
  }

  // A debit note of ৳0 has no entry
  let entry: EntryRef | null = null;
  if (amounts.length > 0) {
    entry = refOf(
      postNew(
        data,
        { date: draft.date, narration: `Debit note ${number}`, lines: summed(amounts) },
        'purchase_debit_note',
        { id: draft.id, number },
      ),
    );
  }
  // Read before the change: what the bill still owes
  const due = bill === null ? '0' : dueOn(data, bill);
  Object.assign(draft, {
    status: 'posted',
    number,
    entry,
    postedAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  });
  const applied = compareMoney(draft.total, due) <= 0 ? draft.total : due;
  if (bill !== null && compareMoney(applied, '0') > 0) {
    applyDebitAllocations(data, draft, [{ billId: bill.id, amount: applied }]);
  }
  return applied;
}

// A draft has no money to apply yet: before the version check, like the API's lockPosted()
export function assertDebitNotePosted(debitNote: MockDebitNote): void {
  if (debitNote.status !== 'posted') throw conflict('debit_note_not_posted');
}

// Apply its money again, like a supplier payment's. What refunds paid back is gone: only the rest
// can be applied.
export function allocateDebitNote(
  data: WorkspaceData,
  debitNote: MockDebitNote,
  allocations: readonly MockBillAllocation[],
): void {
  const left = subtractMoney(debitNote.total, refundedFrom(data, 'debit_note', debitNote.id));
  if (overAllocated(left, allocations)) {
    throw fieldProblem('debit_note_over_allocated', 'allocations');
  }
  applyDebitAllocations(data, debitNote, allocations);
  Object.assign(debitNote, { version: debitNote.version + 1, updatedAt: now() });
}

// --- Supplier refunds ---------------------------------------------------------------------------

export function findSupplierRefund(data: WorkspaceData, id: string): SupplierRefund {
  const found = data.purchase.refunds.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function listSupplierRefunds(
  data: WorkspaceData,
  query: { status?: SupplierRefundStatus | undefined; supplierId?: string | undefined },
): SupplierRefund[] {
  return newestFirst(data.purchase.refunds).filter(
    (item) =>
      (query.status === undefined || item.status === query.status) &&
      (query.supplierId === undefined || item.supplier.id === query.supplierId),
  );
}

// The debit note or payment the money comes from: posted, and this supplier's, with what it has
// left to give back. Another supplier's, a voided payment and a draft debit note all get the same
// answer, under the box that named it.
function sourceOf(data: WorkspaceData, supplierId: string, input: SupplierRefundInput) {
  if (input.debitNoteId !== null) {
    const debitNote = data.purchase.debitNotes.find((item) => item.id === input.debitNoteId);
    const number = debitNote?.number ?? null;
    if (debitNote?.supplier.id !== supplierId || debitNote.status !== 'posted' || number === null) {
      throw fieldProblem('supplier_refund_source_invalid', 'debitNoteId');
    }
    const money = toDebitNote(data, debitNote);
    return {
      source: { type: 'debit_note', id: debitNote.id, number } as const,
      left: unappliedOf({ amount: money.total, applied: money.applied, refunded: money.refunded }),
    };
  }
  if (input.paymentId !== null) {
    const payment = data.purchase.payments.find((item) => item.id === input.paymentId);
    const number = payment?.number ?? null;
    if (payment?.supplier.id !== supplierId || payment.status !== 'posted' || number === null) {
      throw fieldProblem('supplier_refund_source_invalid', 'paymentId');
    }
    return {
      source: { type: 'supplier_payment', id: payment.id, number } as const,
      left: unappliedPaymentOf(paymentSummaryOf(data, payment)),
    };
  }
  // The contract makes sure one of the two is there
  throw fieldProblem('supplier_refund_source', 'debitNoteId');
}

// Saved = posted: numbered and booked (Dr the money account / Cr Accounts payable with the
// supplier). The source's `refunded` is worked out on read, so it goes up with the refund.
export function createSupplierRefund(
  data: WorkspaceData,
  input: SupplierRefundInput,
): SupplierRefund {
  const supplier = supplierOf(data, input.supplierId, null);
  assertBranch(data, input.branchId);
  if (!moneyAccountIds(data.accounts).has(input.accountId)) {
    throw fieldProblem('supplier_refund_account_invalid', 'accountId');
  }
  const { source, left } = sourceOf(data, supplier.id, input);
  const amount = addMoney(input.amount, '0');
  if (compareMoney(amount, left) > 0) throw fieldProblem('supplier_refund_over_source', 'amount');
  data.purchase.counters.refund += 1;
  const number = seriesNumber(data, 'purchase.refund', data.purchase.counters.refund, input.date);
  const id = crypto.randomUUID();
  const entry = postNew(
    data,
    {
      date: input.date,
      narration: `Supplier refund ${number}`,
      lines: [
        side(input.accountId, input.branchId, null, { debit: amount }),
        side(purposeAccount(data, 'accounts_payable'), input.branchId, supplier.id, {
          credit: amount,
        }),
      ],
    },
    'purchase_refund',
    { id, number },
  );
  const refund: SupplierRefund = {
    id,
    number,
    date: input.date,
    supplier,
    amount,
    method: input.method,
    reference: input.reference,
    accountId: input.accountId,
    branchId: input.branchId,
    source,
    status: 'posted',
    version: 1,
    updatedAt: now(),
    note: input.note,
    entry: refOf(entry),
    voidEntry: null,
    voidDate: null,
    voidReason: null,
  };
  data.purchase.refunds = [refund, ...data.purchase.refunds];
  return refund;
}

// A voided refund is final: before the version check, like the API's lock()
export function assertSupplierRefundNotVoided(refund: SupplierRefund): void {
  if (refund.status === 'voided') throw conflict('supplier_refund_voided');
}

// Money that never came: the entry is reversed on the void date, and the money is the source's
// again (worked out on read). The refund stays, with its number.
export function voidSupplierRefund(
  data: WorkspaceData,
  refund: SupplierRefund,
  input: { date: string; reason: string },
): void {
  if (input.date < refund.date) throw fieldProblem('payment_void_date', 'date');
  const reversal = reverseEntry(data, findEntry(data, refund.entry.id), input.date, {
    allowPurchase: true,
    narration: `Supplier refund ${refund.number} voided: ${input.reason}`,
  });
  Object.assign(refund, {
    status: 'voided',
    voidDate: input.date,
    voidReason: input.reason,
    voidEntry: refOf(reversal),
    version: refund.version + 1,
    updatedAt: now(),
  });
}
