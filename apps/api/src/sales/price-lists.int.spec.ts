import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type PriceList,
  priceListItemPageSchema,
  priceListListSchema,
  priceListSchema,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  setupSchema,
  type Unit,
  unitListSchema,
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

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
let units: Unit[];
// Sold by the piece, the 6-pack and the 24-bottle case
let juice: Product;
// Two scents, by the piece and the 72-piece case
let soap: Product;
let dealer: PriceList;

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

function variantOf(product: Product, index = 0): string {
  const found = product.variants[index];
  if (!found) throw new Error(`no variant ${String(index)} of ${product.name}`);
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

async function addProduct(name: string, extra: Partial<ProductFormValues> = {}) {
  const res = await send('POST', '/products', productForm(name, extra));
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

async function list(): Promise<PriceList> {
  return priceListSchema.parse((await send('GET', `/price-lists/${dealer.id}`)).json());
}

async function items(query = '') {
  const res = await send('GET', `/price-lists/${dealer.id}/items?${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return priceListItemPageSchema.parse(res.json());
}

function setPrices(changes: { variantId: string; unitId: string; price: string }[]) {
  return send('PUT', `/price-lists/${dealer.id}/items`, { changes });
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
  juice = await addProduct('Mango juice 250 ml', {
    variants: [variant([], '25')],
    units: [
      { unitId: unitId('pack'), factor: '6', barcode: '' },
      { unitId: unitId('case'), factor: '24', barcode: '' },
    ],
  });
  soap = await addProduct('Beauty soap 100 g', {
    options: [{ name: 'Scent', values: ['Lemon', 'Rose'] }],
    variants: [variant(['Lemon'], '45'), variant(['Rose'], '45')],
    units: [{ unitId: unitId('case'), factor: '72', barcode: '' }],
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('price lists', () => {
  it('are added and renamed, each name once in any case', async () => {
    const res = await send('POST', '/price-lists', { name: 'Dealer', description: '' });
    expect(res.statusCode).toBe(201);
    dealer = priceListSchema.parse(res.json());
    expect(dealer).toMatchObject({ itemCount: 0, customerCount: 0, description: null });

    const same = await send('POST', '/price-lists', { name: 'DEALER', description: '' });
    expect(same.statusCode).toBe(409);
    expect(problemOf(same).fieldErrors).toEqual({ name: ['price_list_name_taken'] });

    const stale = await send('PUT', `/price-lists/${dealer.id}`, {
      name: 'Dealer',
      description: 'Upazila dealers',
      version: dealer.version + 1,
    });
    expect(problemOf(stale).code).toBe('version_conflict');
    const renamed = await send('PUT', `/price-lists/${dealer.id}`, {
      name: 'Dealer',
      description: 'Upazila dealers',
      version: dealer.version,
    });
    dealer = priceListSchema.parse(renamed.json());
    expect(dealer).toMatchObject({ description: 'Upazila dealers', version: 2 });
  });

  it('take prices per item and unit, a batch at a time', async () => {
    const res = await setPrices([
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '22' },
      { variantId: variantOf(juice), unitId: unitId('case'), price: '504' },
      { variantId: variantOf(soap, 0), unitId: unitId('pcs'), price: '38' },
      { variantId: variantOf(soap, 1), unitId: unitId('pcs'), price: '38' },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect(priceListSchema.parse(res.json()).itemCount).toBe(4);

    // By product name, three at a time: every price once, the soap first
    const first = await items('limit=3');
    expect(first.items.map((item) => item.productName)).toEqual([
      'Beauty soap 100 g',
      'Beauty soap 100 g',
      'Mango juice 250 ml',
    ]);
    expect(first.items[0]).toMatchObject({ optionValues: ['Lemon'], price: '38.0000' });
    if (first.nextCursor === null) throw new Error('expected a second page');
    const second = await items(`limit=3&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const keys = [...first.items, ...second.items].map(
      (item) => `${item.variantId}:${item.unitId}`,
    );
    expect(new Set(keys).size).toBe(4);

    expect((await items('search=mango')).items).toHaveLength(2);
    const lemon = soap.variants[0];
    expect((await items(`search=${lemon?.sku ?? ''}`)).items.map((item) => item.variantId)).toEqual(
      [variantOf(soap, 0)],
    );
  });

  it('change a price that is there, and take one out with an empty price', async () => {
    const res = await setPrices([
      { variantId: variantOf(juice), unitId: unitId('case'), price: '500' },
      { variantId: variantOf(soap, 1), unitId: unitId('pcs'), price: '' },
    ]);
    expect(priceListSchema.parse(res.json()).itemCount).toBe(3);
    const juicePrices = (await items('search=mango')).items;
    expect(juicePrices.find((item) => item.unitId === unitId('case'))?.price).toBe('500.0000');

    // One audit row for the batch, with counts, not one per price
    const { items: log } = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=price_list&entityId=${dealer.id}`)).json(),
    );
    expect(log[0]).toMatchObject({
      action: 'price_list.prices_changed',
      changes: { set: { from: null, to: 1 }, removed: { from: null, to: 1 } },
    });
  });

  it('refuse the whole batch for a unit an item is not sold in, or an unknown item', async () => {
    const res = await setPrices([
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '21' },
      // The soap is never sold by the 6-pack
      { variantId: variantOf(soap, 0), unitId: unitId('pack'), price: '220' },
      { variantId: '01939d1c-0000-7000-8000-000000000000', unitId: unitId('pcs'), price: '10' },
    ]);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'changes.1.unitId': ['price_list_unit_invalid'],
      'changes.2.variantId': ['product_variant_unknown'],
    });
    // All or nothing: the juice's good price was not saved either
    const juicePrices = (await items('search=mango')).items;
    expect(juicePrices.find((item) => item.unitId === unitId('pcs'))?.price).toBe('22.0000');

    const twice = await setPrices([
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '21' },
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '20' },
    ]);
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({ 'changes.1.price': ['price_list_item_twice'] });
  });

  it('take no prices while archived, and keep them for the restore', async () => {
    const current = await list();
    const archived = priceListSchema.parse(
      (
        await send('POST', `/price-lists/${dealer.id}/archive`, { version: current.version })
      ).json(),
    );
    expect(archived.archivedAt).not.toBeNull();
    const refused = await setPrices([
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '21' },
    ]);
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused).code).toBe('price_list_invalid');
    expect((await items()).items).toHaveLength(3);

    const restored = await send('POST', `/price-lists/${dealer.id}/restore`, {
      version: archived.version,
    });
    expect(priceListSchema.parse(restored.json())).toMatchObject({
      archivedAt: null,
      itemCount: 3,
    });
  });

  it('lose the price of a pack the product is no longer sold in', async () => {
    const current = productSchema.parse((await send('GET', `/products/${juice.id}`)).json());
    // The case is dropped from the product: its dealer price could never be used again
    const res = await send('PUT', `/products/${juice.id}`, {
      ...productForm(current.name, {
        code: current.code,
        variants: current.variants.map((saved) => ({
          id: saved.id,
          sku: saved.sku,
          optionValues: saved.optionValues,
          barcode: saved.barcode ?? '',
          salePrice: saved.salePrice ?? '',
          archived: false,
        })),
        units: [{ unitId: unitId('pack'), factor: '6', barcode: '' }],
      }),
      version: current.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const juicePrices = (await items('search=mango')).items;
    expect(juicePrices.map((item) => item.unitId)).toEqual([unitId('pcs')]);
    expect((await list()).itemCount).toBe(2);
  });

  it('count the customers that use them, archived ones too', async () => {
    const res = await send('POST', '/customers', {
      code: '',
      name: 'Bhairab Bazar Traders',
      groupId: '',
      contactPerson: '',
      phone: '',
      email: '',
      bin: '',
      paymentTermsDays: 15,
      creditLimit: '200000',
      priceListId: dealer.id,
      notes: '',
      addresses: [],
    });
    expect(res.statusCode, res.body).toBe(201);
    const { items: all } = priceListListSchema.parse((await send('GET', '/price-lists')).json());
    expect(all.find((found) => found.id === dealer.id)?.customerCount).toBe(1);
  });
});
