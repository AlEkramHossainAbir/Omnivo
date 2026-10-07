import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  accountListSchema,
  problemSchema,
  type Product,
  productSchema,
  setupSchema,
  type StockAdjustment,
  stockAdjustmentSchema,
  stockCardSchema,
  stockAccountsSchema,
  stockPageSchema,
  type StockRevaluation,
  stockRevaluationSchema,
  type StockTransfer,
  stockTransferSchema,
  stockValuePageSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
} from '@omnivo/contracts';
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
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// Two workspaces with stock: A must never see, use or change B's warehouses, stock, batches,
// adjustments or transfers. Every answer is 404, or the same "pick one from the list" as for an id
// that does not exist — never a hint that it does.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let unitsOfA: Unit[];
let unitsOfB: Unit[];
let mainOfA: Warehouse;
let mainOfB: Warehouse;
let productOfA: Product;
let productOfB: Product;
let adjustmentOfB: StockAdjustment;
let transferOfB: StockTransfer;
let revaluationOfB: StockRevaluation;

function as(
  who: SignedIn,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload && { payload }),
  });
}

function pcsOf(units: Unit[]): string {
  const pcs = units.find((unit) => unit.code === 'pcs');
  if (!pcs) throw new Error('no pcs');
  return pcs.id;
}

async function setUp(who: SignedIn): Promise<{ units: Unit[]; main: Warehouse }> {
  expect((await as(who, 'POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
  const units = unitListSchema.parse((await as(who, 'GET', '/units')).json()).items;
  const [main] = warehouseListSchema.parse((await as(who, 'GET', '/warehouses')).json()).items;
  if (!main) throw new Error('no warehouse');
  return { units, main };
}

async function productIn(who: SignedIn, units: Unit[], name: string): Promise<Product> {
  const res = await as(who, 'POST', '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcsOf(units),
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'batch',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
  });
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error('no variant');
  return variant.id;
}

function stockIn(warehouseId: string, variantId: string, unitId: string) {
  return {
    date: '2026-10-01',
    warehouseId,
    direction: 'in',
    reason: 'opening',
    note: '',
    lines: [
      {
        variantId,
        unitId,
        quantity: '10',
        batchId: '',
        lotNumber: 'LOT-1',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
        unitCost: '95',
      },
    ],
    post: true,
  };
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
  tenantA = await signUp(app, {
    companyName: 'Agora Mart',
    workspaceSlug: 'agora-mart',
    fullName: 'Abir Hossain',
    email: 'abir@agoramart.com',
    password: 'Shelf-scan-2026',
  });
  tenantB = await signUp(app, {
    companyName: 'Bazar Point',
    workspaceSlug: 'bazar-point',
    fullName: 'Bithi Rahman',
    email: 'bithi@bazarpoint.com',
    password: 'Counter-two-2026',
  });
  ({ units: unitsOfA, main: mainOfA } = await setUp(tenantA));
  ({ units: unitsOfB, main: mainOfB } = await setUp(tenantB));
  productOfA = await productIn(tenantA, unitsOfA, 'Teer Soybean Oil 1 l');
  productOfB = await productIn(tenantB, unitsOfB, 'Rupchanda Soybean Oil 5 l');

  const adjustment = await as(
    tenantB,
    'POST',
    '/stock-adjustments',
    stockIn(mainOfB.id, variantOf(productOfB), pcsOf(unitsOfB)),
  );
  expect(adjustment.statusCode, adjustment.body).toBe(201);
  adjustmentOfB = stockAdjustmentSchema.parse(adjustment.json());

  const store = await as(tenantB, 'POST', '/warehouses', {
    branchId: mainOfB.branchId,
    code: 'BACK',
    name: 'Back room',
    address: '',
  });
  const backOfB = warehouseSchema.parse(store.json());
  const transfer = await as(tenantB, 'POST', '/stock-transfers', {
    fromWarehouseId: mainOfB.id,
    toWarehouseId: backOfB.id,
    date: '2026-10-02',
    note: '',
    lines: [
      {
        variantId: variantOf(productOfB),
        unitId: pcsOf(unitsOfB),
        quantity: '1',
        batchId: adjustmentOfB.lines[0]?.batchId ?? '',
        serialNumbers: [],
      },
    ],
    send: false,
  });
  expect(transfer.statusCode, transfer.body).toBe(201);
  transferOfB = stockTransferSchema.parse(transfer.json());

  const revaluation = await as(tenantB, 'POST', '/stock-revaluations', {
    date: '2026-10-02',
    note: '',
    lines: [{ variantId: variantOf(productOfB), unitCost: '99' }],
  });
  expect(revaluation.statusCode, revaluation.body).toBe(201);
  revaluationOfB = stockRevaluationSchema.parse(revaluation.json());
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('stock across workspaces', () => {
  it("does not list or open B's stock", async () => {
    const page = stockPageSchema.parse(
      (await as(tenantA, 'GET', '/stock?search=rupchanda')).json(),
    );
    expect(page.items).toEqual([]);
    expect((await as(tenantA, 'GET', `/stock/variants/${variantOf(productOfB)}`)).statusCode).toBe(
      404,
    );
    expect(
      (await as(tenantA, 'GET', `/stock/variants/${variantOf(productOfB)}/movements`)).statusCode,
    ).toBe(404);
    expect((await as(tenantA, 'GET', `/stock-adjustments/${adjustmentOfB.id}`)).statusCode).toBe(
      404,
    );
    expect((await as(tenantA, 'GET', `/stock-transfers/${transferOfB.id}`)).statusCode).toBe(404);
    const warehouses = warehouseListSchema.parse((await as(tenantA, 'GET', '/warehouses')).json());
    expect(warehouses.items.map((warehouse) => warehouse.id)).toEqual([mainOfA.id]);
  });

  it("cannot move stock in B's warehouse or of B's product", async () => {
    const intoB = await as(
      tenantA,
      'POST',
      '/stock-adjustments',
      stockIn(mainOfB.id, variantOf(productOfA), pcsOf(unitsOfA)),
    );
    expect(problemSchema.parse(intoB.json()).fieldErrors).toEqual({
      warehouseId: ['stock_warehouse_invalid'],
    });
    const ofB = await as(
      tenantA,
      'POST',
      '/stock-adjustments',
      stockIn(mainOfA.id, variantOf(productOfB), pcsOf(unitsOfB)),
    );
    expect(problemSchema.parse(ofB.json()).fieldErrors).toEqual({
      'lines.0.variantId': ['stock_variant_invalid'],
    });
  });

  it("cannot take from B's batch", async () => {
    await as(
      tenantA,
      'POST',
      '/stock-adjustments',
      stockIn(mainOfA.id, variantOf(productOfA), pcsOf(unitsOfA)),
    );
    const res = await as(tenantA, 'POST', '/stock-adjustments', {
      ...stockIn(mainOfA.id, variantOf(productOfA), pcsOf(unitsOfA)),
      direction: 'out',
      reason: 'damaged',
      lines: [
        {
          variantId: variantOf(productOfA),
          unitId: pcsOf(unitsOfA),
          quantity: '1',
          batchId: adjustmentOfB.lines[0]?.batchId ?? '',
          lotNumber: '',
          expiresOn: '',
          manufacturedOn: '',
          serialNumbers: [],
        },
      ],
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      'lines.0.batchId': ['stock_batch_invalid'],
    });
  });

  it("cannot change B's warehouse, transfer or reorder levels", async () => {
    expect(
      (
        await as(tenantA, 'PUT', `/warehouses/${mainOfB.id}`, {
          branchId: mainOfA.branchId,
          code: 'MAIN',
          name: 'Taken over',
          address: '',
          version: mainOfB.version,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await as(tenantA, 'POST', `/stock-transfers/${transferOfB.id}/send`, {
          version: transferOfB.version,
        })
      ).statusCode,
    ).toBe(404);
    const level = await as(tenantA, 'PUT', '/stock/reorder-levels', {
      warehouseId: mainOfA.id,
      variantId: variantOf(productOfB),
      minQuantity: '5',
      reorderQuantity: '',
    });
    expect(problemSchema.parse(level.json()).code).toBe('stock_variant_invalid');
    // B's own stock is untouched by all of it
    const card = stockCardSchema.parse(
      (await as(tenantB, 'GET', `/stock/variants/${variantOf(productOfB)}`)).json(),
    );
    expect(card.item.onHand).toBe('10.0000');
  });
});

// Step 14: values, revaluations and the stock accounts are as private as the stock itself
describe('stock values across workspaces', () => {
  it("does not value or revalue B's stock", async () => {
    const page = stockValuePageSchema.parse(
      (await as(tenantA, 'GET', '/stock/valuation?search=rupchanda')).json(),
    );
    expect(page.items).toEqual([]);
    expect((await as(tenantA, 'GET', `/stock-revaluations/${revaluationOfB.id}`)).statusCode).toBe(
      404,
    );
    const res = await as(tenantA, 'POST', '/stock-revaluations', {
      date: '2026-10-02',
      note: '',
      lines: [{ variantId: variantOf(productOfB), unitCost: '1' }],
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      'lines.0.variantId': ['stock_variant_invalid'],
    });
  });

  it("cannot point a stock account at one of B's accounts", async () => {
    const choices = stockAccountsSchema.parse((await as(tenantA, 'GET', '/stock-accounts')).json());
    const accountsOfB = accountListSchema.parse((await as(tenantB, 'GET', '/accounts')).json());
    const lossOfB = accountsOfB.items.find((account) => account.code === '5340');
    if (!lossOfB) throw new Error('B has no 5340');
    const res = await as(tenantA, 'PUT', '/stock-accounts', {
      ...Object.fromEntries(Object.entries(choices).map(([use, id]) => [use, id ?? ''])),
      damaged: lossOfB.id,
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      damaged: ['stock_account_invalid'],
    });
    // B's value is untouched: its revaluation still stands
    const card = stockCardSchema.parse(
      (await as(tenantB, 'GET', `/stock/variants/${variantOf(productOfB)}`)).json(),
    );
    expect(card.item).toMatchObject({ unitCost: '99.0000', value: '990.0000' });
  });
});
