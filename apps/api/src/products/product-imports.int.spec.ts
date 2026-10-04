import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  notificationPageSchema,
  productCategoryListSchema,
  type ProductImport,
  productImportDetailSchema,
  productImportSchema,
  productImportTicketSchema,
  productPageSchema,
  problemSchema,
  setupSchema,
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
  startStorage,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// The whole way of an import: the API gives an upload address, the file goes straight to a real
// MinIO, the real worker reads and checks it, and the products appear — or nothing does.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;

function send(method: 'GET' | 'POST', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(owner.accessToken),
    ...(payload && { payload }),
  });
}

// Upload a CSV and start the import, as the import page does
async function upload(fileName: string, csv: string): Promise<ProductImport> {
  const bytes = new TextEncoder().encode(csv);
  const ticket = productImportTicketSchema.parse(
    (await send('POST', '/product-imports', { fileName, sizeBytes: bytes.byteLength })).json(),
  );
  const put = await fetch(ticket.upload.url, {
    method: 'PUT',
    headers: ticket.upload.headers,
    body: bytes,
  });
  expect(put.status).toBe(200);
  const started = await send('POST', `/product-imports/${ticket.import.id}/start`);
  expect(started.statusCode, started.body).toBe(200);
  return productImportSchema.parse(started.json());
}

async function finished(id: string) {
  return eventually(async () => {
    const detail = productImportDetailSchema.parse(
      (await send('GET', `/product-imports/${id}`)).json(),
    );
    expect(['done', 'failed']).toContain(detail.status);
    return detail;
  }, 8_000);
}

async function productNames(): Promise<string[]> {
  return productPageSchema
    .parse((await send('GET', '/products?limit=100')).json())
    .items.map((item) => item.name);
}

beforeAll(async () => {
  [pg, redis, storage] = await Promise.all([startPostgres(), startRedis(), startStorage()]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      storageUrl: storage.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  expect((await send('POST', '/setup', { industry: 'pharma' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), storage.container.stop()]);
});

describe('importing products from a CSV', () => {
  it('creates every product of a good file, with new categories and codes', async () => {
    const started = await upload(
      'medicines.csv',
      [
        'name,unit,sale_price,pack1_unit,pack1_factor,pack2_unit,pack2_factor,sales_unit,category,barcode,cf_generic_name,cf_dosage_form',
        'Napa 500 mg,pcs,1.20,strip,10,box,100,strip,Finished products > Tablets,8941100500118,Paracetamol,Tablet',
        'Seclo 20 mg,pcs,7,strip,10,,,strip,Finished products > Capsules,,Omeprazole,Capsule',
        // A category that does not exist yet: made, under one that does
        'Napa syrup 60 ml,bottle,35,,,,,,Finished products > Paediatric syrups,,Paracetamol,Syrup',
      ].join('\n'),
    );
    expect(started).toMatchObject({ status: 'queued', fileName: 'medicines.csv' });

    const done = await finished(started.id);
    expect(done).toMatchObject({ status: 'done', rowCount: 3, productCount: 3, errors: [] });
    expect(await productNames()).toEqual(['Napa 500 mg', 'Napa syrup 60 ml', 'Seclo 20 mg']);
    const napa = productPageSchema.parse(
      (await send('GET', '/products?search=8941100500118')).json(),
    ).items[0];
    // A pharma workspace: batch tracking, from the business type, like the form
    expect(napa).toMatchObject({ code: 'P-00001', tracking: 'batch' });
    const categories = productCategoryListSchema.parse(
      (await send('GET', '/product-categories')).json(),
    ).items;
    expect(categories.map((category) => category.name)).toContain('Paediatric syrups');

    const bell = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(bell.items[0]).toMatchObject({
      type: 'import.done',
      params: { file: 'medicines.csv', count: 3 },
    });
  });

  it('creates nothing from a file with one wrong row, and says where', async () => {
    const started = await upload(
      'more-medicines.csv',
      [
        'name,unit,sale_price,category,barcode,cf_generic_name',
        'Ace 500 mg,pcs,1.10,Finished products > Antacids,,Paracetamol',
        // Taken by Napa from the first file
        'Ace Plus,pcs,2.50,,8941100500118,Paracetamol + Caffeine',
        // The pharma template makes Generic name required
        'Fexo 120 mg,tablet,8,,,',
      ].join('\n'),
    );
    const failed = await finished(started.id);
    expect(failed.status).toBe('failed');
    expect(failed.errors).toEqual([
      { row: 4, column: 'unit', code: 'import_unit_unknown', params: { value: 'tablet' } },
      { row: 4, column: 'cf_generic_name', code: 'required' },
    ]);
    // Nothing was written, not even the new category
    expect(await productNames()).not.toContain('Ace 500 mg');

    // The same file with Fexo fixed: now the taken barcode is what stands in the way. The worker
    // checked it inside a savepoint, so the category made for Ace was undone again.
    const second = await upload(
      'more-medicines.csv',
      [
        'name,unit,sale_price,category,barcode,cf_generic_name',
        'Ace 500 mg,pcs,1.10,Finished products > Antacids,,Paracetamol',
        'Ace Plus,pcs,2.50,,8941100500118,Paracetamol + Caffeine',
      ].join('\n'),
    );
    const again = await finished(second.id);
    expect(again.errors).toEqual([{ row: 3, column: 'barcode', code: 'barcode_taken' }]);
    const categories = productCategoryListSchema.parse(
      (await send('GET', '/product-categories')).json(),
    ).items;
    expect(categories.map((category) => category.name)).not.toContain('Antacids');
    const bell = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(bell.items[0]).toMatchObject({
      type: 'import.failed',
      params: { file: 'more-medicines.csv', count: 1 },
    });
  });

  it('starts only a file that is really in storage, and only once', async () => {
    const ticket = productImportTicketSchema.parse(
      (await send('POST', '/product-imports', { fileName: 'empty.csv', sizeBytes: 120 })).json(),
    );
    const early = await send('POST', `/product-imports/${ticket.import.id}/start`);
    expect(problemSchema.parse(early.json()).code).toBe('import_not_uploaded');

    const started = await upload(
      'one.csv',
      'name,unit,cf_generic_name\nNorvasc 5 mg,pcs,Amlodipine',
    );
    const twice = await send('POST', `/product-imports/${started.id}/start`);
    expect(problemSchema.parse(twice.json()).code).toBe('import_not_pending');
    expect((await finished(started.id)).status).toBe('done');
  });

  it('refuses a file that is not a CSV, or too large, before any upload', async () => {
    const res = await send('POST', '/product-imports', {
      fileName: 'products.xlsx',
      sizeBytes: 6 * 1024 * 1024,
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      fileName: ['import_file_type'],
      sizeBytes: ['file_too_large'],
    });
  });
});
