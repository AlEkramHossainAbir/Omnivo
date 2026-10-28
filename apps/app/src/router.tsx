import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { INVITE_PATH } from '@omnivo/contracts';

import { restoreSession } from './lib/session';
import { sessionStore } from './lib/session-store';

const rootRoute = createRootRoute({ component: Outlet });

// প্রতিটা পেজ আলাদা chunk (lazyRouteComponent): লগইন পেজ খুলতে ড্যাশবোর্ডের DataTable বা
// সাইডবারের মেনু ডাউনলোড করতে হয় না। বাজেট: প্রথম লোড < 200 KB gz (scripts/check-bundle-size.ts)

// লগইন করা ইউজার /login বা /sign-up-এ এলে সোজা ড্যাশবোর্ডে
async function redirectIfSignedIn(): Promise<void> {
  await restoreSession();
  if (sessionStore.getState().status === 'signed-in') {
    throw redirect({ to: '/' });
  }
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: redirectIfSignedIn,
  component: lazyRouteComponent(() => import('./routes/login'), 'LoginPage'),
});

// ইমেইলের লিংক। লগইন ছাড়াই খোলে, আর লগইন থাকলেও /-এ ফেরায় না (redirectIfSignedIn নেই): অন্য
// অ্যাকাউন্টে বসে থাকা কেউও আমন্ত্রণটা দেখে গ্রহণ করতে পারবে
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: INVITE_PATH,
  component: lazyRouteComponent(() => import('./routes/invite'), 'InvitePage'),
});

// Step 16: a share link (/d/<token>, sent on WhatsApp). No login, and no redirect for someone who
// is signed in: the sender may open it to check what the customer sees. Outside the AppShell:
// the customer is not a user of the app.
const publicDocumentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/d/$token',
  component: lazyRouteComponent(() => import('./routes/public-document'), 'PublicDocumentPage'),
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-up',
  beforeLoad: redirectIfSignedIn,
  component: lazyRouteComponent(() => import('./routes/sign-up'), 'SignUpPage'),
});

// Only someone who can change the settings runs the setup. Others use the app as it is; the
// owner finishes the setup when they sign in next.
function mustRunSetup(): boolean {
  const me = sessionStore.getState().me;
  return me?.tenant.setupStatus === 'pending' && me.permissions.includes('core.settings.manage');
}

// The setup wizard: signed in, but outside the AppShell — until the business type is picked,
// there is nothing else to go to
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  beforeLoad: async () => {
    await restoreSession();
    const { status, me } = sessionStore.getState();
    if (status !== 'signed-in') throw redirect({ to: '/login' });
    if (!me?.permissions.includes('core.settings.manage')) throw redirect({ to: '/' });
  },
  component: lazyRouteComponent(() => import('./routes/onboarding'), 'OnboardingPage'),
});

// pathless layout route: এর নিচের সব পেজ protected, আর সবগুলো AppShell-এর ভেতরে
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async () => {
    await restoreSession();
    if (sessionStore.getState().status !== 'signed-in') {
      throw redirect({ to: '/login' });
    }
    // A new workspace goes through the wizard first — right after sign-up, and on any later
    // visit until a business type is picked
    if (mustRunSetup()) throw redirect({ to: '/onboarding' });
  },
  // layout-ও lazy: সাইডবারের Radix মেনু (~৩০ KB gz) লগইনের আগে লাগে না
  // Step 19b: the frame around the shell, which shows the lock screen in its place (app-frame.tsx)
  component: lazyRouteComponent(() => import('./routes/app-frame'), 'AppFrame'),
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: lazyRouteComponent(() => import('./routes/dashboard'), 'DashboardPage'),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: lazyRouteComponent(() => import('./routes/settings'), 'SettingsPage'),
});

const numberingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/numbering',
  component: lazyRouteComponent(() => import('./routes/numbering'), 'NumberingPage'),
});

const branchesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/branches',
  component: lazyRouteComponent(() => import('./routes/branches'), 'BranchesPage'),
});

const accountsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/accounts',
  component: lazyRouteComponent(() => import('./routes/accounts'), 'AccountsPage'),
});

const journalRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/journal',
  component: lazyRouteComponent(() => import('./routes/journal'), 'JournalPage'),
});

// '/journal/new' beats '/journal/$entryId': TanStack ranks a fixed segment above a parameter.
// Both pages live in one file and one chunk.
const newJournalEntryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/journal/new',
  component: lazyRouteComponent(() => import('./routes/journal-entry'), 'NewJournalEntryPage'),
});

const journalEntryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/journal/$entryId',
  component: lazyRouteComponent(() => import('./routes/journal-entry'), 'JournalEntryPage'),
});

// ?account=<id>: an entry's line links straight to its account's ledger, and the address can be
// bookmarked. ?from=&to=: a report's account opens with the report's own dates (step 11).
// Anything else in the query string is dropped, and a date that is not a date is not trusted.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ledgerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/ledger',
  validateSearch: (
    search: Record<string, unknown>,
  ): { account?: string; from?: string; to?: string } => ({
    ...(typeof search.account === 'string' && { account: search.account }),
    ...(typeof search.from === 'string' && ISO_DATE.test(search.from) && { from: search.from }),
    ...(typeof search.to === 'string' && ISO_DATE.test(search.to) && { to: search.to }),
  }),
  component: lazyRouteComponent(() => import('./routes/ledger'), 'LedgerPage'),
});

const openingBalancesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/opening-balances',
  component: lazyRouteComponent(() => import('./routes/opening-balances'), 'OpeningBalancesPage'),
});

const yearEndRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/year-end',
  component: lazyRouteComponent(() => import('./routes/year-end'), 'YearEndPage'),
});

const trialBalanceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/reports/trial-balance',
  component: lazyRouteComponent(() => import('./routes/trial-balance'), 'TrialBalancePage'),
});

const profitAndLossRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/reports/profit-and-loss',
  component: lazyRouteComponent(() => import('./routes/profit-and-loss'), 'ProfitAndLossPage'),
});

const balanceSheetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/reports/balance-sheet',
  component: lazyRouteComponent(() => import('./routes/balance-sheet'), 'BalanceSheetPage'),
});

const reportExportsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/reports/exports',
  component: lazyRouteComponent(() => import('./routes/report-exports'), 'ReportExportsPage'),
});

// Products (step 12). '/products/new', '/products/categories', '/products/units' and
// '/products/imports' beat '/products/$productId': a fixed segment ranks above a parameter.
const productsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products',
  component: lazyRouteComponent(() => import('./routes/products'), 'ProductsPage'),
});

const newProductRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/new',
  component: lazyRouteComponent(() => import('./routes/product'), 'NewProductPage'),
});

const productRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/$productId',
  component: lazyRouteComponent(() => import('./routes/product'), 'ProductPage'),
});

const productCategoriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/categories',
  component: lazyRouteComponent(
    () => import('./routes/product-categories'),
    'ProductCategoriesPage',
  ),
});

const unitsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/units',
  component: lazyRouteComponent(() => import('./routes/units'), 'UnitsPage'),
});

const productImportsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/imports',
  component: lazyRouteComponent(() => import('./routes/product-imports'), 'ProductImportsPage'),
});

// Warehouses and stock (step 13). The fixed segments ('/stock/adjustments', '/stock/transfers',
// '/stock/batches', '/stock/reorder', and their '/new') beat '/stock/$variantId' and the document
// ids, like '/products/new' beats '/products/$productId'.
const warehousesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/warehouses',
  component: lazyRouteComponent(() => import('./routes/warehouses'), 'WarehousesPage'),
});

const stockRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock',
  component: lazyRouteComponent(() => import('./routes/stock'), 'StockPage'),
});

const stockCardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/$variantId',
  component: lazyRouteComponent(() => import('./routes/stock-card'), 'StockCardPage'),
});

const stockAdjustmentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/adjustments',
  component: lazyRouteComponent(() => import('./routes/stock-adjustments'), 'StockAdjustmentsPage'),
});

const newStockAdjustmentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/adjustments/new',
  component: lazyRouteComponent(
    () => import('./routes/stock-adjustment'),
    'NewStockAdjustmentPage',
  ),
});

const stockAdjustmentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/adjustments/$adjustmentId',
  component: lazyRouteComponent(() => import('./routes/stock-adjustment'), 'StockAdjustmentPage'),
});

const stockTransfersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/transfers',
  component: lazyRouteComponent(() => import('./routes/stock-transfers'), 'StockTransfersPage'),
});

const newStockTransferRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/transfers/new',
  component: lazyRouteComponent(() => import('./routes/stock-transfer'), 'NewStockTransferPage'),
});

const stockTransferRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/transfers/$transferId',
  component: lazyRouteComponent(() => import('./routes/stock-transfer'), 'StockTransferPage'),
});

const stockBatchesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/batches',
  component: lazyRouteComponent(() => import('./routes/stock-batches'), 'StockBatchesPage'),
});

// What the stock is worth (step 14): the valuation report and the revaluations. Fixed segments
// again, so '/stock/valuation' and '/stock/revaluations' beat '/stock/$variantId'.
const stockValuationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/valuation',
  component: lazyRouteComponent(() => import('./routes/stock-valuation'), 'StockValuationPage'),
});

const stockRevaluationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/revaluations',
  component: lazyRouteComponent(
    () => import('./routes/stock-revaluations'),
    'StockRevaluationsPage',
  ),
});

const newStockRevaluationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/revaluations/new',
  component: lazyRouteComponent(
    () => import('./routes/stock-revaluation'),
    'NewStockRevaluationPage',
  ),
});

const stockRevaluationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/revaluations/$revaluationId',
  component: lazyRouteComponent(() => import('./routes/stock-revaluation'), 'StockRevaluationPage'),
});

const stockReorderRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/reorder',
  component: lazyRouteComponent(() => import('./routes/stock-reorder'), 'StockReorderPage'),
});

// Sales (step 15a): customers, their groups, price lists. '/customers/new' beats
// '/customers/$customerId', like the products. The new and edit pages have a file of their own
// (routes/customer-edit.tsx), so the form does not load the statement's table and date pickers.
const customersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/customers',
  component: lazyRouteComponent(() => import('./routes/customers'), 'CustomersPage'),
});

const newCustomerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/customers/new',
  component: lazyRouteComponent(() => import('./routes/customer-edit'), 'NewCustomerPage'),
});

const customerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/customers/$customerId',
  component: lazyRouteComponent(() => import('./routes/customer'), 'CustomerPage'),
});

const editCustomerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/customers/$customerId/edit',
  component: lazyRouteComponent(() => import('./routes/customer-edit'), 'EditCustomerPage'),
});

const customerGroupsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/customer-groups',
  component: lazyRouteComponent(() => import('./routes/customer-groups'), 'CustomerGroupsPage'),
});

const priceListsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/price-lists',
  component: lazyRouteComponent(() => import('./routes/price-lists'), 'PriceListsPage'),
});

const priceListRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/price-lists/$priceListId',
  component: lazyRouteComponent(() => import('./routes/price-list'), 'PriceListPage'),
});

// Quotations, sales orders and deliveries (step 15b). '/…/new' beats '/…/$id', like the stock
// documents. A new order may start from a quotation, and a new delivery from an order: the id comes
// in the search, so "Make order" and "New delivery" are plain links. A search value that is not a
// UUID is dropped here, and the page starts empty instead of asking the API for nonsense.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const quotationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/quotations',
  component: lazyRouteComponent(() => import('./routes/quotations'), 'QuotationsPage'),
});

const newQuotationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/quotations/new',
  component: lazyRouteComponent(() => import('./routes/quotation'), 'NewQuotationPage'),
});

const quotationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/quotations/$quotationId',
  component: lazyRouteComponent(() => import('./routes/quotation'), 'QuotationPage'),
});

const salesOrdersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales-orders',
  component: lazyRouteComponent(() => import('./routes/sales-orders'), 'SalesOrdersPage'),
});

const newSalesOrderRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales-orders/new',
  validateSearch: (search: Record<string, unknown>): { quotationId?: string } => ({
    ...(typeof search.quotationId === 'string' &&
      UUID.test(search.quotationId) && { quotationId: search.quotationId }),
  }),
  component: lazyRouteComponent(() => import('./routes/sales-order'), 'NewSalesOrderPage'),
});

const salesOrderRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales-orders/$orderId',
  component: lazyRouteComponent(() => import('./routes/sales-order'), 'SalesOrderPage'),
});

const deliveriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/deliveries',
  component: lazyRouteComponent(() => import('./routes/deliveries'), 'DeliveriesPage'),
});

const newDeliveryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/deliveries/new',
  validateSearch: (search: Record<string, unknown>): { orderId?: string } => ({
    ...(typeof search.orderId === 'string' &&
      UUID.test(search.orderId) && { orderId: search.orderId }),
  }),
  component: lazyRouteComponent(() => import('./routes/delivery'), 'NewDeliveryPage'),
});

const deliveryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/deliveries/$deliveryId',
  component: lazyRouteComponent(() => import('./routes/delivery'), 'DeliveryPage'),
});

// Invoices and money receipts (step 15c). "Make invoice" on a challan comes with ?deliveryId=, and
// "New invoice" on a customer's page with ?customerId=; "Record payment" on an invoice comes with
// ?customerId= and ?invoiceId=, on a customer's page with ?customerId= alone.
const invoicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/invoices',
  component: lazyRouteComponent(() => import('./routes/invoices'), 'InvoicesPage'),
});

const newInvoiceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/invoices/new',
  validateSearch: (
    search: Record<string, unknown>,
  ): { deliveryId?: string; customerId?: string } => ({
    ...(typeof search.deliveryId === 'string' &&
      UUID.test(search.deliveryId) && { deliveryId: search.deliveryId }),
    ...(typeof search.customerId === 'string' &&
      UUID.test(search.customerId) && { customerId: search.customerId }),
  }),
  component: lazyRouteComponent(() => import('./routes/invoice'), 'NewInvoicePage'),
});

const invoiceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/invoices/$invoiceId',
  component: lazyRouteComponent(() => import('./routes/invoice'), 'InvoicePage'),
});

const receiptsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/receipts',
  component: lazyRouteComponent(() => import('./routes/receipts'), 'ReceiptsPage'),
});

const newReceiptRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/receipts/new',
  validateSearch: (
    search: Record<string, unknown>,
  ): { customerId?: string; invoiceId?: string } => ({
    ...(typeof search.customerId === 'string' &&
      UUID.test(search.customerId) && { customerId: search.customerId }),
    ...(typeof search.invoiceId === 'string' &&
      UUID.test(search.invoiceId) && { invoiceId: search.invoiceId }),
  }),
  component: lazyRouteComponent(() => import('./routes/receipt'), 'NewReceiptPage'),
});

const receiptRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/receipts/$receiptId',
  component: lazyRouteComponent(() => import('./routes/receipt'), 'ReceiptPage'),
});

// Sales returns, credit notes and refunds (step 15d). "Take goods back" on a challan comes with
// ?deliveryId=; "Write credit note" on an invoice with ?invoiceId=, on a return with ?returnId=;
// "Pay back" on a receipt with ?receiptId=, on a credit note with ?creditNoteId=.
const salesReturnsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales-returns',
  component: lazyRouteComponent(() => import('./routes/sales-returns'), 'SalesReturnsPage'),
});

const newSalesReturnRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales-returns/new',
  validateSearch: (search: Record<string, unknown>): { deliveryId?: string } => ({
    ...(typeof search.deliveryId === 'string' &&
      UUID.test(search.deliveryId) && { deliveryId: search.deliveryId }),
  }),
  component: lazyRouteComponent(() => import('./routes/sales-return'), 'NewSalesReturnPage'),
});

const salesReturnRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sales-returns/$returnId',
  component: lazyRouteComponent(() => import('./routes/sales-return'), 'SalesReturnPage'),
});

const creditNotesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/credit-notes',
  component: lazyRouteComponent(() => import('./routes/credit-notes'), 'CreditNotesPage'),
});

const newCreditNoteRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/credit-notes/new',
  validateSearch: (search: Record<string, unknown>): { invoiceId?: string; returnId?: string } => ({
    ...(typeof search.invoiceId === 'string' &&
      UUID.test(search.invoiceId) && { invoiceId: search.invoiceId }),
    ...(typeof search.returnId === 'string' &&
      UUID.test(search.returnId) && { returnId: search.returnId }),
  }),
  component: lazyRouteComponent(() => import('./routes/credit-note'), 'NewCreditNotePage'),
});

const creditNoteRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/credit-notes/$creditNoteId',
  component: lazyRouteComponent(() => import('./routes/credit-note'), 'CreditNotePage'),
});

const refundsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/refunds',
  component: lazyRouteComponent(() => import('./routes/refunds'), 'RefundsPage'),
});

const newRefundRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/refunds/new',
  validateSearch: (
    search: Record<string, unknown>,
  ): { receiptId?: string; creditNoteId?: string } => ({
    ...(typeof search.receiptId === 'string' &&
      UUID.test(search.receiptId) && { receiptId: search.receiptId }),
    ...(typeof search.creditNoteId === 'string' &&
      UUID.test(search.creditNoteId) && { creditNoteId: search.creditNoteId }),
  }),
  component: lazyRouteComponent(() => import('./routes/refund'), 'NewRefundPage'),
});

const refundRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/refunds/$refundId',
  component: lazyRouteComponent(() => import('./routes/refund'), 'RefundPage'),
});

// Purchase (step 17a): suppliers and their groups, like the customers ('/suppliers/new' beats
// '/suppliers/$supplierId'; the form pages have a file of their own, routes/supplier-edit.tsx, for
// the same reason as the customer's), then the requisitions and the "waiting for me" list.
const suppliersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/suppliers',
  component: lazyRouteComponent(() => import('./routes/suppliers'), 'SuppliersPage'),
});

const newSupplierRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/suppliers/new',
  component: lazyRouteComponent(() => import('./routes/supplier-edit'), 'NewSupplierPage'),
});

const supplierRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/suppliers/$supplierId',
  component: lazyRouteComponent(() => import('./routes/supplier'), 'SupplierPage'),
});

const editSupplierRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/suppliers/$supplierId/edit',
  component: lazyRouteComponent(() => import('./routes/supplier-edit'), 'EditSupplierPage'),
});

const supplierGroupsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/supplier-groups',
  component: lazyRouteComponent(() => import('./routes/supplier-groups'), 'SupplierGroupsPage'),
});

const requisitionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/requisitions',
  component: lazyRouteComponent(() => import('./routes/requisitions'), 'RequisitionsPage'),
});

const newRequisitionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/requisitions/new',
  component: lazyRouteComponent(() => import('./routes/requisition'), 'NewRequisitionPage'),
});

const requisitionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/requisitions/$requisitionId',
  component: lazyRouteComponent(() => import('./routes/requisition'), 'RequisitionPage'),
});

const approvalsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/approvals',
  component: lazyRouteComponent(() => import('./routes/approvals'), 'ApprovalsPage'),
});

// Step 18b: the outbox and the last sync of this device
const syncRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sync',
  component: lazyRouteComponent(() => import('./routes/sync'), 'SyncPage'),
});

// Step 20a: the POS screen. Under the app route, so the session, the lock screen and the device's
// copy work as on every page, but the AppFrame draws it without the shell (POS_PATH in
// app-frame.tsx): a counter needs the whole screen. Its own chunk, like every page.
const posRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/pos',
  component: lazyRouteComponent(() => import('./routes/pos'), 'PosPage'),
});

// Step 20a: the POS's pages in the shell: the registers (a workspace setting), the posted sales
// and their page, and what the counters sold short (under Stock). Only '/pos' itself is bare
// (app-frame.tsx), so these keep the sidebar.
const posRegistersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/pos/registers',
  component: lazyRouteComponent(() => import('./routes/pos-registers'), 'PosRegistersPage'),
});

const posSalesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/pos/sales',
  component: lazyRouteComponent(() => import('./routes/pos-sales'), 'PosSalesPage'),
});

const posSaleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/pos/sales/$saleId',
  component: lazyRouteComponent(() => import('./routes/pos-sale'), 'PosSalePage'),
});

const soldShortRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/stock/sold-short',
  component: lazyRouteComponent(() => import('./routes/sold-short'), 'SoldShortPage'),
});

// Step 18c: your own devices (the account menu) and every device of the workspace (the sidebar,
// with core.device.manage)
const myDevicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/my-devices',
  component: lazyRouteComponent(() => import('./routes/my-devices'), 'MyDevicesPage'),
});

const devicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/devices',
  component: lazyRouteComponent(() => import('./routes/devices'), 'DevicesPage'),
});

// Step 17b: purchase orders ("Make purchase order" on a requisition comes with ?requisitionId=) and
// goods receipts ("Receive goods" on an order comes with ?orderId=). '/…/new' beats '/…/$id'.
const purchaseOrdersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/purchase-orders',
  component: lazyRouteComponent(() => import('./routes/purchase-orders'), 'PurchaseOrdersPage'),
});

const newPurchaseOrderRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/purchase-orders/new',
  validateSearch: (search: Record<string, unknown>): { requisitionId?: string } => ({
    ...(typeof search.requisitionId === 'string' &&
      UUID.test(search.requisitionId) && { requisitionId: search.requisitionId }),
  }),
  component: lazyRouteComponent(() => import('./routes/purchase-order'), 'NewPurchaseOrderPage'),
});

const purchaseOrderRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/purchase-orders/$orderId',
  component: lazyRouteComponent(() => import('./routes/purchase-order'), 'PurchaseOrderPage'),
});

const goodsReceiptsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/goods-receipts',
  component: lazyRouteComponent(() => import('./routes/goods-receipts'), 'GoodsReceiptsPage'),
});

const newGoodsReceiptRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/goods-receipts/new',
  validateSearch: (search: Record<string, unknown>): { orderId?: string } => ({
    ...(typeof search.orderId === 'string' &&
      UUID.test(search.orderId) && { orderId: search.orderId }),
  }),
  component: lazyRouteComponent(() => import('./routes/goods-receipt'), 'NewGoodsReceiptPage'),
});

const goodsReceiptRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/goods-receipts/$receiptId',
  component: lazyRouteComponent(() => import('./routes/goods-receipt'), 'GoodsReceiptPage'),
});

// Step 17c: supplier bills ("Make bill" on a goods receipt comes with ?receiptId=, on an order with
// ?orderId=) and supplier payments ("Pay bill" comes with ?billId=, "Pay advance" on an order with
// ?orderId=)
const billsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/bills',
  component: lazyRouteComponent(() => import('./routes/bills'), 'BillsPage'),
});

const newBillRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/bills/new',
  validateSearch: (search: Record<string, unknown>): { receiptId?: string; orderId?: string } => ({
    ...(typeof search.receiptId === 'string' &&
      UUID.test(search.receiptId) && { receiptId: search.receiptId }),
    ...(typeof search.orderId === 'string' &&
      UUID.test(search.orderId) && { orderId: search.orderId }),
  }),
  component: lazyRouteComponent(() => import('./routes/bill'), 'NewBillPage'),
});

const billRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/bills/$billId',
  component: lazyRouteComponent(() => import('./routes/bill'), 'BillPage'),
});

const supplierPaymentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/supplier-payments',
  component: lazyRouteComponent(() => import('./routes/supplier-payments'), 'SupplierPaymentsPage'),
});

const newSupplierPaymentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/supplier-payments/new',
  validateSearch: (search: Record<string, unknown>): { billId?: string; orderId?: string } => ({
    ...(typeof search.billId === 'string' && UUID.test(search.billId) && { billId: search.billId }),
    ...(typeof search.orderId === 'string' &&
      UUID.test(search.orderId) && { orderId: search.orderId }),
  }),
  component: lazyRouteComponent(
    () => import('./routes/supplier-payment'),
    'NewSupplierPaymentPage',
  ),
});

const supplierPaymentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/supplier-payments/$paymentId',
  component: lazyRouteComponent(() => import('./routes/supplier-payment'), 'SupplierPaymentPage'),
});

// Step 17d: purchase returns ("Send goods back" on a goods receipt comes with ?receiptId=), debit
// notes ("Write debit note" on a bill comes with ?billId=, on a return with ?returnId=) and supplier
// refunds ("Record money back" on a debit note comes with ?debitNoteId=, on a payment with
// ?paymentId=)
const purchaseReturnsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/purchase-returns',
  component: lazyRouteComponent(() => import('./routes/purchase-returns'), 'PurchaseReturnsPage'),
});

const newPurchaseReturnRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/purchase-returns/new',
  validateSearch: (search: Record<string, unknown>): { receiptId?: string } => ({
    ...(typeof search.receiptId === 'string' &&
      UUID.test(search.receiptId) && { receiptId: search.receiptId }),
  }),
  component: lazyRouteComponent(() => import('./routes/purchase-return'), 'NewPurchaseReturnPage'),
});

const purchaseReturnRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/purchase-returns/$returnId',
  component: lazyRouteComponent(() => import('./routes/purchase-return'), 'PurchaseReturnPage'),
});

const debitNotesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/debit-notes',
  component: lazyRouteComponent(() => import('./routes/debit-notes'), 'DebitNotesPage'),
});

const newDebitNoteRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/debit-notes/new',
  validateSearch: (search: Record<string, unknown>): { billId?: string; returnId?: string } => ({
    ...(typeof search.billId === 'string' && UUID.test(search.billId) && { billId: search.billId }),
    ...(typeof search.returnId === 'string' &&
      UUID.test(search.returnId) && { returnId: search.returnId }),
  }),
  component: lazyRouteComponent(() => import('./routes/debit-note'), 'NewDebitNotePage'),
});

const debitNoteRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/debit-notes/$debitNoteId',
  component: lazyRouteComponent(() => import('./routes/debit-note'), 'DebitNotePage'),
});

const supplierRefundsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/supplier-refunds',
  component: lazyRouteComponent(() => import('./routes/supplier-refunds'), 'SupplierRefundsPage'),
});

const newSupplierRefundRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/supplier-refunds/new',
  validateSearch: (
    search: Record<string, unknown>,
  ): { debitNoteId?: string; paymentId?: string } => ({
    ...(typeof search.debitNoteId === 'string' &&
      UUID.test(search.debitNoteId) && { debitNoteId: search.debitNoteId }),
    ...(typeof search.paymentId === 'string' &&
      UUID.test(search.paymentId) && { paymentId: search.paymentId }),
  }),
  component: lazyRouteComponent(() => import('./routes/supplier-refund'), 'NewSupplierRefundPage'),
});

const supplierRefundRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/supplier-refunds/$refundId',
  component: lazyRouteComponent(() => import('./routes/supplier-refund'), 'SupplierRefundPage'),
});

const customFieldsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/custom-fields',
  component: lazyRouteComponent(() => import('./routes/custom-fields'), 'CustomFieldsPage'),
});

const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/team',
  component: lazyRouteComponent(() => import('./routes/team'), 'TeamPage'),
});

const rolesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/roles',
  component: lazyRouteComponent(() => import('./routes/roles'), 'RolesPage'),
});

// Step 17a: the approval levels, a workspace setting next to the roles they name
const approvalRulesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/approval-rules',
  component: lazyRouteComponent(() => import('./routes/approval-rules'), 'ApprovalRulesPage'),
});

const auditLogRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/audit-log',
  component: lazyRouteComponent(() => import('./routes/audit-log'), 'AuditLogPage'),
});

// শুধু `pnpm dev`-এ। production build-এ Vite import.meta.env.DEV-কে false বসায়, minifier পুরো
// শাখা মুছে দেয় — import() হারায়, তাই kitchen-sink-এর chunk তৈরিই হয় না
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => appRoute,
        path: '/kitchen-sink',
        component: lazyRouteComponent(() => import('./routes/kitchen-sink'), 'KitchenSinkPage'),
      }),
    ]
  : [];

const routeTree = rootRoute.addChildren([
  loginRoute,
  signUpRoute,
  inviteRoute,
  publicDocumentRoute,
  onboardingRoute,
  appRoute.addChildren([
    dashboardRoute,
    settingsRoute,
    numberingRoute,
    branchesRoute,
    accountsRoute,
    journalRoute,
    newJournalEntryRoute,
    journalEntryRoute,
    ledgerRoute,
    openingBalancesRoute,
    yearEndRoute,
    trialBalanceRoute,
    profitAndLossRoute,
    balanceSheetRoute,
    reportExportsRoute,
    productsRoute,
    newProductRoute,
    productRoute,
    productCategoriesRoute,
    unitsRoute,
    productImportsRoute,
    warehousesRoute,
    stockRoute,
    stockCardRoute,
    stockAdjustmentsRoute,
    newStockAdjustmentRoute,
    stockAdjustmentRoute,
    stockTransfersRoute,
    newStockTransferRoute,
    stockTransferRoute,
    stockBatchesRoute,
    stockReorderRoute,
    stockValuationRoute,
    stockRevaluationsRoute,
    newStockRevaluationRoute,
    stockRevaluationRoute,
    customersRoute,
    newCustomerRoute,
    customerRoute,
    editCustomerRoute,
    customerGroupsRoute,
    priceListsRoute,
    priceListRoute,
    quotationsRoute,
    newQuotationRoute,
    quotationRoute,
    salesOrdersRoute,
    newSalesOrderRoute,
    salesOrderRoute,
    deliveriesRoute,
    newDeliveryRoute,
    deliveryRoute,
    invoicesRoute,
    newInvoiceRoute,
    invoiceRoute,
    receiptsRoute,
    newReceiptRoute,
    receiptRoute,
    salesReturnsRoute,
    newSalesReturnRoute,
    salesReturnRoute,
    creditNotesRoute,
    newCreditNoteRoute,
    creditNoteRoute,
    refundsRoute,
    newRefundRoute,
    refundRoute,
    suppliersRoute,
    newSupplierRoute,
    supplierRoute,
    editSupplierRoute,
    supplierGroupsRoute,
    requisitionsRoute,
    newRequisitionRoute,
    requisitionRoute,
    approvalsRoute,
    syncRoute,
    posRoute,
    posRegistersRoute,
    posSalesRoute,
    posSaleRoute,
    soldShortRoute,
    myDevicesRoute,
    devicesRoute,
    purchaseOrdersRoute,
    newPurchaseOrderRoute,
    purchaseOrderRoute,
    goodsReceiptsRoute,
    newGoodsReceiptRoute,
    goodsReceiptRoute,
    billsRoute,
    newBillRoute,
    billRoute,
    supplierPaymentsRoute,
    newSupplierPaymentRoute,
    supplierPaymentRoute,
    purchaseReturnsRoute,
    newPurchaseReturnRoute,
    purchaseReturnRoute,
    debitNotesRoute,
    newDebitNoteRoute,
    debitNoteRoute,
    supplierRefundsRoute,
    newSupplierRefundRoute,
    supplierRefundRoute,
    customFieldsRoute,
    teamRoute,
    rolesRoute,
    approvalRulesRoute,
    auditLogRoute,
    ...devRoutes,
  ]),
]);

export const router = createRouter({ routeTree });

// <Link to="…"> আর navigate({ to }) এখন route tree থেকে টাইপ পায় — ভুল path compile error
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
