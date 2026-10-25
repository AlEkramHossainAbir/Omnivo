import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Branch,
  branchSchema,
  type Customer,
  type CustomerFormValues,
  customerSchema,
  type Device,
  deviceSchema,
  type PriceList,
  priceListSchema,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  settingsSchema,
  setupSchema,
  supplierSchema,
  SYNC_ENTITIES,
  type SyncChange,
  type SyncEntity,
  syncPullSchema,
  type Unit,
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
import { SyncLogCleanup } from './sync-log-cleanup.js';

// One distributor with two depots: Narsingdi (the main branch) and Chattogram. The tests follow
// a counter in Narsingdi that pulls its data: everything once, then only what changed.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser, for what the API cannot do yet: stock without the books, a revoked device
// (step 18c), a cursor's age
let sql: postgres.Sql;
let tenantId: string;
let owner: SignedIn;
// Rafiq, a salesperson with no role: syncing needs no permission
let rafiq: SignedIn;
let units: Unit[];
let narsingdi: Branch;
let chattogram: Branch;
let depot: Warehouse;
let oldStore: Warehouse;
let ctgDepot: Warehouse;
let juice: Product;
let soap: Product;
let cleaner: Product;
let dealer: PriceList;
let retail: PriceList;
let karim: Customer;
let rahim: Customer;
let soapBatch: string;
// The counter in Narsingdi
let counter: Device;

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
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function unitId(code: string): string {
  const found = units.find((unit) => unit.code === code);
  if (!found) throw new Error(`no unit ${code}`);
  return found.id;
}

function variantId(product: Product, index = 0): string {
  const found = product.variants[index];
  if (!found) throw new Error(`${product.name} has no variant ${String(index)}`);
  return found.id;
}

function variant(optionValues: string[] = [], salePrice = '') {
  return { id: null, sku: '', optionValues, barcode: '', salePrice, archived: false };
}

function productForm(name: string, extra: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: unitId('pcs'),
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [variant()],
    units: [],
    customFields: {},
    ...extra,
  };
}

function customerForm(name: string, extra: Partial<CustomerFormValues> = {}): CustomerFormValues {
  return {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'bn',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  };
}

async function created<T>(schema: z.ZodType<T>, url: string, payload: object): Promise<T> {
  const res = await send('POST', url, payload);
  expect(res.statusCode, res.body).toBe(201);
  return schema.parse(res.json());
}

async function addProduct(name: string, extra: Partial<ProductFormValues> = {}) {
  return created(productSchema, '/products', productForm(name, extra));
}

async function addWarehouse(branch: Branch, code: string, name: string) {
  return created(warehouseSchema, '/warehouses', { branchId: branch.id, code, name, address: '' });
}

// One PUT of a price list's page: one statement, one line per key in the log
async function setPrices(list: PriceList, prices: [string, string, string][]) {
  const res = await send('PUT', `/price-lists/${list.id}/items`, {
    changes: prices.map(([variant, unit, price]) => ({ variantId: variant, unitId: unit, price })),
  });
  expect(res.statusCode, res.body).toBe(200);
}

// The archive and restore routes of products, price lists, customers and branches take the
// version and answer the row with its new version
async function flip<T extends { version: number }>(
  schema: z.ZodType<T>,
  path: string,
  row: T,
  action: 'archive' | 'restore',
): Promise<T> {
  const res = await send('POST', `${path}/${action}`, { version: row.version });
  expect(res.statusCode, res.body).toBe(200);
  return schema.parse(res.json());
}

// Stock straight into stock_balances, as the superuser. Step 13's adjustments would need the
// books set up for every test, and the change log's trigger sees the row whoever writes it.
async function putStock(
  warehouse: Warehouse,
  product: Product,
  variant: string,
  quantity: string,
  batchId: string | null = null,
) {
  await sql`
    INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, batch_id, quantity)
    VALUES (${tenantId}, ${warehouse.id}, ${product.id}, ${variant}, ${batchId}, ${quantity})
    ON CONFLICT ON CONSTRAINT stock_balances_key DO UPDATE SET quantity = EXCLUDED.quantity`;
}

async function renameCompany(companyName: string) {
  const settings = settingsSchema.parse((await send('GET', '/settings')).json());
  const res = await send('PUT', '/settings', {
    version: settings.version,
    companyName,
    legalName: settings.legalName ?? '',
    bin: settings.bin ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    address: settings.address ?? '',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
    allowNegativeStock: settings.allowNegativeStock,
    pricesIncludeVat: settings.pricesIncludeVat,
    overReceiptPercent: settings.overReceiptPercent,
  });
  expect(res.statusCode, res.body).toBe(200);
}

function register(input: { id: string; name: string; branchId: string }, as = owner) {
  return send('POST', '/sync/devices', input, as);
}

async function newDevice(name: string, branch: Branch, as = owner): Promise<Device> {
  const res = await register({ id: v7(), name, branchId: branch.id }, as);
  expect(res.statusCode, res.body).toBe(201);
  return deviceSchema.parse(res.json());
}

function pullPage(deviceId: string, cursor: string | undefined, limit: number, as = owner) {
  const query = new URLSearchParams({ deviceId, protocol: '1', limit: String(limit) });
  if (cursor !== undefined) query.set('cursor', cursor);
  return send('GET', `/sync/pull?${query.toString()}`, undefined, as);
}

// A whole pull, page after page, as the device runs it: until hasMore is false
async function pullAll(device: Device, cursor: string | undefined, limit = 500) {
  const pages = [];
  let next = cursor;
  for (let page = 0; page < 500; page += 1) {
    const res = await pullPage(device.id, next, limit);
    expect(res.statusCode, res.body).toBe(200);
    const body = syncPullSchema.parse(res.json());
    pages.push(body);
    next = body.cursor;
    if (!body.hasMore) {
      return { pages, cursor: body.cursor, changes: pages.flatMap((p) => p.changes) };
    }
  }
  throw new Error('The pull did not end in 500 pages');
}

function keysOf(changes: SyncChange[], entity: SyncEntity, op: SyncChange['op'] = 'upsert') {
  return changes
    .filter((change) => change.entity === entity && change.op === op)
    .map((change) => change.key)
    .sort();
}

function priceKey(list: PriceList, variant: string, unit: string): string {
  return `${list.id}:${variant}:${unit}`;
}

function stockKey(warehouse: Warehouse, variant: string, batchId: string | null = null): string {
  return `${warehouse.id}:${variant}:${batchId ?? '-'}`;
}

// The cursor is opaque to the device, but a test may age it or edit it like a broken client.
// It is base64url JSON of a one-value list (sync-cursor.ts).
const cursorJsonSchema = z.tuple([z.record(z.string(), z.unknown())]);
function editCursor(cursor: string, patch: Record<string, unknown>): string {
  const [value] = cursorJsonSchema.parse(
    JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
  );
  return Buffer.from(JSON.stringify([{ ...value, ...patch }])).toString('base64url');
}

const deviceRowSchema = z.object({
  last_sync_at: z.date().nullable(),
  version: z.number(),
  created_at: z.date(),
  updated_at: z.date(),
});
async function deviceRow(id: string) {
  const [row] = z
    .array(deviceRowSchema)
    .parse(
      await sql`SELECT last_sync_at, version, created_at, updated_at FROM devices WHERE id = ${id}`,
    );
  if (!row) throw new Error(`no device ${id}`);
  return row;
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
    companyName: 'Meghna Distributors',
    workspaceSlug: 'meghna-distributors',
    fullName: 'Shafiq Ahmed',
    email: 'shafiq@meghnadistributors.com',
    password: 'Narsingdi-depot-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  const [tenant] = z
    .array(z.object({ id: z.uuid() }))
    .parse(await sql`SELECT id FROM tenants WHERE slug = 'meghna-distributors'`);
  if (!tenant) throw new Error('no tenant');
  tenantId = tenant.id;

  await signUp(app, {
    companyName: 'Rafiq Traders',
    workspaceSlug: 'rafiq-traders',
    fullName: 'Rafiq Islam',
    email: 'rafiq@meghnadistributors.com',
    password: 'Bhairab-route-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'rafiq@meghnadistributors.com',
    workspace: 'meghna-distributors',
  });
  rafiq = await logIn(app, {
    workspace: 'meghna-distributors',
    email: 'rafiq@meghnadistributors.com',
    password: 'Bhairab-route-2026',
    keepSignedIn: false,
  });

  // The branches: sign-up made the head office (Narsingdi)
  const [head] = z
    .object({ items: z.array(branchSchema) })
    .parse((await send('GET', '/branches')).json()).items;
  if (!head) throw new Error('no branch');
  narsingdi = head;
  chattogram = await created(branchSchema, '/branches', {
    code: 'CTG',
    name: 'Chattogram depot',
    phone: '',
    address: 'Agrabad, Chattogram',
  });

  // Narsingdi keeps the store sign-up made and an old store it no longer uses; Chattogram has its
  // own depot
  const [main] = warehouseListSchema
    .parse((await send('GET', '/warehouses')).json())
    .items.filter((warehouse) => warehouse.code === 'MAIN');
  if (!main) throw new Error('no MAIN warehouse');
  depot = main;
  oldStore = await addWarehouse(narsingdi, 'NRS2', 'Old store');
  oldStore = await flip(warehouseSchema, `/warehouses/${oldStore.id}`, oldStore, 'archive');
  ctgDepot = await addWarehouse(chattogram, 'CTG1', 'Chattogram depot');

  // Products: juice sold by the piece and the case of 24, soap in two scents with batches, and
  // a glass cleaner no longer sold
  juice = await addProduct('Mango juice 250 ml', {
    variants: [variant([], '25')],
    units: [{ unitId: unitId('case'), factor: '24', barcode: '8901234567890' }],
  });
  soap = await addProduct('Beauty soap 100 g', {
    tracking: 'batch',
    hasExpiry: true,
    options: [{ name: 'Scent', values: ['Lemon', 'Rose'] }],
    variants: [variant(['Lemon'], '45'), variant(['Rose'], '45')],
  });
  cleaner = await addProduct('Glass cleaner 500 ml', { variants: [variant([], '120')] });

  // Prices: Dealer is used; Retail was archived, with its prices
  dealer = await created(priceListSchema, '/price-lists', { name: 'Dealer', description: '' });
  retail = await created(priceListSchema, '/price-lists', { name: 'Retail', description: '' });
  await setPrices(dealer, [
    [variantId(juice), unitId('pcs'), '22'],
    [variantId(juice), unitId('case'), '500'],
    [variantId(soap), unitId('pcs'), '40'],
    [variantId(cleaner), unitId('pcs'), '110'],
  ]);
  await setPrices(retail, [[variantId(juice), unitId('pcs'), '25']]);
  retail = await flip(priceListSchema, `/price-lists/${retail.id}`, retail, 'archive');
  cleaner = await flip(productSchema, `/products/${cleaner.id}`, cleaner, 'archive');

  // Customers: two shops; a packaging supplier that is not a customer; a shop that closed
  karim = await created(
    customerSchema,
    '/customers',
    customerForm('Karim Store', { priceListId: dealer.id }),
  );
  rahim = await created(customerSchema, '/customers', customerForm('Rahim Traders'));
  await created(supplierSchema, '/suppliers', {
    code: '',
    name: 'Padma Packaging',
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 0,
    address: '',
    bankAccounts: [],
    notes: '',
  });
  const closed = await created(customerSchema, '/customers', customerForm('Shapla Store'));
  await flip(customerSchema, `/customers/${closed.id}`, closed, 'archive');

  // Stock: juice and a batch of lemon soap in Narsingdi, nothing left of rose, cleaner that is
  // still on a shelf, and Chattogram's own juice
  const [batch] = z.array(z.object({ id: z.uuid() })).parse(
    await sql`
      INSERT INTO batches (id, tenant_id, product_id, variant_id, lot_number, expires_on)
      VALUES (gen_random_uuid(), ${tenantId}, ${soap.id}, ${variantId(soap)}, 'NP24117', '2027-06-30')
      RETURNING id`,
  );
  if (!batch) throw new Error('no batch');
  soapBatch = batch.id;
  await putStock(depot, juice, variantId(juice), '120');
  await putStock(depot, soap, variantId(soap), '72', soapBatch);
  await putStock(depot, soap, variantId(soap, 1), '0');
  await putStock(depot, cleaner, variantId(cleaner), '6');
  await putStock(ctgDepot, juice, variantId(juice), '480');

  counter = await newDevice('Counter 1', narsingdi);
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('registering a device', () => {
  const auditCount = async (id: string) => {
    const [row] = z.array(z.object({ n: z.number() })).parse(
      await sql`SELECT count(*)::int AS n FROM audit_logs
                 WHERE entity_id = ${id} AND action = 'device.registered'`,
    );
    return row?.n;
  };

  it('returns the same device when the browser registers it again', async () => {
    const id = v7();
    const first = await register({ id, name: 'Chrome on Windows', branchId: narsingdi.id });
    expect(first.statusCode, first.body).toBe(201);
    expect(deviceSchema.parse(first.json())).toMatchObject({
      id,
      name: 'Chrome on Windows',
      branchId: narsingdi.id,
      lastSyncAt: null,
      revokedAt: null,
      version: 1,
    });

    // A retry may send another name or branch: the device stays as it was (18c renames and moves)
    const again = await register({ id, name: 'Counter 2', branchId: chattogram.id });
    expect(again.statusCode).toBe(201);
    expect(deviceSchema.parse(again.json())).toEqual(deviceSchema.parse(first.json()));
    expect(await auditCount(id)).toBe(1);
  });

  it('registers once when two requests for the same id arrive together', async () => {
    const id = v7();
    const input = { id, name: 'Chrome on Android', branchId: narsingdi.id };
    const [one, two] = await Promise.all([register(input), register(input)]);
    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
    expect(deviceSchema.parse(one.json())).toEqual(deviceSchema.parse(two.json()));
    expect(await auditCount(id)).toBe(1);
  });

  it('refuses an id that is not a UUIDv7, a short name, and a branch that is not active', async () => {
    const v4 = await register({
      id: randomUUID(),
      name: 'Chrome on Windows',
      branchId: narsingdi.id,
    });
    expect(v4.statusCode).toBe(400);
    expect(problemOf(v4).fieldErrors).toEqual({ id: ['device_id_invalid'] });

    const short = await register({ id: v7(), name: ' X ', branchId: '' });
    expect(short.statusCode).toBe(400);
    expect(problemOf(short).fieldErrors).toEqual({
      name: ['device_name_required'],
      branchId: ['device_branch_invalid'],
    });

    const unknown = await register({ id: v7(), name: 'Chrome on Windows', branchId: v7() });
    expect(unknown.statusCode).toBe(409);
    expect(problemOf(unknown)).toMatchObject({
      code: 'device_branch_invalid',
      fieldErrors: { branchId: ['device_branch_invalid'] },
    });

    const bogura = await created(branchSchema, '/branches', {
      code: 'BOG',
      name: 'Bogura depot',
      phone: '',
      address: '',
    });
    await flip(branchSchema, `/branches/${bogura.id}`, bogura, 'archive');
    const archived = await register({ id: v7(), name: 'Chrome on Windows', branchId: bogura.id });
    expect(problemOf(archived).code).toBe('device_branch_invalid');
  });

  it("keeps a person's device their own", async () => {
    // Rafiq signs in on the counter's browser: the counter's id is not his to use
    const taken = await register(
      { id: counter.id, name: 'Chrome on Windows', branchId: narsingdi.id },
      rafiq,
    );
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken).code).toBe('device_id_invalid');
    const pulled = await pullPage(counter.id, undefined, 10, rafiq);
    expect(pulled.statusCode).toBe(404);
    expect(problemOf(pulled).code).toBe('device_not_found');

    // His own device works, with no role at all
    const his = await newDevice('Rafiq on Android', narsingdi, rafiq);
    expect((await pullPage(his.id, undefined, 10, rafiq)).statusCode).toBe(200);
    const unknown = await pullPage(v7(), undefined, 10);
    expect(problemOf(unknown).code).toBe('device_not_found');
  });

  it('stops a revoked device, and checks the protocol before the device', async () => {
    const lost = await newDevice('Lost phone', narsingdi);
    // The superuser revokes it, as its own person: migration 0048 refuses a revoke that names
    // nobody. 18c's revoke route has tests of its own (devices.int.spec.ts).
    await sql`UPDATE devices SET revoked_at = now(), revoked_by = user_id WHERE id = ${lost.id}`;
    const pulled = await pullPage(lost.id, undefined, 10);
    expect(pulled.statusCode).toBe(403);
    expect(problemOf(pulled).code).toBe('device_revoked');
    // Registering it again does not bring it back: the app sees revokedAt and wipes its data
    const again = await register({ id: lost.id, name: 'Lost phone', branchId: narsingdi.id });
    expect(deviceSchema.parse(again.json()).revokedAt).not.toBeNull();

    const old = await send('GET', `/sync/pull?deviceId=${lost.id}&protocol=2`);
    expect(old.statusCode).toBe(409);
    expect(problemOf(old).code).toBe('sync_protocol_mismatch');
  });
});

describe('a full pull', () => {
  it('sends every row the device keeps, and nothing else', async () => {
    const { pages, changes } = await pullAll(counter, undefined, 1000);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ full: true, hasMore: false });
    expect(changes.every((change) => change.op === 'upsert')).toBe(true);

    // Entity after entity, in the contract's order: what a row points at comes before it
    const order = changes.map((change) => SYNC_ENTITIES.indexOf(change.entity));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(changes.map((c) => `${c.entity}/${c.key}`)).size).toBe(changes.length);

    expect(keysOf(changes, 'settings')).toEqual([tenantId]);
    expect(changes.find((change) => change.entity === 'settings')).toMatchObject({
      data: { companyName: 'Meghna Distributors', allowNegativeStock: false },
    });
    expect(keysOf(changes, 'unit')).toHaveLength(units.length);
    // Only the active warehouses of the device's branch
    expect(keysOf(changes, 'warehouse')).toEqual([depot.id]);
    // Every price list, the archived one too: an old customer may still point at it
    expect(keysOf(changes, 'price_list')).toEqual([dealer.id, retail.id].sort());
    expect(keysOf(changes, 'product')).toEqual([juice.id, soap.id].sort());
    // Not the archived list's prices, nor the archived product's
    expect(keysOf(changes, 'price_list_item')).toEqual(
      [
        priceKey(dealer, variantId(juice), unitId('pcs')),
        priceKey(dealer, variantId(juice), unitId('case')),
        priceKey(dealer, variantId(soap), unitId('pcs')),
      ].sort(),
    );
    // The two shops: not the supplier, not the closed shop
    expect(keysOf(changes, 'customer')).toEqual([karim.id, rahim.id].sort());
    const karimRow = changes.find((change) => change.key === karim.id);
    expect(karimRow).toMatchObject({ data: { name: 'Karim Store', priceListId: dealer.id } });
    expect(karimRow?.op === 'upsert' && 'balance' in karimRow.data).toBe(false);
    // Narsingdi's stock: no zero row, no archived product, nothing from Chattogram
    expect(keysOf(changes, 'stock')).toEqual(
      [stockKey(depot, variantId(juice)), stockKey(depot, variantId(soap), soapBatch)].sort(),
    );
    expect(changes.find((change) => change.key.endsWith(soapBatch))).toMatchObject({
      data: { lotNumber: 'NP24117', expiresOn: '2027-06-30', quantity: '72.0000' },
    });
  });

  it('gives the same rows in pages of any size', async () => {
    const whole = (await pullAll(counter, undefined, 1000)).changes;
    // Limit 1 ends every page at the end of an entity at some point (nothing left for the next
    // one), the case of a page that is full before it starts a new entity
    for (const limit of [1, 2, 3, 5, 8]) {
      const { pages, changes } = await pullAll(counter, undefined, limit);
      expect(changes, `limit ${String(limit)}`).toEqual(whole);
      expect(pages.every((page) => page.full && page.changes.length <= limit)).toBe(true);
      expect(pages.slice(0, -1).every((page) => page.hasMore)).toBe(true);
    }
  });

  it('marks the device synced when the last page is served, without a new version', async () => {
    const tablet = await newDevice('Tablet', narsingdi);
    const first = syncPullSchema.parse((await pullPage(tablet.id, undefined, 2)).json());
    expect(first.hasMore).toBe(true);
    expect((await deviceRow(tablet.id)).last_sync_at).toBeNull();

    await pullAll(tablet, first.cursor);
    const row = await deviceRow(tablet.id);
    expect(row.last_sync_at).not.toBeNull();
    expect(row.version).toBe(1);
    expect(row.updated_at).toEqual(row.created_at);
  });
});

describe('a delta pull', () => {
  let cursor: string;

  beforeAll(async () => {
    cursor = (await pullAll(counter, undefined)).cursor;
  });

  // The next pull from the cursor kept by the last one
  async function changesSince() {
    const pulled = await pullAll(counter, cursor);
    expect(pulled.pages.every((page) => !page.full)).toBe(true);
    cursor = pulled.cursor;
    return pulled.changes;
  }

  it('is empty when nothing changed', async () => {
    expect(await changesSince()).toEqual([]);
  });

  it('sends a changed price, and the prices of a list archived or restored', async () => {
    await setPrices(dealer, [[variantId(juice), unitId('pcs'), '23']]);
    expect(await changesSince()).toMatchObject([
      {
        op: 'upsert',
        key: priceKey(dealer, variantId(juice), unitId('pcs')),
        data: { price: '23.0000' },
      },
    ]);

    dealer = await flip(priceListSchema, `/price-lists/${dealer.id}`, dealer, 'archive');
    const archived = await changesSince();
    expect(keysOf(archived, 'price_list')).toEqual([dealer.id]);
    // The archived cleaner's price too: the log names every price of the list, and the device
    // gets a delete for a key it never had, which changes nothing there
    const cleanerPrice = priceKey(dealer, variantId(cleaner), unitId('pcs'));
    expect(keysOf(archived, 'price_list_item', 'delete')).toHaveLength(4);
    expect(keysOf(archived, 'price_list_item', 'delete')).toContain(cleanerPrice);

    dealer = await flip(priceListSchema, `/price-lists/${dealer.id}`, dealer, 'restore');
    const restored = await changesSince();
    expect(keysOf(restored, 'price_list_item')).toHaveLength(3);
    expect(keysOf(restored, 'price_list_item', 'delete')).toEqual([cleanerPrice]);
  });

  it('sends an archived product as a delete, with its prices and its stock', async () => {
    soap = await flip(productSchema, `/products/${soap.id}`, soap, 'archive');
    expect(await changesSince()).toEqual(
      expect.arrayContaining([
        { op: 'delete', entity: 'product', key: soap.id },
        {
          op: 'delete',
          entity: 'price_list_item',
          key: priceKey(dealer, variantId(soap), unitId('pcs')),
        },
        { op: 'delete', entity: 'stock', key: stockKey(depot, variantId(soap), soapBatch) },
      ]),
    );

    soap = await flip(productSchema, `/products/${soap.id}`, soap, 'restore');
    const back = await changesSince();
    expect(keysOf(back, 'product')).toEqual([soap.id]);
    expect(keysOf(back, 'price_list_item')).toEqual([
      priceKey(dealer, variantId(soap), unitId('pcs')),
    ]);
    expect(keysOf(back, 'stock')).toEqual([stockKey(depot, variantId(soap), soapBatch)]);
  });

  it('follows customers in and out: archived, a supplier who buys, a customer deleted', async () => {
    rahim = await flip(customerSchema, `/customers/${rahim.id}`, rahim, 'archive');
    expect(await changesSince()).toEqual([{ op: 'delete', entity: 'customer', key: rahim.id }]);

    // The packaging supplier starts buying: the same party is a customer now
    const [padma] = z
      .array(z.object({ id: z.uuid(), version: z.number() }))
      .parse(await sql`SELECT id, version FROM parties WHERE name = 'Padma Packaging'`);
    if (!padma) throw new Error('no supplier');
    const made = await send('POST', `/suppliers/${padma.id}/make-customer`, {
      version: padma.version,
    });
    expect(made.statusCode, made.body).toBe(200);
    expect(keysOf(await changesSince(), 'customer')).toEqual([padma.id]);

    // ...and stops: it stays a supplier, but leaves the device. A shop added and deleted between
    // two pulls arrives as a delete of a key the device never had, which is harmless.
    const asCustomer = customerSchema.parse(made.json());
    const removed = await send(
      'DELETE',
      `/customers/${padma.id}?version=${String(asCustomer.version)}`,
    );
    expect(removed.statusCode, removed.body).toBe(204);
    const brief = await created(customerSchema, '/customers', customerForm('Bakul Store'));
    expect(
      (await send('DELETE', `/customers/${brief.id}?version=${String(brief.version)}`)).statusCode,
    ).toBe(204);
    expect(await changesSince()).toEqual(
      expect.arrayContaining([
        { op: 'delete', entity: 'customer', key: padma.id },
        { op: 'delete', entity: 'customer', key: brief.id },
      ]),
    );
  });

  it("sends this branch's stock as it moves, and never the other branch's", async () => {
    await putStock(depot, soap, variantId(soap), '60', soapBatch);
    await putStock(depot, juice, variantId(juice), '0');
    await putStock(ctgDepot, juice, variantId(juice), '456');
    const changes = await changesSince();
    expect(changes).toMatchObject([
      {
        op: 'upsert',
        key: stockKey(depot, variantId(soap), soapBatch),
        data: { quantity: '60.0000' },
      },
      { op: 'delete', entity: 'stock', key: stockKey(depot, variantId(juice)) },
    ]);

    // A new warehouse in Narsingdi comes to the device; the old store, emptied, goes
    const shop = await addWarehouse(narsingdi, 'NRS3', 'Narsingdi shop');
    oldStore = await flip(warehouseSchema, `/warehouses/${oldStore.id}`, oldStore, 'restore');
    expect(keysOf(await changesSince(), 'warehouse')).toEqual([shop.id, oldStore.id].sort());
    oldStore = await flip(warehouseSchema, `/warehouses/${oldStore.id}`, oldStore, 'archive');
    expect(await changesSince()).toEqual([{ op: 'delete', entity: 'warehouse', key: oldStore.id }]);
  });

  it('keeps a pull in progress to where it started', async () => {
    await setPrices(dealer, [[variantId(juice), unitId('pcs'), '24']]);
    await setPrices(dealer, [[variantId(juice), unitId('case'), '520']]);
    await setPrices(dealer, [[variantId(soap), unitId('pcs'), '42']]);
    const first = syncPullSchema.parse((await pullPage(counter.id, cursor, 1)).json());
    expect(first.hasMore).toBe(true);

    // Made while the pull runs: it waits for the next pull, so a busy workspace cannot keep a
    // pull going for ever
    await renameCompany('Meghna Distributors Ltd.');
    const rest = await pullAll(counter, first.cursor, 1);
    const pulled = [...first.changes, ...rest.changes];
    expect(keysOf(pulled, 'price_list_item')).toHaveLength(3);
    expect(keysOf(pulled, 'settings')).toEqual([]);

    cursor = rest.cursor;
    expect(await changesSince()).toMatchObject([
      { entity: 'settings', data: { companyName: 'Meghna Distributors Ltd.' } },
    ]);
  });

  it('starts a full pull again when the cursor is too old, or the device moved branch', async () => {
    const { serverTime } = syncPullSchema.parse((await pullPage(counter.id, cursor, 10)).json());
    const daysBefore = (days: number) =>
      new Date(Date.parse(serverTime) - days * 24 * 60 * 60 * 1000).toISOString();

    // 28 days: the log still has every line since. 30 days: it may not.
    const recent = await pullPage(counter.id, editCursor(cursor, { issuedAt: daysBefore(28) }), 10);
    expect(syncPullSchema.parse(recent.json()).full).toBe(false);
    const aged = await pullPage(counter.id, editCursor(cursor, { issuedAt: daysBefore(30) }), 10);
    expect(syncPullSchema.parse(aged.json()).full).toBe(true);
    const otherProtocol = await pullPage(counter.id, editCursor(cursor, { protocol: 0 }), 10);
    expect(syncPullSchema.parse(otherProtocol.json()).full).toBe(true);

    // Step 18c moves a device from the device list; until then, the superuser
    await sql`UPDATE devices SET branch_id = ${chattogram.id} WHERE id = ${counter.id}`;
    const moved = await pullAll(counter, cursor);
    expect(moved.pages[0]?.full).toBe(true);
    expect(keysOf(moved.changes, 'warehouse')).toEqual([ctgDepot.id]);
    expect(moved.changes.find((change) => change.entity === 'stock')).toMatchObject({
      key: stockKey(ctgDepot, variantId(juice)),
      data: { quantity: '456.0000' },
    });
    await sql`UPDATE devices SET branch_id = ${narsingdi.id} WHERE id = ${counter.id}`;
    cursor = (await pullAll(counter, undefined)).cursor;
  });

  it('refuses a cursor it did not make', async () => {
    const broken = [
      'abc',
      editCursor(cursor, { from: '1; DROP TABLE devices' }),
      editCursor(cursor, { kind: 'full', watermark: '1', entity: 99 }),
      editCursor(cursor, { branchId: 'Narsingdi' }),
    ];
    for (const value of broken) {
      const res = await pullPage(counter.id, value, 10);
      expect(res.statusCode, value).toBe(400);
      expect(problemOf(res).code).toBe('invalid_cursor');
    }
  });
});

describe('the watermark', () => {
  it('holds back what committed after a transaction still open, until that one commits', async () => {
    let cursor = (await pullAll(counter, undefined)).cursor;
    const juicePrice = priceKey(dealer, variantId(juice), unitId('pcs'));
    const soapPrice = priceKey(dealer, variantId(soap), unitId('pcs'));

    // A slow save: its transaction has an id (it wrote), and it is still open
    const slow = await sql.reserve();
    let open = false;
    try {
      await slow`BEGIN`;
      open = true;
      await slow`UPDATE price_list_items SET price = 21
                  WHERE price_list_id = ${dealer.id} AND variant_id = ${variantId(juice)}
                    AND unit_id = ${unitId('pcs')}`;
      // A quick save after it, which commits first: a later transaction id
      await setPrices(dealer, [[variantId(soap), unitId('pcs'), '39']]);

      // The quick one's line is in the log, but the pull may not pass the slow one yet: once its
      // cursor moved past the quick one, the slow one's line (a lower id) would never be read
      const early = await pullAll(counter, cursor);
      expect(early.changes).toEqual([]);
      cursor = early.cursor;
      await slow`COMMIT`;
      open = false;
    } finally {
      // A failed check must not give the pool back a connection inside an open transaction: the
      // next statements on it would never commit
      if (open) await slow`ROLLBACK`;
      slow.release();
    }

    const late = await pullAll(counter, cursor);
    const prices = late.changes.map((change) =>
      change.op === 'upsert' && change.entity === 'price_list_item'
        ? [change.key, change.data.price]
        : [change.key],
    );
    expect(prices.sort()).toEqual(
      [
        [juicePrice, '21.0000'],
        [soapPrice, '39.0000'],
      ].sort(),
    );
  });
});

describe('the change log', () => {
  it('keeps 30 days: the worker deletes the older lines', async () => {
    const lineCount = async () => {
      const [row] = z
        .array(z.object({ n: z.number() }))
        .parse(await sql`SELECT count(*)::int AS n FROM sync_changes`);
      return row?.n ?? 0;
    };
    const before = await lineCount();
    await sql`UPDATE sync_changes SET created_at = now() - interval '31 days'
               WHERE id IN (SELECT id FROM sync_changes ORDER BY id LIMIT 5)`;
    await sql`UPDATE sync_changes SET created_at = now() - interval '29 days'
               WHERE id IN (SELECT id FROM sync_changes ORDER BY id OFFSET 5 LIMIT 5)`;

    expect(await worker.get(SyncLogCleanup).deleteOld()).toBe(5);
    expect(await lineCount()).toBe(before - 5);
    expect(await worker.get(SyncLogCleanup).deleteOld()).toBe(0);
  });
});
