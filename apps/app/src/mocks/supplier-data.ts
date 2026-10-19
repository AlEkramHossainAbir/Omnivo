import {
  defaultNumberFormat,
  type ErrorCode,
  formatDocumentNumber,
  type LanguageCode,
  periodOf,
  type Supplier,
  type SupplierBankAccount,
  type SupplierGroup,
  type SupplierInput,
  type SupplierSort,
  type SupplierStatus,
  type SupplierSummary,
  subtractMoney,
  sumMoney,
  todayIn,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
import type { MockCustomer } from './sales-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 17a suppliers and their groups. The API's rules (suppliers.service.ts,
// supplier-groups.service.ts) on plain arrays, like sales-data.ts does for customers.
//
// The API keeps a party that is both a customer and a supplier as one row. The mock keeps the
// customer in sales.customers and the supplier here, under the same id, and copies the fields they
// share from the side that was saved to the other one (copyToSupplier, copyToCustomer). So the
// version a page sends back is the party's version, whichever side it came from.

// A supplier as stored: the balance is worked out from the books on every read
export type MockSupplier = Omit<Supplier, 'balance'>;
export type MockSupplierGroup = Omit<SupplierGroup, 'supplierCount'>;

export interface MockSuppliers {
  groups: MockSupplierGroup[];
  suppliers: MockSupplier[];
  // The last number given from the 'purchase.supplier' series
  lastCode: number;
}

export function emptySuppliers(): MockSuppliers {
  return { groups: [], suppliers: [], lastCode: 0 };
}

function now(): string {
  return new Date().toISOString();
}

// --- Seed ---------------------------------------------------------------------------------------

function group(name: string): MockSupplierGroup {
  return { id: crypto.randomUUID(), name, version: 1, updatedAt: now() };
}

interface SupplierParts {
  name: string;
  group: MockSupplierGroup | null;
  contactPerson?: string;
  phone?: string;
  email?: string;
  bin?: string;
  paymentTermsDays: number;
  address?: string;
  bankAccounts?: Omit<SupplierBankAccount, 'id'>[];
  documentLanguage?: LanguageCode;
}

function supplier(suppliers: MockSuppliers, parts: SupplierParts): MockSupplier {
  suppliers.lastCode += 1;
  return {
    id: crypto.randomUUID(),
    code: formatDocumentNumber(defaultNumberFormat('purchase.supplier'), '', suppliers.lastCode),
    name: parts.name,
    groupId: parts.group?.id ?? null,
    contactPerson: parts.contactPerson ?? null,
    phone: parts.phone ?? null,
    email: parts.email ?? null,
    documentLanguage: parts.documentLanguage ?? 'en',
    bin: parts.bin ?? null,
    paymentTermsDays: parts.paymentTermsDays,
    address: parts.address ?? null,
    bankAccounts: (parts.bankAccounts ?? []).map((account) => ({
      id: crypto.randomUUID(),
      ...account,
    })),
    notes: null,
    isCustomer: false,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
}

// Real-looking vendors (CLAUDE.md → Content). The garments maker buys yarn and fabric, trims and
// cartons; seedJournal() names Meghna on last year's payable line, so it owes Meghna from the first
// page load. The pharma distributor buys from manufacturers. Before seedJournal(): its payable
// lines name a supplier.
export function seedSuppliers(data: WorkspaceData, garments: boolean): void {
  const suppliers = data.suppliers;
  if (garments) {
    const yarn = group('Yarn and fabric');
    const accessories = group('Accessories');
    const packaging = group('Packaging');
    suppliers.groups = [yarn, accessories, packaging];
    suppliers.suppliers = [
      supplier(suppliers, {
        name: 'Meghna Spinning Mills Ltd.',
        group: yarn,
        contactPerson: 'Md. Rafiqul Islam',
        phone: '+880 1711-234567',
        email: 'sales@meghnaspinning.com',
        bin: '0005678900101',
        paymentTermsDays: 60,
        address: 'Plot 12, BSCIC Industrial Area, Fatullah, Narayanganj 1421',
        bankAccounts: [
          {
            bankName: 'Dutch-Bangla Bank',
            branchName: 'Narayanganj',
            accountName: 'Meghna Spinning Mills Ltd.',
            accountNumber: '1071100023456',
            routingNumber: '090670725',
          },
        ],
      }),
      supplier(suppliers, {
        name: 'Unitex Trims & Accessories',
        group: accessories,
        contactPerson: 'Shahana Parvin',
        phone: '+880 1819-456789',
        paymentTermsDays: 30,
        address: 'House 18, Road 3, Sector 7, Uttara, Dhaka 1230',
        documentLanguage: 'bn',
      }),
      supplier(suppliers, {
        name: 'Gazipur Carton Industries',
        group: packaging,
        phone: '+880 1552-889900',
        paymentTermsDays: 0,
        address: 'Board Bazar, Gazipur 1704',
      }),
    ];
    return;
  }
  const makers = group('Manufacturers');
  suppliers.groups = [makers, group('Importers')];
  suppliers.suppliers = [
    supplier(suppliers, {
      name: 'Beximco Pharmaceuticals Ltd.',
      group: makers,
      contactPerson: 'Tareq Aziz',
      phone: '+880 2-58611001',
      bin: '0006789010202',
      paymentTermsDays: 45,
      address: '19 Dhanmondi R/A, Road 7, Dhaka 1205',
    }),
    supplier(suppliers, {
      name: 'Incepta Pharmaceuticals Ltd.',
      group: makers,
      phone: '+880 2-8891688',
      paymentTermsDays: 30,
      address: '40 Shahid Tajuddin Ahmed Sarani, Tejgaon I/A, Dhaka 1208',
    }),
  ];
}

// --- Balances -----------------------------------------------------------------------------------

function isPayable(data: WorkspaceData, accountId: string): boolean {
  return data.accounts.some(
    (account) => account.id === accountId && account.purpose === 'accounts_payable',
  );
}

// Debit − credit of the supplier's posted payable lines, like the API's subquery: negative while
// the company owes (a bill is a credit). The app turns the sign round to say "You owe".
export function supplierBalanceOf(data: WorkspaceData, partyId: string): string {
  const lines = data.journal.entries
    .filter((entry) => entry.status === 'posted')
    .flatMap((entry) => entry.lines)
    .filter((line) => line.party?.id === partyId && isPayable(data, line.accountId));
  return subtractMoney(
    sumMoney(lines.map((line) => line.debit)),
    sumMoney(lines.map((line) => line.credit)),
  );
}

// The owner sees every balance; someone without purchase.supplier.balance would get null
export function toSupplier(data: WorkspaceData, stored: MockSupplier): Supplier {
  return { ...stored, balance: supplierBalanceOf(data, stored.id) };
}

export function supplierSummaryOf(data: WorkspaceData, stored: MockSupplier): SupplierSummary {
  return {
    id: stored.id,
    code: stored.code,
    name: stored.name,
    groupId: stored.groupId,
    contactPerson: stored.contactPerson,
    phone: stored.phone,
    paymentTermsDays: stored.paymentTermsDays,
    isCustomer: stored.isCustomer,
    balance: supplierBalanceOf(data, stored.id),
    archivedAt: stored.archivedAt,
    updatedAt: stored.updatedAt,
  };
}

export function findSupplier(data: WorkspaceData, id: string): MockSupplier {
  const found = data.suppliers.suppliers.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// The API's filters and orders, on an array, like listCustomers()
export function listSuppliers(
  data: WorkspaceData,
  query: {
    search?: string | undefined;
    groupId?: string | undefined;
    status: SupplierStatus;
    sort: SupplierSort;
  },
): MockSupplier[] {
  const search = query.search?.toLowerCase() ?? '';
  const lower = (value: string | null) => value?.toLowerCase() ?? '';
  const found = data.suppliers.suppliers.filter(
    (item) =>
      (query.status === 'archived') === (item.archivedAt !== null) &&
      (query.groupId === undefined || item.groupId === query.groupId) &&
      (search === '' ||
        lower(item.name).includes(search) ||
        lower(item.code).includes(search) ||
        lower(item.contactPerson).includes(search) ||
        (item.phone ?? '').includes(query.search ?? '')),
  );
  const by = {
    name: (a: MockSupplier, b: MockSupplier) => lower(a.name).localeCompare(lower(b.name)),
    '-name': (a: MockSupplier, b: MockSupplier) => lower(b.name).localeCompare(lower(a.name)),
    code: (a: MockSupplier, b: MockSupplier) => lower(a.code).localeCompare(lower(b.code)),
    '-code': (a: MockSupplier, b: MockSupplier) => lower(b.code).localeCompare(lower(a.code)),
    '-updated': (a: MockSupplier, b: MockSupplier) => b.updatedAt.localeCompare(a.updatedAt),
  };
  return found.sort(by[query.sort]);
}

// --- Saving -------------------------------------------------------------------------------------

function fieldProblem(status: number, code: ErrorCode, field: string): MockProblem {
  return new MockProblem(status, status === 409 ? code : 'invalid_input', { [field]: [code] });
}

// One code per party, whichever side it is (the API's parties_tenant_code_idx): a supplier cannot
// take a customer's code, except its own customer side's
export function partyCodeTaken(data: WorkspaceData, code: string, except?: string): boolean {
  const same = (item: { id: string; code: string }) =>
    item.id !== except && item.code.toLowerCase() === code.toLowerCase();
  return data.sales.customers.some(same) || data.suppliers.suppliers.some(same);
}

// The next free code from the 'purchase.supplier' series; a code someone typed is skipped
function newCode(data: WorkspaceData): string {
  const format = data.series.get('purchase.supplier') ?? defaultNumberFormat('purchase.supplier');
  const period = periodOf(
    todayIn(data.settings.timezone),
    format.yearStyle,
    data.settings.fiscalYearStartMonth,
  );
  for (;;) {
    data.suppliers.lastCode += 1;
    const code = formatDocumentNumber(format, period, data.suppliers.lastCode);
    if (!partyCodeTaken(data, code)) return code;
  }
}

// Create (no `existing`) or update. The bank accounts sent replace the old ones: one sent back
// with its id keeps it, one with an id that is not this supplier's becomes a new one (the API's
// diff by id). The contract has already cleaned the numbers.
export function saveSupplier(
  data: WorkspaceData,
  input: SupplierInput,
  existing?: MockSupplier,
): MockSupplier {
  if (input.groupId !== null && !data.suppliers.groups.some((item) => item.id === input.groupId)) {
    throw fieldProblem(400, 'supplier_group_invalid', 'groupId');
  }
  const code = input.code ?? existing?.code ?? newCode(data);
  if (partyCodeTaken(data, code, existing?.id)) {
    throw fieldProblem(409, 'supplier_code_taken', 'code');
  }
  const own = new Set(existing?.bankAccounts.map((account) => account.id));
  return {
    id: existing?.id ?? crypto.randomUUID(),
    code,
    name: input.name,
    groupId: input.groupId,
    contactPerson: input.contactPerson,
    phone: input.phone,
    email: input.email,
    documentLanguage: input.documentLanguage,
    bin: input.bin,
    paymentTermsDays: input.paymentTermsDays,
    address: input.address,
    bankAccounts: input.bankAccounts.map((account) => ({
      id: account.id !== null && own.has(account.id) ? account.id : crypto.randomUUID(),
      bankName: account.bankName,
      branchName: account.branchName,
      accountName: account.accountName,
      accountNumber: account.accountNumber,
      routingNumber: account.routingNumber,
    })),
    notes: input.notes,
    isCustomer: existing?.isCustomer ?? false,
    archivedAt: existing?.archivedAt ?? null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
}

// --- A party on both sides ----------------------------------------------------------------------

// The party's own fields: one value for both sides
function sharedOf(side: MockCustomer | MockSupplier) {
  return {
    code: side.code,
    name: side.name,
    contactPerson: side.contactPerson,
    phone: side.phone,
    email: side.email,
    documentLanguage: side.documentLanguage,
    bin: side.bin,
    notes: side.notes,
    archivedAt: side.archivedAt,
    version: side.version,
    updatedAt: side.updatedAt,
  };
}

// The supplier's address is the party's billing address (decision 31)
function billingOf(customer: MockCustomer): string | null {
  return customer.addresses.find((address) => address.kind === 'billing')?.address ?? null;
}

// After a customer save: its supplier side (if any) gets the shared fields and the billing address
export function copyToSupplier(data: WorkspaceData, customer: MockCustomer): void {
  const found = data.suppliers.suppliers.find((item) => item.id === customer.id);
  if (found) Object.assign(found, sharedOf(customer), { address: billingOf(customer) });
}

// After a supplier save: its customer side (if any) gets the shared fields. The address becomes
// the billing address's text: it keeps its label and phone, null removes it, and a new one is put
// first (the API's suppliers.service.ts saveAddress()).
export function copyToCustomer(data: WorkspaceData, saved: MockSupplier): void {
  const found = data.sales.customers.find((item) => item.id === saved.id);
  if (!found) return;
  const billing = found.addresses.find((address) => address.kind === 'billing');
  const shipping = found.addresses.filter((address) => address.kind !== 'billing');
  const address =
    saved.address === null
      ? []
      : [
          billing
            ? { ...billing, address: saved.address }
            : {
                id: crypto.randomUUID(),
                kind: 'billing',
                label: null,
                address: saved.address,
                phone: null,
              },
        ];
  Object.assign(found, sharedOf(saved), { addresses: [...address, ...shipping] });
}

// "Make supplier too" (decision 37): the same party, now also a supplier, with the supplier's own
// fields at their defaults
export function makeSupplier(data: WorkspaceData, customer: MockCustomer): MockSupplier {
  if (customer.isSupplier) throw new MockProblem(409, 'party_role_exists');
  const version = customer.version + 1;
  customer.isSupplier = true;
  customer.version = version;
  customer.updatedAt = now();
  const created: MockSupplier = {
    ...sharedOf(customer),
    id: customer.id,
    groupId: null,
    paymentTermsDays: 0,
    address: billingOf(customer),
    bankAccounts: [],
    isCustomer: true,
  };
  data.suppliers.suppliers.push(created);
  return created;
}

// "Make customer too": the customer's own fields at their defaults (no group, terms 0, no limit,
// no price list), and the supplier's address as its billing address
export function makeCustomer(data: WorkspaceData, saved: MockSupplier): MockCustomer {
  if (saved.isCustomer) throw new MockProblem(409, 'party_role_exists');
  saved.isCustomer = true;
  saved.version += 1;
  saved.updatedAt = now();
  const created: MockCustomer = {
    ...sharedOf(saved),
    id: saved.id,
    groupId: null,
    paymentTermsDays: 0,
    creditLimit: null,
    priceListId: null,
    addresses: [],
    isSupplier: true,
  };
  data.sales.customers.push(created);
  copyToCustomer(data, saved);
  return created;
}

// Deleting a supplier: only one nothing uses. A party that is also a customer stays as a customer:
// only its supplier side goes, if no payable line names it (the API's dropSupplierSide). A
// supplier-only party is used by any line that names it (journal_lines_party_fk). Step 17b: a
// purchase order or a goods receipt, drafts too, uses it either way (purchase_orders_supplier_fk,
// goods_receipts_supplier_fk).
export function removeSupplier(data: WorkspaceData, target: MockSupplier): void {
  const lines = data.journal.entries.flatMap((entry) => entry.lines);
  const used = target.isCustomer
    ? lines.some((line) => line.party?.id === target.id && isPayable(data, line.accountId))
    : lines.some((line) => line.party?.id === target.id);
  const ordered = [...data.purchase.orders, ...data.purchase.receipts].some(
    (document) => document.supplier.id === target.id,
  );
  if (used || ordered) throw new MockProblem(409, 'supplier_in_use');
  data.suppliers.suppliers = data.suppliers.suppliers.filter((item) => item.id !== target.id);
  const customer = data.sales.customers.find((item) => item.id === target.id);
  if (customer) {
    Object.assign(customer, { isSupplier: false, version: customer.version + 1, updatedAt: now() });
  }
}

// --- Supplier groups ----------------------------------------------------------------------------

export function toSupplierGroup(data: WorkspaceData, stored: MockSupplierGroup): SupplierGroup {
  return {
    ...stored,
    // Archived suppliers count too: they keep their group
    supplierCount: data.suppliers.suppliers.filter((item) => item.groupId === stored.id).length,
  };
}

export function findSupplierGroup(data: WorkspaceData, id: string): MockSupplierGroup {
  const found = data.suppliers.groups.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertSupplierGroupNameFree(
  data: WorkspaceData,
  name: string,
  except?: string,
): void {
  const taken = data.suppliers.groups.some(
    (item) => item.id !== except && item.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    throw new MockProblem(409, 'supplier_group_name_taken', {
      name: ['supplier_group_name_taken'],
    });
  }
}
