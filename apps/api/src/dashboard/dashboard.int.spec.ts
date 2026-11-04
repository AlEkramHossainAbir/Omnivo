import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  billSchema,
  type Branch,
  branchSchema,
  type Customer,
  customerSchema,
  type Dashboard,
  dashboardPeriods,
  dashboardSchema,
  type Device,
  deviceSchema,
  invoiceSchema,
  journalEntrySchema,
  ledgerPageSchema,
  memberPageSchema,
  negateMoney,
  type PermissionKey,
  type PosCashReason,
  posCashReasonSchema,
  type PosRegister,
  posRegisterSchema,
  posSaleSchema,
  type Product,
  productSchema,
  receiptSchema,
  roleSchema,
  settingsSchema,
  setupSchema,
  shiftIsoDate,
  subtractMoney,
  sumMoney,
  type Supplier,
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
import postgres from 'postgres';
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

// Step 21a. Nabil Super Shop: a grocery in Mirpur (the main branch) and a second shop in Uttara.
// Nusrat (the owner) sees every card; Shirin reads the sales report only; Jamal keeps the stock and
// reads the cash; Rafiq has no role. The tests run in order: an empty dashboard, then the books by
// hand (journal entries), then real documents (invoices, a POS sale, bills, a receipt), the reorder
// levels, and last what each person may see.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: a closing row of the day totals, which no route writes on a date this close
let sql: postgres.Sql;
let owner: SignedIn;
let shirin: SignedIn;
let jamal: SignedIn;
let rafiq: SignedIn;
let today: string;
let main: Warehouse;
let uttara: Branch;
let uttaraStore: Warehouse;
let accounts: Account[];
let vat: TaxRate;
let exempt: TaxRate;
let pcs: string;
let rice: Product;
let oil: Product;
let sugar: Product;
let lentils: Product;
let tea: Product;
let salt: Product;
let soap: Product;
let matches: Product;
let karim: Customer;
let rahim: Customer;
let landlord: Supplier;
let floatIn: PosCashReason;
let counterPc: Device;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type SaleLine = SaleCommand['input']['lines'][number];
type OpenCommand = Extract<SyncCommandInput, { type: 'pos_shift.open' }>;

// What the books were told was sold, by day and branch: the sales the cards must add up. Every
// test that posts a sale adds it here, so the expected numbers hold on any day the test runs (on
// the 1st, yesterday is last month's).
const booked: { date: string; branchId: string | null; amount: string }[] = [];

// A UUIDv7 as a device makes it. Only the version digit matters to the server's checks.
function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

const day = (days: number) => shiftIsoDate(today, days);

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

async function dashboard(query = '', as = owner): Promise<Dashboard> {
  const res = await send('GET', `/dashboard${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return dashboardSchema.parse(res.json());
}

// A card that must be there: the owner holds every permission
function card<T>(value: T | null): T {
  if (value === null) throw new Error('the card is missing');
  return value;
}

function accountId(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

async function addProduct(name: string, salePrice: string): Promise<Product> {
  return created(productSchema, '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcs,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [{ id: null, sku: '', optionValues: [], barcode: '', salePrice, archived: false }],
    units: [],
    customFields: {},
  });
}

async function addCustomer(name: string): Promise<Customer> {
  return created(customerSchema, '/customers', {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'bn',
    bin: '',
    paymentTermsDays: 0,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
  });
}

function inLine(product: Product, quantity: string, unitCost: string) {
  return {
    variantId: variantOf(product),
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

// A journal line by account code, on a branch or on none
function line(code: string, debit: string, credit: string, branchId: string | null) {
  return { accountId: accountId(code), branchId, description: '', debit, credit };
}

async function entry(date: string, lines: object[]): Promise<void> {
  const res = await send('POST', '/journal-entries', {
    date,
    narration: 'Dashboard test',
    lines,
    post: true,
  });
  expect(res.statusCode, res.body).toBe(201);
  journalEntrySchema.parse(res.json());
}

// A sale by hand: cash in, the sales account credited
async function cashSale(date: string, amount: string, branchId: string | null): Promise<void> {
  await entry(date, [line('1110', amount, '', branchId), line('4110', '', amount, branchId)]);
  booked.push({ date, branchId, amount });
}

// What the sales card must say from `booked`: one branch's, or (undefined) the whole workspace's
function expectedSales(branchId?: string) {
  const periods = dashboardPeriods(today);
  const sum = (from: string, to: string) =>
    sumMoney(
      booked
        .filter((sold) => branchId === undefined || sold.branchId === branchId)
        .filter((sold) => sold.date >= from && sold.date <= to)
        .map((sold) => sold.amount),
    );
  return {
    today: sum(periods.today, periods.today),
    yesterday: sum(periods.yesterday, periods.yesterday),
    monthToDate: sum(periods.monthStart, periods.today),
    lastMonthToDate: sum(periods.lastMonthStart, periods.lastMonthEnd),
  };
}

// What an account moved by over the days, debit − credit, from its ledger: the journal's own
// lines, not the day totals the dashboard reads
async function movement(code: string, from: string, to: string): Promise<string> {
  const res = await send('GET', `/accounts/${accountId(code)}/ledger?from=${from}&to=${to}`);
  expect(res.statusCode, res.body).toBe(200);
  const ledger = ledgerPageSchema.parse(res.json());
  return subtractMoney(ledger.closingBalance, ledger.openingBalance);
}

// The sales of the books over the days: the credit of Sales less the debit of Sales returns
async function booksSales(from: string, to: string): Promise<string> {
  const moved = await Promise.all([movement('4110', from, to), movement('4130', from, to)]);
  return negateMoney(sumMoney(moved));
}

function invoiceLine(product: Product, quantity: string, unitPrice: string) {
  return {
    variantId: variantOf(product),
    unitId: pcs,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: vat.id,
    deliveryLineId: '',
    orderLineId: '',
    batchId: '',
    serialNumbers: [],
  };
}

// A direct invoice: the goods leave the warehouse with it, so it posts the sale and its cost
function invoiceForm(
  customer: Customer,
  warehouse: Warehouse,
  date: string,
  lines: object[],
  extra: object = {},
) {
  return {
    customerId: customer.id,
    date,
    dueDate: '',
    customerReference: '',
    branchId: warehouse.branchId,
    warehouseId: warehouse.id,
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

// A bill with one expense and no goods, posted when submitted (no approval level is set)
function billForm(
  date: string,
  dueDate: string,
  number: string,
  expense: { code: string; description: string; amount: string },
) {
  return {
    supplierId: landlord.id,
    date,
    dueDate,
    supplierBillNumber: number,
    mushakNumber: '',
    mushakDate: '',
    branchId: main.branchId,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: [],
    expenses: [
      {
        accountId: accountId(expense.code),
        description: expense.description,
        amount: expense.amount,
        taxRateId: exempt.id,
      },
    ],
    submit: true,
  };
}

async function reorderLevel(warehouse: Warehouse, product: Product, minQuantity: string) {
  const res = await send('PUT', '/stock/reorder-levels', {
    warehouseId: warehouse.id,
    variantId: variantOf(product),
    minQuantity,
    reorderQuantity: '',
  });
  expect(res.statusCode, res.body).toBe(200);
}

// A member of the shop with one role of exactly these permissions; [] = no role at all
async function memberWith(
  person: { fullName: string; email: string; password: string },
  permissions: PermissionKey[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${person.fullName} Store`,
    workspaceSlug: `${person.email.split('@')[0] ?? 'member'}-store`,
    ...person,
  });
  await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'nabil-super-shop' });
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
    workspace: 'nabil-super-shop',
    email: person.email,
    password: person.password,
    keepSignedIn: false,
  });
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
  sql = postgres(pg.superuserUrl, { max: 2 });
  owner = await signUp(app, {
    companyName: 'Nabil Super Shop',
    workspaceSlug: 'nabil-super-shop',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nabilshop.com',
    password: 'Mirpur-grocery-2026',
  });
  expect((await send('POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  today = todayIn(settingsSchema.parse((await send('GET', '/settings')).json()).timezone);

  const [found] = warehouseListSchema
    .parse((await send('GET', '/warehouses')).json())
    .items.filter((warehouse) => warehouse.code === 'MAIN');
  if (!found) throw new Error('no MAIN warehouse');
  main = found;
  uttara = await created(branchSchema, '/branches', {
    code: 'UTT',
    name: 'Uttara shop',
    phone: '',
    address: 'Sector 7, Uttara',
  });
  uttaraStore = await created(warehouseSchema, '/warehouses', {
    branchId: uttara.id,
    code: 'UTT1',
    name: 'Uttara store',
    address: '',
  });

  // A bank account under the bank group, and a Sales returns account: the retail chart has
  // neither (its 4120 is "Service income")
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  await created(accountSchema, '/accounts', {
    parentId: accountId('1120'),
    code: '1121',
    name: 'Dutch-Bangla Bank CD A/C',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
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
  rice = await addProduct('Miniket rice 5 kg', '450');
  oil = await addProduct('Soybean oil 1 L', '190');
  sugar = await addProduct('Sugar 1 kg', '140');
  lentils = await addProduct('Masur dal 1 kg', '130');
  tea = await addProduct('Tea 400 g', '220');
  salt = await addProduct('Salt 1 kg', '42');
  soap = await addProduct('Toilet soap 100 g', '60');
  // Never stocked
  matches = await addProduct('Matchbox', '5');
  for (const [warehouse, lines] of [
    [
      main,
      [
        inLine(rice, '40', '380'),
        inLine(oil, '60', '160'),
        inLine(sugar, '30', '120'),
        inLine(lentils, '30', '105'),
        inLine(tea, '20', '180'),
        inLine(salt, '60', '35'),
        inLine(soap, '2', '45'),
      ],
    ],
    [uttaraStore, [inLine(rice, '10', '380')]],
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
  karim = await addCustomer('Karim Store');
  rahim = await addCustomer('Rahim Traders');
  landlord = await created(supplierSchema, '/suppliers', {
    code: '',
    name: 'Mirpur Properties Ltd.',
    groupId: '',
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
  floatIn = await created(posCashReasonSchema, '/pos/cash-reasons', {
    name: 'Float from the owner',
    direction: 'in',
    accountId: accountId('3100'),
  });
  const device = await send(
    'POST',
    '/sync/devices',
    { id: v7(), name: 'Front counter PC', branchId: main.branchId },
    owner,
  );
  expect(device.statusCode, device.body).toBe(201);
  counterPc = deviceSchema.parse(device.json());

  shirin = await memberWith(
    { fullName: 'Shirin Akter', email: 'shirin@nabilshop.com', password: 'Sales-report-2026' },
    ['sales.report.read'],
  );
  jamal = await memberWith(
    { fullName: 'Jamal Uddin', email: 'jamal@nabilshop.com', password: 'Store-keeper-2026' },
    ['inventory.report.read', 'inventory.stock.value', 'accounting.report.read'],
  );
  rafiq = await memberWith(
    { fullName: 'Rafiq Islam', email: 'rafiq@nabilshop.com', password: 'No-role-yet-2026' },
    [],
  );
}, 240_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('A new shop', () => {
  it('has a dashboard of zeros, with a point for every day and every money account', async () => {
    // The opening stock is posted, but it is no sale and no money
    const answer = await dashboard();
    expect(answer.today).toBe(today);
    expect(answer.branchId).toBeNull();
    const sales = card(answer.sales);
    expect(sales).toMatchObject({
      today: '0.0000',
      yesterday: '0.0000',
      monthToDate: '0.0000',
      lastMonthToDate: '0.0000',
    });
    expect(sales.days.map((point) => point.date)).toEqual(
      Array.from({ length: 30 }, (_, index) => day(index - 29)),
    );
    expect(sales.days.every((point) => point.amount === '0.0000')).toBe(true);
    expect(answer.margin).toEqual({
      monthToDate: { sales: '0.0000', cost: '0.0000' },
      lastMonthToDate: { sales: '0.0000', cost: '0.0000' },
    });
    // Every account money is kept in, at zero, even with no entry yet
    expect(answer.cash).toEqual({
      accounts: [
        { accountId: accountId('1110'), code: '1110', name: 'Cash in hand', balance: '0.0000' },
        {
          accountId: accountId('1121'),
          code: '1121',
          name: 'Dutch-Bangla Bank CD A/C',
          balance: '0.0000',
        },
      ],
      total: '0.0000',
      yesterday: '0.0000',
    });
    expect(answer.topProducts).toEqual([]);
    const nothingDue = { total: '0.0000', overdue: '0.0000', overdueCount: 0 };
    expect(answer.receivables).toEqual(nothingDue);
    expect(answer.payables).toEqual(nothingDue);
    expect(answer.lowStock).toEqual({ count: 0, items: [] });
  });
});

describe('The books by hand', () => {
  beforeAll(async () => {
    // The owner's capital, long ago, and a bank deposit yesterday
    await entry(day(-40), [line('1110', '10000', '', null), line('3100', '', '10000', null)]);
    await entry(day(-1), [
      line('1121', '6000', '', main.branchId),
      line('1110', '', '6000', main.branchId),
    ]);
    await cashSale(today, '1000', main.branchId);
    await cashSale(day(-1), '800', main.branchId);
    await cashSale(today, '300', uttara.id);
    // A line with no branch counts for the whole shop, and for no branch
    await cashSale(today, '100', null);
    await cashSale(dashboardPeriods(today).lastMonthStart, '700', main.branchId);
    // Money given back for a return: the Sales returns account lowers the sales
    await entry(today, [
      line('4130', '200', '', main.branchId),
      line('1110', '', '200', main.branchId),
    ]);
    booked.push({ date: today, branchId: main.branchId, amount: '-200' });
    // Service income is income, but not the shop's sales
    await entry(today, [
      line('1110', '500', '', main.branchId),
      line('4120', '', '500', main.branchId),
    ]);
    // A cheque dated tomorrow: not a sale yet, and not money in the bank yet
    await entry(day(1), [
      line('1121', '9999', '', main.branchId),
      line('4110', '', '9999', main.branchId),
    ]);
  });

  it('adds up the sales accounts by day, less the returns, and nothing else', async () => {
    const sales = card((await dashboard()).sales);
    expect(sales).toMatchObject(expectedSales());
    // On 4 November: 1,000 + 300 + 100 − 200 today, 800 yesterday
    expect(sales.today).toBe('1200.0000');
    expect(sales.days.at(-1)).toEqual({ date: today, amount: '1200.0000' });
    expect(sales.days.at(-2)).toEqual({ date: day(-1), amount: '800.0000' });
    // The same days as the books: the ledgers of Sales and Sales returns
    const periods = dashboardPeriods(today);
    expect(sales.monthToDate).toBe(await booksSales(periods.monthStart, today));
    expect(sales.lastMonthToDate).toBe(
      await booksSales(periods.lastMonthStart, periods.lastMonthEnd),
    );
  });

  it('filters the sales by branch; a line with no branch is in no branch', async () => {
    const mirpur = card((await dashboard(`?branchId=${main.branchId}`)).sales);
    expect(mirpur).toMatchObject(expectedSales(main.branchId));
    expect(mirpur.today).toBe('800.0000');
    const uttaraShop = await dashboard(`?branchId=${uttara.id}`);
    expect(uttaraShop.branchId).toBe(uttara.id);
    expect(card(uttaraShop.sales)).toMatchObject(expectedSales(uttara.id));
    expect(card(uttaraShop.sales).today).toBe('300.0000');
  });

  it('leaves out a year-end closing row, even one dated today', async () => {
    // A year close posts on the year's last day (30 June), which the dashboard reads only on a few
    // days of the year. The row is written by hand on today, as the trigger would write one.
    await sql`INSERT INTO account_day_totals
                (tenant_id, day, account_id, branch_id, closing, debit, credit)
              SELECT tenant_id, ${today}::date, id, ${main.branchId}::uuid, true, 5000, 0
                FROM ledger_accounts WHERE id = ${accountId('4110')}::uuid`;
    expect(card((await dashboard()).sales).today).toBe('1200.0000');
  });

  it('shows the margin with the sales of the same days', async () => {
    const margin = card((await dashboard()).margin);
    expect(margin.monthToDate).toEqual({ sales: expectedSales().monthToDate, cost: '0.0000' });
    expect(margin.lastMonthToDate).toEqual({
      sales: expectedSales().lastMonthToDate,
      cost: '0.0000',
    });
  });

  it('shows every money account up to today, the largest first, and yesterday’s total', async () => {
    // Cash: 10,000 − 6,000 + 1,000 + 800 + 300 + 100 + 700 − 200 + 500. The bank: the deposit,
    // not tomorrow's cheque.
    const cash = card((await dashboard()).cash);
    expect(cash.accounts.map((account) => [account.code, account.balance])).toEqual([
      ['1110', '7200.0000'],
      ['1121', '6000.0000'],
    ]);
    expect(cash.total).toBe('13200.0000');
    // Up to the end of yesterday: what came in today is the difference
    expect(cash.yesterday).toBe('11500.0000');
    // The branch filter never moves the cash: a bank account is the whole shop's
    expect((await dashboard(`?branchId=${uttara.id}`)).cash).toEqual(cash);
  });
});

describe('Real documents', () => {
  let shift: string;
  let register: PosRegister;
  let overdueInvoice: string;

  beforeAll(async () => {
    // Karim Store buys six things today, due today (terms 0): not overdue yet
    await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(karim, main, today, [
        invoiceLine(rice, '4', '450'),
        invoiceLine(oil, '5', '190'),
        invoiceLine(sugar, '5', '140'),
        invoiceLine(lentils, '4', '130'),
        invoiceLine(tea, '2', '220'),
        invoiceLine(salt, '5', '42'),
      ]),
    );
    booked.push({ date: today, branchId: main.branchId, amount: '4620' });
    // Rahim Traders buys at the Uttara shop 10 days ago, due yesterday
    overdueInvoice = (
      await created(
        invoiceSchema,
        '/invoices',
        invoiceForm(rahim, uttaraStore, day(-10), [invoiceLine(rice, '2', '450')], {
          dueDate: day(-1),
        }),
      )
    ).id;
    booked.push({ date: day(-10), branchId: uttara.id, amount: '900' });
    // A day before the chart's 30 days: in the books, not in the top products
    await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(karim, main, day(-30), [invoiceLine(salt, '20', '42')]),
    );
    booked.push({ date: day(-30), branchId: main.branchId, amount: '840' });
    // A draft is not a sale: 50 salts would top the list
    await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(karim, main, today, [invoiceLine(salt, '50', '42')], { post: false }),
    );
    // Rahim pays ৳400 of what is due
    await created(receiptSchema, '/receipts', {
      customerId: rahim.id,
      date: today,
      amount: '400',
      accountId: accountId('1110'),
      method: 'cash',
      reference: '',
      branchId: main.branchId,
      note: '',
      allocations: [{ invoiceId: overdueInvoice, amount: '400' }],
    });

    // The front counter: a register, the device takes it, a shift opens, and a sale of a tea and
    // three soaps (two in stock: one is sold short)
    register = await created(posRegisterSchema, '/pos/registers', {
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
    shift = v7();
    const open: OpenCommand = {
      id: v7(),
      type: 'pos_shift.open',
      shiftId: shift,
      input: {
        registerId: register.id,
        sequence: 1,
        date: today,
        openedAt: new Date().toISOString(),
        opening: { notes: null, total: '1000' },
        floatReasonId: floatIn.id,
      },
    };
    const posLine = (product: Product, quantity: string, price: string): SaleLine => ({
      variantId: variantOf(product),
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
        shiftId: shift,
        date: today,
        soldAt: new Date(Date.now() + 1000).toISOString(),
        customerId: '',
        pricesIncludeVat: false,
        lines: [posLine(tea, '1', '220'), posLine(soap, '3', '60')],
        billDiscountType: 'amount',
        billDiscount: '0',
        // ৳400 and 15% VAT
        payments: [{ method: 'cash', amount: '460', reference: '' }],
      },
    };
    const pushed = await send('POST', '/sync/push', {
      deviceId: counterPc.id,
      protocol: SYNC_PROTOCOL,
      commands: [open, sale],
    });
    expect(pushed.statusCode, pushed.body).toBe(200);
    const results = syncPushSchema.parse(pushed.json()).results;
    expect(
      results.map((result) => result.status),
      JSON.stringify(results),
    ).toEqual(['accepted', 'accepted']);
    const saved = posSaleSchema.parse((await send('GET', `/pos/sales/${sale.saleId}`)).json());
    expect(saved.total).toBe('460.0000');
    booked.push({ date: today, branchId: main.branchId, amount: '400' });

    // The rent, overdue, and the electricity, due next month
    await created(
      billSchema,
      '/bills',
      billForm(day(-20), day(-5), 'MP/2026/0091', {
        code: '5220',
        description: 'Shop rent, Mirpur',
        amount: '12000',
      }),
    );
    await created(
      billSchema,
      '/bills',
      billForm(today, day(25), 'DESCO-88231', {
        code: '5230',
        description: 'Electricity',
        amount: '3000',
      }),
    );
  });

  it('counts invoices and POS sales in the sales, as the books do', async () => {
    const periods = dashboardPeriods(today);
    const answer = await dashboard();
    const sales = card(answer.sales);
    expect(sales).toMatchObject(expectedSales());
    expect(sales.monthToDate).toBe(await booksSales(periods.monthStart, today));
    // The cost is the cost of goods sold account's, sold short included
    const margin = card(answer.margin);
    expect(margin.monthToDate).toEqual({
      sales: sales.monthToDate,
      cost: await movement('5110', periods.monthStart, today),
    });
    expect(margin.lastMonthToDate.cost).toBe(
      await movement('5110', periods.lastMonthStart, periods.lastMonthEnd),
    );
    // Today's documents had a cost: the margin is no longer the whole sales
    expect(margin.monthToDate.cost).not.toBe('0.0000');
  });

  it('lists the five products that sold most, invoices and POS together', async () => {
    const top = card((await dashboard()).topProducts);
    expect(
      top.map((item) => [item.productName, item.quantity, item.amount, item.baseUnit.code]),
    ).toEqual([
      // 4 + 2 at Uttara
      ['Miniket rice 5 kg', '6.0000', '2700.0000', 'pcs'],
      ['Soybean oil 1 L', '5.0000', '950.0000', 'pcs'],
      ['Sugar 1 kg', '5.0000', '700.0000', 'pcs'],
      // 2 on the invoice and 1 at the counter: above the lentils only with the POS sale
      ['Tea 400 g', '3.0000', '660.0000', 'pcs'],
      ['Masur dal 1 kg', '4.0000', '520.0000', 'pcs'],
    ]);
    expect(top[0]).toMatchObject({
      variantId: variantOf(rice),
      productId: rice.id,
      sku: rice.variants[0]?.sku,
    });
  });

  it("filters the top products by branch: a POS sale is its warehouse's branch", async () => {
    const uttaraTop = card((await dashboard(`?branchId=${uttara.id}`)).topProducts);
    expect(uttaraTop.map((item) => [item.productName, item.amount])).toEqual([
      ['Miniket rice 5 kg', '900.0000'],
    ]);
    const mirpurTop = card((await dashboard(`?branchId=${main.branchId}`)).topProducts);
    expect(mirpurTop.map((item) => [item.productName, item.amount])).toEqual([
      ['Miniket rice 5 kg', '1800.0000'],
      ['Soybean oil 1 L', '950.0000'],
      ['Sugar 1 kg', '700.0000'],
      ['Tea 400 g', '660.0000'],
      ['Masur dal 1 kg', '520.0000'],
    ]);
  });

  it('shows what customers owe and what is overdue, after what they paid', async () => {
    // Owed: 5,313 (today, due today) + 1,035 (due yesterday) + 966 (30 days ago) − 400 paid
    expect((await dashboard()).receivables).toEqual({
      total: '6914.0000',
      overdue: '1601.0000',
      overdueCount: 2,
    });
  });

  it('shows what is owed to suppliers and what is overdue', async () => {
    expect((await dashboard()).payables).toEqual({
      total: '15000.0000',
      overdue: '12000.0000',
      overdueCount: 1,
    });
    // Dues are the whole shop's, whatever the branch
    expect((await dashboard(`?branchId=${uttara.id}`)).payables?.total).toBe('15000.0000');
  });
});

describe('Low stock', () => {
  beforeAll(async () => {
    // On hand now at the main store: rice 36, oil 55, sugar 25, dal 26, tea 17, salt 35, soap −1,
    // matches 0; at Uttara rice 8
    await reorderLevel(main, rice, '40');
    await reorderLevel(main, oil, '50');
    await reorderLevel(main, sugar, '50');
    await reorderLevel(main, lentils, '100');
    await reorderLevel(main, tea, '20');
    await reorderLevel(main, salt, '0');
    await reorderLevel(main, soap, '0');
    await reorderLevel(main, matches, '0');
    await reorderLevel(uttaraStore, rice, '10');
  });

  it('counts every item at or below its level and lists the five emptiest', async () => {
    const low = card((await dashboard()).lowStock);
    // Oil is above its level, and salt above a level of 0
    expect(low.count).toBe(7);
    expect(
      low.items.map((item) => [
        item.productName,
        item.warehouseName,
        item.onHand,
        item.minQuantity,
      ]),
    ).toEqual([
      // Below zero first, then empty (the names alone would put Matchbox first), then the
      // smallest share of the level
      ['Toilet soap 100 g', main.name, '-1.0000', '0.0000'],
      ['Matchbox', main.name, '0.0000', '0.0000'],
      ['Masur dal 1 kg', main.name, '26.0000', '100.0000'],
      ['Sugar 1 kg', main.name, '25.0000', '50.0000'],
      ['Miniket rice 5 kg', uttaraStore.name, '8.0000', '10.0000'],
    ]);
    expect(low.items[0]).toMatchObject({
      warehouseId: main.id,
      inTransit: '0.0000',
      incoming: '0.0000',
      reorderQuantity: null,
      baseUnit: { code: 'pcs', decimals: 0 },
    });
  });
});

describe('What each person sees', () => {
  it('is only the cards their permissions allow', async () => {
    const all = await dashboard();
    // The sales report alone: the sales and the top products, no margin without the stock value
    const sales = await dashboard('', shirin);
    expect(sales.sales).toEqual(all.sales);
    expect(sales.topProducts).toEqual(all.topProducts);
    expect([sales.margin, sales.cash, sales.receivables, sales.payables, sales.lowStock]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    // The stock value without the sales report is no margin either
    const store = await dashboard('', jamal);
    expect(store.cash).toEqual(all.cash);
    expect(store.lowStock).toEqual(all.lowStock);
    expect([
      store.sales,
      store.margin,
      store.topProducts,
      store.receivables,
      store.payables,
    ]).toEqual([null, null, null, null, null]);
  });

  it('is a page with no cards for a member with no role', async () => {
    const none = await dashboard('', rafiq);
    expect(none).toMatchObject({
      today,
      sales: null,
      margin: null,
      cash: null,
      topProducts: null,
      receivables: null,
      payables: null,
      lowStock: null,
    });
  });
});

describe('The branch in the query', () => {
  it('must be an id; an unknown one is a branch that sold nothing', async () => {
    expect((await send('GET', '/dashboard?branchId=mirpur')).statusCode).toBe(400);
    const all = await dashboard();
    const unknown = await dashboard(`?branchId=${randomUUID()}`);
    expect(card(unknown.sales)).toMatchObject({ today: '0.0000', monthToDate: '0.0000' });
    expect(unknown.topProducts).toEqual([]);
    expect(unknown.margin?.monthToDate).toEqual({ sales: '0.0000', cost: '0.0000' });
    // The whole shop's cards stay as they are
    expect(unknown.cash).toEqual(all.cash);
    expect(unknown.receivables).toEqual(all.receivables);
    expect(unknown.lowStock).toEqual(all.lowStock);
  });
});
