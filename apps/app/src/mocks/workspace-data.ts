import {
  type Account,
  type AuditAction,
  type AuditChanges,
  type AuditEntityType,
  type AuditEntry,
  type AuditValue,
  type Branch,
  DEFAULT_SETTINGS,
  defaultNumberFormat,
  DOCUMENT_TYPES,
  type DocumentType,
  formatDocumentNumber,
  type Notification,
  type NumberFormat,
  type NumberSeries,
  periodOf,
  type SalesAccounts,
  type Settings,
  type Setup,
  type StockAccounts,
  todayIn,
} from '@omnivo/contracts';

import {
  noStockAccounts,
  seedAccounts,
  seedSalesAccounts,
  seedStockAccounts,
} from './accounting-data';
import {
  emptyDocumentOutput,
  type MockDocumentOutput,
  seedDocumentOutput,
} from './document-output-data';
import { OWNER, type Workspace } from './fixtures';
import { emptyBilling, type MockBilling } from './invoice-data';
import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
import { MockProblem } from './mock';
import { type People, seedPeople } from './people-data';
import { emptyCatalog, garmentsCatalog, type MockCatalog, pharmaCatalog } from './product-data';
import { seedPurchaseOrders } from './purchase-order-data';
import type { MockExport } from './report-data';
import { emptyPurchase, type MockPurchase, seedPurchase } from './requisition-data';
import { emptyReturns, type MockReturns } from './return-data';
import { emptySales, type MockSales, seedSales } from './sales-data';
import {
  emptySalesDocuments,
  type MockSalesDocuments,
  seedSalesDocuments,
} from './sales-document-data';
import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
import { emptySuppliers, type MockSuppliers, seedSuppliers } from './supplier-data';

// mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
// নিয়মগুলো আসল API-র মতো (version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) — UI-র error-পথ mock দিয়েও দেখা যায়
export interface WorkspaceData {
  settings: Settings;
  branches: Branch[];
  series: Map<DocumentType, NumberFormat & { version: number }>;
  audit: AuditEntry[];
  people: People;
  setup: Setup;
  // When a started setup "finishes" (ms since epoch) — the pretend worker, see setup-data.ts
  setupReadyAt: number | null;
  notifications: Notification[];
  accounts: Account[];
  journal: MockJournal;
  // "My exports", newest first; the pretend worker finishes them (report-data.ts)
  exports: MockExport[];
  // Units, categories, custom fields, products and imports (step 12)
  catalog: MockCatalog;
  // Warehouses, the stock ledger and its documents (step 13)
  stock: MockStock;
  // The accounts stock documents post to, besides the inventory account (step 14)
  stockAccounts: StockAccounts;
  // VAT rates, customers and their groups, price lists (step 15a)
  sales: MockSales;
  // Quotations, sales orders and deliveries (step 15b)
  salesDocuments: MockSalesDocuments;
  // Invoices and money receipts (step 15c)
  billing: MockBilling;
  // Sales returns, credit notes and refunds (step 15d)
  returns: MockReturns;
  // The account credit notes take sales back from (step 15d, Settings → Sales)
  salesAccounts: SalesAccounts;
  // The PDFs, emails and share links of the documents a customer receives (step 16)
  documentOutput: MockDocumentOutput;
  // Suppliers and their groups (step 17a)
  suppliers: MockSuppliers;
  // Approval levels and rounds, and requisitions (step 17a); purchase orders and goods receipts
  // (step 17b)
  purchase: MockPurchase;
}

function now(): string {
  return new Date().toISOString();
}

function branch(code: string, name: string, address: string, archived = false): Branch {
  return {
    id: crypto.randomUUID(),
    code,
    name,
    phone: '+880 1711-000000',
    address,
    archivedAt: archived ? now() : null,
    version: 1,
    updatedAt: now(),
  };
}

// আসল ইন্ডাস্ট্রির উদাহরণ (CLAUDE.md → Content): গার্মেন্টসের কারখানা আর ডিপো, ফার্মার ডিপো
function seed(workspace: Workspace): WorkspaceData {
  const garments = workspace.slug === 'rahman-garments';
  const data: WorkspaceData = {
    settings: {
      companyName: workspace.name,
      legalName: null,
      bin: garments ? '0001234560101' : null,
      phone: null,
      email: null,
      address: null,
      ...DEFAULT_SETTINGS,
      logo: null,
      allowNegativeStock: false,
      // Step 17b: a receipt takes no more than the order, until the owner allows a little more
      overReceiptPercent: '0.00',
      // The pharmacy sells at the printed MRP, VAT included; the garments maker quotes before VAT
      pricesIncludeVat: !garments,
      version: 1,
    },
    branches: garments
      ? [
          branch('HO', 'Head office', 'House 42, Road 11, Banani, Dhaka 1213'),
          branch('GZP', 'Gazipur factory', 'BSCIC Industrial Area, Konabari, Gazipur 1751'),
          branch('CTG', 'Chattogram depot', 'Port Connecting Road, Chattogram 4100'),
          branch('NGJ', 'Narayanganj dyeing unit', 'Fatullah, Narayanganj 1421', true),
        ]
      : [branch('HO', 'Head office', 'Tejgaon Industrial Area, Dhaka 1208')],
    series: new Map(),
    audit: [],
    people: seedPeople(workspace),
    // The fixture workspaces were set up long ago; a signed-up one starts at 'pending'
    setup: { status: 'ready', industry: garments ? 'garments' : 'pharma' },
    setupReadyAt: null,
    notifications: garments ? seedNotifications() : [],
    accounts: seedAccounts(garments ? 'garments' : 'pharma'),
    stockAccounts: noStockAccounts(),
    journal: emptyJournal(),
    exports: [],
    catalog: garments ? garmentsCatalog() : pharmaCatalog(),
    stock: emptyStock(),
    sales: emptySales(),
    salesDocuments: emptySalesDocuments(),
    billing: emptyBilling(),
    returns: emptyReturns(),
    salesAccounts: { returns: null },
    documentOutput: emptyDocumentOutput(),
    suppliers: emptySuppliers(),
    purchase: emptyPurchase(),
  };
  data.stockAccounts = seedStockAccounts(data.accounts, garments ? 'garments' : 'pharma');
  data.salesAccounts = seedSalesAccounts(data.accounts);
  // Before the journal: its receivable lines name the customers, its payable lines the suppliers
  seedSales(data, garments);
  seedSuppliers(data, garments);
  if (garments) seedJournal(data);
  seedStock(data, garments);
  // After the stock: an order is sent from a warehouse
  seedSalesDocuments(data, garments);
  // After the quotations: the history belongs to one of them
  seedDocumentOutput(data, garments);
  // After the stock and the team: the lines' costs are its averages, the rounds name members
  seedPurchase(data, garments);
  // After the requisitions: the approval levels and the people are theirs
  seedPurchaseOrders(data, garments);
  record(data, 'workspace.created', 'workspace', workspace.tenantId, {
    name: { from: null, to: workspace.name },
  });
  return data;
}

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

// One of each type, two unread — the bell has something to show from the first page load
function seedNotifications(): Notification[] {
  return [
    {
      id: crypto.randomUUID(),
      type: 'member.joined',
      params: { name: 'Nasrin Akter' },
      readAt: null,
      createdAt: ago(12),
    },
    {
      id: crypto.randomUUID(),
      type: 'invitation.failed',
      params: { email: 'rupa@rahmangarments.bounce' },
      readAt: null,
      createdAt: ago(95),
    },
    {
      id: crypto.randomUUID(),
      type: 'workspace.ready',
      params: {},
      readAt: ago(60 * 24),
      createdAt: ago(60 * 26),
    },
  ];
}

const store = new Map<string, WorkspaceData>();

// Mock sign-up: the first fixture workspace starts over as a brand-new one — the owner alone, the
// Owner role only, setup 'pending' — so `pnpm dev:mock` shows the onboarding wizard after sign-up
export function startFresh(workspace: Workspace, companyName: string): void {
  const data = seed(workspace);
  data.settings = { ...data.settings, companyName, bin: null };
  data.branches = data.branches.slice(0, 1);
  data.people = {
    roles: data.people.roles.filter((role) => role.kind === 'owner'),
    members: data.people.members.filter((member) => member.userId === OWNER.id),
    invitations: [],
  };
  data.setup = { status: 'pending', industry: null };
  data.notifications = [];
  // A new workspace has no chart until its setup job runs (settleSetup)
  data.accounts = [];
  data.stockAccounts = noStockAccounts();
  data.salesAccounts = { returns: null };
  data.journal = emptyJournal();
  data.exports = [];
  // Like the chart: the setup job brings the units and categories (settleSetup)
  data.catalog = emptyCatalog();
  // The VAT rates come with the setup job too (settleSetup); customers are the company's own
  data.sales = emptySales();
  data.suppliers = emptySuppliers();
  data.purchase = emptyPurchase();
  // Sign-up gives a new workspace its Main store, in its one branch (like auth.service.ts)
  data.stock = emptyStock();
  const [first] = data.branches;
  if (first) data.stock.warehouses = [warehouse(first.id, 'MAIN', 'Main store', null)];
  store.set(workspace.tenantId, data);
}

// The API's transaction, for the mock's postings that change many things at once (step 15c: an
// invoice posts a challan, moves stock, marks lines billed and books the sale, and the credit check
// comes last; step 15d: a return puts stock back and moves its challan and order). If fn throws,
// the parts it can change are put back as they were, so a refused posting leaves nothing behind:
// no number used, no stock moved. Only these parts are copied: the garments catalog alone holds
// 10,000 products.
export function transaction<T>(data: WorkspaceData, fn: () => T): T {
  const before = structuredClone({
    journal: data.journal,
    stock: data.stock,
    salesDocuments: data.salesDocuments,
    billing: data.billing,
    returns: data.returns,
    // Step 17b: a goods receipt moves its order's received quantities and takes a number
    purchase: data.purchase,
    audit: data.audit,
  });
  try {
    return fn();
  } catch (error) {
    Object.assign(data, before);
    throw error;
  }
}

export function dataOf(workspace: Workspace): WorkspaceData {
  let data = store.get(workspace.tenantId);
  if (!data) {
    data = seed(workspace);
    store.set(workspace.tenantId, data);
  }
  return data;
}

export function record(
  data: WorkspaceData,
  action: AuditAction,
  entityType: AuditEntityType,
  entityId: string,
  changes: AuditChanges = {},
): void {
  // নতুন আগে — আসল API-র ক্রম
  data.audit.unshift({
    id: crypto.randomUUID(),
    action,
    entityType,
    entityId,
    actor: { id: OWNER.id, fullName: OWNER.fullName },
    changes,
    ipAddress: '103.4.145.2',
    requestId: crypto.randomUUID(),
    createdAt: now(),
  });
}

type Snapshot = Record<string, AuditValue>;

// API-র common/audit/audit.ts-এর মতো: শুধু যা বদলেছে
export function diff(before: Snapshot, after: Snapshot): AuditChanges {
  const changes: AuditChanges = {};
  for (const [field, to] of Object.entries(after)) {
    const from = before[field] ?? null;
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

export function checkVersion(actual: number, sent: number): void {
  if (actual !== sent) throw new MockProblem(409, 'version_conflict');
}

export function findBranch(data: WorkspaceData, id: string): Branch {
  const found = data.branches.find((candidate) => candidate.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertCodeFree(data: WorkspaceData, code: string, except?: string): void {
  if (data.branches.some((other) => other.code === code && other.id !== except)) {
    throw new MockProblem(409, 'branch_code_taken', { code: ['branch_code_taken'] });
  }
}

function usedNumbers(data: WorkspaceData, documentType: DocumentType, period: string): number {
  if (documentType === 'accounting.journal') return data.journal.counters.get(period) ?? 0;
  if (documentType === 'inventory.adjustment') return data.stock.counters.adjustment;
  if (documentType === 'inventory.transfer') return data.stock.counters.transfer;
  if (documentType === 'inventory.revaluation') return data.stock.counters.revaluation;
  if (documentType === 'sales.customer') return data.sales.lastCode;
  if (documentType === 'sales.quotation') return data.salesDocuments.counters.quotation;
  if (documentType === 'sales.order') return data.salesDocuments.counters.order;
  if (documentType === 'sales.delivery') return data.salesDocuments.counters.delivery;
  if (documentType === 'sales.invoice') return data.billing.counters.invoice;
  if (documentType === 'sales.receipt') return data.billing.counters.receipt;
  if (documentType === 'sales.return') return data.returns.counters.salesReturn;
  if (documentType === 'sales.credit_note') return data.returns.counters.creditNote;
  if (documentType === 'sales.refund') return data.returns.counters.refund;
  if (documentType === 'purchase.supplier') return data.suppliers.lastCode;
  if (documentType === 'purchase.requisition') return data.purchase.counters.requisition;
  return 0;
}

export function seriesList(data: WorkspaceData): NumberSeries[] {
  const period = (format: NumberFormat) =>
    periodOf(todayIn(data.settings.timezone), format.yearStyle, data.settings.fiscalYearStartMonth);
  return DOCUMENT_TYPES.map((documentType) => {
    const saved = data.series.get(documentType);
    const format = saved ?? defaultNumberFormat(documentType);
    return {
      documentType,
      ...format,
      version: saved?.version ?? 0,
      // Journal entries, stock documents and customer codes get numbers in the mock; the rest
      // start at 1
      nextNumber: formatDocumentNumber(
        format,
        period(format),
        usedNumbers(data, documentType, period(format)) + 1,
      ),
    };
  });
}
