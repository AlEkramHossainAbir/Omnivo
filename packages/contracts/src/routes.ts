import { z } from 'zod';

import { accountRoutes } from './accounts.js';
import { approvalRoutes, approvalRuleRoutes } from './approvals.js';
import { attachmentRoutes } from './attachments.js';
import { auditRoutes } from './audit.js';
import { authRoutes } from './auth.js';
import { billRoutes } from './bills.js';
import { branchRoutes } from './branches.js';
import { defineRoute } from './http.js';
import { invitationRoutes } from './invitations.js';
import { invoiceRoutes } from './invoices.js';
import { journalRoutes, ledgerRoutes, openingBalanceRoutes, periodLockRoutes } from './journal.js';
import { memberRoutes } from './members.js';
import { notificationRoutes } from './notifications.js';
import { numberSeriesRoutes } from './numbering.js';
import { meRoutes } from './preferences.js';
import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js';
import { creditNoteRoutes } from './credit-notes.js';
import { customFieldRoutes } from './custom-fields.js';
import { customerGroupRoutes, customerRoutes } from './customers.js';
import { deliveryRoutes } from './deliveries.js';
import { documentOutputRoutes, publicDocumentRoutes } from './document-output.js';
import { goodsReceiptRoutes } from './goods-receipts.js';
import { priceListRoutes } from './price-lists.js';
import { productCategoryRoutes } from './product-categories.js';
import { productImportRoutes } from './product-imports.js';
import { productRoutes } from './products.js';
import { purchaseCostRoutes } from './purchase.js';
import { purchaseAccountRoutes } from './purchase-accounts.js';
import { purchaseOrderRoutes } from './purchase-orders.js';
import { quotationRoutes } from './quotations.js';
import { receiptRoutes } from './receipts.js';
import { refundRoutes } from './refunds.js';
import { requisitionLineRoutes, requisitionRoutes } from './requisitions.js';
import { roleRoutes } from './roles.js';
import { salesAccountRoutes } from './sales-accounts.js';
import { salesOrderRoutes } from './sales-orders.js';
import { salesReturnRoutes } from './sales-returns.js';
import { salesPriceRoutes } from './sales.js';
import { settingsRoutes } from './settings.js';
import { setupRoutes } from './setup.js';
import { stockAccountRoutes } from './stock-accounts.js';
import { stockAdjustmentRoutes } from './stock-adjustments.js';
import { stockRevaluationRoutes } from './stock-revaluations.js';
import { stockTransferRoutes } from './stock-transfers.js';
import { stockRoutes } from './stock.js';
import { supplierPaymentRoutes } from './supplier-payments.js';
import { supplierGroupRoutes, supplierRoutes } from './suppliers.js';
import { taxRateRoutes } from './tax-rates.js';
import { unitRoutes } from './units.js';
import { warehouseRoutes } from './warehouses.js';

export const healthRoutes = {
  check: defineRoute({
    method: 'GET',
    path: '/health',
    summary: 'Liveness check',
    auth: 'public',
    status: 200,
    response: z.object({ status: z.literal('ok') }),
  }),
};

// API-র প্রতিটা endpoint এখানে। নতুন মডিউল = এখানে এক লাইন; API-র টেস্ট দেখে যে Nest-এর রুট আর
// এই তালিকা হুবহু মেলে, আর OpenAPI স্পেক এই তালিকা থেকেই লেখা হয়
export const routes = {
  health: healthRoutes,
  auth: authRoutes,
  me: meRoutes,
  members: memberRoutes,
  invitations: invitationRoutes,
  roles: roleRoutes,
  settings: settingsRoutes,
  branches: branchRoutes,
  numberSeries: numberSeriesRoutes,
  audit: auditRoutes,
  attachments: attachmentRoutes,
  setup: setupRoutes,
  notifications: notificationRoutes,
  accounts: accountRoutes,
  journal: journalRoutes,
  ledger: ledgerRoutes,
  openingBalances: openingBalanceRoutes,
  periodLock: periodLockRoutes,
  reports: reportRoutes,
  fiscalYears: fiscalYearRoutes,
  reportExports: reportExportRoutes,
  units: unitRoutes,
  productCategories: productCategoryRoutes,
  customFields: customFieldRoutes,
  products: productRoutes,
  productImports: productImportRoutes,
  warehouses: warehouseRoutes,
  stock: stockRoutes,
  stockAdjustments: stockAdjustmentRoutes,
  stockTransfers: stockTransferRoutes,
  stockRevaluations: stockRevaluationRoutes,
  stockAccounts: stockAccountRoutes,
  taxRates: taxRateRoutes,
  customers: customerRoutes,
  customerGroups: customerGroupRoutes,
  priceLists: priceListRoutes,
  salesPrices: salesPriceRoutes,
  quotations: quotationRoutes,
  salesOrders: salesOrderRoutes,
  deliveries: deliveryRoutes,
  invoices: invoiceRoutes,
  receipts: receiptRoutes,
  salesReturns: salesReturnRoutes,
  creditNotes: creditNoteRoutes,
  refunds: refundRoutes,
  salesAccounts: salesAccountRoutes,
  documentOutput: documentOutputRoutes,
  publicDocuments: publicDocumentRoutes,
  suppliers: supplierRoutes,
  supplierGroups: supplierGroupRoutes,
  approvalRules: approvalRuleRoutes,
  approvals: approvalRoutes,
  purchaseCosts: purchaseCostRoutes,
  requisitions: requisitionRoutes,
  requisitionLines: requisitionLineRoutes,
  purchaseOrders: purchaseOrderRoutes,
  goodsReceipts: goodsReceiptRoutes,
  bills: billRoutes,
  supplierPayments: supplierPaymentRoutes,
  purchaseAccounts: purchaseAccountRoutes,
};
