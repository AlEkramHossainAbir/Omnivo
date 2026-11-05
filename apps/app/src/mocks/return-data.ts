import {
  addMoney,
  addQuantity,
  compareMoney,
  compareQuantity,
  type CreditNote,
  type CreditNoteInput,
  type CreditNoteLine,
  defaultLineDescription,
  documentTotals,
  type EntryRef,
  type ErrorCode,
  fitsDecimals,
  isZeroMoney,
  lineAmounts,
  type LineAmounts,
  moneyAccountIds,
  negateMoney,
  overAllocated,
  prorateMoney,
  type Refund,
  type RefundInput,
  type SalesLineInput,
  type SalesReturn,
  type SalesReturnInput,
  type SalesReturnLine,
  subtractMoney,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  unappliedOf,
} from '@omnivo/contracts';

import {
  allocationRefs,
  applyAllocations,
  assertBranch,
  challanLineOf,
  creditedOnLine,
  dueOn,
  type MockAllocation,
  type MockInvoice,
  refOf,
  refundedFrom,
  salesAccounts,
  side,
  toReceipt,
} from './invoice-data';
import { findEntry, postNew, postStockEntry, reverseEntry } from './journal-data';
import { MockProblem } from './mock';
import {
  customerOf,
  deliveryAccounts,
  fieldProblem,
  newestFirst,
  now,
  seriesNumber,
} from './sales-document-data';
import {
  assertDate,
  assertWarehouses,
  branchOf,
  decimalsOf,
  issuesError,
  postMoves,
  resolveLines,
} from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 15d: sales returns, credit notes and refunds. The API's rules
// (sales-returns.service.ts, credit-notes.service.ts, refunds.service.ts and their books) on plain
// arrays, shortened, so `pnpm dev:mock` and the e2e tests walk the same paths as the real API.

// A return as stored. What credit notes gave back for each line, the challans it names and the
// credit notes written for it are worked out on read, like the API's joins.
export type MockReturnLine = Omit<SalesReturnLine, 'creditedQuantity'>;
export type MockSalesReturn = Omit<SalesReturn, 'lines' | 'deliveries' | 'creditNotes'> & {
  lines: MockReturnLine[];
};

// A credit note as stored: the invoices its money pays, by id, like a receipt's. What it applied
// and what refunds paid back from it are worked out on read.
export type MockCreditNote = Omit<CreditNote, 'applied' | 'refunded' | 'allocations'> & {
  allocations: MockAllocation[];
};

export interface MockReturns {
  salesReturns: MockSalesReturn[];
  creditNotes: MockCreditNote[];
  refunds: Refund[];
  // The last number given from each series, like the other mock documents
  counters: { salesReturn: number; creditNote: number; refund: number };
}

export function emptyReturns(): MockReturns {
  return {
    salesReturns: [],
    creditNotes: [],
    refunds: [],
    counters: { salesReturn: 0, creditNote: 0, refund: 0 },
  };
}

// A closed period refuses before anything moves, like the API's assertPeriodOpen()
function assertOpen(data: WorkspaceData, date: string): void {
  if (data.journal.lockDate !== null && date <= data.journal.lockDate) {
    throw fieldProblem('journal_period_locked', 'date');
  }
}

// --- Sales returns ------------------------------------------------------------------------------

type ReturnFields = Omit<SalesReturnInput, 'post'>;

interface ReturnLineRefs {
  deliveryLineId: string | null;
  variantId: string;
  unitId: string;
  quantity: string;
  batchId: string | null;
  serialNumbers: readonly string[];
}

export function findReturn(data: WorkspaceData, id: string): MockSalesReturn {
  const found = data.returns.salesReturns.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// What posted credit note lines gave back for a return line, in the base unit: the API's
// sales_return_lines.credited_quantity
function creditedQuantityOf(data: WorkspaceData, returnLineId: string): string {
  return sumQuantity(
    data.returns.creditNotes
      .filter((item) => item.status === 'posted')
      .flatMap((item) => item.lines)
      .filter((line) => line.returnLineId === returnLineId)
      .map((line) => line.baseQuantity),
  );
}

export function toReturn(data: WorkspaceData, stored: MockSalesReturn): SalesReturn {
  const challans = new Map<string, { id: string; number: string | null }>();
  for (const line of stored.lines) {
    const challan =
      line.deliveryLineId === null ? undefined : challanLineOf(data, line.deliveryLineId);
    if (challan) {
      challans.set(challan.delivery.id, {
        id: challan.delivery.id,
        number: challan.delivery.number,
      });
    }
  }
  const lineIds = new Set(stored.lines.map((line) => line.id));
  // Drafts too: a second credit note for the same goods is then easy to spot
  const creditNotes = data.returns.creditNotes
    .filter((item) =>
      item.lines.some((line) => line.returnLineId !== null && lineIds.has(line.returnLineId)),
    )
    .map((item) => ({ id: item.id, number: item.number }));
  const byNumber = (a: { number: string | null }, b: { number: string | null }) =>
    (a.number ?? '').localeCompare(b.number ?? '');
  return {
    ...stored,
    lines: stored.lines.map((line) => ({
      ...line,
      creditedQuantity: creditedQuantityOf(data, line.id),
    })),
    deliveries: [...challans.values()].toSorted(byNumber),
    creditNotes: creditNotes.toSorted(byNumber),
  };
}

export function listReturns(
  data: WorkspaceData,
  query: {
    status?: string | undefined;
    customerId?: string | undefined;
    warehouseId?: string | undefined;
  },
): SalesReturn[] {
  return newestFirst(data.returns.salesReturns)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId) &&
        (query.warehouseId === undefined || item.warehouseId === query.warehouseId),
    )
    .map((item) => toReturn(data, item));
}

// The API's checkLines(): a line from a challan is a line of a posted challan of this customer, of
// the same item (in any of its units), with the challan line's batch, no more than what left on it
// less what came back already, and only serial numbers that left on it. A line on its own is a
// stock line that goes out (an existing batch). Every problem at once, under its own line.
function checkReturnLines(
  data: WorkspaceData,
  customerId: string,
  lines: readonly ReturnLineRefs[],
) {
  const challanOf = (line: ReturnLineRefs) =>
    line.deliveryLineId === null ? undefined : challanLineOf(data, line.deliveryLineId);
  const issues: { path: string; code: ErrorCode }[] = [];
  lines.forEach((line, index) => {
    if (line.deliveryLineId === null) return;
    const challan = challanOf(line);
    if (
      challan?.delivery.customer.id !== customerId ||
      challan.delivery.status !== 'posted' ||
      challan.line.variantId !== line.variantId
    ) {
      issues.push({
        path: `lines.${String(index)}.deliveryLineId`,
        code: 'return_delivery_line_invalid',
      });
    }
  });
  if (issues.length > 0) throw issuesError(issues);

  const resolved = resolveLines(
    data,
    lines.map((line) => ({
      variantId: line.variantId,
      unitId: line.unitId,
      quantity: line.quantity,
      batchId: challanOf(line)?.line.batchId ?? line.batchId,
      serialNumbers: [...line.serialNumbers],
    })),
    'out',
  );
  resolved.forEach((line, index) => {
    const typed = lines[index];
    const challan = typed === undefined ? undefined : challanOf(typed);
    if (challan === undefined) return;
    const left = subtractQuantity(challan.line.baseQuantity, challan.line.returnedQuantity);
    if (compareQuantity(line.baseQuantity, left) > 0) {
      issues.push({ path: `lines.${String(index)}.quantity`, code: 'return_over_delivered' });
    }
    const sent = new Set(challan.line.serialNumbers);
    if (line.serialNumbers.some((serial) => !sent.has(serial))) {
      issues.push({ path: `lines.${String(index)}.serialNumbers`, code: 'return_serial_invalid' });
    }
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved.map((line, index) => {
    const typed = lines[index];
    return { line, challan: typed === undefined ? undefined : challanOf(typed) };
  });
}

// A new draft, or a draft changed. Its number comes at posting.
export function saveReturn(
  data: WorkspaceData,
  input: ReturnFields,
  existing?: MockSalesReturn,
): MockSalesReturn {
  if (existing && existing.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  const customer = customerOf(data, input.customerId, existing?.customer.id ?? null);
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const checked = checkReturnLines(data, customer.id, input.lines);
  const saved: MockSalesReturn = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    customer,
    warehouseId: input.warehouseId,
    reason: input.reason,
    status: 'draft',
    note: input.note,
    lineCount: checked.length,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    lines: checked.map(({ line, challan }) => ({
      ...line,
      deliveryLineId: challan?.line.id ?? null,
      deliveryNumber: challan?.delivery.number ?? null,
      // Set at posting, from the invoice that billed the challan line by then
      billed: false,
      invoiceLineId: null,
      invoiceId: null,
      invoiceNumber: null,
      value: null,
    })),
    entry: null,
  };
  const { salesReturns } = data.returns;
  data.returns.salesReturns = existing
    ? salesReturns.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...salesReturns];
  return saved;
}

// Only a draft. It brought nothing back, so nothing is undone.
export function removeReturn(data: WorkspaceData, target: MockSalesReturn): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  data.returns.salesReturns = data.returns.salesReturns.filter((item) => item.id !== target.id);
}

// What `quantity` coming back from a challan line is worth: its share of what the line took out,
// counted over everything returned from it so far, so three returns of one line give back exactly
// its value (the API's returnValue)
function returnValue(
  line: { value: string | null; baseQuantity: string; returnedQuantity: string },
  quantity: string,
): string {
  if (line.value === null) throw new Error('A posted challan line has no value');
  const after = addQuantity(line.returnedQuantity, quantity);
  return subtractMoney(
    prorateMoney(line.value, after, line.baseQuantity),
    prorateMoney(line.value, line.returnedQuantity, line.baseQuantity),
  );
}

// postMoves() asks for a cost (lines.2.unitCost) when an item has none yet. A return has no cost
// box, so the problem goes under the item with the return's own code, like the API's noCostError().
function noCostError(error: unknown): never {
  if (
    !(error instanceof MockProblem) ||
    error.code !== 'stock_cost_required' ||
    error.fieldErrors === undefined
  ) {
    throw error;
  }
  const fieldErrors = Object.fromEntries(
    Object.keys(error.fieldErrors).map((path) => [
      path.replace(/\.unitCost$/, '.variantId'),
      ['return_cost_unknown' as const satisfies ErrorCode],
    ]),
  );
  throw new MockProblem(409, 'return_cost_unknown', fieldErrors);
}

// The posted invoice line that billed a challan line, with its invoice
function billingOf(data: WorkspaceData, deliveryLineId: string) {
  for (const invoice of data.billing.invoices) {
    if (invoice.status !== 'posted') continue;
    const line = invoice.lines.find((item) => item.deliveryLineId === deliveryLineId);
    if (line) return { invoice, line };
  }
  return undefined;
}

// What came back before it was billed goes back onto its order line (you chose this): the
// delivered quantity comes down, and a delivered order is confirmed again. A closed order keeps
// its status and its version (its header is frozen); a confirmed one gets a new version.
function returnOnOrder(data: WorkspaceData, orderLineId: string, quantity: string): void {
  for (const order of data.salesDocuments.orders) {
    const line = order.lines.find((item) => item.id === orderLineId);
    if (!line) continue;
    line.deliveredQuantity = subtractQuantity(line.deliveredQuantity, quantity);
    if (order.status === 'delivered' || order.status === 'confirmed') {
      Object.assign(order, { status: 'confirmed', version: order.version + 1, updatedAt: now() });
    }
    return;
  }
}

// The API's postAndLog(), in its order: the date, the warehouse and the lines checked again, the
// number, the stock back in (a challan line's at what it left at, a line of its own at the average
// cost), the invoice line of each billed challan line, the challan lines and the orders, and the
// cost of goods sold booked back. The handler runs it in a transaction(): a refused step leaves
// nothing, not even the number.
export function postReturn(data: WorkspaceData, draft: MockSalesReturn): void {
  if (draft.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  assertDate(data, draft.date);
  assertOpen(data, draft.date);
  assertWarehouses(data, [{ field: 'warehouseId', id: draft.warehouseId }]);
  // Again: another return may have brought the same goods back since the draft was saved
  const checked = checkReturnLines(data, draft.customer.id, draft.lines);
  const accounts = deliveryAccounts(data);
  data.returns.counters.salesReturn += 1;
  const number = seriesNumber(data, 'sales.return', data.returns.counters.salesReturn, draft.date);

  let values: string[];
  try {
    values = postMoves(
      data,
      { date: draft.date, kind: 'sales_return', direction: 'in', documentId: draft.id, number },
      checked.map(({ line, challan }, index) => ({
        line: index,
        warehouseId: draft.warehouseId,
        stockLine: line,
        batchId: line.batchId,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
        value: challan === undefined ? null : returnValue(challan.line, line.baseQuantity),
      })),
    );
  } catch (error) {
    noCostError(error);
  }

  const lines = draft.lines.map((line, index): MockReturnLine => {
    const challan = checked[index]?.challan;
    // Billed already: a credit note gives the money back for this invoice line
    const billed = challan?.line.invoiced === true ? billingOf(data, challan.line.id) : undefined;
    return {
      ...line,
      billed: billed !== undefined,
      invoiceLineId: billed?.line.id ?? null,
      invoiceId: billed?.invoice.id ?? null,
      invoiceNumber: billed?.invoice.number ?? null,
      value: values[index] ?? null,
    };
  });
  // What came back, on each challan line; not billed yet and from an order: the order can deliver
  // it again
  checked.forEach(({ line, challan }) => {
    if (challan === undefined) return;
    challan.line.returnedQuantity = addQuantity(challan.line.returnedQuantity, line.baseQuantity);
    if (!challan.line.invoiced && challan.line.orderLineId !== null) {
      returnOnOrder(data, challan.line.orderLineId, line.baseQuantity);
    }
  });

  // Dr Inventory (the return warehouse's branch) / Cr Cost of goods sold (where the challan booked
  // it; a line of its own: the return warehouse's branch)
  const inventoryBranch = branchOf(data, draft.warehouseId);
  const entry = postStockEntry(data, {
    date: draft.date,
    source: 'sales_return',
    document: { id: draft.id, number },
    narration: `Sales return ${number}`,
    amounts: values.flatMap((value, index) => {
      const challan = checked[index]?.challan;
      return [
        { accountId: accounts.inventory, branchId: inventoryBranch, amount: value },
        {
          accountId: accounts.costOfGoodsSold,
          branchId: branchOf(data, challan?.delivery.warehouseId ?? draft.warehouseId),
          amount: negateMoney(value),
        },
      ];
    }),
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

// --- Credit notes -------------------------------------------------------------------------------

type CreditNoteFields = Omit<CreditNoteInput, 'post'>;

// What a line names, as the form sends it and as a draft keeps it
interface CreditLineRefs {
  invoiceLineId: string;
  returnLineId: string | null;
  unitId: string;
  quantity: string;
  description: string | null;
  unitPrice: string;
  discountType: SalesLineInput['discountType'];
  discount: string;
}

const CREDIT_NOTE_CODES = {
  invoice: 'credit_note_allocation_invalid',
  over: 'credit_note_over_invoice',
} as const;

export function findCreditNote(data: WorkspaceData, id: string): MockCreditNote {
  const found = data.returns.creditNotes.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function toCreditNote(data: WorkspaceData, stored: MockCreditNote): CreditNote {
  const { allocations, ...creditNote } = stored;
  return {
    ...creditNote,
    applied: sumMoney(allocations.map((allocation) => allocation.amount)),
    refunded: refundedFrom(data, 'credit_note', stored.id),
    allocations: allocationRefs(data, allocations),
  };
}

export function listCreditNotes(
  data: WorkspaceData,
  query: {
    status?: string | undefined;
    customerId?: string | undefined;
    invoiceId?: string | undefined;
  },
): CreditNote[] {
  return newestFirst(data.returns.creditNotes)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId) &&
        (query.invoiceId === undefined || item.invoice.id === query.invoiceId),
    )
    .map((item) => toCreditNote(data, item));
}

// The invoice a credit note credits: a posted invoice of this workspace
function postedInvoice(data: WorkspaceData, invoiceId: string): MockInvoice & { number: string } {
  const invoice = data.billing.invoices.find((item) => item.id === invoiceId);
  const number = invoice?.number ?? null;
  if (invoice?.status !== 'posted' || number === null) {
    throw fieldProblem('credit_note_invoice_invalid', 'invoiceId');
  }
  return { ...invoice, number };
}

// A return line, with its return
function returnLineOf(data: WorkspaceData, returnLineId: string) {
  for (const salesReturn of data.returns.salesReturns) {
    const line = salesReturn.lines.find((item) => item.id === returnLineId);
    if (line) return { salesReturn, line };
  }
  return undefined;
}

// The API's resolve(): each line credits a line of the invoice, in any unit of its item, at the
// VAT the invoice line charged and the invoice's price setting, so crediting a line in full gives
// back exactly what it charged. The caps: no line more than its invoice line's quantity; a return
// line's goods once; the lines on one invoice line no more money than it charged less what posted
// credit notes took back. Every problem at once, under its own line.
function resolveCreditLines(
  data: WorkspaceData,
  invoice: MockInvoice,
  lines: readonly CreditLineRefs[],
): { line: CreditNoteLine; amounts: LineAmounts }[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = lines.flatMap((input, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const billed = invoice.lines.find((line) => line.id === input.invoiceLineId);
    if (billed === undefined) {
      at('invoiceLineId', 'credit_note_line_invalid');
      return [];
    }
    // Any unit of the item: 3 strips back from a line of 2 boxes
    const factor =
      input.unitId === billed.baseUnitId
        ? '1'
        : billed.units.find((pack) => pack.unitId === input.unitId)?.factor;
    if (factor === undefined) {
      at('unitId', 'stock_unit_invalid');
      return [];
    }
    if (!fitsDecimals(input.quantity, decimalsOf(data, input.unitId))) {
      at('quantity', 'stock_quantity_decimals');
      return [];
    }
    const baseQuantity = toBaseQuantity(
      input.quantity,
      factor,
      decimalsOf(data, billed.baseUnitId),
    );
    if (compareQuantity(baseQuantity, billed.baseQuantity) > 0) {
      at('quantity', 'credit_note_over_quantity');
    }
    let returnNumber: string | null = null;
    if (input.returnLineId !== null) {
      const back = returnLineOf(data, input.returnLineId);
      // A return line this invoice line billed, on a posted return
      if (back?.line.invoiceLineId !== billed.id || back.salesReturn.status !== 'posted') {
        at('returnLineId', 'credit_note_return_invalid');
      } else {
        returnNumber = back.salesReturn.number;
        const left = subtractQuantity(
          back.line.baseQuantity,
          creditedQuantityOf(data, back.line.id),
        );
        if (compareQuantity(baseQuantity, left) > 0) at('quantity', 'credit_note_over_return');
      }
    }
    const amounts = lineAmounts(
      {
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        discountType: input.discountType,
        discount: input.discount,
        rate: billed.taxRate.rate,
      },
      invoice.pricesIncludeVat,
    );
    const line: CreditNoteLine = {
      variantId: billed.variantId,
      productId: billed.productId,
      productCode: billed.productCode,
      productName: billed.productName,
      optionValues: billed.optionValues,
      sku: billed.sku,
      baseUnitId: billed.baseUnitId,
      id: crypto.randomUUID(),
      productType: billed.productType,
      tracking: billed.tracking,
      hasExpiry: billed.hasExpiry,
      units: billed.units,
      unitId: input.unitId,
      quantity: addQuantity(input.quantity, '0'),
      baseQuantity,
      description: input.description ?? defaultLineDescription(billed),
      unitPrice: addMoney(input.unitPrice, '0'),
      discountType: input.discountType,
      discount: addMoney(input.discount, '0'),
      taxRate: billed.taxRate,
      net: amounts.net,
      vat: amounts.vat,
      total: amounts.total,
      invoiceLineId: billed.id,
      returnLineId: input.returnLineId,
      returnNumber,
    };
    return [{ line, amounts }];
  });
  if (issues.length > 0) throw issuesError(issues);

  // The money on each invoice line, all of this credit note's lines on it together
  const byInvoiceLine = new Map<string, string[]>();
  for (const { line } of resolved) {
    byInvoiceLine.set(line.invoiceLineId, [
      ...(byInvoiceLine.get(line.invoiceLineId) ?? []),
      line.total,
    ]);
  }
  for (const [id, totals] of byInvoiceLine) {
    const billed = invoice.lines.find((line) => line.id === id);
    if (billed === undefined) continue;
    const left = subtractMoney(billed.total, creditedOnLine(data, invoice.id, id));
    if (compareMoney(sumMoney(totals), left) <= 0) continue;
    // Under every line that takes from it: the person decides which one to lower
    lines.forEach((line, index) => {
      if (line.invoiceLineId === id) {
        issues.push({ path: `lines.${String(index)}.unitPrice`, code: 'credit_note_over_line' });
      }
    });
  }
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

// A new draft, or a draft changed. The customer is always the invoice's; a draft keeps it after it
// was archived, like every draft.
export function saveCreditNote(
  data: WorkspaceData,
  input: CreditNoteFields,
  existing?: MockCreditNote,
): MockCreditNote {
  if (existing && existing.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  const invoice = postedInvoice(data, input.invoiceId);
  const customer = customerOf(data, invoice.customer.id, existing?.customer.id ?? null);
  if (input.date < invoice.date) throw fieldProblem('credit_note_date', 'date');
  const resolved = resolveCreditLines(data, invoice, input.lines);
  const saved: MockCreditNote = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    customer,
    invoice: { id: invoice.id, number: invoice.number, date: invoice.date },
    branchId: invoice.branchId,
    reason: input.reason,
    status: 'draft',
    ...documentTotals(resolved.map((item) => item.amounts)),
    lineCount: resolved.length,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    pricesIncludeVat: invoice.pricesIncludeVat,
    note: input.note,
    lines: resolved.map((item) => item.line),
    allocations: [],
    entry: null,
  };
  const { creditNotes } = data.returns;
  data.returns.creditNotes = existing
    ? creditNotes.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...creditNotes];
  return saved;
}

// Only a draft. It took nothing back, so nothing is undone.
export function removeCreditNote(data: WorkspaceData, target: MockCreditNote): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  data.returns.creditNotes = data.returns.creditNotes.filter((item) => item.id !== target.id);
}

// The API's postAndLog(): the date, the invoice, the customer and the lines checked again (another
// credit note may have taken back the same lines), the number, the sale booked back on the
// invoice's branch, and its money applied to its own invoice, up to what it still owes. Returns
// what it applied, for the audit row. The handler runs it in a transaction().
export function postCreditNote(data: WorkspaceData, draft: MockCreditNote): string {
  if (draft.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  assertOpen(data, draft.date);
  const invoice = postedInvoice(data, draft.invoice.id);
  // Active now: the journal will not book a receivable line for an archived customer
  customerOf(data, draft.customer.id, null);
  if (draft.date < invoice.date) throw fieldProblem('credit_note_date', 'date');
  resolveCreditLines(data, invoice, draft.lines);
  data.returns.counters.creditNote += 1;
  const number = seriesNumber(
    data,
    'sales.credit_note',
    data.returns.counters.creditNote,
    draft.date,
  );

  // Dr Sales returns (the setting) or Sales for the net / Dr Output VAT / Cr Accounts receivable
  // (the customer) for the total. A credit note of ৳0 has no entry; an exempt line no VAT line.
  let entry: EntryRef | null = null;
  if (!isZeroMoney(draft.total)) {
    const accounts = salesAccounts(data);
    const returns = data.salesAccounts.returns ?? accounts.sales;
    const lines = [
      side(returns, invoice.branchId, null, { debit: draft.net }),
      side(accounts.vatOutput, invoice.branchId, null, { debit: draft.vat }),
      side(accounts.receivable, invoice.branchId, draft.customer.id, { credit: draft.total }),
    ].filter((line) => !isZeroMoney(line.debit) || !isZeroMoney(line.credit));
    entry = refOf(
      postNew(
        data,
        { date: draft.date, narration: `Credit note ${number}`, lines },
        'sales_credit_note',
        { id: draft.id, number },
      ),
    );
  }
  // Read before the change: what the invoice still owes
  const due = dueOn(data, invoice);
  Object.assign(draft, {
    status: 'posted',
    number,
    entry,
    postedAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  });
  const applied = compareMoney(draft.total, due) <= 0 ? draft.total : due;
  if (compareMoney(applied, '0') > 0) {
    applyAllocations(data, draft, [{ invoiceId: invoice.id, amount: applied }], CREDIT_NOTE_CODES);
  }
  return applied;
}

// A draft has no money to apply yet: before the version check, like the API's lockPosted()
export function assertCreditNotePosted(creditNote: MockCreditNote): void {
  if (creditNote.status !== 'posted') throw new MockProblem(409, 'credit_note_not_posted');
}

// Apply its money again, like a receipt's. What refunds paid back is gone: only the rest can be
// applied.
export function allocateCreditNote(
  data: WorkspaceData,
  creditNote: MockCreditNote,
  allocations: readonly MockAllocation[],
): void {
  const left = subtractMoney(creditNote.total, refundedFrom(data, 'credit_note', creditNote.id));
  if (overAllocated(left, allocations)) {
    throw fieldProblem('credit_note_over_allocated', 'allocations');
  }
  applyAllocations(data, creditNote, allocations, CREDIT_NOTE_CODES);
  Object.assign(creditNote, { version: creditNote.version + 1, updatedAt: now() });
}

// --- Refunds ------------------------------------------------------------------------------------

export function findRefund(data: WorkspaceData, id: string): Refund {
  const found = data.returns.refunds.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function listRefunds(
  data: WorkspaceData,
  query: { status?: string | undefined; customerId?: string | undefined },
): Refund[] {
  return newestFirst(data.returns.refunds).filter(
    (item) =>
      (query.status === undefined || item.status === query.status) &&
      (query.customerId === undefined || item.customer.id === query.customerId),
  );
}

// The receipt or credit note the money comes from: posted, and this customer's, with what it has
// left to pay back. Another customer's, a voided receipt and a draft credit note all get the same
// answer, under the box that named it.
function sourceOf(data: WorkspaceData, customerId: string, input: RefundInput) {
  if (input.receiptId !== null) {
    const receipt = data.billing.receipts.find((item) => item.id === input.receiptId);
    if (receipt?.customer.id !== customerId || receipt.status !== 'posted') {
      throw fieldProblem('refund_source_invalid', 'receiptId');
    }
    return {
      source: { type: 'receipt', id: receipt.id, number: receipt.number } as const,
      left: unappliedOf(toReceipt(data, receipt)),
    };
  }
  if (input.creditNoteId !== null) {
    const creditNote = data.returns.creditNotes.find((item) => item.id === input.creditNoteId);
    const number = creditNote?.number ?? null;
    if (
      creditNote?.customer.id !== customerId ||
      creditNote.status !== 'posted' ||
      number === null
    ) {
      throw fieldProblem('refund_source_invalid', 'creditNoteId');
    }
    const money = toCreditNote(data, creditNote);
    return {
      source: { type: 'credit_note', id: creditNote.id, number } as const,
      left: unappliedOf({ amount: money.total, applied: money.applied, refunded: money.refunded }),
    };
  }
  // The contract makes sure one of the two is there
  throw fieldProblem('refund_source', 'receiptId');
}

// Saved = posted: numbered and booked (Dr Accounts receivable with the customer / Cr the money
// account). The source's `refunded` is worked out on read, so it goes up with the refund.
export function createRefund(data: WorkspaceData, input: RefundInput): Refund {
  const customer = customerOf(data, input.customerId, null);
  assertBranch(data, input.branchId);
  if (!moneyAccountIds(data.accounts).has(input.accountId)) {
    throw fieldProblem('refund_account_invalid', 'accountId');
  }
  const { source, left } = sourceOf(data, customer.id, input);
  const amount = addMoney(input.amount, '0');
  if (compareMoney(amount, left) > 0) throw fieldProblem('refund_over_source', 'amount');
  data.returns.counters.refund += 1;
  const number = seriesNumber(data, 'sales.refund', data.returns.counters.refund, input.date);
  const id = crypto.randomUUID();
  const accounts = salesAccounts(data);
  const entry = postNew(
    data,
    {
      date: input.date,
      narration: `Refund ${number}`,
      lines: [
        side(accounts.receivable, input.branchId, customer.id, { debit: amount }),
        side(input.accountId, input.branchId, null, { credit: amount }),
      ],
    },
    'sales_refund',
    { id, number },
  );
  const refund: Refund = {
    id,
    number,
    date: input.date,
    customer,
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
  data.returns.refunds = [refund, ...data.returns.refunds];
  return refund;
}

// A voided refund is final: before the version check, like the API's lock()
export function assertRefundNotVoided(refund: Refund): void {
  if (refund.status === 'voided') throw new MockProblem(409, 'refund_voided');
}

// Money that never reached the customer: the entry is reversed on the void date, and the money is
// the source's advance again (worked out on read). The refund stays, with its number.
export function voidRefund(
  data: WorkspaceData,
  refund: Refund,
  input: { date: string; reason: string },
): void {
  if (input.date < refund.date) throw fieldProblem('receipt_void_date', 'date');
  const reversal = reverseEntry(data, findEntry(data, refund.entry.id), input.date, {
    allowSales: true,
    narration: `Refund ${refund.number} voided: ${input.reason}`,
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
