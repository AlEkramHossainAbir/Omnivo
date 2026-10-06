import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  batchStockPageSchema,
  notificationPageSchema,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  reorderPageSchema,
  type Settings,
  settingsSchema,
  setupSchema,
  stockAdjustmentPageSchema,
  stockAdjustmentSchema,
  type StockAdjustmentFormValues,
  stockCardSchema,
  stockMovementPageSchema,
  stockPageSchema,
  stockTransferSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

// One distributor's stock, from the first opening count to a truck that arrived short: juice in
// cartons of 24 (untracked), Napa in batches with expiry dates, and phones by IMEI.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// A member with no role at all: reads stock, changes nothing
let viewer: SignedIn;
let units: Unit[];
let main: Warehouse;
let depot: Warehouse;
let juice: Product;
let napa: Product;
let phone: Product;

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

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function product(name: string, extra: Partial<ProductFormValues>): Promise<Product> {
  const res = await send('POST', '/products', {
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
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

// What the adjustment form sends for one line; each test changes a few fields. Every item costs
// ৳10 a unit here (step 14: stock that comes in needs a cost); an "out" line ignores it.
function line(variantId: string, quantity: string, extra: object = {}) {
  return {
    variantId,
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost: '10',
    ...extra,
  };
}

function adjustment(
  direction: 'in' | 'out',
  lines: object[],
  extra: Partial<StockAdjustmentFormValues> = {},
) {
  return {
    date: '2026-10-01',
    warehouseId: main.id,
    direction,
    reason: direction === 'in' ? 'opening' : 'damaged',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

// What the settings page sends: every field of the form, the version it was opened with
function settingsForm(settings: Settings) {
  return {
    version: settings.version,
    companyName: settings.companyName,
    legalName: settings.legalName ?? '',
    bin: settings.bin ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    address: settings.address ?? '',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
    allowNegativeStock: settings.allowNegativeStock,
  };
}

async function posted(body: object) {
  const res = await send('POST', '/stock-adjustments', body);
  expect(res.statusCode, res.body).toBe(201);
  return stockAdjustmentSchema.parse(res.json());
}

async function cardOf(variantId: string) {
  const res = await send('GET', `/stock/variants/${variantId}`);
  expect(res.statusCode, res.body).toBe(200);
  return stockCardSchema.parse(res.json());
}

function onHandIn(card: Awaited<ReturnType<typeof cardOf>>, warehouseId: string): string {
  return card.warehouses.find((place) => place.warehouseId === warehouseId)?.onHand ?? 'missing';
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
    companyName: 'Meghna Distribution',
    workspaceSlug: 'meghna-distribution',
    fullName: 'Tanvir Hasan',
    email: 'tanvir@meghnadist.com',
    password: 'Depot-truck-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;

  const { items } = warehouseListSchema.parse((await send('GET', '/warehouses')).json());
  const first = items[0];
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;

  juice = await product('Pran Mango Juice 250 ml', {
    units: [{ unitId: unitId('case'), factor: '24', barcode: '' }],
  });
  napa = await product('Napa 500 mg', { tracking: 'batch', hasExpiry: true });
  phone = await product('Walton Primo H10', { tracking: 'serial' });

  await signUp(app, {
    companyName: 'Rina Store',
    workspaceSlug: 'rina-store',
    fullName: 'Rina Akter',
    email: 'rina@meghnadist.com',
    password: 'Counter-cash-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'rina@meghnadist.com',
    workspace: 'meghna-distribution',
  });
  viewer = await logIn(app, {
    workspace: 'meghna-distribution',
    email: 'rina@meghnadist.com',
    password: 'Counter-cash-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('warehouses', () => {
  it('starts every workspace with a Main store in its head office', () => {
    expect(main).toMatchObject({ code: 'MAIN', name: 'Main store', archivedAt: null });
  });

  it('adds a depot, and refuses a code that is taken', async () => {
    const res = await send('POST', '/warehouses', {
      branchId: main.branchId,
      code: 'depot',
      name: 'Chattogram depot',
      address: 'Sagorika Road, Pahartali',
    });
    expect(res.statusCode, res.body).toBe(201);
    depot = warehouseSchema.parse(res.json());
    // Upper-cased by the contract, like a branch code
    expect(depot.code).toBe('DEPOT');

    const twice = await send('POST', '/warehouses', {
      branchId: main.branchId,
      code: 'DEPOT',
      name: 'Another depot',
      address: '',
    });
    expect(twice.statusCode).toBe(409);
    expect(problemOf(twice).fieldErrors).toEqual({ code: ['warehouse_code_taken'] });
  });

  it('keeps a branch with active warehouses from being archived', async () => {
    const res = await send('POST', '/branches', {
      code: 'CTG',
      name: 'Chattogram',
      phone: '',
      address: '',
    });
    expect(res.statusCode, res.body).toBe(201);
    const branch = warehouseSchema.pick({ id: true, version: true }).parse(res.json());
    const store = await send('POST', '/warehouses', {
      branchId: branch.id,
      code: 'CTG',
      name: 'Chattogram store',
      address: '',
    });
    expect(store.statusCode).toBe(201);
    const archive = await send('POST', `/branches/${branch.id}/archive`, {
      version: branch.version,
    });
    expect(archive.statusCode).toBe(409);
    expect(problemOf(archive).code).toBe('branch_has_warehouses');
  });

  it('needs inventory.warehouse.manage to add one', async () => {
    const res = await send(
      'POST',
      '/warehouses',
      { branchId: main.branchId, code: 'BACK', name: 'Back room', address: '' },
      viewer,
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('stock adjustments', () => {
  it('posts the opening stock: 3 cases of juice are 72 pieces', async () => {
    const adjustment1 = await posted(
      adjustment('in', [line(variantOf(juice), '3', { unitId: unitId('case') })]),
    );
    expect(adjustment1).toMatchObject({ status: 'posted', direction: 'in', reason: 'opening' });
    expect(adjustment1.number).toMatch(/^ADJ-2026-27-0001$/);
    expect(adjustment1.lines[0]).toMatchObject({ quantity: '3.0000', baseQuantity: '72.0000' });

    const card = await cardOf(variantOf(juice));
    expect(card.item.onHand).toBe('72.0000');
    expect(onHandIn(card, main.id)).toBe('72.0000');
  });

  it('lets anyone read the stock list, and searches it', async () => {
    const res = await send('GET', '/stock?search=mango', undefined, viewer);
    expect(res.statusCode, res.body).toBe(200);
    const page = stockPageSchema.parse(res.json());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      productName: 'Pran Mango Juice 250 ml',
      onHand: '72.0000',
      units: [{ unitId: unitId('case'), factor: '24.000000' }],
    });
    // In stock only: the phone and Napa have none yet
    const inStock = stockPageSchema.parse((await send('GET', '/stock?filter=in_stock')).json());
    expect(inStock.items.map((item) => item.productName)).toEqual(['Pran Mango Juice 250 ml']);
  });

  it('needs inventory.stock.adjust to write one', async () => {
    const res = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(juice), '1')]),
      viewer,
    );
    expect(res.statusCode).toBe(403);
  });

  it('refuses a reason that goes the other way, and half a case', async () => {
    const wrongWay = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(juice), '1')], { reason: 'found' }),
    );
    expect(wrongWay.statusCode).toBe(400);
    expect(problemOf(wrongWay).fieldErrors).toEqual({ reason: ['adjustment_reason_direction'] });

    const half = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(juice), '1.5', { unitId: unitId('case') })]),
    );
    expect(half.statusCode).toBe(409);
    expect(problemOf(half).fieldErrors).toEqual({
      'lines.0.quantity': ['stock_quantity_decimals'],
    });
  });

  it('refuses to take more than is there, and uses no number for it', async () => {
    const res = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(juice), '80')]),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'lines.0.quantity': ['stock_insufficient'] });
    // Two lines of the same stock count together: 50 + 30 > 72
    const together = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(juice), '50'), line(variantOf(juice), '30')]),
    );
    expect(together.statusCode).toBe(409);
    expect(Object.keys(problemOf(together).fieldErrors ?? {})).toEqual([
      'lines.0.quantity',
      'lines.1.quantity',
    ]);

    const ok = await posted(adjustment('out', [line(variantOf(juice), '2')]));
    // The refused ones took no number: this is the second adjustment posted
    expect(ok.number).toBe('ADJ-2026-27-0002');
    expect((await cardOf(variantOf(juice))).item.onHand).toBe('70.0000');
  });

  it('keeps a draft until it is posted, and moves nothing before', async () => {
    const draft = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(juice), '5')], { post: false, reason: 'sample' }),
    );
    expect(draft.statusCode, draft.body).toBe(201);
    const saved = stockAdjustmentSchema.parse(draft.json());
    expect(saved).toMatchObject({ status: 'draft', number: null });
    expect((await cardOf(variantOf(juice))).item.onHand).toBe('70.0000');

    const edited = await send('PUT', `/stock-adjustments/${saved.id}`, {
      ...adjustment('out', [line(variantOf(juice), '4')], { post: false, reason: 'sample' }),
      version: saved.version,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const again = stockAdjustmentSchema.parse(edited.json());
    const post = await send('POST', `/stock-adjustments/${saved.id}/post`, {
      version: again.version,
    });
    expect(post.statusCode, post.body).toBe(200);
    expect(stockAdjustmentSchema.parse(post.json())).toMatchObject({
      status: 'posted',
      lineCount: 1,
    });
    expect((await cardOf(variantOf(juice))).item.onHand).toBe('66.0000');

    // Posted: no edit, no delete
    const remove = await send(
      'DELETE',
      `/stock-adjustments/${saved.id}?version=${String(again.version + 1)}`,
    );
    expect(remove.statusCode).toBe(409);
    expect(problemOf(remove).code).toBe('stock_not_draft');

    const list = stockAdjustmentPageSchema.parse((await send('GET', '/stock-adjustments')).json());
    expect(list.items.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a date in the future and a date in closed books', async () => {
    const future = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(juice), '1')], { date: '2099-01-01' }),
    );
    expect(future.statusCode).toBe(409);
    expect(problemOf(future).fieldErrors).toEqual({ date: ['stock_date_future'] });

    expect(
      (await send('PUT', '/period-lock', { lockDate: '2026-09-30', version: 0 })).statusCode,
    ).toBe(200);
    const locked = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(juice), '1')], { date: '2026-09-15' }),
    );
    expect(locked.statusCode).toBe(409);
    expect(problemOf(locked).code).toBe('journal_period_locked');
  });

  it('shows the history with a running balance', async () => {
    const res = await send('GET', `/stock/variants/${variantOf(juice)}/movements?limit=2`);
    expect(res.statusCode, res.body).toBe(200);
    const first = stockMovementPageSchema.parse(res.json());
    expect(first.items.map((row) => [row.quantity, row.balance])).toEqual([
      ['72.0000', '72.0000'],
      ['-2.0000', '70.0000'],
    ]);
    expect(first.items[0]?.documentNumber).toBe('ADJ-2026-27-0001');
    const next = stockMovementPageSchema.parse(
      (
        await send(
          'GET',
          `/stock/variants/${variantOf(juice)}/movements?limit=2&cursor=${first.nextCursor ?? ''}`,
        )
      ).json(),
    );
    // Page two goes on from where page one stopped
    expect(next.items[0]?.balance).toBe('66.0000');
    expect(next.closingBalance).toBe('66.0000');
  });
});

describe('batches and expiry', () => {
  it('brings Napa in by lot, and adds a later carton of the same lot to the same batch', async () => {
    await posted(
      adjustment('in', [
        line(variantOf(napa), '100', { lotNumber: 'NP24117', expiresOn: '2027-06-30' }),
        line(variantOf(napa), '50', { lotNumber: 'NP24090', expiresOn: '2027-01-31' }),
      ]),
    );
    await posted(
      adjustment('in', [line(variantOf(napa), '20', { lotNumber: 'np24117', expiresOn: '' })], {
        reason: 'found',
      }),
    );
    const card = await cardOf(variantOf(napa));
    // FEFO: the batch that expires first is on top
    expect(card.batches.map((batch) => [batch.lotNumber, batch.quantity])).toEqual([
      ['NP24090', '50.0000'],
      ['NP24117', '120.0000'],
    ]);
  });

  it('refuses a lot without its expiry, a second expiry for one lot, and an out line without a batch', async () => {
    const noExpiry = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(napa), '10', { lotNumber: 'NP25001' })]),
    );
    expect(problemOf(noExpiry).fieldErrors).toEqual({
      'lines.0.expiresOn': ['stock_expiry_required'],
    });

    const otherExpiry = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [
        line(variantOf(napa), '10', { lotNumber: 'NP24117', expiresOn: '2028-01-31' }),
      ]),
    );
    expect(problemOf(otherExpiry).fieldErrors).toEqual({
      'lines.0.expiresOn': ['stock_batch_expiry_mismatch'],
    });

    const noBatch = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(napa), '10')], { reason: 'expired' }),
    );
    expect(problemOf(noBatch).fieldErrors).toEqual({ 'lines.0.batchId': ['stock_batch_required'] });
  });

  it('takes from the batch named, never more than it holds', async () => {
    const card = await cardOf(variantOf(napa));
    const first = card.batches[0];
    if (!first) throw new Error('no batch');
    const tooMuch = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(napa), '60', { batchId: first.batchId })], {
        reason: 'expired',
      }),
    );
    expect(problemOf(tooMuch).fieldErrors).toEqual({ 'lines.0.quantity': ['stock_insufficient'] });
    await posted(
      adjustment('out', [line(variantOf(napa), '10', { batchId: first.batchId })], {
        reason: 'expired',
      }),
    );
    const report = batchStockPageSchema.parse((await send('GET', '/stock/batches')).json());
    expect(report.items.map((batch) => [batch.lotNumber, batch.quantity])).toEqual([
      ['NP24090', '40.0000'],
      ['NP24117', '120.0000'],
    ]);
  });
});

describe('serial numbers', () => {
  it('brings phones in by IMEI and keeps each one in one place', async () => {
    const count = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(phone), '2', { serialNumbers: ['356938035643809'] })]),
    );
    expect(problemOf(count).fieldErrors).toEqual({
      'lines.0.serialNumbers': ['stock_serial_count'],
    });

    await posted(
      adjustment('in', [
        line(variantOf(phone), '2', { serialNumbers: ['356938035643809', '356938035643817'] }),
      ]),
    );
    const again = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(phone), '1', { serialNumbers: ['356938035643809'] })]),
    );
    expect(problemOf(again).fieldErrors).toEqual({
      'lines.0.serialNumbers': ['stock_serial_in_stock'],
    });

    const elsewhere = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(phone), '1', { serialNumbers: ['356938035643809'] })], {
        warehouseId: depot.id,
        reason: 'lost',
      }),
    );
    expect(problemOf(elsewhere).fieldErrors).toEqual({
      'lines.0.serialNumbers': ['stock_serial_not_here'],
    });

    const card = await cardOf(variantOf(phone));
    expect(card.serials).toEqual([
      { serialNumber: '356938035643809', warehouseId: main.id },
      { serialNumber: '356938035643817', warehouseId: main.id },
    ]);
    // A scan of the IMEI finds the phone
    const found = stockPageSchema.parse(
      (await send('GET', '/stock?search=356938035643817')).json(),
    );
    expect(found.items.map((item) => item.productName)).toEqual(['Walton Primo H10']);
  });
});

describe('transfers', () => {
  it('sends juice to the depot, which receives it short', async () => {
    const create = await send('POST', '/stock-transfers', {
      fromWarehouseId: main.id,
      toWarehouseId: depot.id,
      date: '2026-10-02',
      note: 'Truck DM-TA 11-2233',
      lines: [
        {
          variantId: variantOf(juice),
          unitId: unitId('case'),
          quantity: '2',
          batchId: '',
          serialNumbers: [],
        },
        {
          variantId: variantOf(phone),
          unitId: unitId('pcs'),
          quantity: '1',
          batchId: '',
          serialNumbers: ['356938035643817'],
        },
      ],
      send: true,
    });
    expect(create.statusCode, create.body).toBe(201);
    const sent = stockTransferSchema.parse(create.json());
    expect(sent).toMatchObject({ status: 'in_transit', number: 'TRF-2026-27-0001' });

    // On the road: out of Main store, not yet in the depot
    const card = await cardOf(variantOf(juice));
    expect(onHandIn(card, main.id)).toBe('18.0000');
    expect(card.warehouses.find((place) => place.warehouseId === depot.id)).toMatchObject({
      onHand: '0.0000',
      inTransit: '48.0000',
    });
    expect((await cardOf(variantOf(phone))).serials).toContainEqual({
      serialNumber: '356938035643817',
      warehouseId: null,
    });

    const [juiceLine, phoneLine] = sent.lines;
    if (!juiceLine || !phoneLine) throw new Error('lines missing');
    const tooMany = await send('POST', `/stock-transfers/${sent.id}/receive`, {
      version: sent.version,
      date: '2026-10-03',
      lines: [
        { lineId: juiceLine.id, receivedQuantity: '50', serialNumbers: [] },
        { lineId: phoneLine.id, receivedQuantity: '1', serialNumbers: ['356938035643817'] },
      ],
    });
    expect(problemOf(tooMany).fieldErrors).toEqual({
      'lines.0.receivedQuantity': ['transfer_receive_too_many'],
    });
    const early = await send('POST', `/stock-transfers/${sent.id}/receive`, {
      version: sent.version,
      date: '2026-10-01',
      lines: [
        { lineId: juiceLine.id, receivedQuantity: '48', serialNumbers: [] },
        { lineId: phoneLine.id, receivedQuantity: '1', serialNumbers: ['356938035643817'] },
      ],
    });
    expect(problemOf(early).fieldErrors).toEqual({ date: ['transfer_receive_date'] });

    const receive = await send('POST', `/stock-transfers/${sent.id}/receive`, {
      version: sent.version,
      date: '2026-10-03',
      lines: [
        { lineId: juiceLine.id, receivedQuantity: '40', serialNumbers: [] },
        { lineId: phoneLine.id, receivedQuantity: '1', serialNumbers: ['356938035643817'] },
      ],
    });
    expect(receive.statusCode, receive.body).toBe(200);
    const received = stockTransferSchema.parse(receive.json());
    expect(received).toMatchObject({ status: 'received', short: true, receivedOn: '2026-10-03' });

    const after = await cardOf(variantOf(juice));
    expect(onHandIn(after, depot.id)).toBe('40.0000');
    expect(after.item.inTransit).toBe('0.0000');
    expect((await cardOf(variantOf(phone))).serials).toContainEqual({
      serialNumber: '356938035643817',
      warehouseId: depot.id,
    });

    const twice = await send('POST', `/stock-transfers/${sent.id}/receive`, {
      version: received.version,
      date: '2026-10-03',
      lines: [
        { lineId: juiceLine.id, receivedQuantity: '8', serialNumbers: [] },
        { lineId: phoneLine.id, receivedQuantity: '0', serialNumbers: [] },
      ],
    });
    expect(problemOf(twice).code).toBe('transfer_not_in_transit');
  });

  it('refuses a transfer to the same warehouse', async () => {
    const res = await send('POST', '/stock-transfers', {
      fromWarehouseId: main.id,
      toWarehouseId: main.id,
      date: '2026-10-02',
      note: '',
      lines: [
        {
          variantId: variantOf(juice),
          unitId: unitId('pcs'),
          quantity: '1',
          batchId: '',
          serialNumbers: [],
        },
      ],
      send: false,
    });
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({ toWarehouseId: ['transfer_same_warehouse'] });
  });

  it('lets only one of two people take the same last 30 pieces', async () => {
    // The depot has 40. One person writes 30 off, another sends 30 to Main store, at the same
    // moment. Two kinds of document on purpose: two adjustments would already queue on their
    // shared number series' counter, and never meet at the stock. To make "the same moment"
    // certain, a third connection holds the balance row until both requests wait for it; then
    // one takes the row, the other waits, sees 10 left and is refused under its line.
    const writeOff = () =>
      send(
        'POST',
        '/stock-adjustments',
        adjustment('out', [line(variantOf(juice), '30')], {
          warehouseId: depot.id,
          reason: 'lost',
        }),
      );
    const sendBack = () =>
      send('POST', '/stock-transfers', {
        fromWarehouseId: depot.id,
        toWarehouseId: main.id,
        date: '2026-10-04',
        note: '',
        lines: [
          {
            variantId: variantOf(juice),
            unitId: unitId('pcs'),
            quantity: '30',
            batchId: '',
            serialNumbers: [],
          },
        ],
        send: true,
      });
    const blocker = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
    const probe = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
    let answers: Awaited<ReturnType<typeof writeOff>>[] = [];
    try {
      let both: Promise<typeof answers> | undefined;
      await blocker.begin(async (sql) => {
        await sql`SELECT 1 FROM stock_balances
                   WHERE warehouse_id = ${depot.id} AND variant_id = ${variantOf(juice)} FOR UPDATE`;
        both = Promise.all([writeOff(), sendBack()]);
        await eventually(async () => {
          const [waiting] = await probe<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND datname = 'omnivo'`;
          expect(waiting?.n).toBe(2);
        });
      });
      answers = await (both ?? Promise.resolve([]));
    } finally {
      await Promise.all([blocker.end(), probe.end()]);
    }
    expect(answers.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    const refused = answers.find((res) => res.statusCode === 409);
    // Refused by the API's own check, under the line: not by the database's trigger, which
    // cannot say which line it was
    expect(refused && problemOf(refused).fieldErrors).toEqual({
      'lines.0.quantity': ['stock_insufficient'],
    });
    expect(onHandIn(await cardOf(variantOf(juice)), depot.id)).toBe('10.0000');
  });

  it('keeps a warehouse with stock from being archived', async () => {
    const res = await send('POST', `/warehouses/${depot.id}/archive`, { version: depot.version });
    expect(problemOf(res).code).toBe('warehouse_has_stock');
  });
});

describe('reorder levels', () => {
  it('rings the bell when a posting takes juice down to its level', async () => {
    const level = await send('PUT', '/stock/reorder-levels', {
      warehouseId: main.id,
      variantId: variantOf(juice),
      minQuantity: '12',
      reorderQuantity: '48',
    });
    expect(level.statusCode, level.body).toBe(200);

    // 18 → 10: below 12
    await posted(adjustment('out', [line(variantOf(juice), '8')]));
    const report = reorderPageSchema.parse((await send('GET', '/stock/reorder')).json());
    expect(report.items).toEqual([
      expect.objectContaining({
        productName: 'Pran Mango Juice 250 ml',
        warehouseId: main.id,
        onHand: '10.0000',
        minQuantity: '12.0000',
        reorderQuantity: '48.0000',
      }),
    ]);
    const low = stockPageSchema.parse(
      (await send('GET', `/stock?filter=low&warehouseId=${main.id}`)).json(),
    );
    expect(low.items.map((item) => item.productName)).toEqual(['Pran Mango Juice 250 ml']);

    await eventually(async () => {
      const page = notificationPageSchema.parse((await send('GET', '/notifications')).json());
      expect(page.items[0]).toMatchObject({
        type: 'stock.low',
        params: { warehouse: 'Main store', count: 1 },
      });
    });
  });
});

describe('negative stock', () => {
  it('is refused until the workspace allows it, and never for a batch', async () => {
    const on = await send('PUT', '/settings', {
      ...settingsForm(settingsSchema.parse((await send('GET', '/settings')).json())),
      allowNegativeStock: true,
    });
    expect(on.statusCode, on.body).toBe(200);

    // 10 left, 15 taken: −5 is allowed now for juice (untracked)
    await posted(adjustment('out', [line(variantOf(juice), '15')], { reason: 'lost' }));
    expect(onHandIn(await cardOf(variantOf(juice)), main.id)).toBe('-5.0000');

    const batch = (await cardOf(variantOf(napa))).batches[0];
    if (!batch) throw new Error('no batch');
    const napaOut = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(napa), '500', { batchId: batch.batchId })], {
        reason: 'lost',
      }),
    );
    expect(problemOf(napaOut).fieldErrors).toEqual({ 'lines.0.quantity': ['stock_insufficient'] });

    // Turned off again: stock still comes in to a warehouse below zero
    const off = await send('PUT', '/settings', {
      ...settingsForm(settingsSchema.parse((await send('GET', '/settings')).json())),
      allowNegativeStock: false,
    });
    expect(off.statusCode).toBe(200);
    await posted(adjustment('in', [line(variantOf(juice), '2')], { reason: 'found' }));
    expect(onHandIn(await cardOf(variantOf(juice)), main.id)).toBe('-3.0000');
  });
});

describe('a product with stock', () => {
  it('keeps its base unit and cannot be deleted', async () => {
    const current = productSchema.parse((await send('GET', `/products/${juice.id}`)).json());
    const res = await send('PUT', `/products/${juice.id}`, {
      code: current.code,
      name: current.name,
      type: 'goods',
      categoryId: '',
      description: '',
      baseUnitId: unitId('bottle'),
      salesUnitId: '',
      purchaseUnitId: '',
      tracking: 'none',
      hasExpiry: false,
      options: [],
      variants: current.variants.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        optionValues: [],
        barcode: '',
        salePrice: '',
        archived: false,
      })),
      units: [],
      customFields: {},
      version: current.version,
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ baseUnitId: ['product_base_unit_locked'] });

    const remove = await send('DELETE', `/products/${juice.id}?version=${String(current.version)}`);
    expect(remove.statusCode).toBe(409);
    expect(problemOf(remove).code).toBe('product_in_use');
  });
});

describe('the database itself', () => {
  it('never changes or deletes a movement', async () => {
    await expect(
      superuserSql((sql) => sql`UPDATE stock_movements SET quantity = 1000`),
    ).rejects.toThrow(/cannot be changed or deleted/);
    await expect(superuserSql((sql) => sql`DELETE FROM stock_movements`)).rejects.toThrow(
      /cannot be changed or deleted/,
    );
  });

  it('keeps every balance equal to the sum of its movements', async () => {
    const drift = await superuserSql(
      (sql) => sql`
        SELECT b.warehouse_id, b.variant_id, b.batch_id, b.quantity, m.total
          FROM stock_balances b
          LEFT JOIN LATERAL (
            SELECT coalesce(sum(quantity), 0) AS total FROM stock_movements m
             WHERE m.tenant_id = b.tenant_id AND m.warehouse_id = b.warehouse_id
               AND m.variant_id = b.variant_id AND m.batch_id IS NOT DISTINCT FROM b.batch_id
          ) m ON true
         WHERE b.quantity <> m.total`,
    );
    expect(drift).toEqual([]);
  });

  it('refuses a movement that takes a batch below zero, whoever writes it', async () => {
    await expect(
      superuserSql(async (sql) => {
        const [row] = await sql<
          {
            id: string;
            tenant_id: string;
            variant_id: string;
            product_id: string;
            warehouse_id: string;
            batch_id: string;
          }[]
        >`
          SELECT * FROM stock_balances WHERE batch_id IS NOT NULL LIMIT 1`;
        if (!row) throw new Error('no batch balance');
        await sql`INSERT INTO stock_movements (id, tenant_id, date, warehouse_id, product_id, variant_id,
                    batch_id, quantity, kind, document_id, document_number)
                  VALUES (gen_random_uuid(), ${row.tenant_id}, '2026-10-04', ${row.warehouse_id},
                    ${row.product_id}, ${row.variant_id}, ${row.batch_id}, -100000, 'adjustment',
                    gen_random_uuid(), 'X')`;
      }),
    ).rejects.toThrow(/would be/);
  });
});
