import {
  type BalanceSheetQuery,
  type BranchStatus,
  type JournalStatus,
  type MemberSort,
  type ProductSort,
  type ProductStatus,
  type ProfitAndLossQuery,
  routes,
  type StockDocumentStatus,
  type StockFilter,
  type TransferStatus,
  type TrialBalanceQuery,
  type WarehouseStatus,
} from '@omnivo/contracts';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';

// কয়েকটা পেজ একই settings চায় (টাইমজোন, অর্থবছর) — key আর আনার নিয়ম এক জায়গায়, তাই একবার আনা
// ডেটা সবাই ক্যাশ থেকে পায়, আর সেভের পরে এক জায়গায় হালনাগাদ করলেই সব পেজে নতুন মান
export function settingsQuery(tenantId: string) {
  return queryOptions({
    // tenantId key-তে: workspace বদলালে আগের কোম্পানির settings এই key-তে কখনো মেলে না
    queryKey: ['settings', tenantId],
    queryFn: () => call(routes.settings.get),
  });
}

// রোলের তালিকা তিন জায়গায়: রোলের পেজ (matrix), invite-এর ফর্ম আর সদস্যের রোল বদলানোর ফর্ম।
// একই key — matrix সেভ করলে invite-এর ফর্মও নতুন permission-সংখ্যা দেখায়
export function rolesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['roles', tenantId],
    queryFn: async () => (await call(routes.roles.list)).items,
  });
}

export function invitationsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['invitations', tenantId],
    queryFn: async () => (await call(routes.invitations.list)).items,
    // The worker sends the email a moment after the API answers. While any invitation is still
    // "sending", ask again every 2 seconds, so "Sending" turns into "Sent" (or "Email not sent")
    // by itself. When none is sending, stop: false turns the polling off.
    refetchInterval: (query) =>
      query.state.data?.some((invitation) => invitation.delivery === 'sending') ? 2_000 : false,
  });
}

// The chart of accounts: the tree on its page, the count in the wizard, and from step 10 every
// account picker. An empty chart is still being made by the worker (a new workspace, or step 9's
// backfill for an old one), so while it is empty, ask again every 3 seconds until it arrives.
export function accountsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['accounts', tenantId],
    queryFn: async () => (await call(routes.accounts.list)).items,
    refetchInterval: (query) => (query.state.data?.length === 0 ? 3_000 : false),
  });
}

// The wizard's view of the background setup job. Polls every 1.5 seconds while the job runs, and
// stops as soon as the status is final (ready or failed).
export function setupQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['setup', tenantId],
    queryFn: () => call(routes.setup.get),
    refetchInterval: (query) => (query.state.data?.status === 'provisioning' ? 1_500 : false),
  });
}

// The bell's badge. Polled every 30 seconds — only while the tab is visible (TanStack's default:
// refetchIntervalInBackground is false), so a tab left open overnight sends nothing. Coming back
// to the tab refetches at once (refetchOnWindowFocus).
export function unreadCountQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['notifications', tenantId, 'unread-count'],
    queryFn: async () => (await call(routes.notifications.unreadCount)).count,
    refetchInterval: 30_000,
    // Fresh on every poll; the global 30-second staleTime would otherwise skip the focus refetch
    staleTime: 0,
  });
}

// The newest 20, for the bell's panel. Same key prefix as the count: one invalidate refreshes both.
export function notificationsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['notifications', tenantId, 'latest'],
    queryFn: async () => (await call(routes.notifications.list, { query: { limit: 20 } })).items,
    staleTime: 0,
  });
}

// ধাপ ৫-এ ড্যাশবোর্ডে ছিল; এখন টিমের পেজে, আর সদস্য বদলালে এই key-র সব পাতা invalidate
export function membersQuery(tenantId: string, sort: MemberSort) {
  return infiniteQueryOptions({
    // tenantId key-তে: workspace বদলালে আগের টেন্যান্টের পাতা এই key-তে কখনো মিলবে না
    queryKey: ['members', tenantId, sort],
    // pageParam-এর টাইপ লেখা: শুধু initialPageParam: null থেকে TanStack ভাবত পাতার cursor সবসময়
    // null, আর getNextPageParam-এর string মেলাত না। এখান থেকে সে string | null শেখে — cast ছাড়া
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.members.list, {
        query: { sort, limit: 50, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    // null = শেষ পাতা; TanStack তখন hasNextPage = false
    getNextPageParam: (page) => page.nextCursor,
    // sort বদলালে নতুন key — নতুন পাতা আসা পর্যন্ত আগেরটা দেখানো, টেবিল ফাঁকা হয়ে ঝলকায় না
    placeholderData: keepPreviousData,
  });
}

// The branches page lists them; from step 10 every journal line can pick one. One key for both, so
// a branch added on its page shows up in the line's select at once.
export function branchesQuery(tenantId: string, status: BranchStatus) {
  return queryOptions({
    queryKey: ['branches', tenantId, status],
    queryFn: async () => (await call(routes.branches.list, { query: { status } })).items,
  });
}

// Everything the journal shows starts with ['journal', tenantId]: posting or reversing one entry
// invalidates the list, the entry, the ledgers and the opening balances with one call
export function journalListQuery(tenantId: string, status: JournalStatus | undefined) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'list', status ?? 'all'],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.journal.list, {
        query: {
          limit: 50,
          ...(status !== undefined && { status }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function journalEntryQuery(tenantId: string, entryId: string) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'entry', entryId],
    queryFn: () => call(routes.journal.get, { params: { id: entryId } }),
    // A missing entry (a deleted draft) is an answer, not a network hiccup: no retries
    retry: false,
  });
}

export function ledgerQuery(tenantId: string, accountId: string, from: string, to: string) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'ledger', accountId, from, to],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.ledger.get, {
        params: { id: accountId },
        query: {
          limit: 100,
          ...(from !== '' && { from }),
          ...(to !== '' && { to }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function openingBalancesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'opening-balances'],
    queryFn: () => call(routes.openingBalances.get),
  });
}

export function periodLockQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'period-lock'],
    queryFn: () => call(routes.periodLock.get),
  });
}

// The reports read the journal, so they live under ['journal', tenantId] too: posting, reversing
// or closing a year refreshes every open report. keepPreviousData: changing a date keeps the old
// numbers on screen until the new ones arrive, instead of an empty table in between.
export function trialBalanceQuery(tenantId: string, query: TrialBalanceQuery) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'trial-balance', query],
    queryFn: () => call(routes.reports.trialBalance, { query }),
    placeholderData: keepPreviousData,
  });
}

export function profitAndLossQuery(tenantId: string, query: ProfitAndLossQuery) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'profit-and-loss', query],
    queryFn: () => call(routes.reports.profitAndLoss, { query }),
    placeholderData: keepPreviousData,
  });
}

export function balanceSheetQuery(tenantId: string, query: BalanceSheetQuery) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'balance-sheet', query],
    queryFn: () => call(routes.reports.balanceSheet, { query }),
    placeholderData: keepPreviousData,
  });
}

export function fiscalYearsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'fiscal-years'],
    queryFn: () => call(routes.fiscalYears.list),
  });
}

// "My exports". The worker writes a file a few seconds after the click: while any export is still
// being prepared, ask again every 2 seconds, and stop once none is (like the invitations' email).
export function reportExportsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['report-exports', tenantId],
    queryFn: async () => (await call(routes.reportExports.list, { query: { limit: 50 } })).items,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === 'pending') ? 2_000 : false,
  });
}

// ---------------------------------------------------------------------------------------------
// Products (step 12). Everything starts with ['products', tenantId]: saving a unit, a category or a
// product refreshes every product page with one invalidate.

// Small lists, read whole. While the catalog job of an older workspace has not run yet, the units
// are empty: ask again every 3 seconds until they arrive, like the chart of accounts.
export function unitsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['products', tenantId, 'units'],
    queryFn: async () => (await call(routes.units.list)).items,
    refetchInterval: (query) => (query.state.data?.length === 0 ? 3_000 : false),
  });
}

export function productCategoriesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['products', tenantId, 'categories'],
    queryFn: async () => (await call(routes.productCategories.list)).items,
  });
}

export function productFieldsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['products', tenantId, 'custom-fields'],
    queryFn: async () =>
      (await call(routes.customFields.list, { query: { entity: 'product' } })).items,
  });
}

export interface ProductFilter {
  search: string;
  categoryId: string;
  status: ProductStatus;
  sort: ProductSort;
}

// The list, 50 at a time; the server searches, filters and sorts (10,000 products never come to
// the browser at once)
export function productListQuery(tenantId: string, filter: ProductFilter) {
  return infiniteQueryOptions({
    queryKey: ['products', tenantId, 'list', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.products.list, {
        query: {
          limit: 50,
          status: filter.status,
          sort: filter.sort,
          ...(filter.search !== '' && { search: filter.search }),
          ...(filter.categoryId !== '' && { categoryId: filter.categoryId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function productQuery(tenantId: string, productId: string) {
  return queryOptions({
    queryKey: ['products', tenantId, 'product', productId],
    queryFn: () => call(routes.products.get, { params: { id: productId } }),
    retry: false,
  });
}

// The imports, polled every 2 seconds while one is still on its way (like the exports)
export function productImportsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['products', tenantId, 'imports'],
    queryFn: async () => (await call(routes.productImports.list, { query: { limit: 50 } })).items,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === 'uploading' || item.status === 'queued')
        ? 2_000
        : false,
  });
}

export function productImportQuery(tenantId: string, importId: string) {
  return queryOptions({
    queryKey: ['products', tenantId, 'imports', importId],
    queryFn: () => call(routes.productImports.get, { params: { id: importId } }),
  });
}

// ---------------------------------------------------------------------------------------------
// Warehouses and stock (step 13). Every stock query starts with ['stock', tenantId]: posting an
// adjustment or a transfer changes the stock list, the cards, the reports and the documents, and
// one invalidate refreshes them all.

// The warehouses page lists them; every stock page and form picks from them
export function warehousesQuery(tenantId: string, status: WarehouseStatus) {
  return queryOptions({
    queryKey: ['warehouses', tenantId, status],
    queryFn: async () => (await call(routes.warehouses.list, { query: { status } })).items,
  });
}

export interface StockListFilter {
  search: string;
  warehouseId: string;
  categoryId: string;
  filter: StockFilter;
}

export function stockListQuery(tenantId: string, filter: StockListFilter) {
  return infiniteQueryOptions({
    queryKey: ['stock', tenantId, 'list', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.stock.list, {
        query: {
          limit: 50,
          filter: filter.filter,
          ...(filter.search !== '' && { search: filter.search }),
          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
          ...(filter.categoryId !== '' && { categoryId: filter.categoryId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

// The "Add items" search of a document form: the first 20 matches, with the stock in the form's
// warehouse
export function stockSearchQuery(tenantId: string, search: string, warehouseId: string) {
  return queryOptions({
    queryKey: ['stock', tenantId, 'search', warehouseId, search],
    queryFn: async () =>
      (
        await call(routes.stock.list, {
          query: {
            limit: 20,
            filter: 'all',
            ...(search !== '' && { search }),
            ...(warehouseId !== '' && { warehouseId }),
          },
        })
      ).items,
    placeholderData: keepPreviousData,
  });
}

export function stockCardQuery(tenantId: string, variantId: string) {
  return queryOptions({
    queryKey: ['stock', tenantId, 'card', variantId],
    queryFn: () => call(routes.stock.card, { params: { id: variantId } }),
    retry: false,
  });
}

export function stockMovementsQuery(
  tenantId: string,
  variantId: string,
  filter: { warehouseId: string; from: string; to: string },
) {
  return infiniteQueryOptions({
    queryKey: ['stock', tenantId, 'movements', variantId, filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.stock.movements, {
        params: { id: variantId },
        query: {
          limit: 100,
          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
          ...(filter.from !== '' && { from: filter.from }),
          ...(filter.to !== '' && { to: filter.to }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function batchStockQuery(
  tenantId: string,
  filter: { warehouseId: string; expiresWithin: number | null },
) {
  return infiniteQueryOptions({
    queryKey: ['stock', tenantId, 'batches', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.stock.batches, {
        query: {
          limit: 100,
          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
          ...(filter.expiresWithin !== null && { expiresWithin: filter.expiresWithin }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function reorderQuery(tenantId: string, warehouseId: string) {
  return infiniteQueryOptions({
    queryKey: ['stock', tenantId, 'reorder', warehouseId],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.stock.reorder, {
        query: {
          limit: 100,
          ...(warehouseId !== '' && { warehouseId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function stockAdjustmentsQuery(tenantId: string, status: StockDocumentStatus | undefined) {
  return infiniteQueryOptions({
    queryKey: ['stock', tenantId, 'adjustments', status ?? 'all'],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.stockAdjustments.list, {
        query: {
          limit: 50,
          ...(status !== undefined && { status }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function stockAdjustmentQuery(tenantId: string, adjustmentId: string) {
  return queryOptions({
    queryKey: ['stock', tenantId, 'adjustment', adjustmentId],
    queryFn: () => call(routes.stockAdjustments.get, { params: { id: adjustmentId } }),
    retry: false,
  });
}

export function stockTransfersQuery(tenantId: string, status: TransferStatus | undefined) {
  return infiniteQueryOptions({
    queryKey: ['stock', tenantId, 'transfers', status ?? 'all'],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.stockTransfers.list, {
        query: {
          limit: 50,
          ...(status !== undefined && { status }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function stockTransferQuery(tenantId: string, transferId: string) {
  return queryOptions({
    queryKey: ['stock', tenantId, 'transfer', transferId],
    queryFn: () => call(routes.stockTransfers.get, { params: { id: transferId } }),
    retry: false,
  });
}
