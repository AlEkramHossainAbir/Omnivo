import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  type Bill,
  type BillLineFormValues,
  billSchema,
  type Branch,
  branchListSchema,
  branchSchema,
  costColumns,
  creditNoteSchema,
  type Customer,
  customerGroupSchema,
  customerSchema,
  type Delivery,
  debitNoteSchema,
  deliverySchema,
  deviceSchema,
  type GoodsReceipt,
  goodsReceiptSchema,
  type Invoice,
  invoiceSchema,
  journalEntrySchema,
  memberPageSchema,
  type PermissionKey,
  posCashReasonSchema,
  posRegisterSchema,
  posReturnAmounts,
  type PosSale,
  posSaleSchema,
  problemSchema,
  type Product,
  productCategoryListSchema,
  type ProductFormValues,
  productSchema,
  type PurchaseOrder,
  purchaseOrderSchema,
  type PurchaseReport,
  purchaseReportSchema,
  purchaseReturnSchema,
  roleSchema,
  type SalesOrder,
  salesOrderSchema,
  type SalesReport,
  salesReportSchema,
  salesReturnSchema,
  settingsSchema,
  setupSchema,
  shiftIsoDate,
  type Supplier,
  supplierGroupSchema,
  supplierSchema,
  SYNC_PROTOCOL,
  type SyncCommandInput,
  syncPushSchema,
  type TaxRate,
  taxRateListSchema,
  todayIn,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
} from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// Step 21b. Shapla Super Store: a shop in Dhanmondi (the main branch) and a second shop in Mirpur.
// Every kind of document that sells or buys, once, with amounts that tell them apart:
// - Rahim Traders: a challan of 10 bags of rice, 2 back before the bill, an invoice of the other 8
//   and a credit note that only cuts the price (৳100, no goods back);
// - Karim Store (a wholesale customer): a direct invoice of 5 bottles of oil at 10% off from the
//   Mirpur shop, 1 bottle back with a credit note for it;
// - a walk-in at the POS: rice, two soaps of two scents (one product, two variants) and matches,
//   and one soap back;
// - bills for sugar (from a goods receipt), van hire (an account line) and the rent (an expense),
//   with a debit note for each kind and one without a bill.
// The sums are written out in the tests. Every document is dated a number of days before today,
// so the tests run on any day; a month is worked out from the dates.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// Reads both reports, but not what the stock cost
let shirin: SignedIn;
// No role at all
let rafiq: SignedIn;
let today: string;
let accounts: Account[];
let vat: TaxRate;
let exempt: TaxRate;
let pcs: string;
let dhanmondi: Branch;
let mirpur: Branch;
let main: Warehouse;
let mirpurStore: Warehouse;
let groceries: string;
let riceCategory: string;
let personalCare: string;
let rice: Product;
let oil: Product;
let soap: Product;
let matches: Product;
let sugar: Product;
let homeDelivery: Product;
let vanHire: Product;
let wholesale: string;
let localMills: string;
let rahim: Customer;
let karim: Customer;
let meghna: Supplier;
let landlord: Supplier;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type SaleLine = SaleCommand['input']['lines'][number];
type ReturnCommand = Extract<SyncCommandInput, { type: 'pos_return.create' }>;
type OpenCommand = Extract<SyncCommandInput, { type: 'pos_shift.open' }>;

// A UUIDv7 as a device makes it: only the version digit matters to the server's checks
function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

const day = (days: number) => shiftIsoDate(today, days);

// The sales report's net by the day it counts, for the month grouping: [day, net]
const soldOn: [number, string][] = [];
// The same for the purchase report
const boughtOn: [number, string][] = [];

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({ method, url, headers: bearer(as.accessToken), ...(payload && { payload }) });
}

async function created<T>(schema: z.ZodType<T>, url: string, payload: object): Promise<T> {
  const res = await send('POST', url, payload);
  expect(res.statusCode, res.body).toBe(201);
  return schema.parse(res.json());
}

async function sales(query: string, as = owner): Promise<SalesReport> {
  const res = await send('GET', `/reports/sales?${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return salesReportSchema.parse(res.json());
}

async function purchases(query: string, as = owner): Promise<PurchaseReport> {
  const res = await send('GET', `/reports/purchases?${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseReportSchema.parse(res.json());
}

// The whole period of this test's documents: 60 days back to today
const period = () => `from=${day(-60)}&to=${today}`;

// A row as the test reads it: its kind, its name (or month), and the money
function moneyOf(row: SalesReport['items'][number] | PurchaseReport['items'][number]) {
  return [row.kind, row.name ?? row.month, row.gross, row.returns, row.net];
}

function costOf(row: SalesReport['items'][number]) {
  return [row.name ?? row.kind, row.cost, row.margin, row.marginPercent];
}

// The rows' months, the oldest first, from what the test posted on each day
function byMonth(posted: readonly [number, string][]): [string, string][] {
  const months = new Map<string, number>();
  for (const [days, net] of posted) {
    const month = day(days).slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + Number(net));
  }
  return [...months.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([month, net]) => [month, net.toFixed(4)]);
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function accountId(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function variantOf(product: Product, at = 0): string {
  const variant = product.variants[at];
  if (!variant) throw new Error(`${product.name} has no variant ${String(at)}`);
  return variant.id;
}

function only<T>(items: readonly T[], what: string): T {
  const [first] = items;
  if (first === undefined || items.length !== 1) throw new Error(`not one ${what}`);
  return first;
}

async function addProduct(
  name: string,
  categoryId: string,
  extra: Partial<ProductFormValues> = {},
): Promise<Product> {
  return created(productSchema, '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId,
    description: '',
    baseUnitId: pcs,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
    ...extra,
  } satisfies ProductFormValues);
}

// A category of the retail template, by its name and its parent's id (null = top level)
async function categoryOf(name: string, parentId: string | null = null): Promise<string> {
  const { items } = productCategoryListSchema.parse(
    (await send('GET', '/product-categories')).json(),
  );
  const found = items.find((item) => item.name === name && item.parentId === parentId);
  if (!found) throw new Error(`no category ${name}`);
  return found.id;
}

async function addCustomer(name: string, groupId: string): Promise<Customer> {
  return created(customerSchema, '/customers', {
    code: '',
    name,
    groupId,
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
  });
}

async function addSupplier(name: string, groupId: string): Promise<Supplier> {
  return created(supplierSchema, '/suppliers', {
    code: '',
    name,
    groupId,
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 30,
    address: '',
    bankAccounts: [],
    notes: '',
  });
}

// A member with one role of exactly these permissions; [] = no role at all
async function memberWith(
  person: { fullName: string; email: string; password: string },
  permissions: PermissionKey[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${person.fullName} Store`,
    workspaceSlug: `${person.email.split('@')[0] ?? 'member'}-store`,
    ...person,
  });
  await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'shapla-super-store' });
  if (permissions.length > 0) {
    const role = await created(roleSchema, '/roles', {
      name: `${person.fullName}'s role`,
      description: '',
    });
    const matrix = await send('PUT', '/permission-matrix', {
      roles: [{ id: role.id, version: role.version, permissions }],
    });
    expect(matrix.statusCode, matrix.body).toBe(200);
    const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
    const found = items.find((item) => item.email === person.email);
    if (!found) throw new Error(`${person.email} is not a member`);
    const roles = await send('PUT', `/members/${found.membershipId}/roles`, {
      roleIds: [role.id],
      version: found.version,
    });
    expect(roles.statusCode, roles.body).toBe(200);
  }
  return logIn(app, {
    workspace: 'shapla-super-store',
    email: person.email,
    password: person.password,
    keepSignedIn: false,
  });
}

function stockLine(product: Product, quantity: string, unitCost: string, at = 0) {
  return {
    variantId: variantOf(product, at),
    unitId: pcs,
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost,
  };
}

// A sales line by the piece at 15% VAT; `discount` is a percent
function salesLine(product: Product, quantity: string, unitPrice: string, discount = '') {
  return {
    variantId: variantOf(product),
    unitId: pcs,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount,
    taxRateId: vat.id,
  };
}

function invoiceLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: { discount?: string; deliveryLineId?: string } = {},
) {
  return {
    ...salesLine(product, quantity, unitPrice, extra.discount),
    deliveryLineId: extra.deliveryLineId ?? '',
    orderLineId: '',
    batchId: '',
    serialNumbers: [],
  };
}

function invoiceForm(
  customer: Customer,
  date: string,
  lines: object[],
  extra: { warehouse?: Warehouse; post?: boolean } = {},
) {
  return {
    customerId: customer.id,
    date,
    dueDate: '',
    customerReference: '',
    branchId: extra.warehouse?.branchId ?? dhanmondi.id,
    warehouseId: extra.warehouse?.id ?? '',
    note: '',
    lines,
    post: extra.post ?? true,
  };
}

function lineOf<T extends { variantId: string | null }>(lines: readonly T[], product: Product): T {
  const found = lines.find((line) => line.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} line`);
  return found;
}

// A goods return of a customer, into the store the goods left from
function salesReturnForm(
  customer: Customer,
  date: string,
  warehouse: Warehouse,
  lines: { product: Product; quantity: string; deliveryLineId: string }[],
) {
  return {
    customerId: customer.id,
    date,
    warehouseId: warehouse.id,
    reason: 'damaged',
    note: '',
    lines: lines.map((line) => ({
      variantId: variantOf(line.product),
      unitId: pcs,
      quantity: line.quantity,
      batchId: '',
      serialNumbers: [],
      deliveryLineId: line.deliveryLineId,
    })),
    post: true,
  };
}

// A credit note line: a price cut, or goods back when it names a return line
function creditLine(
  invoiceLineId: string,
  quantity: string,
  unitPrice: string,
  extra: { discount?: string; returnLineId?: string } = {},
) {
  return {
    invoiceLineId,
    returnLineId: extra.returnLineId ?? '',
    unitId: pcs,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: extra.discount ?? '',
  };
}

function billLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<BillLineFormValues> = {},
): BillLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: pcs,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: vat.id,
    receiptLineId: '',
    orderLineId: '',
    accountId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    ...extra,
  };
}

function billForm(
  supplier: Supplier,
  date: string,
  number: string,
  parts: { lines?: BillLineFormValues[]; expenses?: object[]; submit?: boolean },
) {
  return {
    supplierId: supplier.id,
    date,
    dueDate: '',
    supplierBillNumber: number,
    mushakNumber: '',
    mushakDate: '',
    branchId: dhanmondi.id,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: parts.lines ?? [],
    expenses: parts.expenses ?? [],
    // No bill levels in this workspace: a submitted bill is posted at once
    submit: parts.submit ?? true,
  };
}

// A goods return to the supplier from the main store: from a receipt line, or on its own
function purchaseReturnForm(
  supplier: Supplier,
  date: string,
  product: Product,
  quantity: string,
  receiptLineId = '',
) {
  return {
    supplierId: supplier.id,
    date,
    warehouseId: main.id,
    reason: 'damaged',
    note: '',
    lines: [
      {
        variantId: variantOf(product),
        unitId: pcs,
        quantity,
        batchId: '',
        serialNumbers: [],
        receiptLineId,
      },
    ],
    post: true,
  };
}

function debitNoteForm(
  supplier: Supplier,
  bill: Bill | null,
  date: string,
  parts: { lines?: object[]; expenses?: object[] },
) {
  return {
    supplierId: supplier.id,
    billId: bill?.id ?? '',
    date,
    // A debit note without a bill names its branch; with one, it is the bill's
    branchId: bill === null ? dhanmondi.id : '',
    pricesIncludeVat: false,
    reason: 'goods_returned',
    supplierCreditNumber: '',
    supplierCreditDate: '',
    note: '',
    lines: parts.lines ?? [],
    expenses: parts.expenses ?? [],
    post: true,
  };
}

function debitLine(
  quantity: string,
  unitPrice: string,
  source: { billLineId?: string; returnLineId?: string; taxRateId?: string },
) {
  return {
    billLineId: source.billLineId ?? '',
    returnLineId: source.returnLineId ?? '',
    taxRateId: source.taxRateId ?? '',
    unitId: pcs,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
  };
}

// The POS: the front counter of the Dhanmondi shop, its first shift, a sale and a return
async function sellAtTheCounter(): Promise<void> {
  const floatIn = await created(posCashReasonSchema, '/pos/cash-reasons', {
    name: 'Float from the owner',
    direction: 'in',
    accountId: accountId('3100'),
  });
  const counterPc = await created(deviceSchema, '/sync/devices', {
    id: v7(),
    name: 'Front counter PC',
    branchId: dhanmondi.id,
  });
  const register = await created(posRegisterSchema, '/pos/registers', {
    code: 'POS1',
    name: 'Front counter',
    warehouseId: main.id,
    accounts: { cash: accountId('1110'), card: '', bkash: '', nagad: '' },
    maxDiscountPercent: '',
    paperWidth: '80',
    receiptFooter: '',
    overShortAccountId: accountId('5350'),
    varianceAlert: '500',
    lockAfter: '5',
    exchangeAccountId: '',
    returnDays: '7',
  });
  const claim = await send('POST', `/pos/registers/${register.id}/claim`, {
    deviceId: counterPc.id,
  });
  expect(claim.statusCode, claim.body).toBe(200);
  const push = async (commands: (SaleCommand | ReturnCommand | OpenCommand)[]) => {
    const res = await send('POST', '/sync/push', {
      deviceId: counterPc.id,
      protocol: SYNC_PROTOCOL,
      commands,
    });
    expect(res.statusCode, res.body).toBe(200);
    const { results } = syncPushSchema.parse(res.json());
    expect(
      results.map((result) => result.status),
      JSON.stringify(results),
    ).toEqual(commands.map(() => 'accepted'));
  };
  const shiftId = v7();
  const posLine = (product: Product, quantity: string, price: string, at = 0): SaleLine => ({
    variantId: variantOf(product, at),
    unitId: pcs,
    quantity,
    description: '',
    unitPrice: price,
    discountType: 'percent',
    discount: '0',
    taxRateId: vat.id,
    rate: vat.rate,
    startingPrice: price,
    batchId: '',
    serialNumbers: [],
  });
  const sale: SaleCommand = {
    id: v7(),
    type: 'pos_sale.create',
    saleId: v7(),
    input: {
      registerId: register.id,
      sequence: 1,
      shiftId,
      date: today,
      soldAt: new Date(Date.now() + 1000).toISOString(),
      customerId: '',
      pricesIncludeVat: false,
      // ৳580 and 15% VAT
      lines: [
        posLine(rice, '1', '450'),
        posLine(soap, '1', '60', 0),
        posLine(soap, '1', '60', 1),
        posLine(matches, '2', '5'),
      ],
      billDiscountType: 'amount',
      billDiscount: '0',
      payments: [{ method: 'cash', amount: '667', reference: '' }],
    },
  };
  await push([
    {
      id: v7(),
      type: 'pos_shift.open',
      shiftId,
      input: {
        registerId: register.id,
        sequence: 1,
        date: today,
        openedAt: new Date().toISOString(),
        opening: { notes: null, total: '1000' },
        floatReasonId: floatIn.id,
      },
    },
    sale,
  ]);
  const sold: PosSale = posSaleSchema.parse(
    (await send('GET', `/pos/sales/${sale.saleId}`)).json(),
  );
  expect(sold.total).toBe('667.0000');
  soldOn.push([0, '580']);

  // The lime soap comes back: ৳60 and its VAT, in cash
  const lime = sold.lines.find((line) => line.variantId === variantOf(soap, 1));
  if (!lime) throw new Error('no lime soap line');
  const amounts = posReturnAmounts(lime, '1');
  await push([
    {
      id: v7(),
      type: 'pos_return.create',
      returnId: v7(),
      input: {
        registerId: register.id,
        sequence: 1,
        shiftId,
        date: today,
        returnedAt: new Date(Date.now() + 2000).toISOString(),
        saleId: sold.id,
        lines: [
          {
            saleLineId: lime.id,
            quantity: '1',
            net: amounts.net,
            vat: amounts.vat,
            serialNumbers: [],
          },
        ],
        refunds: [{ method: 'cash', amount: amounts.total, reference: '' }],
        note: '',
      },
    },
  ]);
  soldOn.push([0, '-60']);
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Shapla Super Store',
    workspaceSlug: 'shapla-super-store',
    fullName: 'Sharmin Akter',
    email: 'sharmin@shaplastore.com',
    password: 'Dhanmondi-store-2026',
  });
  expect((await send('POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  today = todayIn(settingsSchema.parse((await send('GET', '/settings')).json()).timezone);

  const [first] = branchListSchema.parse((await send('GET', '/branches')).json()).items;
  if (!first) throw new Error('sign-up made no branch');
  dhanmondi = first;
  const [found] = warehouseListSchema
    .parse((await send('GET', '/warehouses')).json())
    .items.filter((warehouse) => warehouse.code === 'MAIN');
  if (!found) throw new Error('no MAIN warehouse');
  main = found;
  mirpur = await created(branchSchema, '/branches', {
    code: 'MIR',
    name: 'Mirpur shop',
    phone: '',
    address: 'Section 10, Mirpur',
  });
  mirpurStore = await created(warehouseSchema, '/warehouses', {
    branchId: mirpur.id,
    code: 'MIR1',
    name: 'Mirpur store',
    address: '',
  });

  // A Sales returns account, picked in the settings: the retail chart has none
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const returns = await created(accountSchema, '/accounts', {
    parentId: accountId('4100'),
    code: '4130',
    name: 'Sales returns',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  expect((await send('PUT', '/sales-accounts', { returns: returns.id })).statusCode).toBe(200);
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;

  const rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const rateNamed = (name: string) => {
    const rate = rates.find((item) => item.name === name);
    if (!rate) throw new Error(`no ${name}`);
    return rate;
  };
  vat = rateNamed('VAT 15%');
  exempt = rateNamed('Exempt');
  pcs =
    unitListSchema.parse((await send('GET', '/units')).json()).items.find((u) => u.code === 'pcs')
      ?.id ?? '';

  // The retail template's Groceries, with Rice under it, and Personal care; matches have none
  groceries = await categoryOf('Groceries');
  riceCategory = await categoryOf('Rice', groceries);
  personalCare = await categoryOf('Personal care');
  rice = await addProduct('Miniket rice 5 kg', riceCategory);
  oil = await addProduct('Soybean oil 1 L', groceries);
  soap = await addProduct('Toilet soap 100 g', personalCare, {
    options: [{ name: 'Scent', values: ['Rose', 'Lime'] }],
    variants: ['Rose', 'Lime'].map((scent) => ({
      id: null,
      sku: '',
      optionValues: [scent],
      barcode: '',
      salePrice: '60',
      archived: false,
    })),
  });
  matches = await addProduct('Matchbox', '');
  sugar = await addProduct('Sugar 1 kg', groceries);
  homeDelivery = await addProduct('Home delivery', '', { type: 'service' });
  vanHire = await addProduct('Van hire', '', { type: 'service' });

  wholesale = (await created(customerGroupSchema, '/customer-groups', { name: 'Wholesale' })).id;
  localMills = (await created(supplierGroupSchema, '/supplier-groups', { name: 'Local mills' })).id;
  rahim = await addCustomer('Rahim Traders', '');
  karim = await addCustomer('Karim Store', wholesale);
  meghna = await addSupplier('Meghna Agro Mills', localMills);
  landlord = await addSupplier('Dhanmondi Properties Ltd.', '');

  // The stock, 40 days ago, at a known cost: the sales' cost is the challan's, at these prices
  for (const [warehouse, lines] of [
    [
      main,
      [
        stockLine(rice, '40', '380'),
        stockLine(soap, '10', '45', 0),
        stockLine(soap, '10', '45', 1),
        stockLine(matches, '50', '3'),
      ],
    ],
    [mirpurStore, [stockLine(oil, '10', '160')]],
  ] as const) {
    const stocked = await send('POST', '/stock-adjustments', {
      date: day(-40),
      warehouseId: warehouse.id,
      direction: 'in',
      reason: 'opening',
      note: '',
      lines,
      post: true,
    });
    expect(stocked.statusCode, stocked.body).toBe(201);
  }

  shirin = await memberWith(
    { fullName: 'Shirin Akter', email: 'shirin@shaplastore.com', password: 'Reports-desk-2026' },
    ['sales.report.read', 'purchase.report.read'],
  );
  rafiq = await memberWith(
    { fullName: 'Rafiq Islam', email: 'rafiq@shaplastore.com', password: 'No-role-yet-2026' },
    [],
  );
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('The documents of two months', () => {
  // Dozens of documents go through the API here, so the 5 seconds of a normal test are not enough
  // when the whole suite runs at once.
  it('are posted the way the shop works', async () => {
    // Rahim: an order, a challan of 10 bags, 2 back before the bill, an invoice of 8
    const order: SalesOrder = await created(salesOrderSchema, '/sales-orders', {
      customerId: rahim.id,
      date: day(-21),
      deliveryDate: '',
      customerReference: '',
      warehouseId: main.id,
      shippingAddressId: '',
      note: '',
      lines: [salesLine(rice, '10', '450')],
      confirm: true,
    });
    const challan: Delivery = await created(deliverySchema, '/deliveries', {
      customerId: rahim.id,
      orderId: order.id,
      date: day(-20),
      warehouseId: main.id,
      shippingAddressId: '',
      vehicle: '',
      note: '',
      lines: [
        {
          variantId: variantOf(rice),
          unitId: pcs,
          quantity: '10',
          batchId: '',
          serialNumbers: [],
          orderLineId: only(order.lines, 'order line').id,
        },
      ],
      post: true,
    });
    const challanLine = only(challan.lines, 'challan line').id;
    await created(
      salesReturnSchema,
      '/sales-returns',
      salesReturnForm(rahim, day(-19), main, [
        { product: rice, quantity: '2', deliveryLineId: challanLine },
      ]),
    );
    const rahimInvoice: Invoice = await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(rahim, day(-18), [
        invoiceLine(rice, '8', '450', { deliveryLineId: challanLine }),
      ]),
    );
    expect(rahimInvoice.net).toBe('3600.0000');
    soldOn.push([-18, '3600']);

    // Karim: a direct invoice from the Mirpur shop, 5 bottles at 10% off (৳855)
    const karimInvoice: Invoice = await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(karim, day(-10), [invoiceLine(oil, '5', '190', { discount: '10' })], {
        warehouse: mirpurStore,
      }),
    );
    expect(karimInvoice.net).toBe('855.0000');
    soldOn.push([-10, '855']);
    const oilLine = only(karimInvoice.lines, 'invoice line');
    // One bottle back, and the credit note for it: ৳171, its cost back to the stock
    const back = await created(
      salesReturnSchema,
      '/sales-returns',
      salesReturnForm(karim, day(-5), mirpurStore, [
        { product: oil, quantity: '1', deliveryLineId: oilLine.deliveryLineId ?? '' },
      ]),
    );
    await created(creditNoteSchema, '/credit-notes', {
      invoiceId: karimInvoice.id,
      date: day(-5),
      reason: 'goods_returned',
      note: '',
      lines: [
        creditLine(oilLine.id, '1', '190', {
          discount: '10',
          returnLineId: only(back.lines, 'return line').id,
        }),
      ],
      post: true,
    });
    soldOn.push([-5, '-171']);

    // Rahim's price cut: ৳100 off, no goods back
    await created(creditNoteSchema, '/credit-notes', {
      invoiceId: rahimInvoice.id,
      date: day(-3),
      reason: 'price_adjustment',
      note: '',
      lines: [creditLine(lineOf(rahimInvoice.lines, rice).id, '1', '100')],
      post: true,
    });
    soldOn.push([-3, '-100']);

    // Outside the period or not posted: a home delivery 70 days ago, and a draft today
    await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(rahim, day(-70), [invoiceLine(homeDelivery, '1', '100')]),
    );
    await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(karim, today, [invoiceLine(homeDelivery, '1', '9999')], { post: false }),
    );

    // A sale the accountant wrote by hand: the books have it, the documents do not
    const byHand = await send('POST', '/journal-entries', {
      date: day(-2),
      narration: 'Cash sale written by hand',
      lines: [
        {
          accountId: accountId('1110'),
          branchId: dhanmondi.id,
          description: '',
          debit: '500',
          credit: '',
        },
        {
          accountId: accountId('4110'),
          branchId: dhanmondi.id,
          description: '',
          debit: '',
          credit: '500',
        },
      ],
      post: true,
    });
    expect(byHand.statusCode, byHand.body).toBe(201);
    journalEntrySchema.parse(byHand.json());

    await sellAtTheCounter();

    // Meghna: an order of 20 kg of sugar at ৳120, received, billed at ৳125 with a van hire
    const draftOrder = await created(purchaseOrderSchema, '/purchase-orders', {
      supplierId: meghna.id,
      date: day(-32),
      expectedDate: '',
      warehouseId: main.id,
      supplierReference: '',
      paymentTermsDays: 30,
      pricesIncludeVat: false,
      note: '',
      lines: [
        {
          variantId: variantOf(sugar),
          unitId: pcs,
          quantity: '20',
          description: '',
          unitPrice: '120',
          discountType: 'percent',
          discount: '',
          taxRateId: vat.id,
          requisitionLineId: '',
        },
      ],
    });
    const submitted = await send('POST', `/purchase-orders/${draftOrder.id}/submit`, {
      version: draftOrder.version,
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const purchaseOrder: PurchaseOrder = purchaseOrderSchema.parse(submitted.json());
    const grn: GoodsReceipt = await created(goodsReceiptSchema, '/goods-receipts', {
      orderId: purchaseOrder.id,
      date: day(-30),
      warehouseId: main.id,
      supplierChallan: '',
      vehicle: '',
      note: '',
      lines: [
        {
          variantId: variantOf(sugar),
          unitId: pcs,
          quantity: '20',
          batchId: '',
          lotNumber: '',
          expiresOn: '',
          manufacturedOn: '',
          serialNumbers: [],
          orderLineId: only(purchaseOrder.lines, 'order line').id,
          rejectedQuantity: '',
          rejectionReason: '',
        },
      ],
      post: true,
    });
    const receiptLine = only(grn.lines, 'receipt line').id;
    const sugarBill: Bill = await created(
      billSchema,
      '/bills',
      billForm(meghna, day(-28), 'MAM/2026/118', {
        lines: [
          billLine(sugar, '20', '125', { receiptLineId: receiptLine }),
          billLine(vanHire, '1', '300', { accountId: accountId('5240') }),
        ],
      }),
    );
    expect(sugarBill).toMatchObject({ status: 'posted', net: '2800.0000' });
    boughtOn.push([-28, '2800']);
    // 2 kg back after the bill, and the debit note for them: ৳250
    const sugarBack = await created(
      purchaseReturnSchema,
      '/purchase-returns',
      purchaseReturnForm(meghna, day(-25), sugar, '2', receiptLine),
    );
    await created(
      debitNoteSchema,
      '/debit-notes',
      debitNoteForm(meghna, sugarBill, day(-24), {
        lines: [
          debitLine('2', '125', {
            billLineId: lineOf(sugarBill.lines, sugar).id,
            returnLineId: only(sugarBack.lines, 'return line').id,
          }),
        ],
      }),
    );
    boughtOn.push([-24, '-250']);

    // The rent: an expense, ৳1,000 of it taken off by a debit note
    const rentBill: Bill = await created(
      billSchema,
      '/bills',
      billForm(landlord, day(-20), 'DPL-2026-10', {
        expenses: [
          {
            accountId: accountId('5220'),
            description: 'Shop rent, Dhanmondi',
            amount: '12000',
            taxRateId: exempt.id,
          },
        ],
      }),
    );
    boughtOn.push([-20, '12000']);
    await created(
      debitNoteSchema,
      '/debit-notes',
      debitNoteForm(landlord, rentBill, day(-15), {
        expenses: [{ billExpenseId: only(rentBill.expenses, 'expense').id, amount: '1000' }],
      }),
    );
    boughtOn.push([-15, '-1000']);

    // 1 kg back with no receipt behind it, on a debit note without a bill: ৳120
    const looseBack = await created(
      purchaseReturnSchema,
      '/purchase-returns',
      purchaseReturnForm(meghna, day(-12), sugar, '1'),
    );
    await created(
      debitNoteSchema,
      '/debit-notes',
      debitNoteForm(meghna, null, day(-12), {
        lines: [
          debitLine('1', '120', {
            returnLineId: only(looseBack.lines, 'return line').id,
            taxRateId: vat.id,
          }),
        ],
      }),
    );
    boughtOn.push([-12, '-120']);

    // A draft bill is not a purchase
    await created(
      billSchema,
      '/bills',
      billForm(meghna, day(-10), 'MAM/2026/131', {
        lines: [billLine(vanHire, '1', '5000', { accountId: accountId('5240') })],
        submit: false,
      }),
    );
  }, 120_000);
});

describe('The sales report', () => {
  it('adds up every kind of document by customer, the walk-ins in one row', async () => {
    const report = await sales(period());
    expect(report.items.map(moneyOf)).toEqual([
      // Invoice ৳3,600, the price cut ৳100
      ['item', 'Rahim Traders', '3600.0000', '100.0000', '3500.0000'],
      // Invoice ৳855, a bottle back ৳171
      ['item', 'Karim Store', '855.0000', '171.0000', '684.0000'],
      // The POS sale ৳580, a soap back ৳60
      ['walk_in', null, '580.0000', '60.0000', '520.0000'],
    ]);
    expect(report.items.map((row) => [row.key, row.id, row.code])).toEqual([
      [rahim.id, rahim.id, rahim.code],
      [karim.id, karim.id, karim.code],
      ['walk_in', null, null],
    ]);
    // The cost: 8 bags at ৳380 (the 2 back before the bill are not sold); 5 bottles at ৳160 less
    // the one back; at the counter 380 + 45 + 45 + 2 × 3, less the soap back. The price cut gave
    // money back, not goods: Rahim's cost stays.
    expect(report.items.map(costOf)).toEqual([
      ['Rahim Traders', ...Object.values(costColumns('3500.0000', '3040.0000'))],
      ['Karim Store', ...Object.values(costColumns('684.0000', '640.0000'))],
      ['walk_in', ...Object.values(costColumns('520.0000', '431.0000'))],
    ]);
    expect(report.totals).toEqual({
      gross: '5035.0000',
      returns: '331.0000',
      net: '4704.0000',
      ...costColumns('4704.0000', '4111.0000'),
    });
    expect(report.withCost).toBe(true);
    expect(report.nextCursor).toBeNull();
    // The books have the ৳500 sale written by hand too: the page shows the difference
    expect(report.books).toBe('5204.0000');
    // No quantity or unit outside the product group: a row mixes products
    expect(report.items.map((row) => [row.quantity, row.baseUnit, row.month])).toEqual([
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ]);
  });

  it("groups a product's variants in one row, with its quantity in the base unit", async () => {
    const report = await sales(`${period()}&groupBy=product`);
    expect(
      report.items.map((row) => [row.name, row.code, row.quantity, row.baseUnit?.code]),
    ).toEqual([
      // 8 billed + 1 at the counter; the price cut takes no bag back
      ['Miniket rice 5 kg', rice.code, '9.0000', 'pcs'],
      // 5 less the one back
      ['Soybean oil 1 L', oil.code, '4.0000', 'pcs'],
      // A rose and a lime sold, the lime back
      ['Toilet soap 100 g', soap.code, '1.0000', 'pcs'],
      ['Matchbox', matches.code, '2.0000', 'pcs'],
    ]);
    expect(report.items.map(moneyOf)).toEqual([
      ['item', 'Miniket rice 5 kg', '4050.0000', '100.0000', '3950.0000'],
      ['item', 'Soybean oil 1 L', '855.0000', '171.0000', '684.0000'],
      ['item', 'Toilet soap 100 g', '120.0000', '60.0000', '60.0000'],
      ['item', 'Matchbox', '10.0000', '0.0000', '10.0000'],
    ]);
    expect(report.items.map((row) => row.cost)).toEqual([
      '3420.0000',
      '640.0000',
      '45.0000',
      '6.0000',
    ]);
    expect(report.totals.net).toBe('4704.0000');
  });

  it('groups by the own category, by branch and by month', async () => {
    const byCategory = await sales(`${period()}&groupBy=category`);
    expect(byCategory.items.map(moneyOf)).toEqual([
      // Rice is in Rice, not in Groceries above it
      ['item', 'Rice', '4050.0000', '100.0000', '3950.0000'],
      ['item', 'Groceries', '855.0000', '171.0000', '684.0000'],
      ['item', 'Personal care', '120.0000', '60.0000', '60.0000'],
      ['no_category', null, '10.0000', '0.0000', '10.0000'],
    ]);
    expect(byCategory.items.map((row) => [row.key, row.code])).toEqual([
      [riceCategory, null],
      [groceries, null],
      [personalCare, null],
      ['no_category', null],
    ]);

    // A credit note counts in its invoice's branch, a POS return in its store's
    const byBranch = await sales(`${period()}&groupBy=branch`);
    expect(byBranch.items.map(moneyOf)).toEqual([
      ['item', dhanmondi.name, '4180.0000', '160.0000', '4020.0000'],
      ['item', 'Mirpur shop', '855.0000', '171.0000', '684.0000'],
    ]);
    expect(byBranch.items.map((row) => [row.key, row.code])).toEqual([
      [dhanmondi.id, dhanmondi.code],
      [mirpur.id, 'MIR'],
    ]);

    // By month: each document on its own date, the months in the order of their net
    const byMonthRows = await sales(`${period()}&groupBy=month&sort=name`);
    expect(byMonthRows.items.map((row) => [row.month, row.net])).toEqual(byMonth(soldOn));
    expect(byMonthRows.items.every((row) => row.key === row.month && row.name === null)).toBe(true);
  });

  it('filters by branch, customer group and category, with the sub-categories', async () => {
    const atMirpur = await sales(`${period()}&branchId=${mirpur.id}`);
    expect(atMirpur.items.map(moneyOf)).toEqual([
      ['item', 'Karim Store', '855.0000', '171.0000', '684.0000'],
    ]);
    // The books of that branch: the sale by hand was in Dhanmondi
    expect(atMirpur.books).toBe('684.0000');

    // A walk-in has no group: the wholesale customers only
    const wholesaleOnly = await sales(`${period()}&customerGroupId=${wholesale}`);
    expect(wholesaleOnly.items.map(moneyOf)).toEqual([
      ['item', 'Karim Store', '855.0000', '171.0000', '684.0000'],
    ]);
    // The books know no customer group: nothing to compare with
    expect(wholesaleOnly.books).toBeNull();

    // Groceries is rice (in Rice, under it) and oil
    const inGroceries = await sales(`${period()}&groupBy=product&categoryId=${groceries}`);
    expect(inGroceries.items.map((row) => [row.name, row.net])).toEqual([
      ['Miniket rice 5 kg', '3950.0000'],
      ['Soybean oil 1 L', '684.0000'],
    ]);
    expect(inGroceries.totals.net).toBe('4634.0000');
    expect(inGroceries.books).toBeNull();
    // The sub-category alone
    const riceOnly = await sales(`${period()}&groupBy=category&categoryId=${riceCategory}`);
    expect(riceOnly.items.map((row) => [row.name, row.net])).toEqual([['Rice', '3950.0000']]);
  });

  it('counts both days at the ends of the period, and nothing outside it or not posted', async () => {
    // Rahim's invoice and Karim's are the first and the last day of this period
    const ends = await sales(`from=${day(-18)}&to=${day(-10)}`);
    expect(ends.items.map((row) => [row.name, row.net])).toEqual([
      ['Rahim Traders', '3600.0000'],
      ['Karim Store', '855.0000'],
    ]);
    const inside = await sales(`from=${day(-17)}&to=${day(-11)}`);
    expect(inside.items).toEqual([]);
    expect(inside.totals).toEqual({
      gross: '0.0000',
      returns: '0.0000',
      net: '0.0000',
      ...costColumns('0.0000', '0.0000'),
    });
    // The home delivery of 70 days ago, a service: no cost
    const old = await sales(`from=${day(-70)}&to=${day(-70)}&groupBy=product`);
    expect(old.items.map((row) => [row.name, row.net, row.cost])).toEqual([
      ['Home delivery', '100.0000', '0.0000'],
    ]);
    // Today: the POS sale and its return, never the draft of ৳9,999
    const now = await sales(`from=${today}&to=${today}`);
    expect(now.totals.net).toBe('520.0000');
  });

  it('sorts amounts as numbers, and puts the rows that are no one last', async () => {
    const keys = (report: SalesReport) => report.items.map((row) => row.name ?? row.kind);
    // ৳3,500, ৳684, ৳520: as text, 684 would come first
    expect(keys(await sales(`${period()}&sort=-net`))).toEqual([
      'Rahim Traders',
      'Karim Store',
      'walk_in',
    ]);
    expect(keys(await sales(`${period()}&sort=net`))).toEqual([
      'walk_in',
      'Karim Store',
      'Rahim Traders',
    ]);
    // The walk-ins have no name: last whichever way the names go
    expect(keys(await sales(`${period()}&sort=name`))).toEqual([
      'Karim Store',
      'Rahim Traders',
      'walk_in',
    ]);
    expect(keys(await sales(`${period()}&sort=-name`))).toEqual([
      'Rahim Traders',
      'Karim Store',
      'walk_in',
    ]);
    // Margins: Karim 6.4%, the walk-ins 17.1%, Rahim 13.1%
    expect(keys(await sales(`${period()}&sort=-marginPercent`))).toEqual([
      'walk_in',
      'Rahim Traders',
      'Karim Store',
    ]);
    expect(keys(await sales(`${period()}&sort=-returns`))).toEqual([
      'Karim Store',
      'Rahim Traders',
      'walk_in',
    ]);
    const byQuantity = await sales(`${period()}&groupBy=product&sort=-quantity`);
    expect(byQuantity.items.map((row) => row.quantity)).toEqual([
      '9.0000',
      '4.0000',
      '2.0000',
      '1.0000',
    ]);
    // A month sorts by its date, the newest first
    const months = await sales(`${period()}&groupBy=month&sort=-name`);
    expect(months.items.map((row) => row.month)).toEqual(
      byMonth(soldOn)
        .map(([month]) => month)
        .toReversed(),
    );
  });

  it('pages the rows, with the totals of all of them on every page', async () => {
    const all = await sales(`${period()}&groupBy=product&sort=name`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: SalesReport = await sales(
        `${period()}&groupBy=product&sort=name&limit=3${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      expect(page.totals).toEqual(all.totals);
      expect(page.books).toBe(all.books);
      seen.push(...page.items.map((row) => row.key));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.items.map((row) => row.key));
    expect(seen).toHaveLength(4);

    const broken = await send('GET', `/reports/sales?${period()}&cursor=not-a-cursor`);
    expect(broken.statusCode).toBe(400);
    expect(problemOf(broken).code).toBe('invalid_cursor');
  });

  it('shows the cost only with the stock value, and never sorts by it without', async () => {
    const report = await sales(period(), shirin);
    expect(report.withCost).toBe(false);
    expect(report.items.map(costOf)).toEqual([
      ['Rahim Traders', null, null, null],
      ['Karim Store', null, null, null],
      ['walk_in', null, null, null],
    ]);
    expect(report.totals).toEqual({
      gross: '5035.0000',
      returns: '331.0000',
      net: '4704.0000',
      cost: null,
      margin: null,
      marginPercent: null,
    });
    // The order of the rows would tell the hidden cost
    for (const sort of ['cost', '-margin', 'marginPercent']) {
      const refused = await send(
        'GET',
        `/reports/sales?${period()}&sort=${sort}`,
        undefined,
        shirin,
      );
      expect(refused.statusCode).toBe(403);
      expect(problemOf(refused)).toMatchObject({
        code: 'permission_missing',
        params: { permissions: 'inventory.stock.value' },
      });
    }
    // No report permission, no report
    expect((await send('GET', `/reports/sales?${period()}`, undefined, rafiq)).statusCode).toBe(
      403,
    );
  });

  it('refuses a quantity sort outside the product group, and a period the wrong way round', async () => {
    const byCustomer = await send('GET', `/reports/sales?${period()}&sort=quantity`);
    expect(problemOf(byCustomer).fieldErrors).toEqual({ sort: ['report_sort_invalid'] });
    const backwards = await send('GET', `/reports/sales?from=${today}&to=${day(-1)}`);
    expect(problemOf(backwards).fieldErrors).toEqual({ to: ['report_range_invalid'] });
    const unknownGroup = await send('GET', `/reports/sales?${period()}&groupBy=cashier`);
    expect(unknownGroup.statusCode).toBe(400);
  });
});

describe('The purchase report', () => {
  it('adds up bills and debit notes by supplier', async () => {
    const report = await purchases(period());
    expect(report.items.map(moneyOf)).toEqual([
      // The rent ৳12,000, ৳1,000 off
      ['item', 'Dhanmondi Properties Ltd.', '12000.0000', '1000.0000', '11000.0000'],
      // Sugar ৳2,500 and the van ৳300; ৳250 back with the bill, ৳120 without one
      ['item', 'Meghna Agro Mills', '2800.0000', '370.0000', '2430.0000'],
    ]);
    expect(report.totals).toEqual({
      gross: '14800.0000',
      returns: '1370.0000',
      net: '13430.0000',
    });
  });

  it('puts the lines with no product in one Expenses row, by product', async () => {
    const report = await purchases(`${period()}&groupBy=product`);
    expect(report.items.map(moneyOf)).toEqual([
      ['expenses', null, '12300.0000', '1000.0000', '11300.0000'],
      ['item', 'Sugar 1 kg', '2500.0000', '370.0000', '2130.0000'],
    ]);
    // 20 kg in, 2 back from the receipt, 1 back on its own; the Expenses row counts no quantity
    expect(report.items.map((row) => [row.kind, row.quantity, row.baseUnit?.code ?? null])).toEqual(
      [
        ['expenses', null, null],
        ['item', '17.0000', 'pcs'],
      ],
    );
    expect(report.items.map((row) => row.key)).toEqual(['expenses', sugar.id]);
    // The rows always add up to all purchases
    expect(report.totals.net).toBe('13430.0000');
  });

  it('puts the products in one Products row, by expense account', async () => {
    const report = await purchases(`${period()}&groupBy=account`);
    // The largest first: the Products row sorts by its net like any other
    expect(report.items.map((row) => [row.kind, row.code, row.name, row.net])).toEqual([
      ['item', '5220', 'Office rent', '11000.0000'],
      ['products', null, null, '2130.0000'],
      ['item', '5240', 'Transport and conveyance', '300.0000'],
    ]);
    expect(report.totals.net).toBe('13430.0000');
  });

  it('groups by month, and leaves the draft bill out', async () => {
    const report = await purchases(`${period()}&groupBy=month&sort=name`);
    expect(report.items.map((row) => [row.month, row.net])).toEqual(byMonth(boughtOn));
  });

  it('filters by supplier group, category and branch', async () => {
    const mills = await purchases(`${period()}&supplierGroupId=${localMills}`);
    expect(mills.items.map((row) => [row.name, row.net])).toEqual([
      ['Meghna Agro Mills', '2430.0000'],
    ]);
    // A category is a product's: the van hire and the rent have none, so they drop out
    const inGroceries = await purchases(`${period()}&groupBy=account&categoryId=${groceries}`);
    expect(inGroceries.items.map((row) => [row.kind, row.net])).toEqual([
      ['products', '2130.0000'],
    ]);
    // Every bill here was the Dhanmondi shop's
    const atMirpur = await purchases(`${period()}&branchId=${mirpur.id}`);
    expect(atMirpur.items).toEqual([]);
    expect(atMirpur.totals.net).toBe('0.0000');
  });

  it('sorts a quantity by product, with the Expenses row last either way', async () => {
    for (const sort of ['quantity', '-quantity']) {
      const report = await purchases(`${period()}&groupBy=product&sort=${sort}`);
      expect(report.items.map((row) => row.kind)).toEqual(['item', 'expenses']);
    }
    for (const sort of ['name', '-name']) {
      const report = await purchases(`${period()}&groupBy=account&sort=${sort}`);
      expect(report.items.map((row) => row.kind).at(-1)).toBe('products');
    }
    const refused = await send('GET', `/reports/purchases?${period()}&sort=-quantity`);
    expect(problemOf(refused).fieldErrors).toEqual({ sort: ['report_sort_invalid'] });
  });

  it('needs the purchase report permission, not the cost', async () => {
    const report = await purchases(period(), shirin);
    expect(report.totals.net).toBe('13430.0000');
    expect((await send('GET', `/reports/purchases?${period()}`, undefined, rafiq)).statusCode).toBe(
      403,
    );
  });
});
