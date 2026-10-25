import {
  type BalanceSheetQuery,
  type BillPage,
  type BillPaymentFilter,
  type BillStatus,
  type BillSummary,
  type BranchStatus,
  type CreditNoteStatus,
  type DebitNoteStatus,
  type CustomerSort,
  type CustomerStatus,
  type DeliveryInvoiceFilter,
  type DeviceSort,
  type DeviceStatus,
  type InvoicePage,
  type InvoicePaymentFilter,
  type InvoiceStatus,
  type InvoiceSummary,
  type JournalStatus,
  MAX_RECEIPT_ALLOCATIONS,
  type MemberSort,
  type OrderStatus,
  type PartyRole,
  type ProductSort,
  type ProductStatus,
  type ProfitAndLossQuery,
  type PurchaseOrderBillFilter,
  type PurchaseOrderReceiptFilter,
  type PurchaseOrderStatus,
  type QuotationStatus,
  type ReceiptStatus,
  type RefundStatus,
  type RequisitionOrderFilter,
  type RequisitionStatus,
  routes,
  type StockDocumentStatus,
  type GrnBillFilter,
  type StockFilter,
  type SupplierPaymentStatus,
  type SupplierRefundStatus,
  type SupplierSort,
  type SupplierStatus,
  type TransferStatus,
  type TrialBalanceQuery,
  type WarehouseStatus,
} from '@omnivo/contracts';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';
import { type DeviceReads, deviceReads } from './device-reads';

// Step 18b (decision 35): without a connection, the small lists a sales form needs (units, VAT
// rates, warehouses) and a customer come from the device's copy, so the order and customer
// forms work offline, down to the components deep inside them that read these queries. Online,
// nothing changes. networkMode 'always': TanStack would otherwise pause a query while the browser
// is offline, and never call the function that knows about the device.
function offline(): DeviceReads | null {
  return navigator.onLine ? null : deviceReads();
}

// The device's copy of the settings (its time zone, prices with VAT), for when the server's were
// never loaded. null while the copy has none. Under ['settings', tenant], so a settings save
// refreshes it with the server's.
export function deviceSettingsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['settings', tenantId, 'device'],
    queryFn: async () => (await deviceReads()?.settings()) ?? null,
    networkMode: 'always',
  });
}

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

// Step 18c: both device lists start with ['devices', tenantId], so a rename, a move or a revoke
// refreshes your own list and the workspace's with one invalidate
export function myDevicesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['devices', tenantId, 'mine'],
    queryFn: async () => (await call(routes.devices.mine)).items,
  });
}

export interface DeviceFilter {
  search: string;
  // '' = every branch
  branchId: string;
  status: DeviceStatus;
  sort: DeviceSort;
}

export function deviceListQuery(tenantId: string, filter: DeviceFilter) {
  return infiniteQueryOptions({
    queryKey: ['devices', tenantId, 'list', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.devices.list, {
        query: {
          limit: 50,
          status: filter.status,
          sort: filter.sort,
          ...(filter.search !== '' && { search: filter.search }),
          ...(filter.branchId !== '' && { branchId: filter.branchId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
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
    queryFn: async () => {
      const device = offline();
      return device ? device.units() : (await call(routes.units.list)).items;
    },
    networkMode: 'always',
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
    // The device has the active warehouses of its branch only: offline, an order is written for
    // one of them (decision 8), and no archived one is known
    queryFn: async () => {
      const device = offline();
      if (device) return status === 'active' ? device.warehouses() : [];
      return (await call(routes.warehouses.list, { query: { status } })).items;
    },
    networkMode: 'always',
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

// ---------------------------------------------------------------------------------------------
// What the stock is worth (step 14). Under ['stock', tenantId] too: every posting changes values.

export function stockValuationQuery(
  tenantId: string,
  filter: { search: string; categoryId: string },
) {
  return infiniteQueryOptions({
    queryKey: ['stock', tenantId, 'valuation', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.stock.valuation, {
        query: {
          limit: 100,
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

export function valuationSummaryQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['stock', tenantId, 'valuation-summary'],
    queryFn: () => call(routes.stock.valuationSummary),
  });
}

export function stockRevaluationsQuery(tenantId: string) {
  return infiniteQueryOptions({
    queryKey: ['stock', tenantId, 'revaluations'],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.stockRevaluations.list, {
        query: { limit: 50, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function stockRevaluationQuery(tenantId: string, revaluationId: string) {
  return queryOptions({
    queryKey: ['stock', tenantId, 'revaluation', revaluationId],
    queryFn: () => call(routes.stockRevaluations.get, { params: { id: revaluationId } }),
    retry: false,
  });
}

// The accounts stock documents post to (Settings → Inventory)
export function stockAccountsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['stock-accounts', tenantId],
    queryFn: () => call(routes.stockAccounts.get),
  });
}

// ---------------------------------------------------------------------------------------------
// VAT rates and sales (step 15a)

// A handful of rates, archived ones too: the settings card shows them all, a picker leaves the
// archived ones out
export function taxRatesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['tax-rates', tenantId],
    queryFn: async () => {
      const device = offline();
      return device ? device.taxRates() : (await call(routes.taxRates.list)).items;
    },
    networkMode: 'always',
  });
}

// Everything about customers starts with ['customers', tenantId]: saving a customer or a group
// refreshes the list, the customer's page and the group counts with one invalidate. Posting in the
// journal changes the balances, so useJournalRefresh invalidates this prefix too.
export function customerGroupsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['customers', tenantId, 'groups'],
    queryFn: async () => (await call(routes.customerGroups.list)).items,
  });
}

export interface CustomerFilter {
  search: string;
  groupId: string;
  status: CustomerStatus;
  sort: CustomerSort;
}

export function customerListQuery(tenantId: string, filter: CustomerFilter) {
  return infiniteQueryOptions({
    queryKey: ['customers', tenantId, 'list', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.customers.list, {
        query: {
          limit: 50,
          status: filter.status,
          sort: filter.sort,
          ...(filter.search !== '' && { search: filter.search }),
          ...(filter.groupId !== '' && { groupId: filter.groupId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

// Step 18a: what the customers on screen owe (decision 10). The rows come from the device; the
// balances, which change with every invoice and receipt, from the server, up to 100 at a time.
// Under ['customers', tenantId], so every sales save that moves a balance refreshes them too.
export function customerBalancesQuery(tenantId: string, ids: readonly string[]) {
  return queryOptions({
    queryKey: ['customers', tenantId, 'balances', ids],
    queryFn: async () =>
      new Map(
        (await call(routes.customers.balances, { query: { ids: ids.join(',') } })).items.map(
          (item) => [item.id, item.balance],
        ),
      ),
    placeholderData: keepPreviousData,
  });
}

export function customerQuery(tenantId: string, customerId: string) {
  return queryOptions({
    queryKey: ['customers', tenantId, 'customer', customerId],
    // A customer with commands waiting is read from the device online too: the server does not
    // have a customer made offline yet, and has an older one when it was changed offline. The
    // balance is the server's only (null). The session refreshes this key after every push.
    queryFn: async () => {
      const device = deviceReads();
      if (device && (!navigator.onLine || (await device.hasCommands(customerId)))) {
        const local = await device.customer(customerId);
        if (local) return local;
      }
      return call(routes.customers.get, { params: { id: customerId } });
    },
    networkMode: 'always',
    retry: false,
  });
}

// Step 15c: the credit line under the customer on the order and invoice forms. Under
// ['customers', tenantId]: every sales save refreshes that prefix (useSalesRefresh), because
// confirming an order, posting an invoice and saving a receipt all move it.
export function customerCreditQuery(tenantId: string, customerId: string) {
  return queryOptions({
    queryKey: ['customers', tenantId, 'credit', customerId],
    queryFn: () => call(routes.customers.credit, { params: { id: customerId } }),
  });
}

// A customer's or (step 17a) a supplier's statement. It reads posted journal lines, so it lives
// under ['journal', tenantId] like the ledger: posting or reversing an entry refreshes it. The role
// is in the key: a party that is both has one id and two statements (its receivable lines, its
// payable lines).
export function partyStatementQuery(
  tenantId: string,
  role: PartyRole,
  partyId: string,
  from: string,
  to: string,
) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'statement', role, partyId, from, to],
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const args = {
        params: { id: partyId },
        query: {
          limit: 100,
          ...(from !== '' && { from }),
          ...(to !== '' && { to }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      };
      // Two calls, not one call of a chosen route: each route is its own type, and both answer
      // with the same ledger page
      return role === 'customer'
        ? call(routes.customers.statement, args)
        : call(routes.suppliers.statement, args);
    },
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------------------------
// Suppliers (step 17a): everything under ['suppliers', tenantId], like the customers. A party that
// is both is one row, so a save on either side refreshes both prefixes (usePartyRefresh in
// supplier-parts.tsx). The statement is partyStatementQuery, above.

export function supplierGroupsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['suppliers', tenantId, 'groups'],
    queryFn: async () => (await call(routes.supplierGroups.list)).items,
  });
}

export interface SupplierFilter {
  search: string;
  groupId: string;
  status: SupplierStatus;
  sort: SupplierSort;
}

export function supplierListQuery(tenantId: string, filter: SupplierFilter) {
  return infiniteQueryOptions({
    queryKey: ['suppliers', tenantId, 'list', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.suppliers.list, {
        query: {
          limit: 50,
          status: filter.status,
          sort: filter.sort,
          ...(filter.search !== '' && { search: filter.search }),
          ...(filter.groupId !== '' && { groupId: filter.groupId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

// The supplier box on a payable line: the first 20 active suppliers that match
export function supplierSearchQuery(tenantId: string, search: string) {
  return queryOptions({
    queryKey: ['suppliers', tenantId, 'search', search],
    queryFn: async () =>
      (
        await call(routes.suppliers.list, {
          query: { limit: 20, status: 'active', ...(search !== '' && { search }) },
        })
      ).items,
    placeholderData: keepPreviousData,
  });
}

export function supplierQuery(tenantId: string, supplierId: string) {
  return queryOptions({
    queryKey: ['suppliers', tenantId, 'supplier', supplierId],
    queryFn: () => call(routes.suppliers.get, { params: { id: supplierId } }),
    retry: false,
  });
}

// Price lists: everything under ['price-lists', tenantId]. Saving prices changes the list's item
// count and the items, and one invalidate refreshes both.
export function priceListsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['price-lists', tenantId, 'all'],
    queryFn: async () => (await call(routes.priceLists.list)).items,
  });
}

export function priceListQuery(tenantId: string, priceListId: string) {
  return queryOptions({
    queryKey: ['price-lists', tenantId, 'one', priceListId],
    queryFn: () => call(routes.priceLists.get, { params: { id: priceListId } }),
    retry: false,
  });
}

export function priceListItemsQuery(tenantId: string, priceListId: string, search: string) {
  return infiniteQueryOptions({
    queryKey: ['price-lists', tenantId, 'items', priceListId, search],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.priceLists.items, {
        params: { id: priceListId },
        query: {
          limit: 100,
          ...(search !== '' && { search }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

// The price list's "Add items" search: the first 20 active products that match
export function productSearchQuery(tenantId: string, search: string) {
  return queryOptions({
    queryKey: ['products', tenantId, 'search', search],
    queryFn: async () =>
      (
        await call(routes.products.list, {
          query: { limit: 20, status: 'active', sort: 'name', ...(search !== '' && { search }) },
        })
      ).items,
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------------------------
// Quotations, sales orders and deliveries (step 15b). Everything starts with ['sales', tenantId]:
// one invalidate after a save refreshes the lists and the documents together. A delivery changes
// its order (what is delivered) as well, which is one more reason for one prefix.

// The lists' filters: a status ('' = all) and a customer ('' = all)
export interface SalesListFilter<TStatus extends string> {
  status: TStatus | '';
  customerId: string;
}

// The delivery list's billing filter (step 15c, '' = all)
export interface DeliveryListFilter extends SalesListFilter<StockDocumentStatus> {
  invoice: DeliveryInvoiceFilter | '';
}

export function quotationsQuery(tenantId: string, filter: SalesListFilter<QuotationStatus>) {
  return infiniteQueryOptions({
    queryKey: ['sales', tenantId, 'quotations', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.quotations.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.customerId !== '' && { customerId: filter.customerId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function quotationQuery(tenantId: string, quotationId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'quotation', quotationId],
    queryFn: () => call(routes.quotations.get, { params: { id: quotationId } }),
    retry: false,
  });
}

export function salesOrdersQuery(tenantId: string, filter: SalesListFilter<OrderStatus>) {
  return infiniteQueryOptions({
    queryKey: ['sales', tenantId, 'orders', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.salesOrders.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.customerId !== '' && { customerId: filter.customerId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

// The delivery form's order box: the customer's confirmed orders, the ones a delivery can take
// goods against. 100 at most: a customer with more open orders than that is a problem of its own.
export function openOrdersQuery(tenantId: string, customerId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'orders', 'open', customerId],
    queryFn: async () =>
      (
        await call(routes.salesOrders.list, {
          query: { limit: 100, status: 'confirmed', customerId },
        })
      ).items,
  });
}

export function salesOrderQuery(tenantId: string, orderId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'order', orderId],
    queryFn: () => call(routes.salesOrders.get, { params: { id: orderId } }),
    retry: false,
  });
}

export function deliveriesQuery(tenantId: string, filter: DeliveryListFilter) {
  return infiniteQueryOptions({
    queryKey: ['sales', tenantId, 'deliveries', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.deliveries.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.customerId !== '' && { customerId: filter.customerId }),
          ...(filter.invoice !== '' && { invoice: filter.invoice }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function deliveryQuery(tenantId: string, deliveryId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'delivery', deliveryId],
    queryFn: () => call(routes.deliveries.get, { params: { id: deliveryId } }),
    retry: false,
  });
}

// ---------------------------------------------------------------------------------------------
// Invoices and money receipts (step 15c), under the same ['sales', tenantId] prefix: posting an
// invoice changes its challans (billed), its orders (invoiced) and the lists at once.

export interface InvoiceListFilter extends SalesListFilter<InvoiceStatus> {
  payment: InvoicePaymentFilter | '';
}

export function invoicesQuery(tenantId: string, filter: InvoiceListFilter) {
  return infiniteQueryOptions({
    queryKey: ['sales', tenantId, 'invoices', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.invoices.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.customerId !== '' && { customerId: filter.customerId }),
          ...(filter.payment !== '' && { payment: filter.payment }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function invoiceQuery(tenantId: string, invoiceId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'invoice', invoiceId],
    queryFn: () => call(routes.invoices.get, { params: { id: invoiceId } }),
    retry: false,
  });
}

// The receipt form's list: the customer's posted invoices not paid in full, the oldest due date
// first (the API's order for this filter). A receipt applies to at most MAX_RECEIPT_ALLOCATIONS
// invoices, so the pages are read up to that many, in one go: the table and "Apply oldest first"
// need them all at once.
export function openInvoicesQuery(tenantId: string, customerId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'invoices', 'open', customerId],
    queryFn: async () => {
      const items: InvoiceSummary[] = [];
      let cursor: string | null = null;
      do {
        const page: InvoicePage = await call(routes.invoices.list, {
          query: {
            limit: 100,
            payment: 'open',
            customerId,
            ...(cursor !== null && { cursor }),
          },
        });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null && items.length < MAX_RECEIPT_ALLOCATIONS);
      return items.slice(0, MAX_RECEIPT_ALLOCATIONS);
    },
  });
}

// The invoice form's "Add challans": the customer's posted challans with a line not billed yet
export function challansToInvoiceQuery(tenantId: string, customerId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'deliveries', 'to-invoice', customerId],
    queryFn: async () =>
      (
        await call(routes.deliveries.list, {
          query: { limit: 100, invoice: 'to_invoice', customerId },
        })
      ).items,
  });
}

// The invoice form's "Add order charges": the customer's orders a service line can be billed from
// (confirmed, delivered or closed), newest first. The list has no filter for "has a service left",
// so the dialog opens an order to see its lines.
export function billableOrdersQuery(tenantId: string, customerId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'orders', 'billable', customerId],
    queryFn: async () =>
      (await call(routes.salesOrders.list, { query: { limit: 100, customerId } })).items.filter(
        (order) =>
          order.status === 'confirmed' || order.status === 'delivered' || order.status === 'closed',
      ),
  });
}

export function receiptsQuery(tenantId: string, filter: SalesListFilter<ReceiptStatus>) {
  return infiniteQueryOptions({
    queryKey: ['sales', tenantId, 'receipts', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.receipts.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.customerId !== '' && { customerId: filter.customerId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function receiptQuery(tenantId: string, receiptId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'receipt', receiptId],
    queryFn: () => call(routes.receipts.get, { params: { id: receiptId } }),
    retry: false,
  });
}

// ---------------------------------------------------------------------------------------------
// Sales returns, credit notes and refunds (step 15d), under ['sales', tenantId] too: posting a
// return changes its challans (what came back) and its order, posting a credit note its invoice,
// and a refund its receipt or credit note, so one invalidate refreshes them all.

export function salesReturnsQuery(tenantId: string, filter: SalesListFilter<StockDocumentStatus>) {
  return infiniteQueryOptions({
    queryKey: ['sales', tenantId, 'returns', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.salesReturns.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.customerId !== '' && { customerId: filter.customerId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function salesReturnQuery(tenantId: string, returnId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'return', returnId],
    queryFn: () => call(routes.salesReturns.get, { params: { id: returnId } }),
    retry: false,
  });
}

// The return form's "Add from challans": the customer's posted challans with goods that can still
// come back (the API's ?return=returnable), newest first. 100 at most, like the invoice's picker.
export function returnableChallansQuery(tenantId: string, customerId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'deliveries', 'returnable', customerId],
    queryFn: async () =>
      (
        await call(routes.deliveries.list, {
          query: { limit: 100, return: 'returnable', customerId },
        })
      ).items,
  });
}

export function creditNotesQuery(tenantId: string, filter: SalesListFilter<CreditNoteStatus>) {
  return infiniteQueryOptions({
    queryKey: ['sales', tenantId, 'credit-notes', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.creditNotes.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.customerId !== '' && { customerId: filter.customerId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function creditNoteQuery(tenantId: string, creditNoteId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'credit-note', creditNoteId],
    queryFn: () => call(routes.creditNotes.get, { params: { id: creditNoteId } }),
    retry: false,
  });
}

// The credit note form's invoice select: the customer's posted invoices, newest first. The list has
// no text search (15c.1); 100 covers a customer's recent bills, and an older one is reached from
// its own page ("Write credit note").
export function postedInvoicesQuery(tenantId: string, customerId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'invoices', 'posted', customerId],
    queryFn: async () =>
      (
        await call(routes.invoices.list, {
          query: { limit: 100, status: 'posted', customerId },
        })
      ).items,
  });
}

// The credit note form's "Add returned goods": the customer's posted returns, newest first. The
// list cannot say which ones hold goods of the chosen invoice, so the picker opens a return to see.
export function postedReturnsQuery(tenantId: string, customerId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'returns', 'posted', customerId],
    queryFn: async () =>
      (
        await call(routes.salesReturns.list, {
          query: { limit: 100, status: 'posted', customerId },
        })
      ).items,
  });
}

export function refundsQuery(tenantId: string, filter: SalesListFilter<RefundStatus>) {
  return infiniteQueryOptions({
    queryKey: ['sales', tenantId, 'refunds', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.refunds.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.customerId !== '' && { customerId: filter.customerId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function refundQuery(tenantId: string, refundId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'refund', refundId],
    queryFn: () => call(routes.refunds.get, { params: { id: refundId } }),
    retry: false,
  });
}

// The refund form's source select: the customer's posted receipts and credit notes. Neither list
// has a filter for "money left" (15d.5), so both are read (100 each, newest first) and the form
// keeps the ones with money left (refundSourcesOf); an advance older than the last 100 receipts is
// paid back from the receipt's page. Filtered there, not here: every list page imports this file,
// and lib/returns.ts would ride along into each of their chunks.
export function refundSourcesQuery(tenantId: string, customerId: string) {
  return queryOptions({
    queryKey: ['sales', tenantId, 'refund-sources', customerId],
    queryFn: async () => {
      const [receipts, creditNotes] = await Promise.all([
        call(routes.receipts.list, { query: { limit: 100, status: 'posted', customerId } }),
        call(routes.creditNotes.list, { query: { limit: 100, status: 'posted', customerId } }),
      ]);
      return { receipts: receipts.items, creditNotes: creditNotes.items };
    },
  });
}

// The account credit notes take sales back from (Settings → Sales)
export function salesAccountsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['sales-accounts', tenantId],
    queryFn: () => call(routes.salesAccounts.get),
  });
}

// ---------------------------------------------------------------------------------------------
// Requisitions and approvals (step 17a). Everything starts with ['purchase', tenantId]: approving a
// requisition changes the requisition, its list, the "waiting for me" list and the navigation's
// count, and one invalidate refreshes them all. Step 17b: the purchase orders and the goods
// receipts join the prefix: approving an order changes what its requisitions have ordered, and
// posting a receipt changes what its order has received.

// The approval levels of every kind of document (Settings → Approval levels, and a draft's card)
export function approvalRulesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['approval-rules', tenantId],
    queryFn: async () => (await call(routes.approvalRules.list)).items,
  });
}

export interface RequisitionListFilter {
  status: RequisitionStatus | '';
  warehouseId: string;
  // Step 17b: "To order" is the buyer's queue: approved, with a line not ordered in full
  order: RequisitionOrderFilter | '';
}

export function requisitionsQuery(tenantId: string, filter: RequisitionListFilter) {
  return infiniteQueryOptions({
    queryKey: ['purchase', tenantId, 'requisitions', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.requisitions.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
          ...(filter.order !== '' && { order: filter.order }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function requisitionQuery(tenantId: string, requisitionId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'requisition', requisitionId],
    queryFn: () => call(routes.requisitions.get, { params: { id: requisitionId } }),
    retry: false,
  });
}

// Step 17b: the lines still to order for one warehouse, oldest requisition first (decision 18).
// The first 50 that match: the dialog searches instead of scrolling through hundreds.
export function openRequisitionLinesQuery(
  tenantId: string,
  filter: { warehouseId: string; requisitionId: string; search: string },
) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'requisition-lines', filter],
    queryFn: async () =>
      (
        await call(routes.requisitionLines.open, {
          query: {
            limit: 50,
            warehouseId: filter.warehouseId,
            ...(filter.requisitionId !== '' && { requisitionId: filter.requisitionId }),
            ...(filter.search !== '' && { search: filter.search }),
          },
        })
      ).items,
    placeholderData: keepPreviousData,
  });
}

export interface PurchaseOrderListFilter {
  status: PurchaseOrderStatus | '';
  warehouseId: string;
  supplierId: string;
  // "To receive": approved, with goods still to come (the store keeper's queue)
  receipt: PurchaseOrderReceiptFilter | '';
  // Step 17c: "Services to bill": a service line no posted bill bills yet (the accountant's queue)
  bill: PurchaseOrderBillFilter | '';
}

export function purchaseOrdersQuery(tenantId: string, filter: PurchaseOrderListFilter) {
  return infiniteQueryOptions({
    queryKey: ['purchase', tenantId, 'orders', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.purchaseOrders.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
          ...(filter.supplierId !== '' && { supplierId: filter.supplierId }),
          ...(filter.receipt !== '' && { receipt: filter.receipt }),
          ...(filter.bill !== '' && { bill: filter.bill }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

// The goods receipt form's order box: the supplier's approved orders with goods still to come.
// 100 at most, like the delivery's open orders: a supplier with more open orders than that is a
// problem of its own.
export function ordersToReceiveQuery(tenantId: string, supplierId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'orders', 'to-receive', supplierId],
    queryFn: async () =>
      (
        await call(routes.purchaseOrders.list, {
          query: { limit: 100, receipt: 'to_receive', supplierId },
        })
      ).items,
  });
}

export function purchaseOrderQuery(tenantId: string, orderId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'order', orderId],
    queryFn: () => call(routes.purchaseOrders.get, { params: { id: orderId } }),
    retry: false,
  });
}

export interface GoodsReceiptListFilter {
  status: StockDocumentStatus | '';
  warehouseId: string;
  supplierId: string;
  // Step 17c: "To bill" (posted, with a line no posted bill bills yet) or "Billed"
  bill: GrnBillFilter | '';
}

export function goodsReceiptsQuery(tenantId: string, filter: GoodsReceiptListFilter) {
  return infiniteQueryOptions({
    queryKey: ['purchase', tenantId, 'receipts', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.goodsReceipts.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
          ...(filter.supplierId !== '' && { supplierId: filter.supplierId }),
          ...(filter.bill !== '' && { bill: filter.bill }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function goodsReceiptQuery(tenantId: string, receiptId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'receipt', receiptId],
    queryFn: () => call(routes.goodsReceipts.get, { params: { id: receiptId } }),
    retry: false,
  });
}

// ---------------------------------------------------------------------------------------------
// Supplier bills and supplier payments (step 17c), under the same ['purchase', tenantId] prefix:
// posting a bill changes its goods receipts (billed), its orders (billed quantities) and the lists;
// posting a payment changes the bills it pays and its order's advances. One invalidate does it all.

export interface BillListFilter {
  status: BillStatus | '';
  supplierId: string;
  payment: BillPaymentFilter | '';
}

export function billsQuery(tenantId: string, filter: BillListFilter) {
  return infiniteQueryOptions({
    queryKey: ['purchase', tenantId, 'bills', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.bills.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.supplierId !== '' && { supplierId: filter.supplierId }),
          ...(filter.payment !== '' && { payment: filter.payment }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function billQuery(tenantId: string, billId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'bill', billId],
    queryFn: () => call(routes.bills.get, { params: { id: billId } }),
    retry: false,
  });
}

// The payment form's list: the supplier's posted bills not paid in full, the oldest due date first
// (the API's order for this filter). Read up to the most a payment applies to, in one go, like the
// money receipt's open invoices: the table and "Apply oldest first" need them all at once.
export function openBillsQuery(tenantId: string, supplierId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'bills', 'open', supplierId],
    queryFn: async () => {
      const items: BillSummary[] = [];
      let cursor: string | null = null;
      do {
        const page: BillPage = await call(routes.bills.list, {
          query: {
            limit: 100,
            payment: 'open',
            supplierId,
            ...(cursor !== null && { cursor }),
          },
        });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null && items.length < MAX_RECEIPT_ALLOCATIONS);
      return items.slice(0, MAX_RECEIPT_ALLOCATIONS);
    },
  });
}

// The bill form's "Add goods receipts": the supplier's posted receipts with a line to bill
export function receiptsToBillQuery(tenantId: string, supplierId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'receipts', 'to-bill', supplierId],
    queryFn: async () =>
      (
        await call(routes.goodsReceipts.list, {
          query: { limit: 100, bill: 'to_bill', supplierId },
        })
      ).items,
  });
}

// The bill form's "Add order services": the supplier's orders with a service no posted bill bills
// yet (decision 22). A draft bill elsewhere may hold one; the API says so at submit.
export function ordersToBillQuery(tenantId: string, supplierId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'orders', 'to-bill', supplierId],
    queryFn: async () =>
      (
        await call(routes.purchaseOrders.list, {
          query: { limit: 100, bill: 'to_bill', supplierId },
        })
      ).items,
  });
}

export interface SupplierPaymentListFilter {
  status: SupplierPaymentStatus | '';
  supplierId: string;
}

export function supplierPaymentsQuery(tenantId: string, filter: SupplierPaymentListFilter) {
  return infiniteQueryOptions({
    queryKey: ['purchase', tenantId, 'payments', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.supplierPayments.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.supplierId !== '' && { supplierId: filter.supplierId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function supplierPaymentQuery(tenantId: string, paymentId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'payment', paymentId],
    queryFn: () => call(routes.supplierPayments.get, { params: { id: paymentId } }),
    retry: false,
  });
}

// The payment form's "Against order": the supplier's approved, received or closed orders
// (decision 44), newest first. 100 at most: an advance is paid against a recent order.
export function ordersToPayQuery(tenantId: string, supplierId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'orders', 'to-pay', supplierId],
    queryFn: async () =>
      (await call(routes.purchaseOrders.list, { query: { limit: 100, supplierId } })).items.filter(
        (order) =>
          order.status === 'approved' || order.status === 'received' || order.status === 'closed',
      ),
  });
}

// ---------------------------------------------------------------------------------------------
// Purchase returns, debit notes and supplier refunds (step 17d), under ['purchase', tenantId] like
// the rest: posting a return changes its goods receipts (returned), its orders (received) and the
// bills that bill them; posting a debit note changes its bill and its returns (debited); a refund
// changes the debit note or payment it takes money back from. One invalidate does it all.

export interface PurchaseReturnListFilter {
  status: StockDocumentStatus | '';
  supplierId: string;
  warehouseId: string;
}

export function purchaseReturnsQuery(tenantId: string, filter: PurchaseReturnListFilter) {
  return infiniteQueryOptions({
    queryKey: ['purchase', tenantId, 'returns', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.purchaseReturns.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.supplierId !== '' && { supplierId: filter.supplierId }),
          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function purchaseReturnQuery(tenantId: string, returnId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'return', returnId],
    queryFn: () => call(routes.purchaseReturns.get, { params: { id: returnId } }),
    retry: false,
  });
}

// The return form's "Add from goods receipts": the supplier's posted receipts with a line that
// still keeps something (the API's ?return=returnable), newest first. 100 at most, like the sales
// return's challan picker.
export function returnableReceiptsQuery(tenantId: string, supplierId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'receipts', 'returnable', supplierId],
    queryFn: async () =>
      (
        await call(routes.goodsReceipts.list, {
          query: { limit: 100, return: 'returnable', supplierId },
        })
      ).items,
  });
}

export interface DebitNoteListFilter {
  status: DebitNoteStatus | '';
  supplierId: string;
}

export function debitNotesQuery(tenantId: string, filter: DebitNoteListFilter) {
  return infiniteQueryOptions({
    queryKey: ['purchase', tenantId, 'debit-notes', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.debitNotes.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.supplierId !== '' && { supplierId: filter.supplierId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function debitNoteQuery(tenantId: string, debitNoteId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'debit-note', debitNoteId],
    queryFn: () => call(routes.debitNotes.get, { params: { id: debitNoteId } }),
    retry: false,
  });
}

// The debit note form's bill select: the supplier's posted bills, newest first, like the credit
// note's postedInvoicesQuery. An older bill is reached from its own page ("Write debit note").
export function postedBillsQuery(tenantId: string, supplierId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'bills', 'posted', supplierId],
    queryFn: async () =>
      (
        await call(routes.bills.list, {
          query: { limit: 100, status: 'posted', supplierId },
        })
      ).items,
  });
}

// The debit note form's "Add returned goods": the supplier's posted returns, newest first. The
// list cannot say which ones hold goods of the chosen bill, so the picker opens a return to see.
export function postedPurchaseReturnsQuery(tenantId: string, supplierId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'returns', 'posted', supplierId],
    queryFn: async () =>
      (
        await call(routes.purchaseReturns.list, {
          query: { limit: 100, status: 'posted', supplierId },
        })
      ).items,
  });
}

export interface SupplierRefundListFilter {
  status: SupplierRefundStatus | '';
  supplierId: string;
}

export function supplierRefundsQuery(tenantId: string, filter: SupplierRefundListFilter) {
  return infiniteQueryOptions({
    queryKey: ['purchase', tenantId, 'refunds', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.supplierRefunds.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.supplierId !== '' && { supplierId: filter.supplierId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function supplierRefundQuery(tenantId: string, refundId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'refund', refundId],
    queryFn: () => call(routes.supplierRefunds.get, { params: { id: refundId } }),
    retry: false,
  });
}

// The supplier refund form's source select: the supplier's posted debit notes and payments, like
// the customer refund's refundSourcesQuery (it says why both are read and filtered on the form)
export function supplierRefundSourcesQuery(tenantId: string, supplierId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'refund-sources', supplierId],
    queryFn: async () => {
      const [debitNotes, payments] = await Promise.all([
        call(routes.debitNotes.list, { query: { limit: 100, status: 'posted', supplierId } }),
        call(routes.supplierPayments.list, {
          query: { limit: 100, status: 'posted', supplierId },
        }),
      ]);
      return { debitNotes: debitNotes.items, payments: payments.items };
    },
  });
}

// Settings → Purchase accounts (decision 17), like the sales accounts: its own key, read by the
// settings card and by the bill form (a service line's empty account names it)
export function purchaseAccountsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['purchase-accounts', tenantId],
    queryFn: () => call(routes.purchaseAccounts.get),
  });
}

// "Waiting for me", oldest first
export function waitingApprovalsQuery(tenantId: string) {
  return infiniteQueryOptions({
    queryKey: ['purchase', tenantId, 'waiting'],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.approvals.waiting, {
        query: { limit: 50, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

// The navigation's count. Polled like the bell's badge (unreadCountQuery): every 30 seconds while
// the tab is visible, so a requisition submitted in another office shows up without a reload.
export function waitingCountQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['purchase', tenantId, 'waiting-count'],
    queryFn: async () => (await call(routes.approvals.waitingCount)).count,
    refetchInterval: 30_000,
    staleTime: 0,
  });
}
