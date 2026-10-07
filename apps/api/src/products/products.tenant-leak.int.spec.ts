import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  customFieldListSchema,
  type Product,
  productCategoryListSchema,
  type ProductFormValues,
  productImportTicketSchema,
  productPageSchema,
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

// Two workspaces, each with products: A must never see, use or change B's products, units,
// categories, custom fields or imports. Every answer is 404, or the same "pick one from the list"
// as for an id that does not exist — never a hint that it does.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let unitsOfA: Unit[];
let unitsOfB: Unit[];
let productOfB: Product;

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

async function setUp(who: SignedIn, industry: 'garments' | 'pharma'): Promise<Unit[]> {
  expect((await as(who, 'POST', '/setup', { industry })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
  return unitListSchema.parse((await as(who, 'GET', '/units')).json()).items;
}

function pcsOf(units: Unit[]): string {
  const pcs = units.find((unit) => unit.code === 'pcs');
  if (!pcs) throw new Error('no pcs');
  return pcs.id;
}

function product(name: string, units: Unit[], extra: Partial<ProductFormValues> = {}) {
  return {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcsOf(units),
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
  } satisfies ProductFormValues;
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
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  tenantB = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  [unitsOfA, unitsOfB] = await Promise.all([setUp(tenantA, 'garments'), setUp(tenantB, 'pharma')]);
  const res = await as(
    tenantB,
    'POST',
    '/products',
    product('Napa 500 mg', unitsOfB, {
      variants: [
        {
          id: null,
          sku: '',
          optionValues: [],
          barcode: '8941100500118',
          salePrice: '1.20',
          archived: false,
        },
      ],
      customFields: { generic_name: 'Paracetamol' },
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  productOfB = productSchema.parse(res.json());
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('product isolation over HTTP', () => {
  it("never lists, finds or reads tenant B's products", async () => {
    const page = productPageSchema.parse((await as(tenantA, 'GET', '/products')).json());
    expect(page.items).toEqual([]);
    // Not by name, nor by B's barcode scanned into A's search box
    for (const search of ['napa', '8941100500118', productOfB.code]) {
      const found = productPageSchema.parse(
        (await as(tenantA, 'GET', `/products?search=${search}`)).json(),
      );
      expect(found.items, search).toEqual([]);
    }
    expect((await as(tenantA, 'GET', `/products/${productOfB.id}`)).statusCode).toBe(404);
  });

  it("cannot change, archive or delete tenant B's product", async () => {
    const edit = { ...product('Taken over', unitsOfA), version: 1 };
    expect((await as(tenantA, 'PUT', `/products/${productOfB.id}`, edit)).statusCode).toBe(404);
    for (const action of ['archive', 'restore']) {
      const res = await as(tenantA, 'POST', `/products/${productOfB.id}/${action}`, { version: 1 });
      expect(res.statusCode).toBe(404);
    }
    expect((await as(tenantA, 'DELETE', `/products/${productOfB.id}?version=1`)).statusCode).toBe(
      404,
    );
    const still = productSchema.parse(
      (await as(tenantB, 'GET', `/products/${productOfB.id}`)).json(),
    );
    expect(still).toMatchObject({ name: 'Napa 500 mg', version: 1, archivedAt: null });
  });

  it("cannot use tenant B's units, categories or variants in its own product", async () => {
    const categoriesOfB = productCategoryListSchema.parse(
      (await as(tenantB, 'GET', '/product-categories')).json(),
    ).items;
    const strip = unitsOfB.find((unit) => unit.code === 'strip');
    const res = await as(
      tenantA,
      'POST',
      '/products',
      product('Borrowed everything', unitsOfA, {
        baseUnitId: pcsOf(unitsOfB),
        categoryId: categoriesOfB[0]?.id ?? '',
        units: [{ unitId: strip?.id ?? '', factor: '10', barcode: '' }],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      categoryId: ['product_category_invalid'],
      baseUnitId: ['product_unit_invalid'],
      'units.0.unitId': ['product_unit_invalid'],
    });
    // B's barcode is B's: A may print the same number on its own product
    const same = await as(
      tenantA,
      'POST',
      '/products',
      product('Gift card', unitsOfA, {
        variants: [
          {
            id: null,
            sku: productOfB.code,
            optionValues: [],
            barcode: '8941100500118',
            salePrice: '',
            archived: false,
          },
        ],
      }),
    );
    expect(same.statusCode, same.body).toBe(201);
    // …and A's form cannot claim B's variant as one of its own
    const created = productSchema.parse(same.json());
    const steal = await as(tenantA, 'PUT', `/products/${created.id}`, {
      ...product('Gift card', unitsOfA, {
        variants: [
          {
            id: productOfB.variants[0]?.id ?? null,
            sku: '',
            optionValues: [],
            barcode: '',
            salePrice: '',
            archived: false,
          },
        ],
      }),
      version: created.version,
    });
    expect(problemSchema.parse(steal.json()).fieldErrors).toEqual({
      'variants.0.id': ['product_variant_unknown'],
    });
  });

  it("cannot touch tenant B's units, categories, fields or imports", async () => {
    const unit = unitsOfB.find((candidate) => candidate.code === 'strip');
    const category = productCategoryListSchema.parse(
      (await as(tenantB, 'GET', '/product-categories')).json(),
    ).items[0];
    const field = customFieldListSchema.parse(
      (await as(tenantB, 'GET', '/custom-fields?entity=product')).json(),
    ).items[0];
    if (!unit || !category || !field) throw new Error('B has no catalog');

    const attempts = [
      as(tenantA, 'PUT', `/units/${unit.id}`, { code: 'x', name: 'X', decimals: 0, version: 1 }),
      as(tenantA, 'POST', `/units/${unit.id}/archive`, { version: 1 }),
      as(tenantA, 'DELETE', `/units/${unit.id}?version=1`),
      as(tenantA, 'PUT', `/product-categories/${category.id}`, {
        parentId: '',
        name: 'X',
        version: 1,
      }),
      as(tenantA, 'DELETE', `/product-categories/${category.id}?version=1`),
      as(tenantA, 'PUT', `/custom-fields/${field.id}`, {
        label: 'X',
        options: [],
        required: false,
        version: 1,
      }),
      as(tenantA, 'POST', `/custom-fields/${field.id}/archive`, { version: 1 }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode).toBe(404);
    // A sub-category of A under B's category is "pick one from the list", like a made-up id
    const under = await as(tenantA, 'POST', '/product-categories', {
      parentId: category.id,
      name: 'X',
    });
    expect(problemSchema.parse(under.json()).code).toBe('category_parent_invalid');

    const ticket = productImportTicketSchema.parse(
      (await as(tenantB, 'POST', '/product-imports', { fileName: 'b.csv', sizeBytes: 10 })).json(),
    );
    expect((await as(tenantA, 'GET', `/product-imports/${ticket.import.id}`)).statusCode).toBe(404);
    expect(
      (await as(tenantA, 'POST', `/product-imports/${ticket.import.id}/start`)).statusCode,
    ).toBe(404);
    const list = await as(tenantA, 'GET', '/product-imports');
    expect(list.json()).toMatchObject({ items: [] });
  });
});
