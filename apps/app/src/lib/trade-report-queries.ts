import {
  type AgingPartyQuery,
  type ApAgingFilter,
  type ArAgingFilter,
  type PurchaseReportFilter,
  routes,
  type SalesReportFilter,
  type StockMovementFilter,
  type VatReportFilter,
  type VatReportSide,
} from '@omnivo/contracts';
import type { SortingState } from '@omnivo/ui';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';

// Step 21b: the queries of the sales and purchase reports and of the two agings. Their own module,
// not lib/queries.ts: that file is in the first chunk every page loads, and these are read only by
// the four lazy report pages (the first chunk is a few KB under its budget).
//
// Every key starts with ['journal', tenantId] like the statements' (step 11): posting an invoice, a
// bill or a receipt invalidates that prefix, so an open report fetches its numbers again.

// 50 rows a page, like the other long lists. The API's cursor is opaque here (it holds an offset).
const PAGE = 50;

export function salesReportQuery(tenantId: string, filter: SalesReportFilter) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'sales-report', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.tradeReports.sales, {
        query: { ...filter, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    // A new filter keeps the old rows and totals on screen until its own arrive, instead of an
    // empty table that jumps
    placeholderData: keepPreviousData,
  });
}

export function purchaseReportQuery(tenantId: string, filter: PurchaseReportFilter) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'purchase-report', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.tradeReports.purchases, {
        query: { ...filter, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function arAgingQuery(tenantId: string, filter: ArAgingFilter) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'ar-aging', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.aging.receivables, {
        query: { ...filter, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function apAgingQuery(tenantId: string, filter: ApAgingFilter) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'ap-aging', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.aging.payables, {
        query: { ...filter, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

// Step 21c: the VAT report's summary (one answer: a few rates) and its documents, one side at a
// time, paged. Under 'journal' like the rest: posting an invoice or a bill moves the VAT.
export function vatReportQuery(tenantId: string, filter: VatReportFilter) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'vat-report', filter],
    queryFn: () => call(routes.vatReport.summary, { query: filter }),
    placeholderData: keepPreviousData,
  });
}

export function vatDocumentsQuery(tenantId: string, filter: VatReportFilter, side: VatReportSide) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'vat-report', 'documents', side, filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.vatReport.documents, {
        query: { ...filter, side, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

// Step 21c: the stock movement report. Every stock document writes a journal entry (step 14), so
// the 'journal' prefix refreshes it after a delivery, a receipt or an adjustment too.
export function stockMovementQuery(tenantId: string, filter: StockMovementFilter) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'stock-movement', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.stockMovementReport.report, {
        query: { ...filter, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

// One party's page is not paged (the contract's agingPartyShape): a party's open documents fit
export function arAgingPartyQuery(tenantId: string, customerId: string, query: AgingPartyQuery) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'ar-aging', 'party', customerId, query],
    queryFn: () => call(routes.aging.receivablesOf, { params: { customerId }, query }),
    placeholderData: keepPreviousData,
  });
}

export function apAgingPartyQuery(tenantId: string, supplierId: string, query: AgingPartyQuery) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'ap-aging', 'party', supplierId, query],
    queryFn: () => call(routes.aging.payablesOf, { params: { supplierId }, query }),
    placeholderData: keepPreviousData,
  });
}

// The table's sort ([{ id: 'net', desc: true }]) as the API's sort ('-net'). A column's id is the
// sort's name, so one function serves the four reports. A sort the report does not have (a column
// the table no longer shows) falls back to the report's default instead of a 400.
export function sortOf<TSort extends string>(
  state: SortingState,
  sorts: readonly TSort[],
  fallback: TSort,
): TSort {
  const [first] = state;
  if (!first) return fallback;
  const wanted = first.desc ? `-${first.id}` : first.id;
  return sorts.find((sort) => sort === wanted) ?? fallback;
}

// The other way: the table's arrow for the sort the page asks with
export function sortingOf(sort: string): SortingState {
  return sort.startsWith('-') ? [{ id: sort.slice(1), desc: true }] : [{ id: sort, desc: false }];
}
