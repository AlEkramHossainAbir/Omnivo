import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  addMoney,
  auditPageSchema,
  type Branch,
  branchSchema,
  type Customer,
  customerSchema,
  type Device,
  deviceSchema,
  type EntryRef,
  journalEntrySchema,
  memberPageSchema,
  type PosCashReason,
  posCashReasonSchema,
  type PosRegister,
  posRegisterSalesPageSchema,
  posRegisterSchema,
  type PosReturn,
  type PosReturnableSale,
  posReturnableSaleSchema,
  posReturnAmounts,
  posReturnPageSchema,
  posReturnSchema,
  type PosSale,
  type PosSaleLine,
  posSaleSchema,
  type PosShift,
  posShiftSchema,
  problemSchema,
  type Product,
  productSchema,
  roleListSchema,
  settingsSchema,
  setupSchema,
  shiftIsoDate,
  sumMoney,
  SYNC_PROTOCOL,
  type SyncCommandInput,
  type SyncResult,
  syncPullSchema,
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
import { z } from 'zod';

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

// Step 20c. Agora Mini Mart again, with a second shop in Uttara. Nusrat (the owner) runs the front
// counter (POS1), Sumi the pharmacy counter (POS2, cash only, returns on the day of the sale only)
// and the Uttara counter (UTT1) takes back receipts of either shop. Rafiq is a member with no role.
// The tests run in order: the setup and the registers, then the returns of the front counter, the
// exchange, the other branch, the shift, the pull, and what happens at the same moment.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: the batches, the serial numbers and the clearing account's balance, which no
// route shows this way, and the immutable rows
let sql: postgres.Sql;
let owner: SignedIn;
let sumi: SignedIn;
let rafiq: SignedIn;
let today: string;
let main: Warehouse;
let uttara: Branch;
let uttaraStore: Warehouse;
let accounts: Account[];
let vat: TaxRate;
let pcs: string;
let juice: Product;
let napa: Product;
let phone: Product;
let wrap: Product;
let farhana: Customer;
let counterPc: Device;
let sumiTablet: Device;
let uttaraPc: Device;
let officeLaptop: Device;
let floatIn: PosCashReason;
let pos1: PosRegister;
let pos2: PosRegister;
let utt1: PosRegister;
// The open shift of each counter
let shift1: string;
let shift2: string;
let shiftU: string;
// The front counter's first sale: two juices and a gift wrapping, for Farhana
let saleA: PosSale;
// Two phones, IMEI-1 and IMEI-2, paid by card
let phones: PosSale;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type SaleLine = SaleCommand['input']['lines'][number];
type Payment = SaleCommand['input']['payments'][number];
type ReturnCommand = Extract<SyncCommandInput, { type: 'pos_return.create' }>;
type ReturnLine = ReturnCommand['input']['lines'][number];
type Refund = ReturnCommand['input']['refunds'][number];
type OpenCommand = Extract<SyncCommandInput, { type: 'pos_shift.open' }>;
type Command = SaleCommand | ReturnCommand | OpenCommand;
// What a return line needs of its sale line, from the sale's page or the return screen's copy
type SoldLine = Pick<PosSaleLine, 'id' | 'quantity' | 'net' | 'vat' | 'returnedQuantity'>;

// A UUIDv7 as a device makes it: the time first, so an id made later sorts later. The lists of
// returns break a tie of dates by the id, and the tests read them in the order they were made.
let idClock = Date.now();
function v7(): string {
  idClock += 1;
  const time = idClock.toString(16).padStart(12, '0');
  const random = randomUUID().replaceAll('-', '');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(13, 16)}-${random.slice(16, 20)}-${random.slice(20)}`;
}

// The device's clock, one second later at every command: the lists are by date and time
let clock = Date.now();
function moment(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

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

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function accountId(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function codeOf(id: string): string {
  return accounts.find((account) => account.id === id)?.code ?? id;
}

// The branch's code, so an entry line reads "DHN" or "UTT"
function branchCodeOf(id: string | null): string {
  if (id === main.branchId) return 'DHN';
  if (id === uttara.id) return 'UTT';
  return String(id);
}

async function member(fullName: string, email: string, password: string): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Store`,
    workspaceSlug: `${email.split('@')[0] ?? 'member'}-store`,
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'agora-mini-mart' });
  return logIn(app, { workspace: 'agora-mini-mart', email, password, keepSignedIn: false });
}

async function giveRoles(email: string, roleNames: string[]): Promise<void> {
  const roles = roleListSchema.parse((await send('GET', '/roles')).json()).items;
  const roleIds = roleNames.map((name) => {
    const role = roles.find((item) => item.name === name);
    if (!role) throw new Error(`no role ${name}`);
    return role.id;
  });
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const res = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds,
    version: found.version,
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function registerDevice(name: string, branchId: string, as = owner): Promise<Device> {
  const res = await send('POST', '/sync/devices', { id: v7(), name, branchId }, as);
  expect(res.statusCode, res.body).toBe(201);
  return deviceSchema.parse(res.json());
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

async function addProduct(
  name: string,
  salePrice: string,
  extra: { type?: string; tracking?: string; hasExpiry?: boolean } = {},
): Promise<Product> {
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
    ...extra,
  });
}

function inLine(product: Product, quantity: string, unitCost: string, extra: object = {}) {
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
    ...extra,
  };
}

function registerForm(code: string, extra: object = {}) {
  return {
    code,
    name: `Counter ${code}`,
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
    ...extra,
  };
}

function editForm(register: PosRegister, extra: object = {}) {
  return {
    name: register.name,
    warehouseId: register.warehouseId,
    accounts: {
      cash: register.accounts.cash,
      card: register.accounts.card ?? '',
      bkash: register.accounts.bkash ?? '',
      nagad: register.accounts.nagad ?? '',
    },
    maxDiscountPercent: register.maxDiscountPercent,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter ?? '',
    overShortAccountId: register.overShortAccountId ?? '',
    varianceAlert: register.varianceAlert,
    lockAfter: register.lockAfter,
    exchangeAccountId: register.exchangeAccountId ?? '',
    returnDays: String(register.returnDays),
    version: register.version,
    ...extra,
  };
}

async function registerNow(register: PosRegister): Promise<PosRegister> {
  const res = await send('GET', `/pos/registers/${register.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterSchema.parse(res.json());
}

// The last sale and the last return number each register gave, as its device keeps them
const sequences = new Map<string, number>();
const returnSequences = new Map<string, number>();

async function claimed(register: PosRegister, device: Device, as = owner): Promise<PosRegister> {
  const res = await send(
    'POST',
    `/pos/registers/${register.id}/claim`,
    { deviceId: device.id },
    as,
  );
  expect(res.statusCode, res.body).toBe(200);
  const held = posRegisterSchema.parse(res.json());
  sequences.set(held.id, held.lastNumber);
  returnSequences.set(held.id, held.lastReturnNumber);
  return held;
}

// The register's first shift, ৳1,000 from the owner
function open(register: PosRegister): OpenCommand {
  return {
    id: v7(),
    type: 'pos_shift.open',
    shiftId: v7(),
    input: {
      registerId: register.id,
      sequence: 1,
      date: today,
      openedAt: moment(),
      opening: { notes: null, total: '1000' },
      floatReasonId: floatIn.id,
    },
  };
}

// A line at its shelf price, 15% VAT
function line(
  product: Product,
  quantity: string,
  price: string,
  extra: Partial<SaleLine> = {},
): SaleLine {
  return {
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
    ...extra,
  };
}

function paid(method: Payment['method'], amount: string, reference = ''): Payment {
  return { method, amount, reference };
}

// A sale with the register's next number, today, to a walk-in
function sale(
  register: PosRegister,
  shiftId: string | null,
  lines: SaleLine[],
  payments: Payment[],
  extra: Partial<SaleCommand['input']> = {},
): SaleCommand {
  const sequence = (sequences.get(register.id) ?? 0) + 1;
  sequences.set(register.id, sequence);
  return {
    id: v7(),
    type: 'pos_sale.create',
    saleId: v7(),
    input: {
      registerId: register.id,
      sequence,
      shiftId,
      date: today,
      soldAt: moment(),
      customerId: '',
      pricesIncludeVat: false,
      lines,
      billDiscountType: 'amount',
      billDiscount: '0',
      payments,
      ...extra,
    },
  };
}

// A return line as the device works it out: its share of the sale line's money, from what the
// device knows came back before (the line's returnedQuantity, or more for a return after another
// one in the same outbox)
function back(sold: SoldLine, quantity: string, extra: Partial<ReturnLine> = {}): ReturnLine {
  const amounts = posReturnAmounts(sold, quantity);
  return {
    saleLineId: sold.id,
    quantity,
    net: amounts.net,
    vat: amounts.vat,
    serialNumbers: [],
    ...extra,
  };
}

// What the lines pay back together
function totalOf(lines: readonly ReturnLine[]): string {
  return sumMoney(lines.map((item) => addMoney(item.net, item.vat)));
}

function cashBack(lines: readonly ReturnLine[]): Refund[] {
  return [{ method: 'cash', amount: totalOf(lines), reference: '' }];
}

// A return with the register's next return number, today
function giveBack(
  register: PosRegister,
  shiftId: string,
  saleId: string,
  lines: ReturnLine[],
  refunds: Refund[],
  extra: Partial<ReturnCommand['input']> = {},
): ReturnCommand {
  const sequence = (returnSequences.get(register.id) ?? 0) + 1;
  returnSequences.set(register.id, sequence);
  return {
    id: v7(),
    type: 'pos_return.create',
    returnId: v7(),
    input: {
      registerId: register.id,
      sequence,
      shiftId,
      date: today,
      returnedAt: moment(),
      saleId,
      lines,
      refunds,
      note: '',
      ...extra,
    },
  };
}

async function push(commands: Command[], device = counterPc, as = owner): Promise<SyncResult[]> {
  const res = await send(
    'POST',
    '/sync/push',
    { deviceId: device.id, protocol: SYNC_PROTOCOL, commands },
    as,
  );
  expect(res.statusCode, res.body).toBe(200);
  return syncPushSchema.parse(res.json()).results;
}

function outcomes(results: SyncResult[]): string[] {
  return results.map((result) =>
    result.status === 'rejected' ? result.error.code : result.status,
  );
}

function refusal(result: SyncResult | undefined) {
  if (result?.status !== 'rejected') throw new Error(`not refused: ${JSON.stringify(result)}`);
  return result.error;
}

async function accepted(commands: Command[], device = counterPc, as = owner): Promise<void> {
  const results = await push(commands, device, as);
  expect(outcomes(results), JSON.stringify(results)).toEqual(commands.map(() => 'accepted'));
}

async function saleNow(id: string): Promise<PosSale> {
  const res = await send('GET', `/pos/sales/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posSaleSchema.parse(res.json());
}

// One sale, pushed alone, that must be accepted
async function sold(command: SaleCommand, device = counterPc, as = owner): Promise<PosSale> {
  await accepted([command], device, as);
  return saleNow(command.saleId);
}

async function returnNow(id: string): Promise<PosReturn> {
  const res = await send('GET', `/pos/returns/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posReturnSchema.parse(res.json());
}

async function returnable(number: string, as = owner): Promise<PosReturnableSale> {
  const res = await send('GET', `/pos/sales/by-number/${number}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return posReturnableSaleSchema.parse(res.json());
}

async function shiftNow(id: string): Promise<PosShift> {
  const res = await send('GET', `/pos/shifts/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posShiftSchema.parse(res.json());
}

function lineOf<T>(lines: readonly T[], at: number): T {
  const found = lines[at];
  if (found === undefined) throw new Error(`no line ${String(at + 1)}`);
  return found;
}

// An entry as [account code, debit, credit, branch], by code: what an accountant reads
async function entryLines(entry: EntryRef | null) {
  if (entry === null) throw new Error('no entry');
  const res = await send('GET', `/journal-entries/${entry.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return journalEntrySchema
    .parse(res.json())
    .lines.map((item) => [
      codeOf(item.accountId),
      item.debit,
      item.credit,
      branchCodeOf(item.branchId),
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

async function auditOf(entityType: string, entityId: string) {
  const res = await send('GET', `/audit-logs?entityType=${entityType}&entityId=${entityId}`);
  expect(res.statusCode, res.body).toBe(200);
  // Oldest first, as the tests tell the story
  return auditPageSchema.parse(res.json()).items.reverse();
}

const quantityRows = z.array(z.object({ quantity: z.string() }));

// The stock of a variant in a warehouse now, every batch together
async function onHand(warehouse: Warehouse, product: Product): Promise<string> {
  const [row] = quantityRows.parse(
    await sql`SELECT coalesce(sum(quantity), 0)::numeric(18, 4)::text AS quantity
                FROM stock_balances
                WHERE warehouse_id = ${warehouse.id} AND variant_id = ${variantOf(product)}`,
  );
  return row?.quantity ?? '0';
}

// A batch's id, by its lot number
async function lotId(lotNumber: string): Promise<string> {
  const [row] = z
    .array(z.object({ id: z.string() }))
    .parse(await sql`SELECT id::text FROM batches WHERE lot_number = ${lotNumber}`);
  if (!row) throw new Error(`no batch ${lotNumber}`);
  return row.id;
}

// The stock of one batch, by its lot number, in the front counter's store
async function lotStock(lotNumber: string): Promise<string> {
  const [row] = quantityRows.parse(
    await sql`SELECT coalesce(sum(s.quantity), 0)::numeric(18, 4)::text AS quantity
                FROM stock_balances s JOIN batches b ON b.id = s.batch_id
                WHERE s.warehouse_id = ${main.id} AND b.lot_number = ${lotNumber}`,
  );
  return row?.quantity ?? '0';
}

// Where a serial number is now: the warehouse's code, or null when it is out of every one
async function serialAt(serialNumber: string): Promise<string | null | undefined> {
  const [row] = z.array(z.object({ code: z.string().nullable() })).parse(
    await sql`SELECT w.code FROM serials s LEFT JOIN warehouses w ON w.id = s.warehouse_id
                  WHERE s.serial_number = ${serialNumber}`,
  );
  return row?.code;
}

// What the books hold on an account, debit less credit
async function balanceOf(code: string): Promise<string> {
  const [row] = z.array(z.object({ balance: z.string() })).parse(
    await sql`SELECT coalesce(sum(debit - credit), 0)::numeric(18, 4)::text AS balance
                  FROM journal_lines WHERE account_id = ${accountId(code)}`,
  );
  return row?.balance ?? '0';
}

// One page is the whole pull: a new workspace has a few hundred rows at most
async function pulled(device: Device, as = owner, cursor?: string) {
  const query = new URLSearchParams({
    deviceId: device.id,
    protocol: String(SYNC_PROTOCOL),
    limit: '1000',
  });
  if (cursor !== undefined) query.set('cursor', cursor);
  const res = await send('GET', `/sync/pull?${query.toString()}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  const page = syncPullSchema.parse(res.json());
  expect(page.hasMore).toBe(false);
  return page;
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
    companyName: 'Agora Mini Mart',
    workspaceSlug: 'agora-mini-mart',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@agoramart.com',
    password: 'Dhanmondi-shop-2026',
  });
  expect((await send('POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  today = todayIn(settingsSchema.parse((await send('GET', '/settings')).json()).timezone);

  sumi = await member('Sumi Akter', 'sumi@agoramart.com', 'Counter-two-2026');
  rafiq = await member('Rafiq Islam', 'rafiq@agoramart.com', 'No-role-yet-2026');
  await giveRoles('sumi@agoramart.com', ['Cashier']);

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

  // The card machine's bank account, under the bank group
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  await created(accountSchema, '/accounts', {
    parentId: accountId('1120'),
    code: '1121',
    name: 'City Bank card settlement',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;

  const rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const fifteen = rates.find((rate) => rate.name === 'VAT 15%');
  if (!fifteen) throw new Error('no VAT 15%');
  vat = fifteen;
  pcs =
    unitListSchema.parse((await send('GET', '/units')).json()).items.find((u) => u.code === 'pcs')
      ?.id ?? '';
  juice = await addProduct('Mango juice 250 ml', '25');
  napa = await addProduct('Napa 500 mg strip', '30', { tracking: 'batch', hasExpiry: true });
  phone = await addProduct('Walton Primo phone', '15000', { tracking: 'serial' });
  wrap = await addProduct('Gift wrapping', '50', { type: 'service' });
  const stocked = await send('POST', '/stock-adjustments', {
    date: shiftIsoDate(today, -40),
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    lines: [
      inLine(juice, '50', '15'),
      inLine(napa, '3', '20', { lotNumber: 'NP-A', expiresOn: shiftIsoDate(today, 200) }),
      inLine(napa, '5', '20', { lotNumber: 'NP-B', expiresOn: shiftIsoDate(today, 90) }),
      inLine(phone, '3', '9000', { serialNumbers: ['IMEI-1', 'IMEI-2', 'IMEI-3'] }),
    ],
    post: true,
  });
  expect(stocked.statusCode, stocked.body).toBe(201);
  farhana = await created(customerSchema, '/customers', {
    code: '',
    name: 'Farhana Akter',
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
  floatIn = await created(posCashReasonSchema, '/pos/cash-reasons', {
    name: 'Float from the owner',
    direction: 'in',
    accountId: accountId('3100'),
  });

  counterPc = await registerDevice('Front counter PC', main.branchId);
  sumiTablet = await registerDevice('Pharmacy tablet', main.branchId, sumi);
  uttaraPc = await registerDevice('Uttara counter PC', uttara.id);
  officeLaptop = await registerDevice('Back office laptop', main.branchId);
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('A new retail workspace', () => {
  it('has an exchange clearing account, and cashiers who take goods back', async () => {
    const clearing = accounts.find((account) => account.code === '2190');
    expect(clearing).toMatchObject({
      name: 'POS exchange clearing',
      type: 'liability',
      isGroup: false,
      parentId: accountId('2100'),
    });
    const roles = roleListSchema.parse((await send('GET', '/roles')).json()).items;
    const holders = roles
      .filter((role) => role.permissions.includes('pos.return.create'))
      .map((role) => role.name)
      .sort();
    expect(holders).toEqual(['Cashier', 'Owner', 'Shop manager']);
  });
});

describe("A register's return settings", () => {
  it('are an exchange account that is a liability, and 0 to 365 days', async () => {
    pos1 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS1', {
        name: 'Front counter',
        accounts: { cash: accountId('1110'), card: accountId('1121'), bkash: '', nagad: '' },
        exchangeAccountId: accountId('2190'),
      }),
    );
    expect(pos1).toMatchObject({
      exchangeAccountId: accountId('2190'),
      returnDays: 7,
      lastReturnNumber: 0,
    });
    // The pharmacy counter: no exchanges, and a return on the day of the sale only
    pos2 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS2', { name: 'Pharmacy counter' }),
    );
    expect(pos2).toMatchObject({ exchangeAccountId: null, returnDays: 7 });
    const edited = await send(
      'PUT',
      `/pos/registers/${pos2.id}`,
      editForm(pos2, { returnDays: '0' }),
    );
    expect(edited.statusCode, edited.body).toBe(200);
    pos2 = posRegisterSchema.parse(edited.json());
    expect(pos2.returnDays).toBe(0);
    const [change] = (await auditOf('pos_register', pos2.id)).filter(
      (row) => row.action === 'pos_register.updated',
    );
    expect(change?.changes).toEqual({ returnDays: { from: '7', to: '0' } });
    utt1 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('UTT1', {
        name: 'Uttara counter',
        warehouseId: uttaraStore.id,
        exchangeAccountId: accountId('2190'),
      }),
    );

    // The cash account is an asset, and 2100 a group: neither can hold the money of an exchange
    for (const code of ['1110', '2100']) {
      const res = await send(
        'POST',
        '/pos/registers',
        registerForm('POS9', { exchangeAccountId: accountId(code) }),
      );
      expect(problemOf(res).fieldErrors).toEqual({
        exchangeAccountId: ['pos_exchange_account_invalid'],
      });
    }
    for (const returnDays of ['', '7.5', '366', '-1']) {
      const res = await send('POST', '/pos/registers', registerForm('POS9', { returnDays }));
      expect(res.statusCode, returnDays).toBe(400);
      expect(problemOf(res).fieldErrors).toEqual({ returnDays: ['pos_return_days_format'] });
    }
    const longest = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS9', { returnDays: '365' }),
    );
    expect(longest.returnDays).toBe(365);
  });

  it('come with the register to the device that takes it, and its shift opens', async () => {
    pos1 = await claimed(pos1, counterPc);
    pos2 = await claimed(pos2, sumiTablet, sumi);
    utt1 = await claimed(utt1, uttaraPc);
    const opens = [open(pos1), open(pos2), open(utt1)];
    await accepted([lineOf(opens, 0)], counterPc);
    await accepted([lineOf(opens, 1)], sumiTablet, sumi);
    await accepted([lineOf(opens, 2)], uttaraPc);
    shift1 = lineOf(opens, 0).shiftId;
    shift2 = lineOf(opens, 1).shiftId;
    shiftU = lineOf(opens, 2).shiftId;
    // The device's copy of the register has the settings, never the last numbers
    const page = await pulled(counterPc);
    const row = page.changes.find(
      (change) => change.entity === 'pos_register' && change.key === pos1.id,
    );
    expect(row?.op === 'upsert' ? row.data : null).toMatchObject({
      exchangeAccountId: accountId('2190'),
      returnDays: 7,
    });
    expect(JSON.stringify(row)).not.toContain('lastReturnNumber');
  });
});

describe('A receipt to take back', () => {
  it('is found by its number at any counter, with what is left of each line', async () => {
    // Two juices and a gift wrapping for Farhana, ৳115 with VAT, paid with ৳200
    saleA = await sold(
      sale(pos1, shift1, [line(juice, '2', '25'), line(wrap, '1', '50')], [paid('cash', '200')], {
        customerId: farhana.id,
      }),
    );
    // Typed in small letters at the pharmacy counter
    const found = await returnable(saleA.number.toLowerCase(), sumi);
    expect(found).toMatchObject({
      id: saleA.id,
      number: 'POS1-000001',
      registerId: pos1.id,
      date: today,
      customer: { id: farhana.id, name: 'Farhana Akter' },
      pricesIncludeVat: false,
      total: '115.0000',
      payments: [{ method: 'cash', amount: '200.0000' }],
    });
    expect(
      found.lines.map((item) => [
        item.productName,
        item.quantity,
        item.total,
        item.returnedQuantity,
      ]),
    ).toEqual([
      ['Mango juice 250 ml', '2.0000', '57.5000', '0.0000'],
      ['Gift wrapping', '1.0000', '57.5000', '0.0000'],
    ]);

    const unknown = await send('GET', '/pos/sales/by-number/POS1-999999');
    expect(unknown.statusCode).toBe(404);
    expect(problemOf(unknown).code).toBe('pos_return_sale_not_found');
    // Finding a sale to take back is the return's permission
    expect(
      (await send('GET', `/pos/sales/by-number/${saleA.number}`, undefined, rafiq)).statusCode,
    ).toBe(403);
  });
});

describe('A return at the counter', () => {
  it('is posted at once: its number, the money back, the goods back and one entry', async () => {
    const juiceBefore = await onHand(main, juice);
    const lines = [back(lineOf(saleA.lines, 0), '1'), back(lineOf(saleA.lines, 1), '1')];
    const command = giveBack(pos1, shift1, saleA.id, lines, cashBack(lines), {
      note: 'Juice was warm, wrapping torn',
    });
    const [result] = await push([command]);
    // The answer brings the sale's row again, with what came back: the next return screen knows
    expect(result).toMatchObject({ id: command.id, status: 'accepted', notices: [] });
    expect(result?.status === 'accepted' ? result.changes : []).toMatchObject([
      {
        op: 'upsert',
        entity: 'pos_sale',
        key: saleA.id,
        data: { lines: [{ returnedQuantity: '1.0000' }, { returnedQuantity: '1.0000' }] },
      },
    ]);

    const done = await returnNow(command.returnId);
    expect(done).toMatchObject({
      number: 'POS1-R000001',
      register: { id: pos1.id, code: 'POS1', name: 'Front counter' },
      shift: { id: shift1 },
      branchId: main.branchId,
      warehouseId: main.id,
      date: today,
      sale: { id: saleA.id, number: 'POS1-000001', date: today },
      customer: { id: farhana.id, name: 'Farhana Akter' },
      cashier: { fullName: 'Nusrat Jahan' },
      net: '75.0000',
      vat: '11.2500',
      total: '86.2500',
      lineCount: 2,
      exchangeSale: null,
      outsideWindow: false,
      pricesIncludeVat: false,
      note: 'Juice was warm, wrapping torn',
      device: { id: counterPc.id, name: 'Front counter PC' },
    });
    expect(
      done.lines.map((item) => [item.productName, item.quantity, item.net, item.vat, item.total]),
    ).toEqual([
      ['Mango juice 250 ml', '1.0000', '25.0000', '3.7500', '28.7500'],
      ['Gift wrapping', '1.0000', '50.0000', '7.5000', '57.5000'],
    ]);
    expect(done.refunds).toEqual([
      { method: 'cash', amount: '86.2500', reference: null, accountId: accountId('1110') },
    ]);
    // The sale the other way round, on 4120 "Sales returns" (the retail template's choice): the
    // juice comes back at the ৳15 it cost; the wrapping is a service, with no stock and no cost
    expect(await entryLines(done.entry)).toEqual([
      ['1110', '0.0000', '86.2500', 'DHN'],
      ['1150', '15.0000', '0.0000', 'DHN'],
      ['2120', '11.2500', '0.0000', 'DHN'],
      ['4120', '75.0000', '0.0000', 'DHN'],
      ['5110', '0.0000', '15.0000', 'DHN'],
    ]);
    expect(Number(await onHand(main, juice))).toBe(Number(juiceBefore) + 1);
    expect((await registerNow(pos1)).lastReturnNumber).toBe(1);

    const saleNowA = await saleNow(saleA.id);
    expect(saleNowA.lines.map((item) => item.returnedQuantity)).toEqual(['1.0000', '1.0000']);
    expect(saleNowA.returns).toEqual([
      { id: command.returnId, number: 'POS1-R000001', date: today, total: '86.2500' },
    ]);
    const [entry] = await auditOf('pos_return', command.returnId);
    expect(entry).toMatchObject({
      action: 'pos_return.created',
      device: { id: counterPc.id, name: 'Front counter PC' },
      changes: {
        number: { from: null, to: 'POS1-R000001' },
        register: { from: null, to: 'POS1' },
        sale: { from: null, to: 'POS1-000001' },
        total: { from: null, to: '86.2500' },
        refunds: { from: null, to: 'cash 86.2500' },
      },
    });
  });

  it('pays a line back to the paisa, the last return taking what is left', async () => {
    // Three juices with ৳10 off the bill: ৳65 + ৳9.75 VAT, which does not split into three evenly
    const three = await sold(
      sale(pos1, shift1, [line(juice, '3', '25')], [paid('cash', '74.75')], {
        billDiscount: '10',
      }),
    );
    const sold3 = lineOf(three.lines, 0);
    expect([sold3.net, sold3.vat, sold3.total]).toEqual(['65.0000', '9.7500', '74.7500']);
    // One juice at a time, all three in one push, each worked out after the one before it
    const first = back(sold3, '1');
    const second = back({ ...sold3, returnedQuantity: '1' }, '1');
    const third = back({ ...sold3, returnedQuantity: '2' }, '1');
    const commands = [first, second, third].map((item) =>
      giveBack(pos1, shift1, three.id, [item], cashBack([item])),
    );
    await accepted(commands);
    const done = await Promise.all(commands.map((command) => returnNow(command.returnId)));
    expect(done.map((item) => [item.number, item.net, item.vat, item.total])).toEqual([
      ['POS1-R000002', '21.6700', '3.2500', '24.9200'],
      ['POS1-R000003', '21.6600', '3.2500', '24.9100'],
      ['POS1-R000004', '21.6700', '3.2500', '24.9200'],
    ]);
    expect(sumMoney(done.map((item) => item.total))).toBe('74.7500');
    // The server worked out the same: nothing for the log
    for (const command of commands) {
      const actions = (await auditOf('pos_return', command.returnId)).map((row) => row.action);
      expect(actions).toEqual(['pos_return.created']);
    }
    expect(lineOf((await saleNow(three.id)).lines, 0).returnedQuantity).toBe('3.0000');
  });

  it('puts batches back into the batches the sale took them from', async () => {
    // Five strips from batch A, which has 3: A gives 3, B (by its expiry) the other 2
    const strips = await sold(
      sale(
        pos1,
        shift1,
        [line(napa, '5', '30', { batchId: await lotId('NP-A') })],
        [paid('cash', '172.50')],
      ),
    );
    expect([await lotStock('NP-A'), await lotStock('NP-B')]).toEqual(['0.0000', '3.0000']);
    const soldStrips = lineOf(strips.lines, 0);
    // Four back: the cashier's batch A first (3), then B (1)
    const four = back(soldStrips, '4');
    const first = giveBack(pos1, shift1, strips.id, [four], cashBack([four]));
    // The last one: A has had all of its 3, so B
    const last = back({ ...soldStrips, returnedQuantity: '4' }, '1');
    const second = giveBack(pos1, shift1, strips.id, [last], cashBack([last]));
    await accepted([first, second]);
    const [done, doneLast] = await Promise.all([
      returnNow(first.returnId),
      returnNow(second.returnId),
    ]);
    const lotsOf = (item: PosReturn) =>
      lineOf(item.lines, 0).batches.map((part) => [part.lotNumber, part.quantity]);
    // By their expiry, like a sale's batches
    expect(lotsOf(done)).toEqual([
      ['NP-B', '1.0000'],
      ['NP-A', '3.0000'],
    ]);
    expect(lotsOf(doneLast)).toEqual([['NP-B', '1.0000']]);
    expect([await lotStock('NP-A'), await lotStock('NP-B')]).toEqual(['3.0000', '5.0000']);
    // At the ৳20 a strip cost
    expect((await entryLines(done.entry)).filter((row) => row[0] === '1150')).toEqual([
      ['1150', '80.0000', '0.0000', 'DHN'],
    ]);
  });

  it('brings a serial number back into stock, or a piece without its number', async () => {
    // Two phones by card, ৳34,500
    phones = await sold(
      sale(
        pos1,
        shift1,
        [line(phone, '2', '15000', { serialNumbers: ['IMEI-1', 'IMEI-2'] })],
        [paid('card', '34500', '7731')],
      ),
    );
    const soldPhones = lineOf(phones.lines, 0);
    expect(await serialAt('IMEI-2')).toBeNull();
    // A phone the sale did not sell, or one with no number: only a broken device sends them
    const wrong = await push([
      giveBack(
        pos1,
        shift1,
        phones.id,
        [back(soldPhones, '1', { serialNumbers: ['IMEI-3'] })],
        [{ method: 'card', amount: '17250', reference: '' }],
      ),
      giveBack(
        pos1,
        shift1,
        phones.id,
        [back(soldPhones, '1')],
        [{ method: 'card', amount: '17250', reference: '' }],
      ),
    ]);
    expect(wrong.map((result) => refusal(result))).toEqual([
      {
        code: 'pos_return_serial_invalid',
        fieldErrors: { 'lines.0.serialNumbers': ['pos_return_serial_invalid'] },
      },
      {
        code: 'pos_return_serial_invalid',
        fieldErrors: { 'lines.0.serialNumbers': ['pos_return_serial_invalid'] },
      },
    ]);
    // IMEI-2 back to the card it was paid with
    const two = back(soldPhones, '1', { serialNumbers: ['IMEI-2'] });
    const command = giveBack(
      pos1,
      shift1,
      phones.id,
      [two],
      [{ method: 'card', amount: totalOf([two]), reference: 'RV-7731' }],
    );
    await accepted([command]);
    const done = await returnNow(command.returnId);
    expect(lineOf(done.lines, 0).serialNumbers).toEqual(['IMEI-2']);
    expect(done.refunds).toEqual([
      { method: 'card', amount: '17250.0000', reference: 'RV-7731', accountId: accountId('1121') },
    ]);
    expect(await serialAt('IMEI-2')).toBe('MAIN');

    // A phone whose number the store never had (20a: sold short as a piece): it comes back as
    // a piece, and lifts the stock where it was
    const phonesBefore = await onHand(main, phone);
    const short = await sold(
      sale(
        pos1,
        shift1,
        [line(phone, '1', '15000', { serialNumbers: ['IMEI-9'] })],
        [paid('cash', '17250')],
      ),
    );
    expect(short.soldShort).toBe(true);
    const nine = back(lineOf(short.lines, 0), '1', { serialNumbers: ['IMEI-9'] });
    const shortBack = giveBack(pos1, shift1, short.id, [nine], cashBack([nine]));
    await accepted([shortBack]);
    expect(lineOf((await returnNow(shortBack.returnId)).lines, 0).serialNumbers).toEqual([
      'IMEI-9',
    ]);
    expect(await onHand(main, phone)).toBe(phonesBefore);
    expect(await serialAt('IMEI-9')).toBeUndefined();
  });

  it('pays back by the ways the sale was paid, split, each from its own account', async () => {
    // What came back of the two phones so far: IMEI-2
    const phoneSale = await saleNow(phones.id);
    // IMEI-1: ৳10,000 back on the card, the rest in cash
    const one = back(lineOf(phoneSale.lines, 0), '1', { serialNumbers: ['IMEI-1'] });
    const command = giveBack(
      pos1,
      shift1,
      phoneSale.id,
      [one],
      [
        { method: 'card', amount: '10000', reference: 'RV-7732' },
        { method: 'cash', amount: '7250', reference: '' },
      ],
    );
    await accepted([command]);
    const done = await returnNow(command.returnId);
    expect(done.refunds.map((item) => [item.method, item.amount, codeOf(item.accountId)])).toEqual([
      ['card', '10000.0000', '1121'],
      ['cash', '7250.0000', '1110'],
    ]);
    expect(await entryLines(done.entry)).toEqual([
      ['1110', '0.0000', '7250.0000', 'DHN'],
      ['1121', '0.0000', '10000.0000', 'DHN'],
      ['1150', '9000.0000', '0.0000', 'DHN'],
      ['2120', '2250.0000', '0.0000', 'DHN'],
      ['4120', '15000.0000', '0.0000', 'DHN'],
      ['5110', '0.0000', '9000.0000', 'DHN'],
    ]);
    expect(lineOf((await saleNow(phoneSale.id)).lines, 0).returnedQuantity).toBe('2.0000');
  });

  it('is refused a way of paying back the register has no account for, and keeps its number', async () => {
    // The pharmacy counter takes cash only, and makes no exchanges
    const strip = await sold(
      sale(pos2, shift2, [line(juice, '1', '25')], [paid('cash', '28.75')]),
      sumiTablet,
      sumi,
    );
    const one = back(lineOf(strip.lines, 0), '1');
    const results = await push(
      [
        giveBack(
          pos2,
          shift2,
          strip.id,
          [one],
          [{ method: 'card', amount: '28.75', reference: '' }],
        ),
        giveBack(
          pos2,
          shift2,
          strip.id,
          [one],
          [{ method: 'exchange', amount: '28.75', reference: '' }],
        ),
      ],
      sumiTablet,
      sumi,
    );
    expect(results.map((result) => refusal(result))).toEqual([
      {
        code: 'pos_method_not_set',
        fieldErrors: { 'refunds.0.method': ['pos_method_not_set'] },
      },
      {
        code: 'pos_exchange_not_set',
        fieldErrors: { 'refunds.0.method': ['pos_exchange_not_set'] },
      },
    ]);
    // The two slips were printed: their numbers are used, and the next one is 3
    expect((await registerNow(pos2)).lastReturnNumber).toBe(2);
    const command = giveBack(pos2, shift2, strip.id, [one], cashBack([one]));
    await accepted([command], sumiTablet, sumi);
    expect((await returnNow(command.returnId)).number).toBe('POS2-R000003');
  });

  it('is posted after the window, beyond what is left, with its own amounts and without the permission, and the log says so', async () => {
    // Yesterday's juice at the pharmacy counter, which takes back on the day of the sale only
    const yesterday = shiftIsoDate(today, -1);
    const old = await sold(
      sale(pos2, null, [line(juice, '1', '25')], [paid('cash', '28.75')], { date: yesterday }),
      sumiTablet,
      sumi,
    );
    // Sumi lost her role while the tablet was offline. Two juices of a line of one, at ৳26 each.
    await giveRoles('sumi@agoramart.com', []);
    const two = back(lineOf(old.lines, 0), '2', { net: '52', vat: '7.80' });
    const command = giveBack(pos2, shift2, old.id, [two], cashBack([two]));
    const juiceBefore = await onHand(main, juice);
    await accepted([command], sumiTablet, sumi);
    await giveRoles('sumi@agoramart.com', ['Cashier']);

    // The money was paid back: posted as the device sent it
    const done = await returnNow(command.returnId);
    expect(done).toMatchObject({ outsideWindow: true, net: '52.0000', vat: '7.8000' });
    expect(Number(await onHand(main, juice))).toBe(Number(juiceBefore) + 2);
    // Only the one juice that was sold had a cost
    expect((await entryLines(done.entry)).filter((row) => row[0] === '1150')).toEqual([
      ['1150', '15.0000', '0.0000', 'DHN'],
    ]);
    const rows = await auditOf('pos_return', command.returnId);
    expect(rows.map((row) => [row.action, row.changes])).toEqual([
      ['pos_return.created', expect.any(Object)],
      [
        'pos_return.outside_window',
        {
          sale: { from: null, to: old.number },
          soldOn: { from: null, to: yesterday },
          returnedOn: { from: null, to: today },
          returnDays: { from: null, to: '0' },
        },
      ],
      [
        'pos_return.over_returned',
        // What the device sent, as it sent it, and what the server knew
        { lines: { from: null, to: 'line 1: 2 of 1.0000, 0.0000 back before' } },
      ],
      [
        'pos_return.amounts_differ',
        {
          lines: {
            from: null,
            to: 'line 1: 52 + 7.80 sent, 25.0000 + 3.7500 worked out',
          },
        },
      ],
      [
        'pos_return.without_permission',
        {
          number: { from: null, to: done.number },
          returnedOn: { from: null, to: today },
          missing: { from: null, to: 'pos.return.create' },
        },
      ],
    ]);
    // Nothing is left to take back, and never less than nothing
    const found = await returnable(old.number);
    expect(lineOf(found.lines, 0).returnedQuantity).toBe('2.0000');
  });

  it('is refused what only a broken device sends, and keeps the number', async () => {
    // The wrapping is all back; one of the two juices is left
    const one = back({ ...lineOf(saleA.lines, 0), returnedQuantity: '1' }, '1');
    const lastBefore = (await registerNow(pos1)).lastReturnNumber;
    const notHeld = giveBack(pos2, shift2, saleA.id, [one], cashBack([one]));
    const results = await push([
      // A line of another sale
      giveBack(pos1, shift1, saleA.id, [{ ...one, saleLineId: v7() }], cashBack([one])),
      // A sale the server does not have
      giveBack(pos1, shift1, v7(), [one], cashBack([one])),
      // The pharmacy counter's shift
      giveBack(pos1, shift2, saleA.id, [one], cashBack([one])),
      // The pharmacy counter, which this PC does not hold
      notHeld,
    ]);
    expect(results.map((result) => refusal(result))).toEqual([
      {
        code: 'pos_return_line_unknown',
        fieldErrors: { 'lines.0.saleLineId': ['pos_return_line_unknown'] },
      },
      {
        code: 'pos_return_sale_not_found',
        fieldErrors: { saleId: ['pos_return_sale_not_found'] },
      },
      { code: 'pos_shift_unknown', fieldErrors: { shiftId: ['pos_shift_unknown'] } },
      { code: 'pos_register_not_held', fieldErrors: { registerId: ['pos_register_not_held'] } },
    ]);
    expect((await registerNow(pos1)).lastReturnNumber).toBe(lastBefore + 3);

    // What the device's own form refuses never reaches the books, and keeps no number
    const twice = giveBack(pos1, shift1, saleA.id, [one, one], cashBack([one, one]));
    const short = giveBack(
      pos1,
      shift1,
      saleA.id,
      [one],
      [{ method: 'cash', amount: '20', reference: '' }],
    );
    const formResults = await push([twice, short]);
    expect(formResults.map((result) => refusal(result))).toEqual([
      {
        code: 'invalid_input',
        fieldErrors: { 'lines.1.saleLineId': ['pos_return_line_twice'] },
      },
      { code: 'invalid_input', fieldErrors: { refunds: ['pos_refund_mismatch'] } },
    ]);

    // The same command again gets the same answer; its number again is a bug
    const good = giveBack(pos1, shift1, saleA.id, [one], cashBack([one]));
    await accepted([good]);
    const again = await push([good]);
    expect(outcomes(again)).toEqual(['accepted']);
    const taken = await push([{ ...good, id: v7(), returnId: v7() }]);
    expect(refusal(taken[0])).toEqual({
      code: 'pos_return_number_taken',
      fieldErrors: { sequence: ['pos_return_number_taken'] },
    });
    const returns = posReturnPageSchema.parse(
      (await send('GET', `/pos/returns?saleId=${saleA.id}`)).json(),
    );
    expect(returns.items.map((item) => item.number)).toEqual(
      [good.input.sequence, 1].map((sequence) => `POS1-R${String(sequence).padStart(6, '0')}`),
    );
  });

  it('is listed newest first, by register, sale and shift, one page at a time', async () => {
    const all = posReturnPageSchema.parse((await send('GET', '/pos/returns?limit=100')).json());
    const firstPage = posReturnPageSchema.parse((await send('GET', '/pos/returns?limit=3')).json());
    expect(firstPage.items).toEqual(all.items.slice(0, 3));
    if (firstPage.nextCursor === null) throw new Error('one page only');
    const secondPage = posReturnPageSchema.parse(
      (
        await send('GET', `/pos/returns?limit=3&cursor=${encodeURIComponent(firstPage.nextCursor)}`)
      ).json(),
    );
    expect(secondPage.items).toEqual(all.items.slice(3, 6));
    const byRegister = posReturnPageSchema.parse(
      (await send('GET', `/pos/returns?registerId=${pos2.id}`)).json(),
    );
    expect(byRegister.items.map((item) => item.number)).toEqual(['POS2-R000004', 'POS2-R000003']);
    const byShift = posReturnPageSchema.parse(
      (await send('GET', `/pos/returns?shiftId=${shift2}`)).json(),
    );
    expect(byShift.items).toEqual(byRegister.items);
    // Reading them needs no permission, like the sales
    const res = await send('GET', '/pos/returns', undefined, rafiq);
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('An exchange', () => {
  it("pays for the next sale with the return's money, through the clearing account", async () => {
    // Two juices back (৳57.50); the customer takes a strip of Napa (৳34.50) and the rest in cash
    const juices = await sold(
      sale(pos1, shift1, [line(juice, '2', '25')], [paid('cash', '57.50')]),
    );
    const two = back(lineOf(juices.lines, 0), '2');
    const returned = giveBack(
      pos1,
      shift1,
      juices.id,
      [two],
      [
        { method: 'exchange', amount: '34.50', reference: '' },
        { method: 'cash', amount: '23', reference: '' },
      ],
    );
    const next = sale(
      pos1,
      shift1,
      [line(napa, '1', '30', { batchId: await lotId('NP-B') })],
      [{ method: 'exchange', amount: '34.50', reference: '', returnId: returned.returnId }],
    );
    await accepted([returned, next]);
    expect(await balanceOf('2190')).toBe('0.0000');

    const bought = await saleNow(next.saleId);
    expect(bought).toMatchObject({ total: '34.5000', paid: '34.5000', change: '0.0000' });
    expect(bought.payments).toEqual([
      {
        method: 'exchange',
        amount: '34.5000',
        reference: null,
        accountId: accountId('2190'),
        return: {
          id: returned.returnId,
          number: `POS1-R${String(returned.input.sequence).padStart(6, '0')}`,
        },
      },
    ]);
    const done = await returnNow(returned.returnId);
    expect(done.exchangeSale).toEqual({ id: next.saleId, number: bought.number });
    expect(done.refunds.map((item) => [item.method, item.amount, codeOf(item.accountId)])).toEqual([
      ['exchange', '34.5000', '2190'],
      ['cash', '23.0000', '1110'],
    ]);
    expect(await entryLines(bought.entry)).toEqual(
      expect.arrayContaining([['2190', '34.5000', '0.0000', 'DHN']]),
    );
  });

  it('is refused when the sale does not match its return', async () => {
    const juices = await sold(
      sale(pos1, shift1, [line(juice, '2', '25')], [paid('cash', '57.50')]),
    );
    const soldJuice = lineOf(juices.lines, 0);
    const one = back(soldJuice, '1');
    const credit = (amount: string) => [{ method: 'exchange' as const, amount, reference: '' }];
    const ret = giveBack(pos1, shift1, juices.id, [one], credit('28.75'));
    // Uttara's counter takes back the other juice, in its own shift
    const uttaraOne = back({ ...soldJuice, returnedQuantity: '1' }, '1');
    const atUttara = giveBack(utt1, shiftU, juices.id, [uttaraOne], credit('28.75'));
    await accepted([ret]);
    await accepted([atUttara], uttaraPc);
    const pay = (returnId: string, amount = '28.75'): Payment => ({
      method: 'exchange',
      amount,
      reference: '',
      returnId,
    });
    const juice1 = [line(juice, '1', '25')];
    // A return that was refused in the same push: the sale after it cannot use it
    const refusedReturn = giveBack(pos1, shift1, v7(), [one], credit('28.75'));
    const results = await push([
      sale(pos1, shift1, juice1, [pay(v7())]),
      sale(pos1, shift1, juice1, [pay(ret.returnId, '20'), paid('cash', '8.75')]),
      sale(pos1, shift1, juice1, [pay(atUttara.returnId)]),
      sale(pos1, shift1, juice1, [pay(ret.returnId)]),
      sale(pos1, shift1, juice1, [pay(ret.returnId)]),
      refusedReturn,
      sale(pos1, shift1, juice1, [pay(refusedReturn.returnId)]),
    ]);
    expect(outcomes(results)).toEqual([
      'pos_return_unknown',
      'pos_exchange_invalid',
      'pos_exchange_invalid',
      'accepted',
      'pos_exchange_invalid',
      'pos_return_sale_not_found',
      'pos_return_unknown',
    ]);
    expect(refusal(results[0]).fieldErrors).toEqual({
      'payments.0.method': ['pos_return_unknown'],
    });
    expect(refusal(results[4]).fieldErrors).toEqual({
      'payments.0.method': ['pos_exchange_invalid'],
    });
    // Uttara's exchange credit is still waiting on the clearing account for its own sale
    expect(await balanceOf('2190')).toBe('-28.7500');
    await accepted([sale(utt1, shiftU, juice1, [pay(atUttara.returnId)])], uttaraPc);
    expect(await balanceOf('2190')).toBe('0.0000');
  });
});

describe("Another branch's receipt", () => {
  it("comes back into this counter's store, and the sale's branch takes the sale back", async () => {
    // Farhana buys two juices at the front counter, and brings one to Uttara. Online, the Uttara
    // counter finds the receipt on the server.
    const hers = await sold(
      sale(pos1, shift1, [line(juice, '2', '25')], [paid('cash', '57.50')], {
        customerId: farhana.id,
      }),
    );
    const found = await returnable(hers.number);
    const juiceLine = lineOf(found.lines, 0);
    const cursor = (await pulled(counterPc)).cursor;
    const [mainBefore, uttaraBefore] = await Promise.all([
      onHand(main, juice),
      onHand(uttaraStore, juice),
    ]);
    const one = back(juiceLine, '1');
    const command = giveBack(utt1, shiftU, hers.id, [one], cashBack([one]));
    const [result] = await push([command], uttaraPc);
    // Uttara's counter does not keep POS1's sales: the answer is a delete, which it ignores
    expect(result?.status === 'accepted' ? result.changes : null).toEqual([
      { op: 'delete', entity: 'pos_sale', key: hers.id },
    ]);
    const done = await returnNow(command.returnId);
    expect(done).toMatchObject({
      number: 'UTT1-R000002',
      branchId: uttara.id,
      warehouseId: uttaraStore.id,
      sale: { id: hers.id, number: hers.number },
      customer: { id: farhana.id },
    });
    expect([await onHand(main, juice), Number(await onHand(uttaraStore, juice))]).toEqual([
      mainBefore,
      Number(uttaraBefore) + 1,
    ]);
    // The sale, its VAT and its cost come off Dhanmondi; the cash and the juice are in Uttara. The
    // juice cost ৳14.71 when she bought it: the average fell below ৳15 when the pharmacy took back
    // a juice it never sold, at no cost (above).
    expect(await entryLines(done.entry)).toEqual([
      ['1110', '0.0000', '28.7500', 'UTT'],
      ['1150', '14.7100', '0.0000', 'UTT'],
      ['2120', '3.7500', '0.0000', 'DHN'],
      ['4120', '25.0000', '0.0000', 'DHN'],
      ['5110', '0.0000', '14.7100', 'DHN'],
    ]);
    // The front counter hears of it with its next pull
    const next = await pulled(counterPc, owner, cursor);
    const row = next.changes.find(
      (change) => change.entity === 'pos_sale' && change.key === hers.id,
    );
    expect(row?.op === 'upsert' ? row.data : null).toMatchObject({
      lines: [{ returnedQuantity: '1.0000' }],
    });
  });
});

describe('The shift', () => {
  it('takes the cash refunds out of the drawer, and counts the returns made in it', async () => {
    const shift = await shiftNow(shift1);
    const returns = posReturnPageSchema.parse(
      (await send('GET', `/pos/returns?shiftId=${shift1}&limit=100`)).json(),
    ).items;
    // Every return the front counter took, and no other: Uttara's return of a POS1 receipt is in
    // Uttara's shift
    const all = posReturnPageSchema.parse((await send('GET', '/pos/returns?limit=100')).json());
    expect(returns).toEqual(all.items.filter((item) => item.register.id === pos1.id));
    expect(shift.returnCount).toBe(returns.length);
    expect(shift.returnsTotal).toBe(sumMoney(returns.map((item) => item.total)));
    expect(shift.returnsVat).toBe(sumMoney(returns.map((item) => item.vat)));
    const refunds = await Promise.all(returns.map((item) => returnNow(item.id)));
    const cashRefunds = refunds.flatMap((item) =>
      item.refunds.filter((refund) => refund.method === 'cash').map((refund) => refund.amount),
    );
    expect(shift.cash.cashRefunded).toBe(sumMoney(cashRefunds));
    expect(shift.refunds).toEqual([
      { method: 'cash', amount: sumMoney(cashRefunds) },
      { method: 'card', amount: '27250.0000' },
      { method: 'exchange', amount: '63.2500' },
    ]);
    const { cash } = shift;
    expect(shift.expectedCash).toBe(
      sumMoney([
        cash.opening,
        cash.cashTaken,
        cash.paidIn,
        `-${cash.changeGiven}`,
        `-${cash.paidOut}`,
        `-${cash.cashRefunded}`,
      ]),
    );
  });
});

describe('The pull', () => {
  it('brings the recent sales of the register a device holds, and no other', async () => {
    // A sale of 31 days ago, from an outbox of long ago: posted, and on no device
    const old = sale(pos1, null, [line(juice, '1', '25')], [paid('cash', '28.75')], {
      date: shiftIsoDate(today, -31),
    });
    const [result] = await push([old]);
    expect(result?.status === 'accepted' ? result.changes : null).toEqual([
      { op: 'delete', entity: 'pos_sale', key: old.saleId },
    ]);
    const salesOf = async (register: PosRegister) =>
      z
        .array(z.object({ id: z.string() }))
        .parse(
          await sql`SELECT id::text FROM pos_sales
                     WHERE register_id = ${register.id} AND date >= ${shiftIsoDate(today, -30)}
                     ORDER BY sequence`,
        )
        .map((row) => row.id);
    const keysOf = async (device: Device, as = owner) =>
      (await pulled(device, as)).changes
        .filter((change) => change.entity === 'pos_sale')
        .map((change) => change.key)
        .sort();
    const ofPos1 = await salesOf(pos1);
    expect(ofPos1).not.toContain(old.saleId);
    expect(await keysOf(counterPc)).toEqual([...ofPos1].sort());
    expect(await keysOf(sumiTablet, sumi)).toEqual([...(await salesOf(pos2))].sort());
    expect(await keysOf(uttaraPc)).toEqual([...(await salesOf(utt1))].sort());
    expect(await keysOf(officeLaptop)).toEqual([]);

    // Right after a claim, the device reads the same sales by the register's numbers
    const firstPage = posRegisterSalesPageSchema.parse(
      (await send('GET', `/pos/registers/${pos1.id}/sales?limit=4`)).json(),
    );
    expect(firstPage.items.map((item) => item.id)).toEqual(ofPos1.slice(0, 4));
    if (firstPage.nextCursor === null) throw new Error('one page only');
    const rest = posRegisterSalesPageSchema.parse(
      (
        await send(
          'GET',
          `/pos/registers/${pos1.id}/sales?limit=100&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
        )
      ).json(),
    );
    expect(rest.nextCursor).toBeNull();
    expect(rest.items.map((item) => item.id)).toEqual(ofPos1.slice(4));
    // With the cashier's permission, of a register this workspace has
    expect(
      (await send('GET', `/pos/registers/${pos1.id}/sales`, undefined, rafiq)).statusCode,
    ).toBe(403);
    expect((await send('GET', `/pos/registers/${v7()}/sales`)).statusCode).toBe(404);
  });
});

describe('At the same moment', () => {
  it('two counters take back the last juice of a line: both posted, the second written down', async () => {
    const one = await sold(
      sale(pos2, shift2, [line(juice, '1', '25')], [paid('cash', '28.75')]),
      sumiTablet,
      sumi,
    );
    const soldJuice = lineOf(one.lines, 0);
    const atPharmacy = back(soldJuice, '1');
    const atUttara = back(soldJuice, '1');
    const commands = [
      giveBack(pos2, shift2, one.id, [atPharmacy], cashBack([atPharmacy])),
      giveBack(utt1, shiftU, one.id, [atUttara], cashBack([atUttara])),
    ] as const;
    const [pharmacy, uttaraAnswer] = await Promise.all([
      push([commands[0]], sumiTablet, sumi),
      push([commands[1]], uttaraPc),
    ]);
    expect([...outcomes(pharmacy), ...outcomes(uttaraAnswer)]).toEqual(['accepted', 'accepted']);
    // The sale was locked: whichever came second saw the first, and the log says so once
    const over = await Promise.all(
      commands.map(async (command) =>
        (await auditOf('pos_return', command.returnId)).some(
          (row) => row.action === 'pos_return.over_returned',
        ),
      ),
    );
    expect(over.filter(Boolean)).toHaveLength(1);
    expect(lineOf((await saleNow(one.id)).lines, 0).returnedQuantity).toBe('2.0000');
  });
});

describe('What a return points at', () => {
  it('is never changed, and the exchange account of a register is not deleted', async () => {
    const [first] = posReturnPageSchema.parse((await send('GET', '/pos/returns')).json()).items;
    if (!first) throw new Error('no return');
    // Not even by the superuser: a mistake is put right with a new sale (0056)
    await expect(
      sql`UPDATE pos_returns SET note = 'changed' WHERE id = ${first.id}`,
    ).rejects.toThrow('a POS return cannot be changed or deleted');
    await expect(sql`DELETE FROM pos_return_refunds WHERE return_id = ${first.id}`).rejects.toThrow(
      'a POS return cannot be changed or deleted',
    );
    // An exchange account no entry uses yet, only a register: still in use
    const spare = await created(accountSchema, '/accounts', {
      parentId: accountId('2100'),
      code: '2195',
      name: 'POS exchange clearing (Uttara)',
      isGroup: false,
      holdsMoney: false,
      description: '',
    });
    accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
    await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('UTT2', { warehouseId: uttaraStore.id, exchangeAccountId: spare.id }),
    );
    const res = await send('DELETE', `/accounts/${spare.id}?version=${String(spare.version)}`);
    expect(res.statusCode, res.body).toBe(409);
    expect(problemOf(res).code).toBe('account_in_use');
  });
});

describe('A sale still in the outbox', () => {
  it('is taken back in the same push, by the line ids the device made', async () => {
    // Sold offline, and the goods came back ten minutes later: the device knows the line by the id
    // it made, before the server has seen the sale
    const lineId = v7();
    const soldOffline = sale(
      pos2,
      shift2,
      [line(juice, '2', '25', { id: lineId })],
      [paid('cash', '57.50')],
    );
    const amounts = posReturnAmounts(
      { quantity: '2', net: '50', vat: '7.5', returnedQuantity: '0' },
      '1',
    );
    const taken = giveBack(
      pos2,
      shift2,
      soldOffline.saleId,
      [{ saleLineId: lineId, quantity: '1', ...amounts, serialNumbers: [] }],
      [paid('cash', amounts.total)],
    );
    expect(outcomes(await push([soldOffline, taken], sumiTablet, sumi))).toEqual([
      'accepted',
      'accepted',
    ]);
    const posted = await saleNow(soldOffline.saleId);
    expect(lineOf(posted.lines, 0)).toMatchObject({ id: lineId, returnedQuantity: '1.0000' });

    // An id used once is never a second line's: the sale is refused, and keeps its number
    const again = sale(
      pos2,
      shift2,
      [line(juice, '1', '25', { id: lineId })],
      [paid('cash', '28.75')],
    );
    const [answer] = await push([again], sumiTablet, sumi);
    expect(refusal(answer)).toMatchObject({ code: 'sync_id_taken' });
    expect((await registerNow(pos2)).lastNumber).toBe(again.input.sequence);
  });
});
