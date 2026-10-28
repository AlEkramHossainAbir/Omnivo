import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  auditPageSchema,
  type Branch,
  branchSchema,
  type Customer,
  customerSchema,
  type Device,
  deviceListItemSchema,
  deviceSchema,
  journalEntrySchema,
  memberPageSchema,
  myDeviceListSchema,
  periodLockSchema,
  type PosRegister,
  posRegisterListSchema,
  posRegisterSchema,
  type PosSale,
  posSalePageSchema,
  posSaleSchema,
  problemSchema,
  type Product,
  productSchema,
  roleListSchema,
  settingsSchema,
  setupSchema,
  soldShortPageSchema,
  SYNC_PROTOCOL,
  type SyncChange,
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

// Agora Mini Mart: a shop in Dhanmondi (the main branch) with a back store, and a second shop in
// Uttara. Nusrat (the owner) sells at the front counter, Sumi is a cashier, Kamal the shop manager,
// and Rafiq a member with no role. The tests run in order: the registers first, then the devices
// that take them, then the sales.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: the stock balances and the bell, which no route of this step shows
let sql: postgres.Sql;
let owner: SignedIn;
let sumi: SignedIn;
let rafiq: SignedIn;
let today: string;
let main: Warehouse;
let backStore: Warehouse;
let closedStore: Warehouse;
let uttara: Branch;
let uttaraStore: Warehouse;
let accounts: Account[];
let vat: TaxRate;
let pcs: string;
let juice: Product;
let napa: Product;
let phone: Product;
let wrap: Product;
// Napa's batches: A and B on sale, OLD past its expiry date
let batchA: string;
let counterPc: Device;
let officeLaptop: Device;
let uttaraPc: Device;
let sumiTablet: Device;
let pos1: PosRegister;
let pos2: PosRegister;
let pos3: PosRegister;
let utt1: PosRegister;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type SaleLine = SaleCommand['input']['lines'][number];
type Payment = SaleCommand['input']['payments'][number];

// A UUIDv7 as a device makes it. Only the version digit matters to the server's checks.
function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
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

// A day before or after another, as an ISO date
function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

function accountId(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function codeOf(id: string): string {
  return accounts.find((account) => account.id === id)?.code ?? id;
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

// Stock brought in at a cost, before the counter opens
async function stockIn(warehouse: Warehouse, lines: object[]): Promise<void> {
  const res = await send('POST', '/stock-adjustments', {
    date: addDays(today, -20),
    warehouseId: warehouse.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    lines,
    post: true,
  });
  expect(res.statusCode, res.body).toBe(201);
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

// A member who signs in to the shop with no role yet; the roles come from the retail templates
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

// The register form, with a cash drawer and nothing else unless asked
function registerForm(code: string, warehouse: Warehouse, extra: object = {}) {
  return {
    code,
    name: `Counter ${code}`,
    warehouseId: warehouse.id,
    accounts: { cash: accountId('1110'), card: '', bkash: '', nagad: '' },
    maxDiscountPercent: '',
    paperWidth: '80',
    receiptFooter: '',
    ...extra,
  };
}

function accountsForm(register: PosRegister) {
  return {
    cash: register.accounts.cash,
    card: register.accounts.card ?? '',
    bkash: register.accounts.bkash ?? '',
    nagad: register.accounts.nagad ?? '',
  };
}

// The form as the settings page fills it from a register
function editForm(register: PosRegister, extra: object = {}) {
  return {
    name: register.name,
    warehouseId: register.warehouseId,
    accounts: accountsForm(register),
    maxDiscountPercent: register.maxDiscountPercent,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter ?? '',
    version: register.version,
    ...extra,
  };
}

async function registerNow(register: PosRegister): Promise<PosRegister> {
  const res = await send('GET', `/pos/registers/${register.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterSchema.parse(res.json());
}

async function listRegisters(query = '', as = owner) {
  const res = await send('GET', `/pos/registers${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterListSchema.parse(res.json()).items;
}

// The last number each register gave, as a device keeps it: from the claim's answer on
const sequences = new Map<string, number>();

function claim(register: PosRegister, device: Device, as = owner) {
  return send('POST', `/pos/registers/${register.id}/claim`, { deviceId: device.id }, as);
}

async function claimed(register: PosRegister, device: Device, as = owner): Promise<PosRegister> {
  const res = await claim(register, device, as);
  expect(res.statusCode, res.body).toBe(200);
  const held = posRegisterSchema.parse(res.json());
  sequences.set(register.id, held.lastNumber);
  return held;
}

function release(register: PosRegister, device: Device, as = owner) {
  return send('POST', `/pos/registers/${register.id}/release`, { deviceId: device.id }, as);
}

async function released(register: PosRegister, device: Device, as = owner): Promise<PosRegister> {
  const res = await release(register, device, as);
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterSchema.parse(res.json());
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

// A sale with the register's next number, sold today by the device's clock, to a walk-in
function sale(
  register: PosRegister,
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
      date: today,
      soldAt: new Date().toISOString(),
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

async function push(
  commands: SaleCommand[],
  device: Device = counterPc,
  as = owner,
): Promise<SyncResult[]> {
  const res = await send(
    'POST',
    '/sync/push',
    { deviceId: device.id, protocol: SYNC_PROTOCOL, commands },
    as,
  );
  expect(res.statusCode, res.body).toBe(200);
  return syncPushSchema.parse(res.json()).results;
}

function refusal(result: SyncResult | undefined) {
  if (result?.status !== 'rejected') throw new Error(`not refused: ${JSON.stringify(result)}`);
  return result.error;
}

// What each answer was: "accepted", or the refusal's code
function outcomes(results: SyncResult[]): string[] {
  return results.map((result) =>
    result.status === 'rejected' ? result.error.code : result.status,
  );
}

async function saleNow(id: string): Promise<PosSale> {
  const res = await send('GET', `/pos/sales/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posSaleSchema.parse(res.json());
}

// One sale, pushed alone, that must be accepted
async function sold(command: SaleCommand, device = counterPc, as = owner): Promise<PosSale> {
  const [result] = await push([command], device, as);
  expect(result?.status, JSON.stringify(result)).toBe('accepted');
  return saleNow(command.saleId);
}

function numberOf(command: SaleCommand, code: string): string {
  return `${code}-${String(command.input.sequence).padStart(6, '0')}`;
}

// A sale's journal entry as [account code, debit, credit], by code — what an accountant reads
async function entryLines(of: PosSale) {
  if (of.entry === null) throw new Error(`${of.number} has no entry`);
  const entry = journalEntrySchema.parse(
    (await send('GET', `/journal-entries/${of.entry.id}`)).json(),
  );
  return entry.lines
    .map((item) => [codeOf(item.accountId), item.debit, item.credit])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

// The stock of a variant in a warehouse now, every batch together
async function onHand(warehouse: Warehouse, product: Product): Promise<string> {
  const [row] = z.array(z.object({ quantity: z.string() })).parse(
    await sql`SELECT coalesce(sum(quantity), 0)::numeric(18, 4)::text AS quantity
                FROM stock_balances
                WHERE warehouse_id = ${warehouse.id} AND variant_id = ${variantOf(product)}`,
  );
  return row?.quantity ?? '0';
}

async function auditOf(entityType: string, entityId: string) {
  const res = await send('GET', `/audit-logs?entityType=${entityType}&entityId=${entityId}`);
  expect(res.statusCode, res.body).toBe(200);
  return auditPageSchema.parse(res.json()).items;
}

// One page is the whole pull: a new workspace has a few hundred rows at most
async function pulled(device: Device, cursor?: string) {
  const query = new URLSearchParams({
    deviceId: device.id,
    protocol: String(SYNC_PROTOCOL),
    limit: '1000',
  });
  if (cursor !== undefined) query.set('cursor', cursor);
  const res = await send('GET', `/sync/pull?${query.toString()}`);
  expect(res.statusCode, res.body).toBe(200);
  const page = syncPullSchema.parse(res.json());
  expect(page.hasMore).toBe(false);
  return page;
}

function registersIn(changes: SyncChange[]) {
  return changes.filter((change) => change.entity === 'pos_register');
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
  await member('Kamal Hossain', 'kamal@agoramart.com', 'Shop-manager-2026');
  rafiq = await member('Rafiq Islam', 'rafiq@agoramart.com', 'No-role-yet-2026');
  await giveRoles('sumi@agoramart.com', ['Cashier']);
  await giveRoles('kamal@agoramart.com', ['Shop manager']);

  // Dhanmondi's MAIN store, an empty back store and a closed godown; Uttara has its own store
  const [found] = warehouseListSchema
    .parse((await send('GET', '/warehouses')).json())
    .items.filter((warehouse) => warehouse.code === 'MAIN');
  if (!found) throw new Error('no MAIN warehouse');
  main = found;
  backStore = await created(warehouseSchema, '/warehouses', {
    branchId: main.branchId,
    code: 'BACK',
    name: 'Back store',
    address: '',
  });
  const old = await created(warehouseSchema, '/warehouses', {
    branchId: main.branchId,
    code: 'OLD',
    name: 'Old godown',
    address: '',
  });
  const archived = await send('POST', `/warehouses/${old.id}/archive`, { version: old.version });
  expect(archived.statusCode, archived.body).toBe(200);
  closedStore = warehouseSchema.parse(archived.json());
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

  // The card machine's bank account and the bKash merchant wallet, under the money groups
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  await created(accountSchema, '/accounts', {
    parentId: accountId('1120'),
    code: '1121',
    name: 'City Bank card settlement',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  await created(accountSchema, '/accounts', {
    parentId: accountId('1130'),
    code: '1131',
    name: 'bKash merchant 01711',
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
  await stockIn(main, [
    inLine(juice, '50', '15'),
    inLine(napa, '3', '20', { lotNumber: 'NP-A', expiresOn: addDays(today, 200) }),
    inLine(napa, '5', '20', { lotNumber: 'NP-B', expiresOn: addDays(today, 90) }),
    inLine(napa, '4', '20', { lotNumber: 'NP-OLD', expiresOn: addDays(today, -5) }),
    inLine(phone, '2', '9000', { serialNumbers: ['IMEI-1', 'IMEI-2'] }),
  ]);
  const [lot] = z
    .array(z.object({ id: z.string() }))
    .parse(await sql`SELECT id::text FROM batches WHERE lot_number = 'NP-A'`);
  batchA = lot?.id ?? '';

  counterPc = await registerDevice('Front counter PC', main.branchId);
  officeLaptop = await registerDevice('Back office laptop', main.branchId);
  uttaraPc = await registerDevice('Uttara counter PC', uttara.id);
  sumiTablet = await registerDevice('Counter 2 tablet', main.branchId, sumi);
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('POS registers', () => {
  it('are made with an upper-case code, and listed with their branch and who holds them', async () => {
    pos1 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('pos1', main, {
        name: 'Front counter',
        accounts: {
          cash: accountId('1110'),
          card: accountId('1121'),
          bkash: accountId('1131'),
          nagad: '',
        },
        maxDiscountPercent: '5',
        receiptFooter: 'Goods once sold are exchanged within 7 days',
      }),
    );
    expect(pos1).toMatchObject({
      code: 'POS1',
      name: 'Front counter',
      branchId: main.branchId,
      warehouseId: main.id,
      accounts: {
        cash: accountId('1110'),
        card: accountId('1121'),
        bkash: accountId('1131'),
        nagad: null,
      },
      maxDiscountPercent: '5.00',
      paperWidth: '80',
      deviceId: null,
      lastNumber: 0,
      archivedAt: null,
    });
    // An empty limit is 0: no discount at all without the permission
    pos2 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS2', main, { paperWidth: '58' }),
    );
    expect([pos2.maxDiscountPercent, pos2.receiptFooter]).toEqual(['0.00', null]);
    pos3 = await created(posRegisterSchema, '/pos/registers', registerForm('POS3', backStore));
    utt1 = await created(posRegisterSchema, '/pos/registers', registerForm('UTT1', uttaraStore));
    expect(utt1.branchId).toBe(uttara.id);

    const all = await listRegisters();
    expect(all.map((item) => [item.code, item.holder])).toEqual([
      ['POS1', null],
      ['POS2', null],
      ['POS3', null],
      ['UTT1', null],
    ]);
    expect((await listRegisters(`?branchId=${uttara.id}`)).map((item) => item.code)).toEqual([
      'UTT1',
    ]);
    // The audit log names the warehouse and the accounts by their codes
    const [entry] = await auditOf('pos_register', pos1.id);
    expect(entry).toMatchObject({
      action: 'pos_register.created',
      changes: {
        code: { from: null, to: 'POS1' },
        warehouse: { from: null, to: 'MAIN' },
        cashAccount: { from: null, to: '1110' },
        cardAccount: { from: null, to: '1121' },
        bkashAccount: { from: null, to: '1131' },
        maxDiscountPercent: { from: null, to: '5.00' },
      },
    });
    expect(entry?.changes).not.toHaveProperty('nagadAccount');
  });

  it('refuse a code that is taken, a warehouse that is not active, and an account that holds no money', async () => {
    const taken = await send('POST', '/pos/registers', registerForm('pos1', main));
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken)).toMatchObject({
      code: 'pos_register_code_taken',
      fieldErrors: { code: ['pos_register_code_taken'] },
    });
    const closed = await send('POST', '/pos/registers', registerForm('POS8', closedStore));
    expect(problemOf(closed).fieldErrors).toEqual({
      warehouseId: ['pos_register_warehouse_invalid'],
    });
    // Sales is not a money account, and the wallets' group itself takes no entries
    const wrong = await send(
      'POST',
      '/pos/registers',
      registerForm('POS8', main, {
        accounts: {
          cash: accountId('1110'),
          card: accountId('4110'),
          bkash: accountId('1130'),
          nagad: '',
        },
      }),
    );
    expect(problemOf(wrong)).toMatchObject({
      code: 'pos_register_account_invalid',
      fieldErrors: {
        'accounts.card': ['pos_register_account_invalid'],
        'accounts.bkash': ['pos_register_account_invalid'],
      },
    });
    // What the form itself refuses
    const form = await send(
      'POST',
      '/pos/registers',
      registerForm('POS-8', main, {
        name: 'C',
        warehouseId: '',
        accounts: { cash: '', card: '', bkash: '', nagad: '' },
        maxDiscountPercent: '120',
      }),
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      code: ['pos_register_code_format'],
      name: ['pos_register_name_required'],
      warehouseId: ['pos_register_warehouse_invalid'],
      'accounts.cash': ['pos_register_cash_required'],
      maxDiscountPercent: ['pos_discount_limit_format'],
    });
    expect((await listRegisters()).map((item) => item.code)).toEqual([
      'POS1',
      'POS2',
      'POS3',
      'UTT1',
    ]);
  });

  it('are set up with pos.register.manage, and read by anyone', async () => {
    const cashier = await send('POST', '/pos/registers', registerForm('POS9', main), sumi);
    expect(cashier.statusCode).toBe(403);
    expect(problemOf(cashier).code).toBe('permission_missing');
    expect(await listRegisters('', rafiq)).toHaveLength(4);
    const one = await send('GET', `/pos/registers/${pos1.id}`, undefined, rafiq);
    expect(one.statusCode, one.body).toBe(200);
  });

  it('change everything but the code, with the version', async () => {
    const res = await send(
      'PUT',
      `/pos/registers/${pos2.id}`,
      // A code in the body is not part of the edit form: it is dropped
      editForm(pos2, {
        code: 'POS9',
        name: 'Pharmacy counter',
        maxDiscountPercent: '2.5',
        receiptFooter: 'Medicines are not taken back',
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const after = posRegisterSchema.parse(res.json());
    expect(after).toMatchObject({
      code: 'POS2',
      name: 'Pharmacy counter',
      maxDiscountPercent: '2.50',
      receiptFooter: 'Medicines are not taken back',
      version: pos2.version + 1,
    });
    const stale = await send('PUT', `/pos/registers/${pos2.id}`, editForm(pos2));
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');
    const [entry] = await auditOf('pos_register', pos2.id);
    expect(entry).toMatchObject({
      action: 'pos_register.updated',
      changes: {
        name: { from: 'Counter POS2', to: 'Pharmacy counter' },
        maxDiscountPercent: { from: '0.00', to: '2.50' },
        receiptFooter: { from: null, to: 'Medicines are not taken back' },
      },
    });
    pos2 = after;
  });

  it('are archived and restored; an archived one is not taken', async () => {
    const archived = await send('POST', `/pos/registers/${pos3.id}/archive`, {
      version: pos3.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const gone = posRegisterSchema.parse(archived.json());
    expect(gone.archivedAt).not.toBeNull();
    expect((await listRegisters()).map((item) => item.code)).not.toContain('POS3');
    expect((await listRegisters('?status=archived')).map((item) => item.code)).toEqual(['POS3']);

    const taken = await claim(gone, officeLaptop);
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken).code).toBe('pos_register_archived');

    const restored = await send('POST', `/pos/registers/${pos3.id}/restore`, {
      version: gone.version,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    pos3 = posRegisterSchema.parse(restored.json());
    expect(pos3.archivedAt).toBeNull();
  });
});

describe('a device and its register', () => {
  it('takes a free register, and the same answer when it asks again', async () => {
    const held = await claimed(pos1, counterPc);
    // Who holds it is not part of the form: the version stays, and a manager's open form still saves
    expect(held).toMatchObject({ deviceId: counterPc.id, lastNumber: 0, version: pos1.version });
    expect(await claimed(pos1, counterPc)).toEqual(held);
    const [item] = await listRegisters();
    expect(item?.holder).toEqual({ deviceName: 'Front counter PC', userName: 'Nusrat Jahan' });
    const entries = await auditOf('pos_register', pos1.id);
    expect(entries.map((entry) => [entry.action, entry.changes])).toEqual([
      ['pos_register.claimed', { device: { from: null, to: 'Front counter PC' } }],
      ['pos_register.created', expect.anything()],
    ]);
    pos1 = held;
  });

  it('is refused a held register, a second register, or one of another branch', async () => {
    const held = await claim(pos1, officeLaptop);
    expect(held.statusCode).toBe(409);
    expect(problemOf(held).code).toBe('pos_register_in_use');
    const second = await claim(pos2, counterPc);
    expect(problemOf(second).code).toBe('pos_device_has_register');
    const branch = await claim(pos2, uttaraPc);
    expect(problemOf(branch).code).toBe('pos_register_branch');
    expect((await registerNow(pos2)).deviceId).toBeNull();
  });

  it("takes only a person's own device, and needs pos.sale.create", async () => {
    // Rafiq has no role: the route's guard refuses him first
    const rafiqPhone = await registerDevice('Rafiq phone', main.branchId, rafiq);
    const noRole = await claim(pos2, rafiqPhone, rafiq);
    expect(noRole.statusCode).toBe(403);
    expect(problemOf(noRole).code).toBe('permission_missing');
    // Sumi may sell, but not on the owner's PC, nor on a device nobody registered
    const other = await claim(pos2, counterPc, sumi);
    expect(other.statusCode).toBe(404);
    expect(problemOf(other).code).toBe('device_not_found');
    const unknown = await claim(pos2, { ...counterPc, id: v7() }, sumi);
    expect(problemOf(unknown).code).toBe('device_not_found');
    pos2 = await claimed(pos2, sumiTablet, sumi);
    expect(pos2.deviceId).toBe(sumiTablet.id);
  });

  it('is let go only by the device that holds it', async () => {
    const other = await release(pos1, officeLaptop);
    expect(other.statusCode).toBe(409);
    expect(problemOf(other).code).toBe('pos_register_not_held');
    // A cashier lets go without pos.register.manage: it is her device's register
    const free = await released(pos2, sumiTablet, sumi);
    expect(free).toMatchObject({ deviceId: null, version: pos2.version });
    // Sent again after a lost answer: the register is free, and it says so
    expect(await released(pos2, sumiTablet, sumi)).toEqual(free);
    const [entry] = await auditOf('pos_register', pos2.id);
    expect(entry).toMatchObject({
      action: 'pos_register.released',
      changes: { device: { from: 'Counter 2 tablet', to: null } },
    });
    pos2 = await claimed(pos2, sumiTablet, sumi);
  });

  it('goes to one device when two take it at the same moment', async () => {
    const spare = await registerDevice('Spare PC', main.branchId);
    const answers = await Promise.all([claim(pos3, officeLaptop), claim(pos3, spare)]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const lost = answers.find((res) => res.statusCode === 409);
    if (!lost) throw new Error('nobody lost');
    expect(problemOf(lost).code).toBe('pos_register_in_use');
    const winner = (await registerNow(pos3)).deviceId === spare.id ? spare : officeLaptop;
    await released(pos3, winner);

    // One device taking two free registers at once: the database's index refuses the second
    const pos4 = await created(posRegisterSchema, '/pos/registers', registerForm('POS4', main));
    const both = await Promise.all([claim(pos3, spare), claim(pos4, spare)]);
    expect(both.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const refused = both.find((res) => res.statusCode === 409);
    if (!refused) throw new Error('nothing refused');
    expect(problemOf(refused).code).toBe('pos_device_has_register');
    // Tidy up: POS3 free again, POS4 archived
    for (const register of [pos3, pos4]) {
      if ((await registerNow(register)).deviceId !== null) await released(register, spare);
    }
    const archived = await send('POST', `/pos/registers/${pos4.id}/archive`, {
      version: (await registerNow(pos4)).version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
  });

  it('is let go when its device is revoked or moved to another branch', async () => {
    const lost = await registerDevice('Lost tablet', main.branchId);
    await claimed(pos3, lost);
    const revoked = await send('POST', `/devices/${lost.id}/revoke`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    // The database let go of it in the revoke's own transaction, without a version
    expect(await registerNow(pos3)).toMatchObject({ deviceId: null, version: pos3.version });
    const again = await claim(pos3, lost);
    expect(again.statusCode).toBe(403);
    expect(problemOf(again).code).toBe('device_revoked');

    const moving = await registerDevice('Moving laptop', main.branchId);
    await claimed(pos3, moving);
    const mine = myDeviceListSchema
      .parse((await send('GET', '/me/devices')).json())
      .items.find((device) => device.id === moving.id);
    if (!mine) throw new Error('no moving laptop');
    const moved = await send('PUT', `/devices/${moving.id}/branch`, {
      branchId: uttara.id,
      version: mine.version,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(deviceListItemSchema.parse(moved.json()).branchId).toBe(uttara.id);
    expect((await registerNow(pos3)).deviceId).toBeNull();
  });
});

describe("a register's warehouse", () => {
  it('stays in its branch while a device holds the register; a free one moves it along', async () => {
    await claimed(pos3, officeLaptop);
    const toUttara = await send('PUT', `/pos/registers/${pos3.id}`, {
      ...editForm(await registerNow(pos3)),
      warehouseId: uttaraStore.id,
    });
    expect(toUttara.statusCode).toBe(409);
    expect(problemOf(toUttara)).toMatchObject({
      code: 'pos_register_branch',
      fieldErrors: { warehouseId: ['pos_register_branch'] },
    });
    const store = await send('PUT', `/warehouses/${backStore.id}`, {
      branchId: uttara.id,
      code: backStore.code,
      name: backStore.name,
      address: '',
      version: backStore.version,
    });
    expect(store.statusCode).toBe(409);
    expect(problemOf(store).code).toBe('warehouse_branch_locked');
    // Another warehouse of the same branch is fine: the device's sales stay in its branch
    const sameBranch = await send('PUT', `/pos/registers/${pos3.id}`, {
      ...editForm(await registerNow(pos3)),
      warehouseId: main.id,
    });
    expect(sameBranch.statusCode, sameBranch.body).toBe(200);
    const back = await send('PUT', `/pos/registers/${pos3.id}`, {
      ...editForm(posRegisterSchema.parse(sameBranch.json())),
      warehouseId: backStore.id,
    });
    expect(back.statusCode, back.body).toBe(200);

    // Free, the back store goes to Uttara and takes the register with it
    await released(pos3, officeLaptop);
    const freeStore = await send('PUT', `/warehouses/${backStore.id}`, {
      branchId: uttara.id,
      code: backStore.code,
      name: backStore.name,
      address: '',
      version: backStore.version,
    });
    expect(freeStore.statusCode, freeStore.body).toBe(200);
    backStore = warehouseSchema.parse(freeStore.json());
    pos3 = await registerNow(pos3);
    expect(pos3.branchId).toBe(uttara.id);
    expect(problemOf(await claim(pos3, officeLaptop)).code).toBe('pos_register_branch');
  });
});

describe('the pull', () => {
  it("sends the registers of the device's branch, without their last number", async () => {
    const rows = registersIn((await pulled(officeLaptop)).changes);
    expect(rows.map((row) => row.key).sort()).toEqual([pos1.id, pos2.id].sort());
    const first = rows.find((row) => row.key === pos1.id);
    if (first?.op !== 'upsert' || first.entity !== 'pos_register') throw new Error('no POS1');
    expect(first.data).toMatchObject({
      code: 'POS1',
      deviceId: counterPc.id,
      branchId: main.branchId,
    });
    expect(first.data).not.toHaveProperty('lastNumber');
    // Uttara's counter sees its own two, the back store's register among them
    const uttaraRows = registersIn((await pulled(uttaraPc)).changes);
    expect(uttaraRows.map((row) => row.key).sort()).toEqual([utt1.id, pos3.id].sort());
  });

  it('sends a register again when it is made, taken or archived, not when it sold', async () => {
    const { cursor } = await pulled(officeLaptop);
    await sold(sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')]));
    expect(registersIn((await pulled(officeLaptop, cursor)).changes)).toEqual([]);

    const pos5 = await created(posRegisterSchema, '/pos/registers', registerForm('POS5', main));
    const made = await pulled(officeLaptop, cursor);
    expect(registersIn(made.changes).map((row) => [row.op, row.key])).toEqual([
      ['upsert', pos5.id],
    ]);
    await claimed(pos5, officeLaptop);
    expect(registersIn((await pulled(officeLaptop, made.cursor)).changes)).toMatchObject([
      { op: 'upsert', key: pos5.id, data: { deviceId: officeLaptop.id } },
    ]);
    await released(pos5, officeLaptop);
    const archived = await send('POST', `/pos/registers/${pos5.id}/archive`, {
      version: pos5.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(registersIn((await pulled(officeLaptop, made.cursor)).changes)).toEqual([
      { op: 'delete', entity: 'pos_register', key: pos5.id },
    ]);
  });
});

describe('a sale pushed from the counter', () => {
  it('is posted at once: its number, its money, its stock and one journal entry', async () => {
    const juiceBefore = await onHand(main, juice);
    // Two juices and a gift wrapping, ৳115 with VAT; the customer gives ৳200 as two notes
    const command = sale(
      pos1,
      [line(juice, '2', '25'), line(wrap, '1', '50')],
      [paid('cash', '100'), paid('cash', '100')],
    );
    const [result] = await push([command]);
    // Nothing for the device to write: sales are not on the device
    expect(result).toEqual({ id: command.id, status: 'accepted', notices: [], changes: [] });
    const done = await saleNow(command.saleId);
    expect(done).toMatchObject({
      number: numberOf(command, 'POS1'),
      register: { id: pos1.id, code: 'POS1', name: 'Front counter' },
      branchId: main.branchId,
      warehouseId: main.id,
      date: today,
      customer: null,
      cashier: { fullName: 'Nusrat Jahan' },
      net: '100.0000',
      vat: '15.0000',
      total: '115.0000',
      paid: '200.0000',
      change: '85.0000',
      lineCount: 2,
      soldShort: false,
      device: { id: counterPc.id, name: 'Front counter PC' },
    });
    expect(done.payments).toEqual([
      { method: 'cash', amount: '100.0000', reference: null, accountId: accountId('1110') },
      { method: 'cash', amount: '100.0000', reference: null, accountId: accountId('1110') },
    ]);
    expect(done.lines.map((item) => [item.total, item.shortQuantity, item.batches])).toEqual([
      ['57.5000', '0.0000', []],
      ['57.5000', '0.0000', []],
    ]);
    // The two notes are one cash line, less the change; the juices cost ৳15 each
    expect(await entryLines(done)).toEqual([
      ['1110', '115.0000', '0.0000'],
      ['1150', '0.0000', '30.0000'],
      ['2120', '0.0000', '15.0000'],
      ['4110', '0.0000', '100.0000'],
      ['5110', '30.0000', '0.0000'],
    ]);
    expect(Number(await onHand(main, juice))).toBe(Number(juiceBefore) - 2);
    expect((await registerNow(pos1)).lastNumber).toBe(command.input.sequence);
    const [entry] = await auditOf('pos_sale', command.saleId);
    expect(entry).toMatchObject({
      action: 'pos_sale.created',
      device: { id: counterPc.id, name: 'Front counter PC' },
      changes: {
        number: { from: null, to: done.number },
        register: { from: null, to: 'POS1' },
        total: { from: null, to: '115.0000' },
        paid: { from: null, to: '200.0000' },
        soldShort: { from: null, to: 0 },
      },
    });
  });

  it('takes each way of paying into its own account', async () => {
    // A phone at ৳15,000 + 15% = ৳17,250: ৳10,000 on the card, ৳5,000 by bKash, ৳3,000 in cash
    const done = await sold(
      sale(
        pos1,
        [line(phone, '1', '15000', { serialNumbers: ['IMEI-1'] })],
        [paid('card', '10000', '4242'), paid('bkash', '5000', 'TRX8KD2Q1'), paid('cash', '3000')],
      ),
    );
    expect([done.total, done.paid, done.change]).toEqual(['17250.0000', '18000.0000', '750.0000']);
    expect(
      done.payments.map((item) => [item.method, item.reference, codeOf(item.accountId)]),
    ).toEqual([
      ['card', '4242', '1121'],
      ['bkash', 'TRX8KD2Q1', '1131'],
      ['cash', null, '1110'],
    ]);
    expect(done.lines[0]?.serialNumbers).toEqual(['IMEI-1']);
    expect(await entryLines(done)).toEqual([
      ['1110', '2250.0000', '0.0000'],
      ['1121', '10000.0000', '0.0000'],
      ['1131', '5000.0000', '0.0000'],
      ['1150', '0.0000', '9000.0000'],
      ['2120', '0.0000', '2250.0000'],
      ['4110', '0.0000', '15000.0000'],
      ['5110', '9000.0000', '0.0000'],
    ]);
  });

  it('is for the customer the cashier picked, also one archived since', async () => {
    const lalmatia = await addCustomer('Lalmatia Pharmacy');
    const first = await sold(
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '28.75')], { customerId: lalmatia.id }),
    );
    expect(first.customer).toEqual({ id: lalmatia.id, code: lalmatia.code, name: lalmatia.name });
    // No receivable: the whole amount was paid at the counter
    expect((await entryLines(first)).map((row) => row[0])).not.toContain('1140');
    const archived = await send('POST', `/customers/${lalmatia.id}/archive`, {
      version: lalmatia.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    // Sold while the device still had the customer: it was sold already
    const second = await sold(
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')], { customerId: lalmatia.id }),
    );
    const page = posSalePageSchema.parse(
      (await send('GET', `/pos/sales?customerId=${lalmatia.id}`)).json(),
    );
    expect(page.items.map((item) => item.number).sort()).toEqual(
      [first.number, second.number].sort(),
    );
    const unknown = await push([
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')], { customerId: v7() }),
    ]);
    expect(refusal(unknown[0])).toMatchObject({
      code: 'sales_customer_invalid',
      fieldErrors: { customerId: ['sales_customer_invalid'] },
    });
  });

  it("works VAT out of prices that include it, shares the bill's discount, and logs the overrides", async () => {
    // Four juices at ৳23 (the shelf says ৳25) and a wrapping at ৳46, VAT inside: ৳138. Half off
    // the bill (৳69), shared 92 : 46, so the juices pay ৳46 (VAT ৳6) and the wrapping ৳23 (VAT ৳3).
    const done = await sold(
      sale(
        pos1,
        [line(juice, '4', '23', { startingPrice: '25' }), line(wrap, '1', '46')],
        [paid('cash', '100')],
        { pricesIncludeVat: true, billDiscountType: 'percent', billDiscount: '50' },
      ),
    );
    expect(done).toMatchObject({
      pricesIncludeVat: true,
      billDiscountType: 'percent',
      billDiscount: '50.0000',
      billDiscountAmount: '69.0000',
      net: '60.0000',
      vat: '9.0000',
      total: '69.0000',
      change: '31.0000',
    });
    expect(
      done.lines.map((item) => [item.billDiscount, item.net, item.vat, item.startingPrice]),
    ).toEqual([
      ['46.0000', '40.0000', '6.0000', '25.0000'],
      ['23.0000', '20.0000', '3.0000', '46.0000'],
    ]);
    expect(await entryLines(done)).toEqual([
      ['1110', '69.0000', '0.0000'],
      ['1150', '0.0000', '60.0000'],
      ['2120', '0.0000', '9.0000'],
      ['4110', '0.0000', '60.0000'],
      ['5110', '60.0000', '0.0000'],
    ]);
    // Nusrat may: the audit log says what she did, and that she was allowed to
    const entries = await auditOf('pos_sale', done.id);
    expect(entries.map((entry) => [entry.action, entry.changes])).toContainEqual([
      'pos_sale.overridden',
      {
        overrides: { from: null, to: 'price on line 1, bill discount' },
        maxDiscountPercent: { from: null, to: '5.00' },
        allowed: { from: null, to: true },
      },
    ]);
  });

  it("is taken from a cashier who went over the register's limit, and the log says so", async () => {
    // POS2's limit is 2.5%; Sumi gives 10% off a juice without pos.price.override
    const done = await sold(
      sale(pos2, [line(juice, '1', '25', { discount: '10' })], [paid('cash', '30')]),
      sumiTablet,
      sumi,
    );
    // ৳22.50 after the discount; the VAT of ৳3.375 is rounded to the paisa
    expect(done).toMatchObject({ cashier: { fullName: 'Sumi Akter' }, total: '25.8800' });
    const entries = await auditOf('pos_sale', done.id);
    expect(entries.find((entry) => entry.action === 'pos_sale.overridden')?.changes).toEqual({
      overrides: { from: null, to: 'discount on line 1' },
      maxDiscountPercent: { from: null, to: '2.50' },
      allowed: { from: null, to: false },
    });
  });

  it("is booked on the device's day, unless that day is ahead or closed", async () => {
    const yesterday = await sold(
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')], { date: addDays(today, -1) }),
    );
    expect(yesterday.date).toBe(addDays(today, -1));
    // A clock set a day ahead: the books take today
    const ahead = await sold(
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')], { date: addDays(today, 1) }),
    );
    expect(ahead.date).toBe(today);

    // The books closed up to yesterday: a sale of two days ago goes on today, the first open day
    const lock = periodLockSchema.parse((await send('GET', '/period-lock')).json());
    const closed = await send('PUT', '/period-lock', {
      lockDate: addDays(today, -1),
      version: lock.version,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const late = await sold(
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')], { date: addDays(today, -2) }),
    );
    expect(late.date).toBe(today);
    const [entry] = await auditOf('pos_sale', late.id);
    expect(entry?.changes).toMatchObject({
      date: { from: null, to: today },
      soldOn: { from: null, to: addDays(today, -2) },
    });
    const opened = await send('PUT', '/period-lock', {
      lockDate: '',
      version: periodLockSchema.parse(closed.json()).version,
    });
    expect(opened.statusCode, opened.body).toBe(200);
  });

  it('goes below zero rather than be refused, and tells the people who keep the stock', async () => {
    // All the juice and 5 more; 10 strips of Napa from batch A, which has 3; and a phone whose
    // serial number the store does not have
    const juiceLeft = await onHand(main, juice);
    const done = await sold(
      sale(
        pos1,
        [
          line(juice, String(Number(juiceLeft) + 5), '25'),
          line(napa, '10', '30', { batchId: batchA }),
          line(phone, '1', '15000', { serialNumbers: ['IMEI-9'] }),
        ],
        [paid('cash', '50000')],
      ),
    );
    expect(done.soldShort).toBe(true);
    // A first, then B by its expiry (the expired OLD batch is skipped), the rest below zero on A
    expect(done.lines[1]?.batches.map((part) => [part.lotNumber, part.quantity])).toEqual([
      ['NP-A', '5.0000'],
      ['NP-B', '5.0000'],
    ]);
    expect(done.lines.map((item) => item.shortQuantity)).toEqual(['5.0000', '2.0000', '0.0000']);
    expect(await onHand(main, juice)).toBe('-5.0000');
    const lots = z.array(z.object({ lot_number: z.string(), quantity: z.string() })).parse(
      await sql`SELECT b.lot_number, s.quantity::text FROM stock_balances s
                  JOIN batches b ON b.id = s.batch_id
                  WHERE s.warehouse_id = ${main.id} ORDER BY b.lot_number`,
    );
    expect(lots).toEqual([
      { lot_number: 'NP-A', quantity: '-2.0000' },
      { lot_number: 'NP-B', quantity: '0.0000' },
      { lot_number: 'NP-OLD', quantity: '4.0000' },
    ]);

    const short = soldShortPageSchema.parse((await send('GET', '/pos/sold-short')).json());
    expect(
      short.items.map((item) => [
        item.productName,
        item.saleNumber,
        item.shortQuantity,
        item.lotNumber,
        item.serialNumbers,
        item.onHandNow,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['Mango juice 250 ml', done.number, '5.0000', null, [], '-5.0000'],
        ['Napa 500 mg strip', done.number, '2.0000', 'NP-A', [], '2.0000'],
        ['Walton Primo phone', done.number, '0.0000', null, ['IMEI-9'], '0.0000'],
      ]),
    );
    const elsewhere = soldShortPageSchema.parse(
      (await send('GET', `/pos/sold-short?warehouseId=${uttaraStore.id}`)).json(),
    );
    expect(elsewhere.items).toEqual([]);

    // The owner and the shop manager hear about it; the cashier and Rafiq do not
    await eventually(async () => {
      const bells = z
        .array(z.object({ email: z.string(), params: z.record(z.string(), z.unknown()) }))
        .parse(
          await sql`SELECT u.email, n.params FROM notifications n JOIN users u ON u.id = n.user_id
                     WHERE n.type = 'pos.sold_short' ORDER BY u.email`,
        );
      expect(bells.map((bell) => bell.email)).toEqual([
        'kamal@agoramart.com',
        'nusrat@agoramart.com',
      ]);
      expect(bells[0]?.params).toEqual({
        id: done.id,
        number: done.number,
        warehouse: main.name,
        count: 3,
      });
    });

    // Put right with an adjustment: the list shows the stock now
    await stockIn(main, [inLine(juice, '24', '15')]);
    const after = soldShortPageSchema.parse((await send('GET', '/pos/sold-short')).json());
    expect(after.items.find((item) => item.productName === 'Mango juice 250 ml')?.onHandNow).toBe(
      '19.0000',
    );
  });

  it('is refused a batch or serial numbers a device never sends, and keeps the number', async () => {
    const results = await push([
      sale(pos1, [line(napa, '1', '30')], [paid('cash', '40')]),
      sale(pos1, [line(napa, '1', '30', { batchId: v7() })], [paid('cash', '40')]),
      sale(
        pos1,
        [line(phone, '2', '15000', { serialNumbers: ['IMEI-2'] })],
        [paid('cash', '40000')],
      ),
    ]);
    expect(results.map((result) => refusal(result))).toEqual([
      {
        code: 'stock_batch_required',
        fieldErrors: { 'lines.0.batchId': ['stock_batch_required'] },
      },
      { code: 'stock_batch_invalid', fieldErrors: { 'lines.0.batchId': ['stock_batch_invalid'] } },
      {
        code: 'stock_serial_count',
        fieldErrors: { 'lines.0.serialNumbers': ['stock_serial_count'] },
      },
    ]);
    // Their receipts were printed: the numbers are used, and the next device goes on after them
    expect((await registerNow(pos1)).lastNumber).toBe(sequences.get(pos1.id));
  });

  it('is refused a way of paying the register has no account for, and keeps the number', async () => {
    const results = await push(
      [sale(pos2, [line(juice, '1', '25')], [paid('cash', '10'), paid('bkash', '20', 'TRX1')])],
      sumiTablet,
      sumi,
    );
    expect(refusal(results[0])).toEqual({
      code: 'pos_method_not_set',
      fieldErrors: { 'payments.1.method': ['pos_method_not_set'] },
    });
    expect((await registerNow(pos2)).lastNumber).toBe(sequences.get(pos2.id));

    // POS1 stops taking cards while a card sale waits on the counter PC
    const before = await registerNow(pos1);
    const noCard = await send(
      'PUT',
      `/pos/registers/${pos1.id}`,
      editForm(before, { accounts: { ...accountsForm(before), card: '' } }),
    );
    expect(noCard.statusCode, noCard.body).toBe(200);
    const card = await push([
      sale(pos1, [line(juice, '1', '25')], [paid('card', '28.75', '4242')]),
    ]);
    expect(refusal(card[0]).code).toBe('pos_method_not_set');
    const back = await send(
      'PUT',
      `/pos/registers/${pos1.id}`,
      editForm(posRegisterSchema.parse(noCard.json()), { accounts: accountsForm(before) }),
    );
    expect(back.statusCode, back.body).toBe(200);
    // The number after the refused one is free
    await sold(sale(pos1, [line(juice, '1', '25')], [paid('card', '28.75', '4242')]));
  });

  it('is refused for a register the device does not hold', async () => {
    const results = await push(
      [sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')])],
      officeLaptop,
    );
    expect(refusal(results[0])).toEqual({
      code: 'pos_register_not_held',
      fieldErrors: { registerId: ['pos_register_not_held'] },
    });
  });

  it("is refused for what the device's own form refuses, and keeps no answer", async () => {
    const commands = [
      // ৳28.75 to pay, ৳20 given
      sale(pos1, [line(juice, '1', '25')], [paid('cash', '20')]),
      // A card charged more than the total: change comes only from the cash
      sale(pos1, [line(juice, '1', '25')], [paid('card', '30', '4242')]),
      sale(pos1, [line(juice, '1', '25')], []),
    ];
    const results = await push(commands);
    expect(results.map((result) => refusal(result))).toEqual([
      { code: 'invalid_input', fieldErrors: { payments: ['pos_payment_short'] } },
      { code: 'invalid_input', fieldErrors: { payments: ['pos_change_not_cash'] } },
      { code: 'invalid_input', fieldErrors: { payments: ['pos_payments_required'] } },
    ]);
    const kept = await sql`SELECT id FROM sync_commands
                            WHERE id IN ${sql(commands.map((command) => command.id))}`;
    expect(kept).toHaveLength(0);
    // The device never saves such a sale, so the server does not keep its number either
    sequences.set(pos1.id, (await registerNow(pos1)).lastNumber);
  });

  it('is posted when the cashier lost pos.sale.create since, and the log says so', async () => {
    // Taken away while Sumi's tablet was offline: the sale she made then is in the drawer already,
    // so it is posted when it arrives (decision 28)
    await giveRoles('sumi@agoramart.com', []);
    const command = sale(pos2, [line(juice, '1', '25')], [paid('cash', '30')]);
    const done = await sold(command, sumiTablet, sumi);
    expect(done.number).toBe(numberOf(command, 'POS2'));
    const entries = await auditOf('pos_sale', done.id);
    expect(entries.map((entry) => [entry.action, entry.changes])).toContainEqual([
      'pos_sale.without_permission',
      {
        number: { from: null, to: done.number },
        soldOn: { from: null, to: command.input.date },
        missing: { from: null, to: 'pos.sale.create' },
      },
    ]);
    await giveRoles('sumi@agoramart.com', ['Cashier']);

    // With the permission back, a sale writes no such row
    const next = await sold(
      sale(pos2, [line(juice, '1', '25')], [paid('cash', '30')]),
      sumiTablet,
      sumi,
    );
    const nextEntries = await auditOf('pos_sale', next.id);
    expect(nextEntries.map((entry) => entry.action)).not.toContain('pos_sale.without_permission');
  });

  it('runs once when sent again; its id and its number are used once', async () => {
    const command = sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')]);
    expect(outcomes(await push([command, command]))).toEqual(['accepted', 'accepted']);
    expect(outcomes(await push([command]))).toEqual(['accepted']);
    const page = posSalePageSchema.parse(
      (await send('GET', `/pos/sales?registerId=${pos1.id}&limit=100`)).json(),
    );
    expect(page.items.filter((item) => item.number === numberOf(command, 'POS1'))).toHaveLength(1);

    // The sale's id under a new command, and the same number with a new sale id: only a bug sends
    // either, and each is refused rather than written twice
    const sameId = {
      ...sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')]),
      saleId: command.saleId,
    };
    const sameNumber = { ...command, id: v7(), saleId: v7() };
    const results = await push([sameId, sameNumber]);
    expect(refusal(results[0])).toEqual({ code: 'sync_id_taken' });
    expect(refusal(results[1])).toEqual({
      code: 'pos_number_taken',
      fieldErrors: { sequence: ['pos_number_taken'] },
    });
  });

  it('is written one after the other when two pushes of one register arrive together', async () => {
    const first = sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')]);
    const second = sale(pos1, [line(juice, '1', '25')], [paid('cash', '30')]);
    // The later number may arrive first: the last number is the highest, whatever the order
    const [a, b] = await Promise.all([push([second]), push([first])]);
    expect(outcomes([...a, ...b])).toEqual(['accepted', 'accepted']);
    expect((await registerNow(pos1)).lastNumber).toBe(second.input.sequence);
  });

  it('is listed newest first, by register, one page at a time', async () => {
    const byRegister = posSalePageSchema.parse(
      (await send('GET', `/pos/sales?registerId=${pos2.id}`)).json(),
    );
    // Only POS2's: Sumi's three on her tablet
    expect(byRegister.items.map((item) => item.register.code)).toEqual(['POS2', 'POS2', 'POS2']);
    const numbers: string[] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor === null ? '' : `&cursor=${cursor}`;
      const page = posSalePageSchema.parse(
        (await send('GET', `/pos/sales?registerId=${pos1.id}&limit=3${after}`)).json(),
      );
      numbers.push(...page.items.map((item) => item.number));
      cursor = page.nextCursor;
    } while (cursor !== null);
    const all = posSalePageSchema.parse(
      (await send('GET', `/pos/sales?registerId=${pos1.id}&limit=100`)).json(),
    );
    expect(numbers).toEqual(all.items.map((item) => item.number));
    // Newest day first: the sale of yesterday is last
    expect(all.items.at(-1)?.date).toBe(addDays(today, -1));
    const missing = await send('GET', `/pos/sales/${v7()}`);
    expect(missing.statusCode).toBe(404);
  });

  it("keeps its entry out of the journal's Reverse", async () => {
    const [latest] = posSalePageSchema.parse(
      (await send('GET', '/pos/sales?limit=1')).json(),
    ).items;
    if (!latest) throw new Error('no sale');
    const done = await saleNow(latest.id);
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${done.entry?.id ?? ''}`)).json(),
    );
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: today,
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('journal_is_stock');
  });
});

describe('what a POS sale or a register points at', () => {
  it('is not deleted: the customer, the item and the account', async () => {
    const customer = await addCustomer('Mohammadpur Store');
    await sold(
      sale(pos1, [line(wrap, '1', '50')], [paid('cash', '60')], { customerId: customer.id }),
    );
    const gone = await send(
      'DELETE',
      `/customers/${customer.id}?version=${String(customer.version)}`,
    );
    expect(gone.statusCode).toBe(409);
    expect(problemOf(gone).code).toBe('customer_in_use');

    const item = await send('DELETE', `/products/${wrap.id}?version=${String(wrap.version)}`);
    expect(item.statusCode).toBe(409);
    expect(problemOf(item).code).toBe('product_in_use');

    // A wallet only a register uses
    const nagad = await created(accountSchema, '/accounts', {
      parentId: accountId('1130'),
      code: '1132',
      name: 'Nagad merchant 01811',
      isGroup: false,
      holdsMoney: false,
      description: '',
    });
    const now = await registerNow(pos2);
    const res = await send(
      'PUT',
      `/pos/registers/${pos2.id}`,
      editForm(now, { accounts: { ...accountsForm(now), nagad: nagad.id } }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const account = await send('DELETE', `/accounts/${nagad.id}?version=${String(nagad.version)}`);
    expect(account.statusCode).toBe(409);
    expect(problemOf(account).code).toBe('account_in_use');
  });
});
