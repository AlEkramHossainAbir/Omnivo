import {
  addMoney,
  compareMoney,
  isZeroMoney,
  negateMoney,
  STOCK_MOVEMENT_COLUMN_OF,
  type StockMovementColumn,
  type StockMovementFilter,
  type StockMovementReport,
  type StockMovementRow,
  subtractMoney,
  sumMoney,
  TAX_RATE_KINDS,
  type TaxRateKind,
  type TaxRateRef,
  type VatDocument,
  type VatDocumentPage,
  type VatReport,
  type VatReportFilter,
  type VatReportRow,
  type VatReportSide,
} from '@omnivo/contracts';

import { pageOf } from './sales-document-data';
import { branchOf } from './stock-data';
import { categoryAndBelow } from './trade-report-data';
import type { WorkspaceData } from './workspace-data';

// Step 21c: the VAT report and the stock movement report on the mock's arrays. The API's rules
// (vat-queries.ts, stock-movement-queries.ts) written again, like the 21b reports
// (trade-report-data.ts), so a sale posted in `pnpm dev:mock` or in a Playwright test shows in
// the reports at once.

// ---------------------------------------------------------------------------------------------
// VAT

interface VatLine {
  side: VatReportSide;
  kind: VatDocument['kind'];
  docId: string;
  number: string;
  date: string;
  partyName: string | null;
  partyBin: string | null;
  branchId: string | null;
  // A bill's Mushak 6.3, a debit note's 6.7
  mushak: string | null;
  // A credit note, a POS return or a debit note: it takes VAT off
  returned: boolean;
  rate: TaxRateRef;
  net: string;
  vat: string;
}

// A line as the API's vatLines() gives it: what takes off is negative
interface LineSource {
  taxRate: TaxRateRef;
  net: string;
  vat: string;
}

type Document = Omit<VatLine, 'rate' | 'net' | 'vat'>;

function linesOf(document: Document, lines: readonly LineSource[]): VatLine[] {
  return lines.map((line) => ({
    ...document,
    rate: line.taxRate,
    net: document.returned ? negateMoney(line.net) : line.net,
    vat: document.returned ? negateMoney(line.vat) : line.vat,
  }));
}

// Every line with VAT in the period (decision 1), signed, with its document's branch (decision 19)
function vatLines(data: WorkspaceData, from: string, to: string): VatLine[] {
  const inPeriod = (date: string) => date >= from && date <= to;
  const customers = new Map(data.sales.customers.map((item) => [item.id, item]));
  const suppliers = new Map(data.suppliers.suppliers.map((item) => [item.id, item]));
  const customer = (id: string | null | undefined) =>
    id === null || id === undefined ? undefined : customers.get(id);
  const supplier = (id: string) => suppliers.get(id);
  const sales = new Map(data.pos.sales.map((sale) => [sale.id, sale]));

  const invoices = data.billing.invoices
    .filter((item) => item.status === 'posted' && inPeriod(item.date))
    .flatMap((item) =>
      linesOf(
        {
          side: 'output',
          kind: 'invoice',
          docId: item.id,
          number: item.number ?? '',
          date: item.date,
          partyName: customer(item.customer.id)?.name ?? null,
          partyBin: customer(item.customer.id)?.bin ?? null,
          branchId: item.branchId,
          mushak: null,
          returned: false,
        },
        item.lines,
      ),
    );
  const posSales = data.pos.sales
    .filter((item) => inPeriod(item.date))
    .flatMap((item) =>
      linesOf(
        {
          side: 'output',
          kind: 'pos_sale',
          docId: item.id,
          number: item.number,
          date: item.date,
          partyName: customer(item.customer?.id)?.name ?? null,
          partyBin: customer(item.customer?.id)?.bin ?? null,
          branchId: branchOf(data, item.warehouseId),
          mushak: null,
          returned: false,
        },
        item.lines,
      ),
    );
  // A credit note counts in its invoice's branch, which is its own branchId
  const creditNotes = data.returns.creditNotes
    .filter((item) => item.status === 'posted' && inPeriod(item.date))
    .flatMap((item) =>
      linesOf(
        {
          side: 'output',
          kind: 'credit_note',
          docId: item.id,
          number: item.number ?? '',
          date: item.date,
          partyName: customer(item.customer.id)?.name ?? null,
          partyBin: customer(item.customer.id)?.bin ?? null,
          branchId: item.branchId,
          mushak: null,
          returned: true,
        },
        item.lines,
      ),
    );
  // A POS return line has no rate of its own: it is the sale line's
  const posReturns = data.pos.returns
    .filter((item) => inPeriod(item.date))
    .flatMap((item) => {
      const sale = sales.get(item.saleId);
      if (!sale) return [];
      const document: Document = {
        side: 'output',
        kind: 'pos_return',
        docId: item.id,
        number: item.number,
        date: item.date,
        partyName: customer(sale.customer?.id)?.name ?? null,
        partyBin: customer(sale.customer?.id)?.bin ?? null,
        branchId: branchOf(data, item.warehouseId),
        mushak: null,
        returned: true,
      };
      return item.lines.flatMap((line) => {
        const sold = sale.lines.find((candidate) => candidate.id === line.saleLineId);
        return sold
          ? linesOf(document, [{ taxRate: sold.taxRate, net: line.net, vat: line.vat }])
          : [];
      });
    });
  const bills = data.purchase.bills
    .filter((item) => item.status === 'posted' && inPeriod(item.date))
    .flatMap((item) =>
      linesOf(
        {
          side: 'input',
          kind: 'bill',
          docId: item.id,
          number: item.number ?? '',
          date: item.date,
          partyName: supplier(item.supplier.id)?.name ?? null,
          partyBin: supplier(item.supplier.id)?.bin ?? null,
          branchId: item.branchId,
          mushak: item.mushakNumber,
          returned: false,
        },
        [...item.lines, ...item.expenses],
      ),
    );
  const debitNotes = data.purchase.debitNotes
    .filter((item) => item.status === 'posted' && inPeriod(item.date))
    .flatMap((item) =>
      linesOf(
        {
          side: 'input',
          kind: 'debit_note',
          docId: item.id,
          number: item.number ?? '',
          date: item.date,
          partyName: supplier(item.supplier.id)?.name ?? null,
          partyBin: supplier(item.supplier.id)?.bin ?? null,
          branchId: item.branchId,
          mushak: item.supplierCreditNumber,
          returned: true,
        },
        [...item.lines, ...item.expenses],
      ),
    );
  return [...invoices, ...posSales, ...creditNotes, ...posReturns, ...bills, ...debitNotes];
}

function inBranch(lines: readonly VatLine[], branchId: string | undefined): VatLine[] {
  return branchId === undefined ? [...lines] : lines.filter((line) => line.branchId === branchId);
}

// A line's rate kind as the contract's enum; a kind this mock does not know sorts last
function kindOf(kind: string): TaxRateKind {
  return TAX_RATE_KINDS.find((item) => item === kind) ?? 'exempt';
}

// The order of a return (decision 15): standard first, then reduced, zero-rated, exempt; the
// highest rate first; then the name and the id
function byReturnOrder(a: VatReportRow, b: VatReportRow): number {
  return (
    TAX_RATE_KINDS.indexOf(a.kind) - TAX_RATE_KINDS.indexOf(b.kind) ||
    compareMoney(b.rate, a.rate) ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
    a.taxRateId.localeCompare(b.taxRateId)
  );
}

function sideSum(lines: readonly VatLine[], side: VatReportSide, field: 'net' | 'vat'): string {
  return sumMoney(lines.filter((line) => line.side === side).map((line) => line[field]));
}

// What the books moved on the VAT accounts in the period and branch (the API's booksVat)
function booksVat(data: WorkspaceData, filter: VatReportFilter): VatReport['books'] {
  const purposeOf = new Map(data.accounts.map((account) => [account.id, account.purpose]));
  const lines = data.journal.entries
    .filter(
      (entry) => entry.status === 'posted' && entry.date >= filter.from && entry.date <= filter.to,
    )
    .flatMap((entry) => entry.lines)
    .filter((line) => filter.branchId === undefined || line.branchId === filter.branchId);
  const on = (purpose: string) => lines.filter((line) => purposeOf.get(line.accountId) === purpose);
  return {
    output: sumMoney(on('vat_output').map((line) => subtractMoney(line.credit, line.debit))),
    input: sumMoney(on('vat_input').map((line) => subtractMoney(line.debit, line.credit))),
  };
}

export function vatReportOf(data: WorkspaceData, filter: VatReportFilter): VatReport {
  const lines = inBranch(vatLines(data, filter.from, filter.to), filter.branchId);

  // One row per rate, kind and percent (decision 14), named by its latest line
  const groups = new Map<string, VatLine[]>();
  for (const line of lines) {
    const key = `${line.rate.id}:${kindOf(line.rate.kind)}:${line.rate.rate}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const rows = [...groups].map(([key, group]): VatReportRow => {
    const latest = group.toSorted(
      (a, b) => b.date.localeCompare(a.date) || b.docId.localeCompare(a.docId),
    )[0];
    const outputVat = sideSum(group, 'output', 'vat');
    const inputVat = sideSum(group, 'input', 'vat');
    return {
      key,
      taxRateId: latest?.rate.id ?? '',
      name: latest?.rate.name ?? '',
      kind: kindOf(latest?.rate.kind ?? ''),
      rate: latest?.rate.rate ?? '0',
      outputNet: sideSum(group, 'output', 'net'),
      outputVat,
      inputNet: sideSum(group, 'input', 'net'),
      inputVat,
      netVat: subtractMoney(outputVat, inputVat),
    };
  });

  const returned = (side: VatReportSide) =>
    negateMoney(
      sumMoney(lines.filter((line) => line.side === side && line.returned).map((line) => line.vat)),
    );
  const outputVat = sideSum(lines, 'output', 'vat');
  const inputVat = sideSum(lines, 'input', 'vat');
  return {
    rows: rows.toSorted(byReturnOrder),
    totals: {
      outputNet: sideSum(lines, 'output', 'net'),
      outputVat,
      outputVatReturned: returned('output'),
      inputNet: sideSum(lines, 'input', 'net'),
      inputVat,
      inputVatReturned: returned('input'),
      // Bills only, before the debit notes (decision 17)
      inputVatWithoutMushak: sumMoney(
        lines
          .filter((line) => line.kind === 'bill' && line.mushak === null)
          .map((line) => line.vat),
      ),
      netVat: subtractMoney(outputVat, inputVat),
    },
    books: booksVat(data, filter),
  };
}

// The documents behind one side, oldest first (decision 18): one row per document
export function vatDocumentsOf(
  data: WorkspaceData,
  query: VatReportFilter & { side: VatReportSide; limit: number; cursor?: string | undefined },
): VatDocumentPage {
  const lines = inBranch(vatLines(data, query.from, query.to), query.branchId).filter(
    (line) => line.side === query.side,
  );
  const documents = new Map<string, VatDocument>();
  for (const line of lines) {
    const found = documents.get(line.docId);
    documents.set(
      line.docId,
      found
        ? { ...found, net: addMoney(found.net, line.net), vat: addMoney(found.vat, line.vat) }
        : {
            kind: line.kind,
            id: line.docId,
            number: line.number,
            date: line.date,
            partyName: line.partyName,
            partyBin: line.partyBin,
            mushakNumber: line.mushak,
            net: line.net,
            vat: line.vat,
          },
    );
  }
  const sorted = [...documents.values()].toSorted(
    (a, b) =>
      a.date.localeCompare(b.date) || a.number.localeCompare(b.number) || a.id.localeCompare(b.id),
  );
  return pageOf(sorted, query);
}

// ---------------------------------------------------------------------------------------------
// Stock movement

type Columns = Record<StockMovementColumn, string>;

interface Moves {
  opening: string;
  openingValue: string;
  closing: string;
  closingValue: string;
  columns: Columns;
  moved: boolean;
}

function noColumns(): Columns {
  return { purchased: '0', sold: '0', transfers: '0', adjusted: '0' };
}

// The number columns' values to sort by. A value sort is refused before this without
// inventory.stock.value (the handler), like the API's service (decision 24).
const SORT_VALUE = {
  opening: (row) => row.opening,
  purchased: (row) => row.purchased,
  sold: (row) => row.sold,
  transfers: (row) => row.transfers,
  adjusted: (row) => row.adjusted,
  closing: (row) => row.closing,
  openingValue: (row) => row.openingValue,
  closingValue: (row) => row.closingValue,
} satisfies Record<string, (row: StockMovementRow) => string | null>;

function isSortColumn(column: string): column is keyof typeof SORT_VALUE {
  return column in SORT_VALUE;
}

// The mock's ledger starts at the beginning, so it adds the movements up from there, where the
// API works back from what each variant holds now (decision 5). Both give the same numbers.
export function stockMovementOf(
  data: WorkspaceData,
  query: StockMovementFilter & { limit: number; cursor?: string | undefined },
  withValue: boolean,
): StockMovementReport {
  const { from, to } = query;
  const byVariant = new Map<string, Moves>();
  for (const movement of data.stock.movements) {
    if (movement.date > to) continue;
    if (query.warehouseId !== undefined && movement.warehouseId !== query.warehouseId) continue;
    const moves = byVariant.get(movement.variantId) ?? {
      opening: '0',
      openingValue: '0',
      closing: '0',
      closingValue: '0',
      columns: noColumns(),
      moved: false,
    };
    moves.closing = addMoney(moves.closing, movement.quantity);
    moves.closingValue = addMoney(moves.closingValue, movement.value);
    if (movement.date < from) {
      moves.opening = addMoney(moves.opening, movement.quantity);
      moves.openingValue = addMoney(moves.openingValue, movement.value);
    } else {
      // A revaluation counts as a movement: it moved the value
      moves.moved = true;
      const column = STOCK_MOVEMENT_COLUMN_OF[movement.kind];
      if (column !== null) {
        // "sold" turned round: stock that left is positive there (decision 21)
        const quantity = column === 'sold' ? negateMoney(movement.quantity) : movement.quantity;
        moves.columns[column] = addMoney(moves.columns[column], quantity);
      }
    }
    byVariant.set(movement.variantId, moves);
  }

  const wanted = query.categoryId === undefined ? null : categoryAndBelow(data, query.categoryId);
  const units = new Map(data.catalog.units.map((unit) => [unit.id, unit]));
  const rows: { row: StockMovementRow; position: number }[] = [];
  for (const product of data.catalog.products) {
    if (wanted !== null && (product.categoryId === null || !wanted.has(product.categoryId))) {
      continue;
    }
    const unit = units.get(product.baseUnitId);
    for (const [position, variant] of product.variants.entries()) {
      const moves = byVariant.get(variant.id);
      // decision 22: 'moved' = a movement in the period; 'all' adds what had stock at the start
      if (!moves || !(moves.moved || (query.show === 'all' && !isZeroMoney(moves.opening)))) {
        continue;
      }
      rows.push({
        position,
        row: {
          variantId: variant.id,
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          optionValues: variant.optionValues,
          sku: variant.sku,
          baseUnitId: product.baseUnitId,
          baseUnit: { code: unit?.code ?? '', decimals: unit?.decimals ?? 0 },
          opening: moves.opening,
          ...moves.columns,
          closing: moves.closing,
          openingValue: withValue ? moves.openingValue : null,
          closingValue: withValue ? moves.closingValue : null,
        },
      });
    }
  }

  // The sort's column, then the name in any case, the product and the variant's place
  const direction = query.sort.startsWith('-') ? -1 : 1;
  const column = query.sort.replace(/^-/, '');
  const byName = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    a.row.productName.toLowerCase().localeCompare(b.row.productName.toLowerCase()) ||
    a.row.productId.localeCompare(b.row.productId) ||
    a.position - b.position;
  const textOf = (item: (typeof rows)[number]) =>
    (column === 'sku' ? item.row.sku : item.row.productName).toLowerCase();
  const ordered = rows.toSorted((a, b) => {
    if (column === 'name' || column === 'sku') {
      return direction * textOf(a).localeCompare(textOf(b)) || byName(a, b);
    }
    const valueOf = isSortColumn(column) ? SORT_VALUE[column] : () => null;
    const [left, right] = [valueOf(a.row), valueOf(b.row)];
    const compared = left === null || right === null ? 0 : direction * compareMoney(left, right);
    return compared || byName(a, b);
  });

  const page = pageOf(ordered, query);
  const total = (field: 'openingValue' | 'closingValue') =>
    withValue ? sumMoney(rows.map((item) => item.row[field] ?? '0')) : null;
  return {
    items: page.items.map((item) => item.row),
    nextCursor: page.nextCursor,
    withValue,
    totals: {
      variants: rows.length,
      openingValue: total('openingValue'),
      closingValue: total('closingValue'),
    },
  };
}
