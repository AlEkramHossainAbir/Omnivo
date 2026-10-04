import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  customFieldDefinitionSchema,
  customFieldListSchema,
  type Product,
  productCategoryListSchema,
  productCategorySchema,
  type ProductFormValues,
  productPageSchema,
  productSchema,
  problemSchema,
  setupSchema,
  type Unit,
  unitListSchema,
  unitSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INDUSTRY_TEMPLATES } from '../setup/templates.js';
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

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// Nasrin: a member of Farhana's workspace with no role at all
let viewer: SignedIn;
let units: Unit[];

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

function unitId(code: string): string {
  const found = units.find((unit) => unit.code === code);
  if (!found) throw new Error(`no unit ${code}`);
  return found.id;
}

async function categoryId(name: string): Promise<string> {
  const { items } = productCategoryListSchema.parse(
    (await send('GET', '/product-categories')).json(),
  );
  const found = items.find((category) => category.name === name);
  if (!found) throw new Error(`no category ${name}`);
  return found.id;
}

function variant(optionValues: string[] = [], extra: object = {}) {
  return { id: null, sku: '', optionValues, barcode: '', salePrice: '', archived: false, ...extra };
}

// What the product form sends for a simple product; each test changes a few fields
function simple(name: string, extra: Partial<ProductFormValues> = {}): ProductFormValues {
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
    options: [],
    variants: [variant()],
    units: [],
    customFields: {},
    ...extra,
  };
}

// A form built from a saved product, as the edit page does
function formOf(product: Product): ProductFormValues & { version: number } {
  return {
    code: product.code,
    name: product.name,
    type: product.type === 'service' ? 'service' : 'goods',
    categoryId: product.categoryId ?? '',
    description: product.description ?? '',
    baseUnitId: product.baseUnitId,
    salesUnitId: product.salesUnitId ?? '',
    purchaseUnitId: product.purchaseUnitId ?? '',
    tracking: 'none',
    hasExpiry: product.hasExpiry,
    options: product.options,
    variants: product.variants.map((saved) => ({
      id: saved.id,
      sku: saved.sku,
      optionValues: saved.optionValues,
      barcode: saved.barcode ?? '',
      salePrice: saved.salePrice ?? '',
      archived: saved.archivedAt !== null,
    })),
    units: product.units.map((pack) => ({ ...pack, barcode: pack.barcode ?? '' })),
    customFields: {},
    version: product.version,
  };
}

async function created(body: object): Promise<Product> {
  const res = await send('POST', '/products', body);
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  // The units, categories and custom fields come from the setup job: the real worker runs
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;

  await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'nasrin@rahmangarments.com',
    workspace: 'rahman-garments',
  });
  viewer = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('the starting catalog', () => {
  it('comes with the setup job: the template’s units, categories and fields', async () => {
    const template = INDUSTRY_TEMPLATES.garments.catalog;
    expect(units.map((unit) => unit.code).sort()).toEqual(
      template.units.map((unit) => unit.code).sort(),
    );
    expect(units.find((unit) => unit.code === 'yard')).toMatchObject({
      dimension: 'length',
      ratio: '0.914400',
      decimals: 2,
    });
    expect(units.find((unit) => unit.code === 'box')?.ratio).toBeNull();
    const { items } = productCategoryListSchema.parse(
      (await send('GET', '/product-categories')).json(),
    );
    const garments = items.find((category) => category.name === 'Finished garments');
    expect(
      items.filter((category) => category.parentId === garments?.id).map((c) => c.name),
    ).toEqual(expect.arrayContaining(['T-shirts', 'Polo shirts']));
    const fields = customFieldListSchema.parse(
      (await send('GET', '/custom-fields?entity=product')).json(),
    ).items;
    expect(fields.map((field) => field.key)).toEqual(['buyer', 'composition', 'gsm', 'season']);
  });

  it('reaches a workspace set up before this step, through the catalog job', async () => {
    // A workspace that was 'ready' before step 12: no units yet, and the event that migration
    // 0020 queues for it
    const old = await signUp(app, {
      companyName: 'Karim Pharma',
      workspaceSlug: 'karim-pharma',
      fullName: 'Karim Uddin',
      email: 'karim@karimpharma.com',
      password: 'Batch-expiry-2026',
    });
    await superuserSql(async (sql) => {
      const [tenant] = await sql<{ id: string }[]>`
        UPDATE tenants SET setup_status = 'ready', industry = 'pharma'
         WHERE slug = 'karim-pharma' RETURNING id`;
      if (!tenant) throw new Error('no tenant');
      await sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                VALUES (gen_random_uuid(), ${tenant.id}, 'workspace.catalog_requested', '{}')`;
    });
    await eventually(async () => {
      const list = unitListSchema.parse(
        (
          await app.inject({ method: 'GET', url: '/units', headers: bearer(old.accessToken) })
        ).json(),
      ).items;
      expect(list.map((unit) => unit.code)).toContain('strip');
    });
    const fields = customFieldListSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/custom-fields?entity=product',
          headers: bearer(old.accessToken),
        })
      ).json(),
    ).items;
    expect(fields.find((field) => field.key === 'generic_name')?.required).toBe(true);
  });
});

describe('units', () => {
  it('adds a unit; its code is taken in any case', async () => {
    const res = await send('POST', '/units', {
      code: 'Gz',
      name: 'Gauze roll',
      dimension: 'count',
      ratio: '',
      decimals: 0,
    });
    expect(res.statusCode).toBe(201);
    expect(unitSchema.parse(res.json())).toMatchObject({ code: 'Gz', ratio: null });
    const again = await send('POST', '/units', {
      code: 'gz',
      name: 'Gauze',
      dimension: 'count',
      ratio: '',
      decimals: 0,
    });
    expect(again.statusCode).toBe(409);
    expect(problemOf(again).fieldErrors).toEqual({ code: ['unit_code_taken'] });
  });

  it('keeps a unit a product uses; archiving hides it from new products only', async () => {
    const reel = unitSchema.parse(
      (
        await send('POST', '/units', {
          code: 'reel',
          name: 'Reel',
          dimension: 'count',
          ratio: '',
          decimals: 0,
        })
      ).json(),
    );
    units.push(reel);
    const thread = await created(
      simple('Sewing thread 40/2', { units: [{ unitId: reel.id, factor: '12', barcode: '' }] }),
    );
    const removed = await send('DELETE', `/units/${reel.id}?version=${String(reel.version)}`);
    expect(removed.statusCode).toBe(409);
    expect(problemOf(removed).code).toBe('unit_in_use');

    const archived = await send('POST', `/units/${reel.id}/archive`, { version: reel.version });
    expect(archived.statusCode).toBe(200);
    // The product that has it can still be saved…
    const kept = await send('PUT', `/products/${thread.id}`, formOf(thread));
    expect(kept.statusCode, kept.body).toBe(200);
    // …a new one cannot start with it
    const refused = await send(
      'POST',
      '/products',
      simple('Sewing thread 60/3', { units: [{ unitId: reel.id, factor: '12', barcode: '' }] }),
    );
    expect(refused.statusCode).toBe(400);
    expect(problemOf(refused).fieldErrors).toEqual({ 'units.0.unitId': ['product_unit_invalid'] });
  });
});

describe('categories', () => {
  it('keeps names unique among siblings, and a category out of its own branch', async () => {
    const fabrics = await categoryId('Fabrics');
    const twice = await send('POST', '/product-categories', { parentId: fabrics, name: 'knit' });
    expect(twice.statusCode).toBe(409);
    expect(problemOf(twice).fieldErrors).toEqual({ name: ['category_name_taken'] });
    // The same name elsewhere is fine
    expect(
      (await send('POST', '/product-categories', { parentId: '', name: 'Knit' })).statusCode,
    ).toBe(201);

    const knit = await categoryId('Fabrics');
    const { items } = productCategoryListSchema.parse(
      (await send('GET', '/product-categories')).json(),
    );
    const child = items.find((category) => category.parentId === knit && category.name === 'Knit');
    const parent = items.find((category) => category.id === knit);
    if (!child || !parent) throw new Error('no Knit under Fabrics');
    const loop = await send('PUT', `/product-categories/${knit}`, {
      parentId: child.id,
      name: parent.name,
      version: parent.version,
    });
    expect(loop.statusCode).toBe(409);
    expect(problemOf(loop).code).toBe('category_parent_loop');
  });

  it('deletes only an empty category', async () => {
    const tees = await categoryId('T-shirts');
    await created(simple('Basic crew-neck T-shirt', { categoryId: tees }));
    const { items } = productCategoryListSchema.parse(
      (await send('GET', '/product-categories')).json(),
    );
    const category = productCategorySchema.parse(items.find((item) => item.id === tees));
    expect(category.productCount).toBe(1);
    const inUse = await send(
      'DELETE',
      `/product-categories/${tees}?version=${String(category.version)}`,
    );
    expect(problemOf(inUse).code).toBe('category_in_use');
    const garments = items.find((item) => item.name === 'Finished garments');
    const withChildren = await send(
      'DELETE',
      `/product-categories/${garments?.id ?? ''}?version=${String(garments?.version ?? 1)}`,
    );
    expect(problemOf(withChildren).code).toBe('category_has_children');
  });
});

describe('a product', () => {
  it('gets the next code, and its one variant the same SKU', async () => {
    const shirt = await created(
      simple('Oxford shirt', {
        variants: [variant([], { salePrice: '1450', barcode: '8941100500118' })],
      }),
    );
    expect(shirt.code).toMatch(/^P-\d{5}$/);
    expect(shirt.variants).toMatchObject([
      { sku: shirt.code, salePrice: '1450.0000', barcode: '8941100500118', archivedAt: null },
    ]);
    // The barcode means this shirt in the whole workspace — a pack of another product too
    const clash = await send(
      'POST',
      '/products',
      simple('Oxford shirt box', {
        units: [{ unitId: unitId('box'), factor: '10', barcode: '8941100500118' }],
      }),
    );
    expect(clash.statusCode).toBe(409);
    expect(problemOf(clash).fieldErrors).toEqual({ 'units.0.barcode': ['barcode_taken'] });
  });

  it('makes a variant product, with SKUs from its code and options', async () => {
    const polo = await created(
      simple('Pique polo shirt', {
        code: 'ST-118',
        options: [
          { name: 'Size', values: ['M', 'L'] },
          { name: 'Colour', values: ['Navy blue', 'White'] },
        ],
        variants: [
          variant(['M', 'Navy blue'], { salePrice: '650' }),
          variant(['L', 'Navy blue'], { salePrice: '650' }),
          variant(['M', 'White'], { salePrice: '600', sku: 'ST-118-MW' }),
        ],
        units: [{ unitId: unitId('dozen'), factor: '12', barcode: '' }],
        purchaseUnitId: unitId('dozen'),
        customFields: { gsm: '220', buyer: 'H&M', composition: '', season: '' },
      }),
    );
    expect(polo.variants.map((v) => v.sku)).toEqual([
      'ST-118-M-NAVY-BLUE',
      'ST-118-L-NAVY-BLUE',
      'ST-118-MW',
    ]);
    expect(polo).toMatchObject({
      purchaseUnitId: unitId('dozen'),
      salesUnitId: null,
      customFields: { gsm: '220', buyer: 'H&M' },
    });
    // The code is taken in any case
    const again = await send('POST', '/products', simple('Polo copy', { code: 'st-118' }));
    expect(problemOf(again).fieldErrors).toEqual({ code: ['product_code_taken'] });
  });

  it('refuses a dozen of 10 pieces: standard units convert at their own rate', async () => {
    const res = await send(
      'POST',
      '/products',
      simple('Shirt buttons', { units: [{ unitId: unitId('dozen'), factor: '10', barcode: '' }] }),
    );
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({ 'units.0.factor': ['product_factor_standard'] });
    // A yard of fabric sold by the metre: the rounded standard number
    const fabric = await created(
      simple('Single jersey 180 GSM', {
        baseUnitId: unitId('m'),
        units: [{ unitId: unitId('yard'), factor: '0.9144', barcode: '' }],
      }),
    );
    expect(fabric.units).toEqual([{ unitId: unitId('yard'), factor: '0.914400', barcode: null }]);
  });

  it('checks the custom fields against the workspace’s', async () => {
    const res = await send(
      'POST',
      '/products',
      simple('Fleece hoodie', { customFields: { gsm: 'heavy', fabric: 'Fleece' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({
      'customFields.gsm': ['number_format'],
      customFields: ['custom_field_unknown'],
    });
  });

  it('keeps the values of an archived field when the product is saved again', async () => {
    const fields = customFieldListSchema.parse(
      (await send('GET', '/custom-fields?entity=product')).json(),
    ).items;
    const season = customFieldDefinitionSchema.parse(
      fields.find((field) => field.key === 'season'),
    );
    const jacket = await created(
      simple('Puffer jacket', { customFields: { season: 'Winter 2026' } }),
    );
    await send('POST', `/custom-fields/${season.id}/archive`, { version: season.version });
    // The form no longer sends the archived field; the value stays
    const saved = productSchema.parse(
      (
        await send('PUT', `/products/${jacket.id}`, {
          ...formOf(jacket),
          name: 'Puffer jacket (men)',
        })
      ).json(),
    );
    expect(saved.customFields).toEqual({ season: 'Winter 2026' });
    const restored = await send('POST', `/custom-fields/${season.id}/restore`, {
      version: season.version + 1,
    });
    expect(restored.statusCode).toBe(200);
  });

  it('keeps variant ids on an edit: values can swap, variants come and go', async () => {
    const tee = await created(
      simple('Raglan tee', {
        code: 'ST-207',
        options: [{ name: 'Size', values: ['S', 'M'] }],
        variants: [variant(['S'], { barcode: '96385074' }), variant(['M'])],
      }),
    );
    const [small, medium] = tee.variants;
    if (!small || !medium) throw new Error('two variants');
    const form = formOf(tee);
    const res = await send('PUT', `/products/${tee.id}`, {
      ...form,
      options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
      variants: [
        // S and M swap their SKUs (typed the wrong way round the first time)
        { ...form.variants[0], sku: medium.sku },
        { ...form.variants[1], sku: small.sku, archived: true },
        variant(['L']),
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = productSchema.parse(res.json());
    expect(saved.variants.map((v) => [v.id === small.id, v.sku, v.archivedAt !== null])).toEqual([
      [true, 'ST-207-M', false],
      [false, 'ST-207-S', true],
      [false, 'ST-207-L', false],
    ]);
    expect(saved.variants[1]?.id).toBe(medium.id);
    expect(saved.variants[0]?.barcode).toBe('96385074');

    // An id that is not this product's own
    const foreign = await send('PUT', `/products/${tee.id}`, {
      ...formOf(saved),
      variants: [
        { ...formOf(saved).variants[0], id: crypto.randomUUID() },
        ...formOf(saved).variants.slice(1),
      ],
    });
    expect(problemOf(foreign).fieldErrors).toEqual({
      'variants.0.id': ['product_variant_unknown'],
    });
    // A stale form
    const stale = await send('PUT', `/products/${tee.id}`, formOf(tee));
    expect(problemOf(stale).code).toBe('version_conflict');
  });

  it('archives, restores and deletes — but not a product with a history', async () => {
    const mug = await created(simple('Promotional mug'));
    const archived = productSchema.parse(
      (await send('POST', `/products/${mug.id}/archive`, { version: mug.version })).json(),
    );
    expect(archived.archivedAt).not.toBeNull();
    const restored = productSchema.parse(
      (await send('POST', `/products/${mug.id}/restore`, { version: archived.version })).json(),
    );
    expect(restored.archivedAt).toBeNull();

    // A batch (from step 13: a stock line) points at its variant: it stays
    await superuserSql(
      (sql) => sql`INSERT INTO batches (id, tenant_id, product_id, variant_id, lot_number)
                   SELECT gen_random_uuid(), tenant_id, product_id, id, 'L-01'
                     FROM product_variants WHERE id = ${restored.variants[0]?.id ?? ''}`,
    );
    const inUse = await send('DELETE', `/products/${mug.id}?version=${String(restored.version)}`);
    expect(problemOf(inUse).code).toBe('product_in_use');

    const sample = await created(simple('Sample swatch card'));
    expect(
      (await send('DELETE', `/products/${sample.id}?version=${String(sample.version)}`)).statusCode,
    ).toBe(204);
    expect((await send('GET', `/products/${sample.id}`)).statusCode).toBe(404);
    const audit = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=product')).json(),
    );
    expect(audit.items.find((item) => item.action === 'product.deleted')?.changes).toMatchObject({
      name: { from: 'Sample swatch card', to: null },
    });
  });
});

describe('the product list', () => {
  it('pages through every product once, in each order', async () => {
    for (const sort of ['name', '-name', 'code', '-code', '-updated'] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ sort, limit: '3', ...(cursor && { cursor }) });
        const page = productPageSchema.parse((await send('GET', `/products?${query}`)).json());
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      const all = productPageSchema.parse(
        (await send('GET', `/products?sort=${sort}&limit=100`)).json(),
      );
      expect(seen, sort).toEqual(all.items.map((item) => item.id));
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it('finds by part of a name, code or SKU, and by a whole barcode', async () => {
    const search = async (term: string) =>
      productPageSchema
        .parse((await send('GET', `/products?search=${encodeURIComponent(term)}`)).json())
        .items.map((item) => item.name);
    expect(await search('polo')).toEqual(['Pique polo shirt']);
    expect(await search('st-118')).toEqual(['Pique polo shirt']);
    expect(await search('navy-blue')).toEqual(['Pique polo shirt']);
    expect(await search('8941100500118')).toEqual(['Oxford shirt']);
    expect(await search('89411005')).toEqual([]);
    // LIKE's wildcards are plain characters in a search
    expect(await search('%')).toEqual([]);
  });

  it('filters by a category and the categories under it, and by status', async () => {
    const garments = await categoryId('Finished garments');
    const page = productPageSchema.parse(
      (await send('GET', `/products?categoryId=${garments}`)).json(),
    );
    expect(page.items.map((item) => item.name)).toEqual(['Basic crew-neck T-shirt']);
    const archived = productPageSchema.parse(
      (await send('GET', '/products?status=archived')).json(),
    );
    expect(archived.items).toEqual([]);
  });

  it('sums up each product: variants and price range', async () => {
    const page = productPageSchema.parse((await send('GET', '/products?search=polo')).json());
    expect(page.items[0]).toMatchObject({
      hasVariants: true,
      variantCount: 3,
      minPrice: '600.0000',
      maxPrice: '650.0000',
    });
  });
});

describe('permissions', () => {
  it('lets every member read products, and only managers change them', async () => {
    expect((await send('GET', '/products', undefined, viewer)).statusCode).toBe(200);
    expect((await send('GET', '/units', undefined, viewer)).statusCode).toBe(200);
    const res = await send('POST', '/products', simple('Viewer’s product'), viewer);
    expect(res.statusCode).toBe(403);
    expect(problemOf(res).params).toEqual({ permissions: 'inventory.product.manage' });
    const field = await send(
      'POST',
      '/custom-fields',
      { entity: 'product', key: 'x', label: 'X', type: 'text', options: [], required: false },
      viewer,
    );
    expect(field.statusCode).toBe(403);
  });
});
