import {
  addMoney,
  agingAmountsOf,
  type AgingAmounts,
  agingBucketOf,
  type AgingReport,
  type AgingRow,
  type AgingSort,
  type ApAgingAdvance,
  type ApAgingFilter,
  type ApAgingParty,
  type ArAgingAdvance,
  type ArAgingFilter,
  type ArAgingParty,
  compareMoney,
  costColumns,
  daysOverdue,
  isZeroMoney,
  negateMoney,
  type PartyRef,
  prorateMoney,
  type PurchaseReport,
  type PurchaseReportFilter,
  type PurchaseReportRow,
  type SalesReport,
  type SalesReportFilter,
  type SalesReportRow,
  subtractMoney,
  sumMoney,
  type TradeReportRowKind,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
import { isClosing } from './report-data';
import { pageOf } from './sales-document-data';
import { findVariant } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// Step 21b: the sales and purchase reports and the two agings on the mock's arrays. The API's rules
// (trade-report-queries.ts, aging-queries.ts) written again, like the statements' (report-data.ts),
// so a sale posted in `pnpm dev:mock` or in a Playwright test shows in the report at once.
//
// One thing is simpler than the API: the mock's allocations have no applied_on. An allocation counts
// from the later of its two documents' dates (what the API's backfill gives an old one), so a
// re-apply today does not show as "today" here.

// ---------------------------------------------------------------------------------------------
// What the two reports share

// A column's value to sort by; null goes last either way, like the API's NULLS LAST
type SortValue = string | null;

interface RowIdentity {
  key: string;
  kind: TradeReportRowKind;
  id: string | null;
  code: string | null;
  name: string | null;
  month: string | null;
}

// A row's name to sort by: a month by its date, a thing by its name in any case. A row that is not
// an item has none, so it comes last whichever way (the API's SORT_NAME).
function sortName(row: RowIdentity): string | null {
  return row.kind === 'item' ? (row.month ?? row.name?.toLowerCase() ?? null) : null;
}

function compareText(a: string | null, b: string | null, direction: number): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return direction * a.localeCompare(b);
}

function compareNumber(a: SortValue, b: SortValue, direction: number): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return direction * compareMoney(a, b);
}

// 'net' sorts up and '-net' down; then the name and the key, so a page never repeats a row
function sorted<R extends RowIdentity>(
  rows: readonly R[],
  sort: string,
  valueOf: (row: R, column: string) => SortValue,
): R[] {
  const direction = sort.startsWith('-') ? -1 : 1;
  const column = sort.replace(/^-/, '');
  return rows.toSorted((a, b) => {
    if (column === 'name') {
      return compareText(sortName(a), sortName(b), direction) || compareText(a.key, b.key, 1);
    }
    return (
      compareNumber(valueOf(a, column), valueOf(b, column), direction) ||
      compareText(sortName(a), sortName(b), 1) ||
      compareText(a.key, b.key, 1)
    );
  });
}

// This category and every one under it (the API's inCategory)
function categoryAndBelow(data: WorkspaceData, categoryId: string): Set<string> {
  const found = new Set([categoryId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const category of data.catalog.categories) {
      if (category.parentId !== null && found.has(category.parentId) && !found.has(category.id)) {
        found.add(category.id);
        grew = true;
      }
    }
  }
  return found;
}

const monthRow = (date: string): RowIdentity => ({
  key: date.slice(0, 7),
  kind: 'item',
  id: null,
  code: null,
  name: null,
  month: date.slice(0, 7),
});

function kindRow(kind: TradeReportRowKind): RowIdentity {
  return { key: kind, kind, id: null, code: null, name: null, month: null };
}

function thingRow(id: string, code: string | null, name: string): RowIdentity {
  return { key: id, kind: 'item', id, code, name, month: null };
}

function unitOf(data: WorkspaceData, unitId: string) {
  const unit = data.catalog.units.find((candidate) => candidate.id === unitId);
  return unit ? { code: unit.code, decimals: unit.decimals } : null;
}

interface Totalled {
  gross: string[];
  returns: string[];
  quantity: string[];
  cost: string[];
}

// One row per key, in the order they were first met
function groupInto<L extends { gross: string; returns: string; quantity: string; cost: string }>(
  lines: readonly L[],
  identityOf: (line: L) => RowIdentity,
): { identity: RowIdentity; line: L; sums: Totalled }[] {
  const groups = new Map<string, { identity: RowIdentity; line: L; sums: Totalled }>();
  for (const line of lines) {
    const identity = identityOf(line);
    const group = groups.get(identity.key) ?? {
      identity,
      line,
      sums: { gross: [], returns: [], quantity: [], cost: [] },
    };
    group.sums.gross.push(line.gross);
    group.sums.returns.push(line.returns);
    group.sums.quantity.push(line.quantity);
    group.sums.cost.push(line.cost);
    groups.set(identity.key, group);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------------------------
// Sales

interface SaleLine {
  date: string;
  customerId: string | null;
  branchId: string;
  variantId: string;
  gross: string;
  returns: string;
  quantity: string;
  cost: string;
}

// The four kinds of lines of the API's salesLines(), signed so that adding them up gives the period
function salesLines(data: WorkspaceData): SaleLine[] {
  const challanLines = new Map(
    data.salesDocuments.deliveries.flatMap((delivery) =>
      delivery.lines.map((line) => [line.id, line] as const),
    ),
  );
  const returnLines = new Map(
    data.returns.salesReturns.flatMap((item) => item.lines.map((line) => [line.id, line] as const)),
  );
  const branchOf = new Map(data.stock.warehouses.map((place) => [place.id, place.branchId]));
  const invoices = data.billing.invoices.filter((invoice) => invoice.status === 'posted');
  const invoiceOf = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const sales = new Map(data.pos.sales.map((sale) => [sale.id, sale]));

  const sold = invoices.flatMap((invoice) =>
    invoice.lines.map((line): SaleLine => {
      const challan =
        line.deliveryLineId === null ? undefined : challanLines.get(line.deliveryLineId);
      return {
        date: invoice.date,
        customerId: invoice.customer.id,
        branchId: invoice.branchId,
        variantId: line.variantId,
        gross: line.net,
        returns: '0',
        quantity: line.baseQuantity,
        // The challan line's cost, in the share this line billed
        cost: challan?.value
          ? prorateMoney(challan.value, line.baseQuantity, challan.baseQuantity)
          : '0',
      };
    }),
  );
  const atCounter = data.pos.sales.flatMap((sale) =>
    sale.lines.map((line): SaleLine => ({
      date: sale.date,
      customerId: sale.customer?.id ?? null,
      branchId: branchOf.get(sale.warehouseId) ?? '',
      variantId: line.variantId,
      gross: line.net,
      returns: '0',
      quantity: line.baseQuantity,
      cost: line.value,
    })),
  );
  const credited = data.returns.creditNotes
    .filter((note) => note.status === 'posted')
    .flatMap((note) =>
      note.lines.map((line): SaleLine => {
        const back = line.returnLineId === null ? undefined : returnLines.get(line.returnLineId);
        return {
          date: note.date,
          customerId: note.customer.id,
          branchId: invoiceOf.get(note.invoice.id)?.branchId ?? '',
          variantId: line.variantId,
          gross: '0',
          returns: line.net,
          // A price cut gives money back, not goods
          quantity: back ? negateMoney(line.baseQuantity) : '0',
          cost: back?.value
            ? negateMoney(prorateMoney(back.value, line.baseQuantity, back.baseQuantity))
            : '0',
        };
      }),
    );
  const returned = data.pos.returns.flatMap((item) => {
    const sale = sales.get(item.saleId);
    return item.lines.flatMap((line): SaleLine[] => {
      const soldLine = sale?.lines.find((candidate) => candidate.id === line.saleLineId);
      if (!sale || !soldLine) return [];
      return [
        {
          date: item.date,
          customerId: sale.customer?.id ?? null,
          branchId: branchOf.get(item.warehouseId) ?? '',
          variantId: soldLine.variantId,
          gross: '0',
          returns: line.net,
          quantity: negateMoney(line.baseQuantity),
          cost: negateMoney(line.value),
        },
      ];
    });
  });
  return [...sold, ...atCounter, ...credited, ...returned];
}

// The books' sales of the period: the 'sales' account less the Sales returns account (null with a
// customer group or a category, whose lines the books do not have)
function booksSales(data: WorkspaceData, filter: SalesReportFilter): string | null {
  if (filter.customerGroupId !== undefined || filter.categoryId !== undefined) return null;
  const sales = data.accounts.find((account) => account.purpose === 'sales')?.id;
  const accounts = new Set([sales, data.salesAccounts.returns]);
  return sumMoney(
    data.journal.entries
      .filter(
        (entry) =>
          entry.status === 'posted' &&
          entry.date >= filter.from &&
          entry.date <= filter.to &&
          !isClosing(data, entry),
      )
      .flatMap((entry) => entry.lines)
      .filter(
        (line) =>
          accounts.has(line.accountId) &&
          (filter.branchId === undefined || line.branchId === filter.branchId),
      )
      .map((line) => subtractMoney(line.credit, line.debit)),
  );
}

export function salesReportOf(
  data: WorkspaceData,
  query: SalesReportFilter & { limit: number; cursor?: string | undefined },
  withCost: boolean,
): SalesReport {
  const customers = new Map(data.sales.customers.map((customer) => [customer.id, customer]));
  const categories = new Map(data.catalog.categories.map((category) => [category.id, category]));
  const branches = new Map(data.branches.map((branch) => [branch.id, branch]));
  const wanted = query.categoryId === undefined ? null : categoryAndBelow(data, query.categoryId);
  const lines = salesLines(data).flatMap((line) => {
    const found = findVariant(data, line.variantId);
    if (!found) return [];
    const customer = line.customerId === null ? undefined : customers.get(line.customerId);
    const inPeriod = line.date >= query.from && line.date <= query.to;
    const inBranch = query.branchId === undefined || line.branchId === query.branchId;
    // A walk-in has no group, so the group filter leaves the walk-ins out
    const inGroup =
      query.customerGroupId === undefined || customer?.groupId === query.customerGroupId;
    const inCategory =
      wanted === null ||
      (found.product.categoryId !== null && wanted.has(found.product.categoryId));
    return inPeriod && inBranch && inGroup && inCategory
      ? [{ ...line, product: found.product, customer }]
      : [];
  });
  const groups = groupInto(lines, (line): RowIdentity => {
    if (query.groupBy === 'month') return monthRow(line.date);
    if (query.groupBy === 'product') {
      return thingRow(line.product.id, line.product.code, line.product.name);
    }
    if (query.groupBy === 'branch') {
      const branch = branches.get(line.branchId);
      return thingRow(line.branchId, branch?.code ?? null, branch?.name ?? '');
    }
    if (query.groupBy === 'category') {
      const category =
        line.product.categoryId === null ? undefined : categories.get(line.product.categoryId);
      return category ? thingRow(category.id, null, category.name) : kindRow('no_category');
    }
    return line.customer
      ? thingRow(line.customer.id, line.customer.code, line.customer.name)
      : kindRow('walk_in');
  });
  const rows = groups.map(({ identity, line, sums }): SalesReportRow => {
    const gross = sumMoney(sums.gross);
    const returns = sumMoney(sums.returns);
    const net = subtractMoney(gross, returns);
    return {
      ...identity,
      quantity: query.groupBy === 'product' ? sumMoney(sums.quantity) : null,
      baseUnit: query.groupBy === 'product' ? unitOf(data, line.product.baseUnitId) : null,
      gross,
      returns,
      net,
      ...costColumns(net, withCost ? sumMoney(sums.cost) : null),
    };
  });
  const gross = sumMoney(rows.map((row) => row.gross));
  const returns = sumMoney(rows.map((row) => row.returns));
  const net = subtractMoney(gross, returns);
  const cost = withCost ? sumMoney(groups.flatMap((group) => group.sums.cost)) : null;
  const values = (row: SalesReportRow, column: string): SortValue => {
    if (column === 'quantity') return row.quantity;
    if (column === 'gross') return row.gross;
    if (column === 'returns') return row.returns;
    if (column === 'cost') return row.cost;
    if (column === 'margin') return row.margin;
    if (column === 'marginPercent') return row.marginPercent;
    return row.net;
  };
  return {
    ...pageOf(sorted(rows, query.sort, values), query),
    totals: { gross, returns, net, ...costColumns(net, cost) },
    withCost,
    books: booksSales(data, query),
  };
}

// ---------------------------------------------------------------------------------------------
// Purchases

interface PurchaseLine {
  date: string;
  supplierId: string;
  branchId: string;
  variantId: string | null;
  accountId: string | null;
  gross: string;
  returns: string;
  quantity: string;
  cost: string;
}

// The API's purchaseLines(): bill lines, bill expenses, debit note lines and debit note expenses
function purchaseLines(data: WorkspaceData): PurchaseLine[] {
  const bills = data.purchase.bills.filter((bill) => bill.status === 'posted');
  const billLines = new Map(
    bills.flatMap((bill) => bill.lines.map((line) => [line.id, line] as const)),
  );
  const billExpenses = new Map(
    bills.flatMap((bill) => bill.expenses.map((expense) => [expense.id, expense] as const)),
  );
  const notes = data.purchase.debitNotes.filter((note) => note.status === 'posted');
  return [
    ...bills.flatMap((bill) => [
      ...bill.lines.map((line): PurchaseLine => ({
        date: bill.date,
        supplierId: bill.supplier.id,
        branchId: bill.branchId,
        variantId: line.variantId,
        accountId: line.accountId,
        gross: line.net,
        returns: '0',
        quantity: line.accountId === null ? line.baseQuantity : '0',
        cost: '0',
      })),
      ...bill.expenses.map((expense): PurchaseLine => ({
        date: bill.date,
        supplierId: bill.supplier.id,
        branchId: bill.branchId,
        variantId: null,
        accountId: expense.accountId,
        gross: expense.net,
        returns: '0',
        quantity: '0',
        cost: '0',
      })),
    ]),
    ...notes.flatMap((note) => [
      ...note.lines.map((line): PurchaseLine => {
        const billed = line.billLineId === null ? undefined : billLines.get(line.billLineId);
        const accountId = billed?.accountId ?? null;
        return {
          date: note.date,
          supplierId: note.supplier.id,
          branchId: note.branchId,
          variantId: line.variantId,
          accountId,
          gross: '0',
          returns: line.net,
          quantity:
            line.returnLineId === null || accountId !== null ? '0' : negateMoney(line.baseQuantity),
          cost: '0',
        };
      }),
      ...note.expenses.map((expense): PurchaseLine => ({
        date: note.date,
        supplierId: note.supplier.id,
        branchId: note.branchId,
        variantId: null,
        accountId: billExpenses.get(expense.billExpenseId)?.accountId ?? expense.accountId,
        gross: '0',
        returns: expense.net,
        quantity: '0',
        cost: '0',
      })),
    ]),
  ];
}

export function purchaseReportOf(
  data: WorkspaceData,
  query: PurchaseReportFilter & { limit: number; cursor?: string | undefined },
): PurchaseReport {
  const suppliers = new Map(data.suppliers.suppliers.map((supplier) => [supplier.id, supplier]));
  const accounts = new Map(data.accounts.map((account) => [account.id, account]));
  const wanted = query.categoryId === undefined ? null : categoryAndBelow(data, query.categoryId);
  const lines = purchaseLines(data).flatMap((line) => {
    // An account line's product is a service, which belongs in the "Expenses" row (decision 11)
    const found =
      line.variantId === null || line.accountId !== null
        ? undefined
        : findVariant(data, line.variantId);
    const supplier = suppliers.get(line.supplierId);
    const inPeriod = line.date >= query.from && line.date <= query.to;
    const inBranch = query.branchId === undefined || line.branchId === query.branchId;
    const inGroup =
      query.supplierGroupId === undefined || supplier?.groupId === query.supplierGroupId;
    // Product lines only: an account line or an expense has no category, so it drops out
    const inCategory =
      wanted === null ||
      (found?.product.categoryId != null && wanted.has(found.product.categoryId));
    return inPeriod && inBranch && inGroup && inCategory
      ? [{ ...line, product: found?.product, supplier }]
      : [];
  });
  const groups = groupInto(lines, (line): RowIdentity => {
    if (query.groupBy === 'month') return monthRow(line.date);
    if (query.groupBy === 'product') {
      return line.product
        ? thingRow(line.product.id, line.product.code, line.product.name)
        : kindRow('expenses');
    }
    if (query.groupBy === 'account') {
      const account = line.accountId === null ? undefined : accounts.get(line.accountId);
      return account ? thingRow(account.id, account.code, account.name) : kindRow('products');
    }
    return thingRow(line.supplierId, line.supplier?.code ?? null, line.supplier?.name ?? '');
  });
  const rows = groups.map(({ identity, line, sums }): PurchaseReportRow => {
    const gross = sumMoney(sums.gross);
    const returns = sumMoney(sums.returns);
    const byProduct = query.groupBy === 'product' && identity.kind === 'item';
    return {
      ...identity,
      quantity: byProduct ? sumMoney(sums.quantity) : null,
      baseUnit: byProduct && line.product ? unitOf(data, line.product.baseUnitId) : null,
      gross,
      returns,
      net: subtractMoney(gross, returns),
    };
  });
  const gross = sumMoney(rows.map((row) => row.gross));
  const returns = sumMoney(rows.map((row) => row.returns));
  const values = (row: PurchaseReportRow, column: string): SortValue => {
    if (column === 'quantity') return row.quantity;
    if (column === 'gross') return row.gross;
    if (column === 'returns') return row.returns;
    return row.net;
  };
  return {
    ...pageOf(sorted(rows, query.sort, values), query),
    totals: { gross, returns, net: subtractMoney(gross, returns) },
  };
}

// ---------------------------------------------------------------------------------------------
// The agings

// An invoice or a bill: its total and what was applied to it, each with the day it counts from
interface OpenDocument {
  id: string;
  partyId: string;
  number: string;
  date: string;
  dueDate: string;
  total: string;
  supplierBillNumber: string;
  applied: { amount: string; on: string }[];
}

// A receipt, payment, credit note or debit note: the same with what it applied and paid back
interface AdvanceDocument<TKind> {
  id: string;
  kind: TKind;
  partyId: string;
  number: string;
  date: string;
  amount: string;
  applied: { amount: string; on: string }[];
  refunds: { amount: string; date: string; status: string; voidDate: string | null }[];
  // Still counted up to this day when voided later (the API's void_date > D); null when it is not
  voidDate: string | null;
}

interface AgingSide<TKind> {
  parties: (data: WorkspaceData) => (PartyRef & { groupId: string | null })[];
  documents: (data: WorkspaceData) => OpenDocument[];
  advances: (data: WorkspaceData) => AdvanceDocument<TKind>[];
  account: 'accounts_receivable' | 'accounts_payable';
}

function later(a: string, b: string): string {
  return a > b ? a : b;
}

const RECEIVABLES: AgingSide<ArAgingAdvance['kind']> = {
  account: 'accounts_receivable',
  parties: (data) =>
    data.sales.customers.map(({ id, code, name, groupId }) => ({
      id,
      code,
      name,
      groupId,
    })),
  documents: (data) => {
    const receipts = data.billing.receipts.filter((receipt) => receipt.status === 'posted');
    const notes = data.returns.creditNotes.filter((note) => note.status === 'posted');
    return data.billing.invoices
      .filter((invoice) => invoice.status === 'posted' && invoice.number !== null)
      .map((invoice) => ({
        id: invoice.id,
        partyId: invoice.customer.id,
        number: invoice.number ?? '',
        date: invoice.date,
        dueDate: invoice.dueDate,
        total: invoice.total,
        supplierBillNumber: '',
        applied: [...receipts, ...notes].flatMap((source) =>
          source.allocations
            .filter((allocation) => allocation.invoiceId === invoice.id)
            .map((allocation) => ({
              amount: allocation.amount,
              on: later(source.date, invoice.date),
            })),
        ),
      }));
  },
  advances: (data) => {
    const invoiceDate = new Map(data.billing.invoices.map((item) => [item.id, item.date]));
    const appliedOf = (source: {
      date: string;
      allocations: { invoiceId: string; amount: string }[];
    }) =>
      source.allocations.map((allocation) => ({
        amount: allocation.amount,
        on: later(source.date, invoiceDate.get(allocation.invoiceId) ?? source.date),
      }));
    const { refunds } = data.returns;
    return [
      ...data.billing.receipts.map((receipt): AdvanceDocument<ArAgingAdvance['kind']> => ({
        id: receipt.id,
        kind: 'receipt',
        partyId: receipt.customer.id,
        number: receipt.number,
        date: receipt.date,
        amount: receipt.amount,
        applied: appliedOf(receipt),
        refunds: refunds.filter((refund) => refund.source.id === receipt.id),
        voidDate: receipt.status === 'voided' ? receipt.voidDate : null,
      })),
      ...data.returns.creditNotes
        .filter((note) => note.status === 'posted')
        .map((note): AdvanceDocument<ArAgingAdvance['kind']> => ({
          id: note.id,
          kind: 'credit_note',
          partyId: note.customer.id,
          number: note.number ?? '',
          date: note.date,
          amount: note.total,
          applied: appliedOf(note),
          refunds: refunds.filter((refund) => refund.source.id === note.id),
          voidDate: null,
        })),
    ];
  },
};

const PAYABLES: AgingSide<ApAgingAdvance['kind']> = {
  account: 'accounts_payable',
  parties: (data) =>
    data.suppliers.suppliers.map(({ id, code, name, groupId }) => ({
      id,
      code,
      name,
      groupId,
    })),
  documents: (data) => {
    const payments = data.purchase.payments.filter((payment) => payment.status === 'posted');
    const notes = data.purchase.debitNotes.filter((note) => note.status === 'posted');
    return data.purchase.bills
      .filter((bill) => bill.status === 'posted' && bill.number !== null)
      .map((bill) => ({
        id: bill.id,
        partyId: bill.supplier.id,
        number: bill.number ?? '',
        date: bill.date,
        dueDate: bill.dueDate,
        total: bill.total,
        supplierBillNumber: bill.supplierBillNumber,
        applied: [...payments, ...notes].flatMap((source) =>
          source.allocations
            .filter((allocation) => allocation.billId === bill.id)
            .map((allocation) => ({
              amount: allocation.amount,
              on: later(source.date, bill.date),
            })),
        ),
      }));
  },
  advances: (data) => {
    const billDate = new Map(data.purchase.bills.map((item) => [item.id, item.date]));
    const appliedOf = (source: {
      date: string;
      allocations: { billId: string; amount: string }[];
    }) =>
      source.allocations.map((allocation) => ({
        amount: allocation.amount,
        on: later(source.date, billDate.get(allocation.billId) ?? source.date),
      }));
    const { refunds } = data.purchase;
    return [
      ...data.purchase.payments
        // A draft's or a pending payment's plan moves no money
        .filter((payment) => payment.status === 'posted' || payment.status === 'voided')
        .map((payment): AdvanceDocument<ApAgingAdvance['kind']> => ({
          id: payment.id,
          kind: 'payment',
          partyId: payment.supplier.id,
          number: payment.number ?? '',
          date: payment.date,
          amount: payment.amount,
          applied: appliedOf(payment),
          refunds: refunds.filter((refund) => refund.source.id === payment.id),
          voidDate: payment.status === 'voided' ? payment.voidDate : null,
        })),
      ...data.purchase.debitNotes
        .filter((note) => note.status === 'posted')
        .map((note): AdvanceDocument<ApAgingAdvance['kind']> => ({
          id: note.id,
          kind: 'debit_note',
          partyId: note.supplier.id,
          number: note.number ?? '',
          date: note.date,
          amount: note.total,
          applied: appliedOf(note),
          refunds: refunds.filter((refund) => refund.source.id === note.id),
          voidDate: null,
        })),
    ];
  },
};

function appliedBy(applied: readonly { amount: string; on: string }[], asOf: string): string {
  return sumMoney(applied.filter((item) => item.on <= asOf).map((item) => item.amount));
}

// The documents of one party with something still open on the day
function openDocuments<TKind>(data: WorkspaceData, side: AgingSide<TKind>, asOf: string) {
  return side
    .documents(data)
    .filter((document) => document.date <= asOf)
    .map((document) => ({
      ...document,
      open: subtractMoney(document.total, appliedBy(document.applied, asOf)),
    }))
    .filter((document) => !isZeroMoney(document.open));
}

// What was not applied by that day and not paid back by then (the API's voided rule: a receipt
// voided after the day still counts on it)
function openAdvances<TKind>(data: WorkspaceData, side: AgingSide<TKind>, asOf: string) {
  return side
    .advances(data)
    .filter(
      (advance) => advance.date <= asOf && (advance.voidDate === null || advance.voidDate > asOf),
    )
    .map((advance) => ({
      ...advance,
      left: subtractMoney(
        subtractMoney(advance.amount, appliedBy(advance.applied, asOf)),
        sumMoney(
          advance.refunds
            .filter(
              (refund) =>
                refund.date <= asOf &&
                (refund.status === 'posted' || (refund.voidDate ?? '') > asOf),
            )
            .map((refund) => refund.amount),
        ),
      ),
    }))
    .filter((advance) => compareMoney(advance.left, '0') > 0);
}

// The account's balance on the day, in the report's sense, with the same parties as the report
function ledgerOf<TKind>(
  data: WorkspaceData,
  side: AgingSide<TKind>,
  asOf: string,
  keepParty: (partyId: string | null) => boolean,
): string {
  const accountId = data.accounts.find((account) => account.purpose === side.account)?.id;
  return sumMoney(
    data.journal.entries
      .filter((entry) => entry.status === 'posted' && entry.date <= asOf)
      .flatMap((entry) => entry.lines)
      .filter((line) => line.accountId === accountId && keepParty(line.party?.id ?? null))
      .map((line) =>
        side.account === 'accounts_receivable'
          ? subtractMoney(line.debit, line.credit)
          : subtractMoney(line.credit, line.debit),
      ),
  );
}

function zeroAmounts(): AgingAmounts {
  return agingAmountsOf([], [], '2000-01-01');
}

function addAmounts(a: AgingAmounts, b: AgingAmounts): AgingAmounts {
  return {
    current: addMoney(a.current, b.current),
    days1To30: addMoney(a.days1To30, b.days1To30),
    days31To60: addMoney(a.days31To60, b.days31To60),
    days61To90: addMoney(a.days61To90, b.days61To90),
    over90: addMoney(a.over90, b.over90),
    due: addMoney(a.due, b.due),
    advances: addMoney(a.advances, b.advances),
    balance: addMoney(a.balance, b.balance),
  };
}

// The amount a sort names; a sort that matches none is the balance, the report's default
function amountOf(row: AgingAmounts, column: string): string {
  for (const [name, value] of Object.entries(row)) {
    if (name === column) return value;
  }
  return row.balance;
}

function agingReport<TKind>(
  data: WorkspaceData,
  side: AgingSide<TKind>,
  query: {
    asOf: string;
    show: 'all' | 'overdue';
    sort: AgingSort;
    groupId: string | undefined;
    limit: number;
    cursor?: string | undefined;
  },
): AgingReport {
  const { asOf, groupId } = query;
  const parties = side
    .parties(data)
    .filter((party) => groupId === undefined || party.groupId === groupId);
  const documents = openDocuments(data, side, asOf);
  const advances = openAdvances(data, side, asOf);
  const rows = parties.flatMap((party): (RowIdentity & { row: AgingRow })[] => {
    const own = documents.filter((document) => document.partyId === party.id);
    const money = advances.filter((advance) => advance.partyId === party.id).map((a) => a.left);
    if (own.length === 0 && money.length === 0) return [];
    const amounts = agingAmountsOf(own, money, asOf);
    if (query.show === 'overdue' && isZeroMoney(subtractMoney(amounts.due, amounts.current))) {
      return [];
    }
    return [
      {
        ...thingRow(party.id, party.code, party.name),
        row: { ...amounts, party: { id: party.id, code: party.code, name: party.name } },
      },
    ];
  });
  const groupIds = new Set(parties.map((party) => party.id));
  const page = pageOf(
    sorted(rows, query.sort, ({ row }, column) => amountOf(row, column)),
    query,
  );
  return {
    items: page.items.map(({ row }) => row),
    nextCursor: page.nextCursor,
    asOf,
    totals: rows.map(({ row }) => row).reduce<AgingAmounts>(addAmounts, zeroAmounts()),
    ledger:
      query.show === 'overdue'
        ? null
        : ledgerOf(
            data,
            side,
            asOf,
            (partyId) => groupId === undefined || (partyId !== null && groupIds.has(partyId)),
          ),
  };
}

export function arAgingOf(
  data: WorkspaceData,
  query: ArAgingFilter & { limit: number; cursor?: string | undefined },
): AgingReport {
  return agingReport(data, RECEIVABLES, { ...query, groupId: query.customerGroupId });
}

export function apAgingOf(
  data: WorkspaceData,
  query: ApAgingFilter & { limit: number; cursor?: string | undefined },
): AgingReport {
  return agingReport(data, PAYABLES, { ...query, groupId: query.supplierGroupId });
}

// A party's page: its row, its documents the oldest due date first, its advances the oldest first
function partyPage<TKind>(
  data: WorkspaceData,
  side: AgingSide<TKind>,
  partyId: string,
  asOf: string,
) {
  const party = side.parties(data).find((candidate) => candidate.id === partyId);
  if (!party) throw new MockProblem(404, 'not_found');
  const documents = openDocuments(data, side, asOf)
    .filter((document) => document.partyId === partyId)
    .toSorted((a, b) => a.dueDate.localeCompare(b.dueDate));
  const advances = openAdvances(data, side, asOf)
    .filter((advance) => advance.partyId === partyId)
    .toSorted((a, b) => a.date.localeCompare(b.date));
  return {
    asOf,
    party: { id: party.id, code: party.code, name: party.name },
    totals: agingAmountsOf(
      documents,
      advances.map((advance) => advance.left),
      asOf,
    ),
    ledger: ledgerOf(data, side, asOf, (id) => id === partyId),
    documents: documents.map((document) => ({
      id: document.id,
      number: document.number,
      date: document.date,
      dueDate: document.dueDate,
      total: document.total,
      open: document.open,
      daysOverdue: daysOverdue(document.dueDate, asOf),
      bucket: agingBucketOf(document.dueDate, asOf),
      supplierBillNumber: document.supplierBillNumber,
    })),
    advances: advances.map((advance) => ({
      id: advance.id,
      kind: advance.kind,
      number: advance.number,
      date: advance.date,
      amount: advance.left,
    })),
  };
}

export function arAgingPartyOf(
  data: WorkspaceData,
  customerId: string,
  asOf: string,
): ArAgingParty {
  return partyPage(data, RECEIVABLES, customerId, asOf);
}

export function apAgingPartyOf(
  data: WorkspaceData,
  supplierId: string,
  asOf: string,
): ApAgingParty {
  return partyPage(data, PAYABLES, supplierId, asOf);
}
