import {
  type Customer,
  type CustomerGroup,
  type CustomerInput,
  type CustomerSort,
  type CustomerStatus,
  type CustomerSummary,
  defaultNumberFormat,
  type ErrorCode,
  formatDocumentNumber,
  type PartyRef,
  periodOf,
  type PriceList,
  type PriceListItem,
  type SetPriceListItemsInput,
  subtractMoney,
  sumMoney,
  type TaxRate,
  type TaxRateInput,
  todayIn,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
import type { MockCatalog } from './product-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 15a: VAT rates, customers and their groups, price lists. The API's rules
// (tax-rates.service.ts, customers.service.ts, price-lists.service.ts) on plain arrays, so
// `pnpm dev:mock` and the e2e tests walk the same paths as the real API.

// A customer as stored: the balance is worked out from the books on every read, like the API's
// subquery, so a posted entry shows up in it at once
export type MockCustomer = Omit<Customer, 'balance'>;
export type MockGroup = Omit<CustomerGroup, 'customerCount'>;
export type MockPriceList = Omit<PriceList, 'itemCount' | 'customerCount'>;

// One price: the API's price_list_items row. The product's name, code and SKU are looked up on
// read, so a renamed product shows its new name.
export interface MockPriceItem {
  priceListId: string;
  productId: string;
  variantId: string;
  unitId: string;
  price: string;
  updatedAt: string;
}

export interface MockSales {
  taxRates: TaxRate[];
  groups: MockGroup[];
  customers: MockCustomer[];
  priceLists: MockPriceList[];
  priceItems: MockPriceItem[];
  // The last number given from the 'sales.customer' series
  lastCode: number;
}

function now(): string {
  return new Date().toISOString();
}

// "15" → "15.00", "18500" → "18500.0000": the way Postgres sends NUMERIC(5,2) and NUMERIC(19,4)
function percent(value: string): string {
  return Number(value).toFixed(2);
}

function money(value: string): string {
  return Number(value).toFixed(4);
}

export function emptySales(): MockSales {
  return { taxRates: [], groups: [], customers: [], priceLists: [], priceItems: [], lastCode: 0 };
}

// The API's TAX_RATES template (apps/api/src/setup/templates.ts): what the setup job gives a new
// workspace, and what migration 0026 gave the old ones
export function startingTaxRates(): TaxRate[] {
  const rate = (name: string, kind: string, value: string, isDefault = false): TaxRate => ({
    id: crypto.randomUUID(),
    name,
    kind,
    rate: percent(value),
    isDefault,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  });
  return [
    rate('VAT 15%', 'standard', '15', true),
    rate('VAT 10%', 'reduced', '10'),
    rate('VAT 7.5%', 'reduced', '7.5'),
    rate('VAT 5%', 'reduced', '5'),
    rate('Zero-rated', 'zero_rated', '0'),
    rate('Exempt', 'exempt', '0'),
  ];
}

// --- Seed ---------------------------------------------------------------------------------------

function group(name: string): MockGroup {
  return { id: crypto.randomUUID(), name, version: 1, updatedAt: now() };
}

function priceList(name: string, description: string | null): MockPriceList {
  return {
    id: crypto.randomUUID(),
    name,
    description,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
}

interface CustomerParts {
  name: string;
  group: MockGroup | null;
  contactPerson?: string;
  phone?: string;
  email?: string;
  bin?: string;
  paymentTermsDays: number;
  creditLimit: string | null;
  priceList?: MockPriceList;
  billing?: string;
  shipping?: [label: string, address: string][];
  archived?: boolean;
}

function customer(sales: MockSales, parts: CustomerParts): MockCustomer {
  sales.lastCode += 1;
  return {
    id: crypto.randomUUID(),
    code: formatDocumentNumber(defaultNumberFormat('sales.customer'), '', sales.lastCode),
    name: parts.name,
    groupId: parts.group?.id ?? null,
    contactPerson: parts.contactPerson ?? null,
    phone: parts.phone ?? null,
    email: parts.email ?? null,
    bin: parts.bin ?? null,
    paymentTermsDays: parts.paymentTermsDays,
    creditLimit: parts.creditLimit === null ? null : money(parts.creditLimit),
    priceListId: parts.priceList?.id ?? null,
    notes: null,
    addresses: [
      ...(parts.billing === undefined
        ? []
        : [
            {
              id: crypto.randomUUID(),
              kind: 'billing',
              label: null,
              address: parts.billing,
              phone: null,
            },
          ]),
      ...(parts.shipping ?? []).map(([label, address]) => ({
        id: crypto.randomUUID(),
        kind: 'shipping',
        label,
        address,
        phone: null,
      })),
    ],
    isSupplier: false,
    archivedAt: parts.archived ? now() : null,
    version: 1,
    updatedAt: now(),
  };
}

// A price for every active variant of a product, in one of its units
function pricesFor(
  catalog: MockCatalog,
  list: MockPriceList,
  code: string,
  unitCode: string,
  price: string,
): MockPriceItem[] {
  const product = catalog.products.find((item) => item.code === code);
  const unit = catalog.units.find((item) => item.code === unitCode);
  if (!product || !unit) throw new Error(`The mock catalog has no ${code} in ${unitCode}`);
  return product.variants.map((variant) => ({
    priceListId: list.id,
    productId: product.id,
    variantId: variant.id,
    unitId: unit.id,
    price: money(price),
    updatedAt: now(),
  }));
}

// Real-looking buyers (CLAUDE.md → Content). The garments workspace sells to export buyers, whose
// receivable lines are in its seeded journal (seedJournal names H&M and Primark), and to a few
// local ones. The pharma workspace sells to pharmacies and hospitals at a pharmacy price, with
// medicine exempt from VAT.
export function seedSales(data: WorkspaceData, garments: boolean): void {
  const sales = data.sales;
  sales.taxRates = startingTaxRates();
  if (garments) {
    const exportBuyers = group('Export buyers');
    const local = group('Local buyers');
    const houses = group('Buying houses');
    const fob = priceList('Export FOB', 'FOB Chattogram prices for export buyers, before VAT');
    const wholesale = priceList('Local wholesale', null);
    sales.groups = [exportBuyers, local, houses];
    sales.priceLists = [fob, wholesale];
    sales.priceItems = [
      ...pricesFor(data.catalog, fob, 'ST-118', 'pcs', '585'),
      ...pricesFor(data.catalog, fob, 'ST-118', 'dozen', '6900'),
      ...pricesFor(data.catalog, wholesale, 'P-00001', 'pcs', '290'),
      ...pricesFor(data.catalog, wholesale, 'P-00004', 'carton', '2750'),
    ];
    sales.customers = [
      customer(sales, {
        name: 'H&M Hennes & Mauritz GBC AB',
        group: exportBuyers,
        contactPerson: 'Anna Lindqvist',
        phone: '+46 8 796 55 00',
        email: 'sourcing.dhaka@hm.com',
        paymentTermsDays: 90,
        creditLimit: '50000000',
        priceList: fob,
        billing: 'Mäster Samuelsgatan 46A, 106 38 Stockholm, Sweden',
        shipping: [['Chattogram port', 'CFS shed 3, Chattogram port, Chattogram 4100']],
      }),
      customer(sales, {
        name: 'Primark Stores Ltd.',
        group: exportBuyers,
        contactPerson: 'Ciara Byrne',
        phone: '+353 1 888 0400',
        paymentTermsDays: 120,
        creditLimit: null,
        priceList: fob,
        billing: 'Arthur Ryan House, 22-24 Parnell Street, Dublin 1, Ireland',
      }),
      customer(sales, {
        name: 'Aarong',
        group: local,
        contactPerson: 'Mahmudul Hasan',
        phone: '+880 1713-045678',
        bin: '0003456780202',
        paymentTermsDays: 30,
        creditLimit: '500000',
        priceList: wholesale,
        billing: 'Plot 446/F, Tejgaon Industrial Area, Dhaka 1208',
        shipping: [
          ['Central warehouse', 'Aarong central warehouse, Jamgora, Ashulia, Savar'],
          ['Uttara outlet', 'House 2, Road 7, Sector 3, Uttara, Dhaka 1230'],
        ],
      }),
      customer(sales, {
        name: 'Bengal Buying House Ltd.',
        group: houses,
        contactPerson: 'Rafiqul Islam',
        phone: '+880 1819-223344',
        paymentTermsDays: 0,
        creditLimit: '0',
        billing: 'House 9, Road 4, Gulshan 1, Dhaka 1212',
      }),
      customer(sales, {
        name: 'Sonar Bangla Traders',
        group: local,
        phone: '+880 1552-667788',
        paymentTermsDays: 15,
        creditLimit: '100000',
        archived: true,
      }),
    ];
    return;
  }
  const pharmacies = group('Pharmacies');
  const hospitals = group('Hospitals');
  const pharmacy = priceList('Pharmacy', 'Trade price for retail pharmacies, VAT included');
  sales.groups = [pharmacies, hospitals, group('Distributors')];
  sales.priceLists = [pharmacy];
  sales.priceItems = [
    ...pricesFor(data.catalog, pharmacy, 'P-00001', 'pcs', '1.08'),
    ...pricesFor(data.catalog, pharmacy, 'P-00001', 'strip', '10.50'),
    ...pricesFor(data.catalog, pharmacy, 'P-00001', 'box', '102'),
  ];
  sales.customers = [
    customer(sales, {
      name: 'Lazz Pharma Ltd.',
      group: pharmacies,
      contactPerson: 'Shamim Ahmed',
      phone: '+880 1711-556677',
      paymentTermsDays: 15,
      creditLimit: '300000',
      priceList: pharmacy,
      billing: '64/3 Lake Circus, Kalabagan, Dhaka 1205',
      shipping: [['Kalabagan branch', '64/3 Lake Circus, Kalabagan, Dhaka 1205']],
    }),
    customer(sales, {
      name: 'Square Hospitals Ltd.',
      group: hospitals,
      contactPerson: 'Dr. Nazmul Karim',
      phone: '+880 2-8144400',
      bin: '0004567890303',
      paymentTermsDays: 45,
      creditLimit: '2000000',
      billing: '18/F Bir Uttam Qazi Nuruzzaman Sarak, West Panthapath, Dhaka 1205',
    }),
    customer(sales, {
      name: 'Tamanna Pharmacy',
      group: pharmacies,
      phone: '+880 1913-778899',
      paymentTermsDays: 0,
      creditLimit: '0',
      priceList: pharmacy,
      billing: 'Shop 12, Mirpur 10 Circle, Dhaka 1216',
    }),
  ];
  // Paracetamol is exempt from VAT: the product picks its own rate instead of the default
  const exempt = sales.taxRates.find((rate) => rate.kind === 'exempt');
  const napa = data.catalog.products.find((item) => item.code === 'P-00001');
  if (napa && exempt) napa.taxRateId = exempt.id;
}

// --- VAT rates ----------------------------------------------------------------------------------

function rateNameTaken(rates: readonly TaxRate[], name: string, except?: string): boolean {
  return rates.some((rate) => rate.id !== except && rate.name.toLowerCase() === name.toLowerCase());
}

// The API's order: the default first, then the highest rate, then by name
export function sortedTaxRates(sales: MockSales): TaxRate[] {
  return sales.taxRates.toSorted(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      Number(b.rate) - Number(a.rate) ||
      a.name.localeCompare(b.name),
  );
}

export function findTaxRate(sales: MockSales, id: string): TaxRate {
  const found = sales.taxRates.find((rate) => rate.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

function clearDefault(sales: MockSales): void {
  for (const rate of sales.taxRates) {
    if (rate.isDefault) Object.assign(rate, { isDefault: false, version: rate.version + 1 });
  }
}

// The first rate of a workspace is its default, whatever the form said: exactly one rate is
export function createTaxRate(sales: MockSales, input: TaxRateInput): TaxRate {
  if (rateNameTaken(sales.taxRates, input.name)) {
    throw new MockProblem(409, 'tax_rate_name_taken', { name: ['tax_rate_name_taken'] });
  }
  const isDefault = input.isDefault || !sales.taxRates.some((rate) => rate.isDefault);
  if (isDefault) clearDefault(sales);
  const created: TaxRate = {
    id: crypto.randomUUID(),
    name: input.name,
    kind: input.kind,
    rate: percent(input.rate),
    isDefault,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
  sales.taxRates.push(created);
  return created;
}

export function updateTaxRate(
  sales: MockSales,
  target: TaxRate,
  input: TaxRateInput & { version: number },
): void {
  if (target.version !== input.version) throw new MockProblem(409, 'version_conflict');
  if (target.isDefault && !input.isDefault) {
    throw new MockProblem(409, 'tax_rate_default_needed', {
      isDefault: ['tax_rate_default_needed'],
    });
  }
  if (input.isDefault && target.archivedAt !== null) {
    throw new MockProblem(409, 'tax_rate_default_archived', {
      isDefault: ['tax_rate_default_archived'],
    });
  }
  if (rateNameTaken(sales.taxRates, input.name, target.id)) {
    throw new MockProblem(409, 'tax_rate_name_taken', { name: ['tax_rate_name_taken'] });
  }
  if (input.isDefault && !target.isDefault) clearDefault(sales);
  Object.assign(target, {
    name: input.name,
    kind: input.kind,
    rate: percent(input.rate),
    isDefault: input.isDefault,
    version: target.version + 1,
    updatedAt: now(),
  });
}

export function setTaxRateArchived(target: TaxRate, version: number, archived: boolean): void {
  if (target.version !== version) throw new MockProblem(409, 'version_conflict');
  if ((target.archivedAt !== null) === archived) return;
  if (archived && target.isDefault) {
    throw new MockProblem(409, 'tax_rate_default_archived', {
      isDefault: ['tax_rate_default_archived'],
    });
  }
  Object.assign(target, {
    archivedAt: archived ? now() : null,
    version: target.version + 1,
    updatedAt: now(),
  });
}

// A product's rate: an active one, or the archived one it already had (products.service.ts)
export function assertProductTaxRate(
  sales: MockSales,
  taxRateId: string | null,
  kept: string | null,
): void {
  if (taxRateId === null) return;
  const rate = sales.taxRates.find((item) => item.id === taxRateId);
  if (!rate || (rate.archivedAt !== null && taxRateId !== kept)) {
    throw new MockProblem(400, 'invalid_input', { taxRateId: ['tax_rate_invalid'] });
  }
}

// --- Customers ----------------------------------------------------------------------------------

function isReceivable(data: WorkspaceData, accountId: string): boolean {
  return data.accounts.some(
    (account) => account.id === accountId && account.purpose === 'accounts_receivable',
  );
}

// What the customer owes: debit − credit of its posted receivable lines
function balanceOf(data: WorkspaceData, partyId: string): string {
  const lines = data.journal.entries
    .filter((entry) => entry.status === 'posted')
    .flatMap((entry) => entry.lines)
    .filter((line) => line.party?.id === partyId && isReceivable(data, line.accountId));
  return subtractMoney(
    sumMoney(lines.map((line) => line.debit)),
    sumMoney(lines.map((line) => line.credit)),
  );
}

// The owner sees every balance; a mock signed in without sales.customer.balance would get null
export function toCustomer(data: WorkspaceData, stored: MockCustomer): Customer {
  return { ...stored, balance: balanceOf(data, stored.id) };
}

export function customerSummaryOf(data: WorkspaceData, stored: MockCustomer): CustomerSummary {
  return {
    id: stored.id,
    code: stored.code,
    name: stored.name,
    groupId: stored.groupId,
    contactPerson: stored.contactPerson,
    phone: stored.phone,
    paymentTermsDays: stored.paymentTermsDays,
    creditLimit: stored.creditLimit,
    balance: balanceOf(data, stored.id),
    archivedAt: stored.archivedAt,
    updatedAt: stored.updatedAt,
  };
}

export function findCustomer(sales: MockSales, id: string): MockCustomer {
  const found = sales.customers.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// The API's filters and orders, on an array. The cursor is an offset, like the mock's other lists.
export function listCustomers(
  sales: MockSales,
  query: {
    search?: string | undefined;
    groupId?: string | undefined;
    status: CustomerStatus;
    sort: CustomerSort;
  },
): MockCustomer[] {
  const search = query.search?.toLowerCase() ?? '';
  const lower = (value: string | null) => value?.toLowerCase() ?? '';
  const found = sales.customers.filter(
    (item) =>
      (query.status === 'archived') === (item.archivedAt !== null) &&
      (query.groupId === undefined || item.groupId === query.groupId) &&
      (search === '' ||
        lower(item.name).includes(search) ||
        lower(item.code).includes(search) ||
        lower(item.contactPerson).includes(search) ||
        // The phone as typed, like the API: digits have no case
        (item.phone ?? '').includes(query.search ?? '')),
  );
  const by = {
    name: (a: MockCustomer, b: MockCustomer) => lower(a.name).localeCompare(lower(b.name)),
    '-name': (a: MockCustomer, b: MockCustomer) => lower(b.name).localeCompare(lower(a.name)),
    code: (a: MockCustomer, b: MockCustomer) => lower(a.code).localeCompare(lower(b.code)),
    '-code': (a: MockCustomer, b: MockCustomer) => lower(b.code).localeCompare(lower(a.code)),
    '-updated': (a: MockCustomer, b: MockCustomer) => b.updatedAt.localeCompare(a.updatedAt),
  };
  return found.sort(by[query.sort]);
}

function fieldProblem(status: number, code: ErrorCode, field: string): MockProblem {
  return new MockProblem(status, status === 409 ? code : 'invalid_input', { [field]: [code] });
}

// The next free code from the 'sales.customer' series; a code someone typed by hand is skipped
function newCode(data: WorkspaceData): string {
  const format = data.series.get('sales.customer') ?? defaultNumberFormat('sales.customer');
  const period = periodOf(
    todayIn(data.settings.timezone),
    format.yearStyle,
    data.settings.fiscalYearStartMonth,
  );
  for (;;) {
    data.sales.lastCode += 1;
    const code = formatDocumentNumber(format, period, data.sales.lastCode);
    if (!data.sales.customers.some((item) => item.code.toLowerCase() === code.toLowerCase())) {
      return code;
    }
  }
}

// Create (no `existing`) or update. The addresses sent replace the old ones; one sent back with
// its id keeps it, one with an id that is not this customer's becomes a new address. The billing
// address comes first, then the shipping ones in the order sent.
export function saveCustomer(
  data: WorkspaceData,
  input: CustomerInput,
  existing?: MockCustomer,
): MockCustomer {
  const { sales } = data;
  if (input.groupId !== null && !sales.groups.some((item) => item.id === input.groupId)) {
    throw fieldProblem(400, 'customer_group_invalid', 'groupId');
  }
  if (input.priceListId !== null) {
    const list = sales.priceLists.find((item) => item.id === input.priceListId);
    const kept = existing?.priceListId === input.priceListId;
    if (!list || (list.archivedAt !== null && !kept)) {
      throw fieldProblem(400, 'price_list_invalid', 'priceListId');
    }
  }
  const code = input.code ?? existing?.code ?? newCode(data);
  const taken = sales.customers.some(
    (item) => item.id !== existing?.id && item.code.toLowerCase() === code.toLowerCase(),
  );
  if (taken) throw fieldProblem(409, 'customer_code_taken', 'code');
  const own = new Set(existing?.addresses.map((address) => address.id));
  const addresses = input.addresses.map((address) => ({
    id: address.id !== null && own.has(address.id) ? address.id : crypto.randomUUID(),
    kind: address.kind,
    label: address.label,
    address: address.address,
    phone: address.phone,
  }));
  return {
    id: existing?.id ?? crypto.randomUUID(),
    code,
    name: input.name,
    groupId: input.groupId,
    contactPerson: input.contactPerson,
    phone: input.phone,
    email: input.email,
    bin: input.bin,
    paymentTermsDays: input.paymentTermsDays,
    creditLimit: input.creditLimit === null ? null : money(input.creditLimit),
    priceListId: input.priceListId,
    notes: input.notes,
    addresses: [
      ...addresses.filter((address) => address.kind === 'billing'),
      ...addresses.filter((address) => address.kind !== 'billing'),
    ],
    isSupplier: existing?.isSupplier ?? false,
    archivedAt: existing?.archivedAt ?? null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
}

// The journal keeps a party's code and name on each line, and so does each sales document (step
// 15b); the API joins them on read. After a rename they show the new name, like the API's.
export function refreshPartyRefs(data: WorkspaceData, saved: MockCustomer): void {
  const ref = { id: saved.id, code: saved.code, name: saved.name };
  for (const entry of data.journal.entries) {
    for (const line of entry.lines) {
      if (line.party?.id === saved.id) line.party = ref;
    }
  }
  const { quotations, orders, deliveries } = data.salesDocuments;
  for (const document of [...quotations, ...orders, ...deliveries]) {
    if (document.customer.id === saved.id) document.customer = ref;
  }
}

// Only a customer no entry and no sales document names, drafts included (the API's
// journal_lines_party_fk, and step 15b's quotations/sales_orders/deliveries_customer_fk)
export function assertCustomerUnused(data: WorkspaceData, id: string): void {
  const { quotations, orders, deliveries } = data.salesDocuments;
  const used =
    data.journal.entries.some((entry) => entry.lines.some((line) => line.party?.id === id)) ||
    [...quotations, ...orders, ...deliveries].some((document) => document.customer.id === id);
  if (used) throw new MockProblem(409, 'customer_in_use');
}

// A line's customer as the journal shows it. Unknown, archived (unless allowArchived) or not a
// customer: undefined, and checkParties() answers journal_party_invalid.
export function partyRefOf(
  sales: MockSales,
  partyId: string,
  allowArchived = false,
): PartyRef | undefined {
  const found = sales.customers.find((item) => item.id === partyId);
  if (!found || (found.archivedAt !== null && !allowArchived)) return undefined;
  return { id: found.id, code: found.code, name: found.name };
}

// --- Customer groups ----------------------------------------------------------------------------

export function toGroup(sales: MockSales, stored: MockGroup): CustomerGroup {
  return {
    ...stored,
    // Archived customers count too: they keep their group
    customerCount: sales.customers.filter((item) => item.groupId === stored.id).length,
  };
}

export function findGroup(sales: MockSales, id: string): MockGroup {
  const found = sales.groups.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertGroupNameFree(sales: MockSales, name: string, except?: string): void {
  const taken = sales.groups.some(
    (item) => item.id !== except && item.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    throw new MockProblem(409, 'customer_group_name_taken', {
      name: ['customer_group_name_taken'],
    });
  }
}

// --- Price lists --------------------------------------------------------------------------------

export function toPriceList(sales: MockSales, stored: MockPriceList): PriceList {
  return {
    ...stored,
    itemCount: sales.priceItems.filter((item) => item.priceListId === stored.id).length,
    customerCount: sales.customers.filter((item) => item.priceListId === stored.id).length,
  };
}

export function findPriceList(sales: MockSales, id: string): MockPriceList {
  const found = sales.priceLists.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertPriceListNameFree(sales: MockSales, name: string, except?: string): void {
  const taken = sales.priceLists.some(
    (item) => item.id !== except && item.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    throw new MockProblem(409, 'price_list_name_taken', { name: ['price_list_name_taken'] });
  }
}

// The prices of a list with what each row shows, by product name (then variant and unit, the
// API's cursor order), searched by product name, code or SKU
export function priceItemsOf(
  data: WorkspaceData,
  listId: string,
  search: string | undefined,
): PriceListItem[] {
  const term = search?.toLowerCase() ?? '';
  return data.sales.priceItems
    .filter((item) => item.priceListId === listId)
    .flatMap((item) => {
      const product = data.catalog.products.find((row) => row.id === item.productId);
      const variant = product?.variants.find((row) => row.id === item.variantId);
      if (!product || !variant) return [];
      const row: PriceListItem = {
        variantId: item.variantId,
        unitId: item.unitId,
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        sku: variant.sku,
        optionValues: variant.optionValues,
        price: item.price,
        updatedAt: item.updatedAt,
      };
      const found =
        term === '' ||
        product.name.toLowerCase().includes(term) ||
        product.code.toLowerCase().includes(term) ||
        variant.sku.toLowerCase().includes(term);
      return found ? [row] : [];
    })
    .sort(
      (a, b) =>
        a.productName.toLowerCase().localeCompare(b.productName.toLowerCase()) ||
        a.variantId.localeCompare(b.variantId) ||
        a.unitId.localeCompare(b.unitId),
    );
}

// A batch of prices, all or nothing: every change must be a known variant in a unit its product
// is sold in (the base unit or a pack). '' (null) takes the price out of the list.
export function setPriceItems(
  data: WorkspaceData,
  list: MockPriceList,
  input: SetPriceListItemsInput,
): { set: number; removed: number } {
  if (list.archivedAt !== null) throw new MockProblem(409, 'price_list_invalid');
  const fieldErrors: Record<string, ErrorCode[]> = {};
  const rows = input.changes.flatMap((change, index) => {
    const product = data.catalog.products.find((item) =>
      item.variants.some((variant) => variant.id === change.variantId),
    );
    if (!product) {
      fieldErrors[`changes.${String(index)}.variantId`] = ['product_variant_unknown'];
      return [];
    }
    const sold =
      product.baseUnitId === change.unitId ||
      product.units.some((pack) => pack.unitId === change.unitId);
    if (!sold) {
      fieldErrors[`changes.${String(index)}.unitId`] = ['price_list_unit_invalid'];
      return [];
    }
    return [{ ...change, productId: product.id }];
  });
  const [first] = Object.values(fieldErrors).flat();
  if (first !== undefined) throw new MockProblem(409, first, fieldErrors);

  const same = (item: MockPriceItem, row: { variantId: string; unitId: string }) =>
    item.priceListId === list.id && item.variantId === row.variantId && item.unitId === row.unitId;
  let set = 0;
  let removed = 0;
  for (const row of rows) {
    const existing = data.sales.priceItems.find((item) => same(item, row));
    if (row.price === null) {
      // Counted like the API's audit row: what was asked, not what was there
      removed += 1;
      data.sales.priceItems = data.sales.priceItems.filter((item) => !same(item, row));
    } else if (existing) {
      Object.assign(existing, { price: money(row.price), updatedAt: now() });
      set += 1;
    } else {
      data.sales.priceItems.push({
        priceListId: list.id,
        productId: row.productId,
        variantId: row.variantId,
        unitId: row.unitId,
        price: money(row.price),
        updatedAt: now(),
      });
      set += 1;
    }
  }
  return { set, removed };
}

// After a product is saved or deleted: the prices of a variant it no longer has, or of a unit it is
// no longer sold in, go (the API's cascade and products.service.ts's delete)
export function dropStalePrices(data: WorkspaceData): void {
  data.sales.priceItems = data.sales.priceItems.filter((item) => {
    const product = data.catalog.products.find((row) => row.id === item.productId);
    return (
      product !== undefined &&
      product.variants.some((variant) => variant.id === item.variantId) &&
      (product.baseUnitId === item.unitId ||
        product.units.some((pack) => pack.unitId === item.unitId))
    );
  });
}
