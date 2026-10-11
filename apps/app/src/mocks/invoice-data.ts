import {
  addMoney,
  addQuantity,
  compareMoney,
  compareQuantity,
  type CustomerCredit,
  dueDateOf,
  type EntryRef,
  type ErrorCode,
  type Invoice,
  type InvoiceInput,
  type InvoiceLine,
  type InvoicePaymentFilter,
  isOverdue,
  isZeroMoney,
  isZeroQuantity,
  moneyAccountIds,
  overAllocated,
  paymentStatusOf,
  prorateMoney,
  type Receipt,
  type ReceiptInput,
  type StockLine,
  subtractMoney,
  subtractQuantity,
  sumMoney,
  todayIn,
} from '@omnivo/contracts';

import { findEntry, postNew, reverseEntry } from './journal-data';
import { MockProblem } from './mock';
import { balanceOf } from './sales-data';
import {
  confirmOrder,
  customerOf,
  fieldProblem,
  type MockDelivery,
  type MockOrder,
  newestFirst,
  now,
  postDelivery,
  ratesOf,
  type ResolvedLine,
  resolveSalesLines,
  saveDelivery,
  seriesNumber,
  totalsOf,
} from './sales-document-data';
import { assertWarehouses, issuesError, resolveLines } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 15c: invoices, money receipts and the credit limit. The API's rules
// (invoices.service.ts, receipts.service.ts, credit.service.ts, sales-books.service.ts) on plain
// arrays, shortened, so `pnpm dev:mock` and the e2e tests walk the same paths as the real API.

// An invoice as stored. What receipts paid on it, its challans, its orders and its payments are
// worked out on read, like the API's joins: a receipt saved a second ago shows on the invoice.
export type MockInvoice = Omit<Invoice, 'amountPaid' | 'deliveries' | 'orders' | 'payments'>;

export interface MockAllocation {
  invoiceId: string;
  amount: string;
}

// A receipt as stored: the invoices it pays, by id. What it applied and the invoices' numbers,
// dates and totals are looked up on read.
export type MockReceipt = Omit<Receipt, 'applied' | 'allocations'> & {
  allocations: MockAllocation[];
};

export interface MockBilling {
  invoices: MockInvoice[];
  receipts: MockReceipt[];
  // The last number given from each series, like the other mock documents
  counters: { invoice: number; receipt: number };
}

export function emptyBilling(): MockBilling {
  return { invoices: [], receipts: [], counters: { invoice: 0, receipt: 0 } };
}

// --- What every invoice and receipt checks ------------------------------------------------------

// An active branch: whose sale it is, or whose money (the API's assertBranch)
function assertBranch(data: WorkspaceData, branchId: string): void {
  const branch = data.branches.find((item) => item.id === branchId);
  if (branch?.archivedAt !== null) throw fieldProblem('sales_branch_invalid', 'branchId');
}

// The accounts the sales documents post to, by their purpose (the API's SalesBooksService). Every
// chart has one of each, and an account with a purpose is never archived or deleted.
function salesAccounts(data: WorkspaceData) {
  const idOf = (purpose: string): string => {
    const id = data.accounts.find((account) => account.purpose === purpose)?.id;
    if (id === undefined) throw new Error(`The mock chart has no ${purpose} account`);
    return id;
  };
  return {
    receivable: idOf('accounts_receivable'),
    sales: idOf('sales'),
    vatOutput: idOf('vat_output'),
  };
}

// A journal line with one side only
function side(
  accountId: string,
  branchId: string,
  partyId: string | null,
  amount: { debit?: string; credit?: string },
) {
  return {
    accountId,
    branchId,
    partyId,
    description: null,
    debit: amount.debit ?? '0',
    credit: amount.credit ?? '0',
  };
}

function refOf(entry: { id: string; number: string | null }): EntryRef {
  return { id: entry.id, number: entry.number ?? '' };
}

// --- The credit limit ---------------------------------------------------------------------------

// What a confirmed order line will still bill: its total × the part not invoiced yet. A closed
// order bills only what it delivered (goods) or already billed (services). The API's stillToBill.
function stillToBill(order: MockOrder, line: MockOrder['lines'][number]): string {
  const expected =
    order.status !== 'closed'
      ? line.baseQuantity
      : line.productType === 'goods'
        ? line.deliveredQuantity
        : line.invoicedQuantity;
  const left = subtractQuantity(expected, line.invoicedQuantity);
  if (compareQuantity(left, '0') <= 0) return '0';
  return prorateMoney(line.total, left, line.baseQuantity);
}

// The API's CreditService.get(): what the customer owes now, plus what confirmed orders will still
// bill. The forms' credit line and the checks below use the same numbers.
export function creditOf(data: WorkspaceData, customerId: string): CustomerCredit {
  const customer = data.sales.customers.find((item) => item.id === customerId);
  if (!customer) throw new MockProblem(404, 'not_found');
  const balance = sumMoney([balanceOf(data, customerId)]);
  const onOrder = sumMoney(
    data.salesDocuments.orders
      .filter(
        (order) =>
          order.customer.id === customerId &&
          ['confirmed', 'delivered', 'closed'].includes(order.status),
      )
      .flatMap((order) => order.lines.map((line) => stillToBill(order, line))),
  );
  const exposure = sumMoney([balance, onOrder]);
  return {
    limit: customer.creditLimit,
    balance,
    onOrder,
    exposure,
    available: customer.creditLimit === null ? null : subtractMoney(customer.creditLimit, exposure),
  };
}

// After the change: refused when the exposure is over the limit AND higher than before (billing a
// confirmed order at its price adds nothing). With overrideCreditLimit it goes ahead, and the
// handler writes the audit row. The mock signs in as the owner, who has sales.credit.override, so
// credit_override_forbidden never comes from here (the API's tests, 15c.4, cover it).
function checkCredit(
  data: WorkspaceData,
  customerId: string,
  before: string,
  overrideCreditLimit: boolean,
): { limit: string; exposure: string } | null {
  const { limit, exposure } = creditOf(data, customerId);
  if (limit === null) return null;
  if (compareMoney(exposure, limit) <= 0 || compareMoney(exposure, before) <= 0) return null;
  if (!overrideCreditLimit) {
    throw new MockProblem(409, 'credit_limit_exceeded', undefined, { limit, exposure });
  }
  return { limit, exposure };
}

// "Confirm order" (step 15b) with the credit check of 15c. The handler runs it in a transaction(),
// so a refused confirmation leaves the order a draft, as the API's does.
export function confirmWithCredit(
  data: WorkspaceData,
  target: MockOrder,
  overrideCreditLimit: boolean,
): { limit: string; exposure: string } | null {
  const before = creditOf(data, target.customer.id).exposure;
  confirmOrder(data, target);
  return checkCredit(data, target.customer.id, before, overrideCreditLimit);
}

// --- Invoices: reading --------------------------------------------------------------------------

type InvoiceFields = Omit<InvoiceInput, 'post' | 'overrideCreditLimit'>;

export function findInvoice(data: WorkspaceData, id: string): MockInvoice {
  const found = data.billing.invoices.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// A challan line, with its challan
function challanLineOf(data: WorkspaceData, deliveryLineId: string) {
  for (const delivery of data.salesDocuments.deliveries) {
    const line = delivery.lines.find((item) => item.id === deliveryLineId);
    if (line) return { delivery, line };
  }
  return undefined;
}

// An order line, with its order
function orderLineOf(data: WorkspaceData, orderLineId: string) {
  for (const order of data.salesDocuments.orders) {
    const line = order.lines.find((item) => item.id === orderLineId);
    if (line) return { order, line };
  }
  return undefined;
}

// What posted receipts applied to it. Worked out, not kept: the API keeps invoices.amount_paid
// with a trigger on the allocations, and the two can never disagree here either.
function paidOn(data: WorkspaceData, invoiceId: string): string {
  return sumMoney(
    data.billing.receipts.flatMap((receipt) =>
      receipt.allocations
        .filter((allocation) => allocation.invoiceId === invoiceId)
        .map((allocation) => allocation.amount),
    ),
  );
}

export function toInvoice(data: WorkspaceData, stored: MockInvoice): Invoice {
  const deliveries = new Map<string, { id: string; number: string; date: string }>();
  const orders = new Map<string, { id: string; number: string | null }>();
  for (const line of stored.lines) {
    const challan =
      line.deliveryLineId === null ? undefined : challanLineOf(data, line.deliveryLineId);
    // A billed challan is posted, so it has a number
    const number = challan?.delivery.number ?? null;
    if (challan && number !== null) {
      deliveries.set(challan.delivery.id, {
        id: challan.delivery.id,
        number,
        date: challan.delivery.date,
      });
    }
    const order = line.orderLineId === null ? undefined : orderLineOf(data, line.orderLineId);
    if (order) orders.set(order.order.id, { id: order.order.id, number: order.order.number });
  }
  const payments = data.billing.receipts.flatMap((receipt) =>
    receipt.allocations
      .filter((allocation) => allocation.invoiceId === stored.id)
      .map((allocation) => ({
        receiptId: receipt.id,
        receiptNumber: receipt.number,
        date: receipt.date,
        amount: allocation.amount,
      })),
  );
  return {
    ...stored,
    amountPaid: paidOn(data, stored.id),
    deliveries: [...deliveries.values()].toSorted((a, b) => a.date.localeCompare(b.date)),
    orders: [...orders.values()],
    payments: payments.toSorted((a, b) => a.date.localeCompare(b.date)),
  };
}

function matchesPayment(
  invoice: Invoice,
  payment: InvoicePaymentFilter | undefined,
  today: string,
): boolean {
  if (payment === undefined) return true;
  if (invoice.status !== 'posted') return false;
  const paid = paymentStatusOf(invoice) === 'paid';
  if (payment === 'paid') return paid;
  if (payment === 'open') return !paid;
  return isOverdue(invoice, today);
}

// Newest date first, like every list; "not paid" and "overdue" list the oldest due date first,
// the order a receipt pays them in. Two of the same due date: the older invoice first, like the
// API's (due_date, id) with uuidv7 ids. The array keeps the newest first, so it is reversed before
// the stable sort.
export function listInvoices(
  data: WorkspaceData,
  query: {
    status?: string | undefined;
    customerId?: string | undefined;
    payment?: InvoicePaymentFilter | undefined;
  },
): Invoice[] {
  const today = todayIn(data.settings.timezone);
  const byDue = query.payment === 'open' || query.payment === 'overdue';
  const stored = byDue
    ? data.billing.invoices.toReversed().toSorted((a, b) => a.dueDate.localeCompare(b.dueDate))
    : newestFirst(data.billing.invoices);
  return stored
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId),
    )
    .map((item) => toInvoice(data, item))
    .filter((item) => matchesPayment(item, query.payment, today));
}

// --- Invoices: what a save checks ---------------------------------------------------------------

interface LineRefs {
  deliveryLineId: string | null;
  orderLineId: string | null;
  variantId: string;
  unitId: string;
  quantity: string;
}

// What a line bills: the challan line, and the order line (its own, or the challan line's)
interface LineSource {
  deliveryLineId: string | null;
  orderLineId: string | null;
}

// The API's checkSources(): a challan line is on a posted challan of this customer, of the same
// item, unit and quantity, and not billed yet; an order line is a service line of a confirmed (or
// delivered, or closed) order of this customer, billed whole and not billed yet. The orders behind
// the lines must read prices the same way. Run at save and again at posting: drafts claim nothing,
// so another invoice may have billed a line in between.
function checkSources(data: WorkspaceData, customerId: string, lines: readonly LineRefs[]) {
  const issues: { path: string; code: ErrorCode }[] = [];
  const vatSettings = new Set<boolean>();
  const keptVariantIds = new Set<string>();
  const keptRateIds = new Set<string>();
  const same = (line: LineRefs, other: { variantId: string; unitId: string; quantity: string }) =>
    line.variantId === other.variantId &&
    line.unitId === other.unitId &&
    compareQuantity(line.quantity, other.quantity) === 0;
  const useOrder = (found: ReturnType<typeof orderLineOf>) => {
    if (!found) return;
    vatSettings.add(found.order.pricesIncludeVat);
    keptRateIds.add(found.line.taxRate.id);
  };
  const sources = lines.map((line, index): LineSource => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    if (line.deliveryLineId !== null) {
      const challan = challanLineOf(data, line.deliveryLineId);
      if (
        challan?.delivery.customer.id !== customerId ||
        challan.delivery.status !== 'posted' ||
        !same(line, challan.line)
      ) {
        at('deliveryLineId', 'invoice_delivery_line_invalid');
      } else if (challan.line.invoiced) {
        at('deliveryLineId', 'invoice_delivery_line_billed');
      }
      const orderLineId = challan?.line.orderLineId ?? null;
      keptVariantIds.add(line.variantId);
      useOrder(orderLineId === null ? undefined : orderLineOf(data, orderLineId));
      return { deliveryLineId: line.deliveryLineId, orderLineId };
    }
    if (line.orderLineId !== null) {
      const found = orderLineOf(data, line.orderLineId);
      // Goods on an order are billed through their challan: only the challan says they left
      if (
        found?.order.customer.id !== customerId ||
        !['confirmed', 'delivered', 'closed'].includes(found.order.status) ||
        found.line.productType !== 'service' ||
        !same(line, found.line)
      ) {
        at('orderLineId', 'invoice_order_line_invalid');
      } else if (!isZeroQuantity(found.line.invoicedQuantity)) {
        at('orderLineId', 'invoice_order_line_billed');
      }
      keptVariantIds.add(line.variantId);
      useOrder(found);
      return { deliveryLineId: null, orderLineId: line.orderLineId };
    }
    return { deliveryLineId: null, orderLineId: null };
  });
  if (issues.length > 0) throw issuesError(issues);
  if (vatSettings.size > 1) throw new MockProblem(409, 'invoice_vat_mixed');
  const [pricesIncludeVat] = [...vatSettings];
  return { sources, pricesIncludeVat: pricesIncludeVat ?? null, keptVariantIds, keptRateIds };
}

// The challan an invoice makes for its own goods names its lines lines.0, lines.1 …; on the
// invoice they are, say, lines.2 and lines.5. Each problem moves under the invoice line it belongs
// to, like the API's onInvoiceLines().
function onInvoiceLines<T>(indexes: readonly number[], fn: () => T): T {
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

// A goods line of the invoice's own, as the challan it makes takes it
function stockLineOf(line: {
  variantId: string;
  unitId: string;
  quantity: string;
  batchId: string | null;
  serialNumbers: readonly string[];
}) {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    batchId: line.batchId,
    serialNumbers: [...line.serialNumbers],
  };
}

// The lines of its own (neither a challan line nor an order line). A goods one is checked like a
// challan line now (warehouse, batch, serial numbers), because posting delivers it; a service one
// takes no batch or serial. Returns the stock line of each goods one, by its index: the invoice
// keeps its batch, lot and expiry for print.
function checkOwnLines(
  data: WorkspaceData,
  input: InvoiceFields,
  resolved: readonly ResolvedLine[],
  sources: readonly LineSource[],
): Map<number, StockLine> {
  const issues: { path: string; code: ErrorCode }[] = [];
  const goods: number[] = [];
  input.lines.forEach((typed, index) => {
    const source = sources[index];
    // A challan line or an order line (or no source at all) is not a line of its own
    if (source?.deliveryLineId !== null || source.orderLineId !== null) return;
    if (resolved[index]?.line.productType === 'goods') {
      goods.push(index);
      return;
    }
    const at = (field: string) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code: 'invoice_stock_not_allowed' });
    };
    if (typed.batchId !== null) at('batchId');
    if (typed.serialNumbers.length > 0) at('serialNumbers');
  });
  if (issues.length > 0) throw issuesError(issues);
  if (goods.length === 0) return new Map();
  if (input.warehouseId === null) throw fieldProblem('invoice_warehouse_required', 'warehouseId');
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const typed = goods.flatMap((index) => {
    const line = input.lines[index];
    return line ? [stockLineOf(line)] : [];
  });
  const stockLines = onInvoiceLines(goods, () => resolveLines(data, typed, 'out'));
  return new Map(
    goods.flatMap((index, position) => {
      const line = stockLines[position];
      return line ? [[index, line] as const] : [];
    }),
  );
}

// The customer's billing address as one text, the way the invoice prints it (15a has one per
// customer). Kept on the invoice, so a later change does not rewrite a posted invoice.
function billingAddressOf(data: WorkspaceData, customerId: string): string | null {
  const address = data.sales.customers
    .find((item) => item.id === customerId)
    ?.addresses.find((item) => item.kind === 'billing');
  if (!address) return null;
  return [address.label, address.address, address.phone]
    .filter((part): part is string => part !== null)
    .join('\n');
}

// --- Invoices: saving and posting ---------------------------------------------------------------

// A new draft, or a draft changed. Its number comes at posting.
export function saveInvoice(
  data: WorkspaceData,
  input: InvoiceFields,
  existing?: MockInvoice,
): MockInvoice {
  if (existing && existing.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  const customer = customerOf(data, input.customerId, existing?.customer.id ?? null);
  assertBranch(data, input.branchId);
  const checked = checkSources(data, customer.id, input.lines);
  // The orders' way of reading prices, else the draft's own, else the workspace's now
  const pricesIncludeVat =
    checked.pricesIncludeVat ?? existing?.pricesIncludeVat ?? data.settings.pricesIncludeVat;
  const resolved = resolveSalesLines(
    data,
    input.lines,
    pricesIncludeVat,
    new Set([...checked.keptRateIds, ...ratesOf(existing?.lines ?? [])]),
    checked.keptVariantIds,
  );
  const own = checkOwnLines(data, input, resolved, checked.sources);
  const terms = data.sales.customers.find((item) => item.id === customer.id)?.paymentTermsDays;
  const lines = resolved.map(({ line }, index): InvoiceLine => {
    const source = checked.sources[index] ?? { deliveryLineId: null, orderLineId: null };
    const challan =
      source.deliveryLineId === null ? undefined : challanLineOf(data, source.deliveryLineId);
    const order = source.orderLineId === null ? undefined : orderLineOf(data, source.orderLineId);
    // The batch and serial numbers the goods leave with: the challan line's, or the line's own
    const stock = challan?.line ?? own.get(index);
    return {
      ...line,
      deliveryLineId: source.deliveryLineId,
      orderLineId: source.orderLineId,
      deliveryNumber: challan?.delivery.number ?? null,
      orderNumber: order?.order.number ?? null,
      batchId: stock?.batchId ?? null,
      lotNumber: stock?.lotNumber ?? null,
      expiresOn: stock?.expiresOn ?? null,
      serialNumbers: stock?.serialNumbers ?? [],
    };
  });
  const saved: MockInvoice = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    // An empty box: the customer's payment terms (step 15a), counted from the invoice date
    dueDate: input.dueDate ?? dueDateOf(input.date, terms ?? 0),
    customer,
    customerReference: input.customerReference,
    branchId: input.branchId,
    warehouseId: input.warehouseId,
    status: 'draft',
    pricesIncludeVat,
    ...totalsOf(resolved),
    billingAddress: billingAddressOf(data, customer.id),
    note: input.note,
    lines,
    lineCount: lines.length,
    entry: null,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
  const { invoices } = data.billing;
  data.billing.invoices = existing
    ? invoices.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...invoices];
  return saved;
}

// Only a draft. It claimed no challan line, so nothing is undone.
export function removeInvoice(data: WorkspaceData, target: MockInvoice): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  data.billing.invoices = data.billing.invoices.filter((item) => item.id !== target.id);
}

// What a posting did besides the invoice itself, for the handler's audit rows
export interface InvoicePosted {
  challan: MockDelivery | null;
  overridden: { limit: string; exposure: string } | null;
}

// The API's postAndLog(), in its order: the date, the customer and the branch checked again, the
// sources checked again, the number, the invoice's own goods out on a challan of their own, the
// challan lines marked billed, the order lines' invoiced quantity, the sale in the books, the
// credit check, and the invoice posted last. The handler runs it in a transaction(): a refused
// step leaves nothing, not even the challan it made.
export function postInvoice(
  data: WorkspaceData,
  draft: MockInvoice,
  overrideCreditLimit: boolean,
): InvoicePosted {
  if (draft.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  if (data.journal.lockDate !== null && draft.date <= data.journal.lockDate) {
    throw fieldProblem('journal_period_locked', 'date');
  }
  // Active now: the journal will not book a sale to an archived customer
  customerOf(data, draft.customer.id, null);
  assertBranch(data, draft.branchId);
  checkSources(data, draft.customer.id, draft.lines);
  const before = creditOf(data, draft.customer.id).exposure;
  data.billing.counters.invoice += 1;
  const number = seriesNumber(data, 'sales.invoice', data.billing.counters.invoice, draft.date);

  // The goods lines of its own leave on a challan of their own, from the invoice's warehouse
  const own = draft.lines.flatMap((line, index) =>
    line.deliveryLineId === null && line.orderLineId === null && line.productType === 'goods'
      ? [index]
      : [],
  );
  let challan: MockDelivery | null = null;
  if (own.length > 0) {
    const { warehouseId } = draft;
    if (warehouseId === null) throw fieldProblem('invoice_warehouse_required', 'warehouseId');
    const made = onInvoiceLines(own, () =>
      postDelivery(
        data,
        saveDelivery(data, {
          customerId: draft.customer.id,
          orderId: null,
          date: draft.date,
          warehouseId,
          shippingAddressId: null,
          vehicle: null,
          note: `Invoice ${number}`,
          lines: own.flatMap((index) => {
            const line = draft.lines[index];
            return line ? [{ ...stockLineOf(line), orderLineId: null }] : [];
          }),
        }),
      ),
    );
    own.forEach((index, position) => {
      const line = draft.lines[index];
      const out = made.lines[position];
      if (!line || !out) return;
      Object.assign(line, {
        deliveryLineId: out.id,
        deliveryNumber: made.number,
        batchId: out.batchId,
        lotNumber: out.lotNumber,
        expiresOn: out.expiresOn,
        serialNumbers: out.serialNumbers,
      });
    });
    challan = made;
  }

  // Each challan line billed once; what was billed onto its order line (a challan line's through
  // the order line it delivered, a service line's directly). The order keeps its version, like the
  // API's: a delivered or closed order's header is frozen.
  for (const line of draft.lines) {
    const billed =
      line.deliveryLineId === null ? undefined : challanLineOf(data, line.deliveryLineId);
    if (billed) billed.line.invoiced = true;
    const ordered = line.orderLineId === null ? undefined : orderLineOf(data, line.orderLineId);
    if (ordered) {
      ordered.line.invoicedQuantity = addQuantity(ordered.line.invoicedQuantity, line.baseQuantity);
    }
  }

  // Dr Accounts receivable (the customer) / Cr Sales / Cr Output VAT, every line with the
  // invoice's branch. A ৳0 invoice has no entry; an exempt sale has no VAT line.
  let entry: EntryRef | null = null;
  if (!isZeroMoney(draft.total)) {
    const accounts = salesAccounts(data);
    const lines = [
      side(accounts.receivable, draft.branchId, draft.customer.id, { debit: draft.total }),
      side(accounts.sales, draft.branchId, null, { credit: draft.net }),
      side(accounts.vatOutput, draft.branchId, null, { credit: draft.vat }),
    ].filter((line) => !isZeroMoney(line.debit) || !isZeroMoney(line.credit));
    entry = refOf(
      postNew(data, { date: draft.date, narration: `Invoice ${number}`, lines }, 'sales_invoice', {
        id: draft.id,
        number,
      }),
    );
  }
  const overridden = checkCredit(data, draft.customer.id, before, overrideCreditLimit);
  Object.assign(draft, {
    status: 'posted',
    number,
    entry,
    postedAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  });
  return { challan, overridden };
}

// --- Money receipts -----------------------------------------------------------------------------

export function findReceipt(data: WorkspaceData, id: string): MockReceipt {
  const found = data.billing.receipts.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// The invoices it pays, oldest due date first: the order the form suggested them in
export function toReceipt(data: WorkspaceData, stored: MockReceipt): Receipt {
  const { allocations, ...receipt } = stored;
  return {
    ...receipt,
    applied: sumMoney(allocations.map((allocation) => allocation.amount)),
    allocations: allocations
      .flatMap((allocation) => {
        const invoice = data.billing.invoices.find((item) => item.id === allocation.invoiceId);
        // Only posted invoices are paid, so each has a number
        const number = invoice?.number ?? null;
        if (!invoice || number === null) return [];
        return [
          {
            invoiceId: invoice.id,
            invoiceNumber: number,
            invoiceDate: invoice.date,
            dueDate: invoice.dueDate,
            invoiceTotal: invoice.total,
            amount: allocation.amount,
          },
        ];
      })
      .toSorted((a, b) => a.dueDate.localeCompare(b.dueDate)),
  };
}

export function listReceipts(
  data: WorkspaceData,
  query: { status?: string | undefined; customerId?: string | undefined },
): Receipt[] {
  return newestFirst(data.billing.receipts)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId),
    )
    .map((item) => toReceipt(data, item));
}

// The API's apply(): the whole list replaces the old one. Each invoice is a posted invoice of the
// receipt's customer, and gets no more than it still owes; what this receipt had on it counts as
// owed again, because it is being replaced. Every problem at once, under its own row.
function applyAllocations(
  data: WorkspaceData,
  receipt: MockReceipt,
  wanted: readonly MockAllocation[],
): void {
  const had = new Map(receipt.allocations.map((item) => [item.invoiceId, item.amount]));
  const issues: { path: string; code: ErrorCode }[] = [];
  wanted.forEach((allocation, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `allocations.${String(index)}.${field}`, code });
    };
    const invoice = data.billing.invoices.find((item) => item.id === allocation.invoiceId);
    if (invoice?.customer.id !== receipt.customer.id || invoice.status !== 'posted') {
      at('invoiceId', 'receipt_invoice_invalid');
      return;
    }
    const due = sumMoney([
      subtractMoney(invoice.total, paidOn(data, invoice.id)),
      had.get(invoice.id) ?? '0',
    ]);
    if (compareMoney(allocation.amount, due) > 0) at('amount', 'receipt_over_invoice');
  });
  if (issues.length > 0) throw issuesError(issues);
  receipt.allocations = wanted.map((allocation) => ({
    invoiceId: allocation.invoiceId,
    amount: addMoney(allocation.amount, '0'),
  }));
}

// Saved = posted: numbered, booked (Dr the money account / Cr Accounts receivable with the
// customer), then applied. The handler runs it in a transaction(): a refused allocation leaves no
// receipt and no entry.
export function createReceipt(data: WorkspaceData, input: ReceiptInput): MockReceipt {
  const customer = customerOf(data, input.customerId, null);
  assertBranch(data, input.branchId);
  // Exactly the list the form offers (contracts' moneyAccountIds)
  if (!moneyAccountIds(data.accounts).has(input.accountId)) {
    throw fieldProblem('receipt_account_invalid', 'accountId');
  }
  data.billing.counters.receipt += 1;
  const number = seriesNumber(data, 'sales.receipt', data.billing.counters.receipt, input.date);
  const id = crypto.randomUUID();
  const amount = addMoney(input.amount, '0');
  const accounts = salesAccounts(data);
  // The books first: a closed period refuses here, before any invoice is touched
  const entry = postNew(
    data,
    {
      date: input.date,
      narration: `Money receipt ${number}`,
      lines: [
        side(input.accountId, input.branchId, null, { debit: amount }),
        side(accounts.receivable, input.branchId, customer.id, { credit: amount }),
      ],
    },
    'sales_receipt',
    { id, number },
  );
  const receipt: MockReceipt = {
    id,
    number,
    date: input.date,
    customer,
    amount,
    method: input.method,
    reference: input.reference,
    accountId: input.accountId,
    branchId: input.branchId,
    status: 'posted',
    note: input.note,
    allocations: [],
    entry: refOf(entry),
    voidEntry: null,
    voidDate: null,
    voidReason: null,
    version: 1,
    updatedAt: now(),
  };
  data.billing.receipts = [receipt, ...data.billing.receipts];
  applyAllocations(data, receipt, input.allocations);
  return receipt;
}

// A voided receipt is final: before the version check, like the API's lock()
export function assertNotVoided(receipt: MockReceipt): void {
  if (receipt.status === 'voided') throw new MockProblem(409, 'receipt_voided');
}

// Apply the money again: an advance onto a new invoice, or moved from one invoice to another.
// Nothing in the books changes, only what each invoice still owes.
export function allocateReceipt(
  data: WorkspaceData,
  receipt: MockReceipt,
  allocations: readonly MockAllocation[],
): void {
  if (overAllocated(receipt.amount, allocations)) {
    throw new MockProblem(409, 'receipt_over_allocated', {
      allocations: ['receipt_over_allocated'],
    });
  }
  applyAllocations(data, receipt, allocations);
  Object.assign(receipt, { version: receipt.version + 1, updatedAt: now() });
}

// A bounced cheque: the money comes off the invoices, and the entry is reversed on the void date
// with the reason in its narration. The receipt stays, so its number is never missing.
export function voidReceipt(
  data: WorkspaceData,
  receipt: MockReceipt,
  input: { date: string; reason: string },
): void {
  if (input.date < receipt.date) throw fieldProblem('receipt_void_date', 'date');
  receipt.allocations = [];
  const reversal = reverseEntry(data, findEntry(data, receipt.entry.id), input.date, {
    allowSales: true,
    narration: `Money receipt ${receipt.number} voided: ${input.reason}`,
  });
  Object.assign(receipt, {
    status: 'voided',
    voidDate: input.date,
    voidReason: input.reason,
    voidEntry: refOf(reversal),
    version: receipt.version + 1,
    updatedAt: now(),
  });
}
