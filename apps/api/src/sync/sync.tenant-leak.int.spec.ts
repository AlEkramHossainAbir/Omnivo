import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  branchListSchema,
  type Customer,
  customerBalancesSchema,
  customerSchema,
  type Device,
  deviceSchema,
  type Product,
  productSchema,
  problemSchema,
  setupSchema,
  type SyncChange,
  syncPullSchema,
  type Unit,
  unitListSchema,
  warehouseListSchema,
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
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// Two workspaces, each with a device. A device of A must never receive a row of B, nor use B's
// device, nor learn B's customers' balances; and in the database, the API's role must never read
// or write B's change log or devices.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;

interface Workspace {
  who: SignedIn;
  tenantId: string;
  units: Unit[];
  product: Product;
  customer: Customer;
  device: Device;
}
let a: Workspace;
let b: Workspace;

function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

function as(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload && { payload }),
  });
}

function pull(who: SignedIn, deviceId: string, cursor?: string) {
  const query = new URLSearchParams({ deviceId, protocol: '1', limit: '1000' });
  if (cursor !== undefined) query.set('cursor', cursor);
  return as(who, 'GET', `/sync/pull?${query.toString()}`);
}

// One page is enough: each workspace has far fewer rows than the limit
async function pulled(space: Pick<Workspace, 'who' | 'device'>, cursor?: string) {
  const res = await pull(space.who, space.device.id, cursor);
  expect(res.statusCode, res.body).toBe(200);
  const page = syncPullSchema.parse(res.json());
  expect(page.hasMore).toBe(false);
  return page;
}

// A change as text: its key (a price or a stock key holds three ids) and every id inside its row,
// so one search finds an id wherever the change names it
function idsIn(change: SyncChange): string {
  return JSON.stringify(change);
}

async function workspace(input: {
  companyName: string;
  workspaceSlug: string;
  fullName: string;
  email: string;
  password: string;
  industry: 'garments' | 'pharma';
  product: string;
  // The pharma template's products need a generic name
  customFields: Record<string, string>;
  customer: string;
}): Promise<Workspace> {
  const who = await signUp(app, {
    companyName: input.companyName,
    workspaceSlug: input.workspaceSlug,
    fullName: input.fullName,
    email: input.email,
    password: input.password,
  });
  expect((await as(who, 'POST', '/setup', { industry: input.industry })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
  const units = unitListSchema.parse((await as(who, 'GET', '/units')).json()).items;
  const pcs = units.find((unit) => unit.code === 'pcs');
  if (!pcs) throw new Error('no pcs');
  const productRes = await as(who, 'POST', '/products', {
    code: '',
    name: input.product,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcs.id,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '10', archived: false },
    ],
    units: [],
    customFields: input.customFields,
  });
  expect(productRes.statusCode, productRes.body).toBe(201);
  const customerRes = await as(who, 'POST', '/customers', {
    code: '',
    name: input.customer,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
  });
  expect(customerRes.statusCode, customerRes.body).toBe(201);
  const [branch] = branchListSchema.parse((await as(who, 'GET', '/branches')).json()).items;
  if (!branch) throw new Error('no branch');
  const deviceRes = await as(who, 'POST', '/sync/devices', {
    id: v7(),
    name: 'Chrome on Windows',
    branchId: branch.id,
  });
  expect(deviceRes.statusCode, deviceRes.body).toBe(201);
  const device = deviceSchema.parse(deviceRes.json());
  // The settings row's key is the workspace's id
  const settings = (await pulled({ who, device })).changes.find(
    (change) => change.entity === 'settings',
  );
  return {
    who,
    tenantId: settings?.key ?? '',
    units,
    product: productSchema.parse(productRes.json()),
    customer: customerSchema.parse(customerRes.json()),
    device,
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
  [a, b] = await Promise.all([
    workspace({
      companyName: 'Rahman Garments Ltd.',
      workspaceSlug: 'rahman-garments',
      fullName: 'Farhana Rahman',
      email: 'farhana@rahmangarments.com',
      password: 'Gazipur-knit-2026',
      industry: 'garments',
      product: 'Polo shirt',
      customFields: {},
      customer: 'Nordic Wear AB',
    }),
    workspace({
      companyName: 'Karim Pharma',
      workspaceSlug: 'karim-pharma',
      fullName: 'Karim Uddin',
      email: 'karim@karimpharma.com',
      password: 'Batch-expiry-2026',
      industry: 'pharma',
      product: 'Napa 500 mg',
      customFields: { generic_name: 'Paracetamol' },
      customer: 'Lazz Pharma',
    }),
  ]);
  expect(a.tenantId).not.toBe('');
  expect(b.tenantId).not.toBe('');
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('pulling over HTTP', () => {
  it("never sends tenant B's rows to A's device", async () => {
    const { changes } = await pulled(a);
    const warehousesOfB = warehouseListSchema.parse(
      (await as(b.who, 'GET', '/warehouses')).json(),
    ).items;
    const idsOfB = [
      b.tenantId,
      b.product.id,
      ...b.product.variants.map((variant) => variant.id),
      b.customer.id,
      ...b.units.map((unit) => unit.id),
      ...warehousesOfB.map((warehouse) => warehouse.id),
    ];
    const everything = changes.map(idsIn).join('\n');
    for (const id of idsOfB) expect(everything).not.toContain(id);

    // A gets its own, so the check above is not passing on an empty pull
    expect(changes.filter((change) => change.entity === 'settings').map((c) => c.key)).toEqual([
      a.tenantId,
    ]);
    expect(changes.map((change) => change.key)).toEqual(
      expect.arrayContaining([a.product.id, a.customer.id]),
    );
  });

  it("never sends tenant B's changes in A's delta", async () => {
    const { cursor } = await pulled(a);
    const res = await as(b.who, 'POST', `/customers/${b.customer.id}/archive`, {
      version: b.customer.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const archived = await as(b.who, 'POST', `/products/${b.product.id}/archive`, {
      version: b.product.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    expect((await pulled(a, cursor)).changes).toEqual([]);
    // B's own device does hear about them
    const ofB = (await pulled(b)).changes.map((change) => change.key);
    expect(ofB).not.toContain(b.product.id);
    expect(ofB).not.toContain(b.customer.id);
  });

  it("cannot register or pull with tenant B's device", async () => {
    const [branch] = branchListSchema.parse((await as(a.who, 'GET', '/branches')).json()).items;
    const taken = await as(a.who, 'POST', '/sync/devices', {
      id: b.device.id,
      name: 'Chrome on Windows',
      branchId: branch?.id ?? '',
    });
    expect(taken.statusCode).toBe(409);
    expect(problemSchema.parse(taken.json()).code).toBe('device_id_invalid');

    const res = await pull(a.who, b.device.id);
    expect(res.statusCode).toBe(404);
    expect(problemSchema.parse(res.json()).code).toBe('device_not_found');
    // ...and B's device still answers B, with its own branch
    expect((await pull(b.who, b.device.id)).statusCode).toBe(200);
  });

  it("gives no balance of tenant B's customers", async () => {
    const res = await as(a.who, 'GET', `/customer-balances?ids=${b.customer.id},${a.customer.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(customerBalancesSchema.parse(res.json()).items).toEqual([
      { id: a.customer.id, balance: '0.0000' },
    ]);
  });
});

// Postgres error code of a statement run as the given role, or null when it worked
async function errorCodeAs(url: string, run: (sql: postgres.Sql) => Promise<unknown>) {
  const sql = postgres(url, { max: 1 });
  try {
    await run(sql);
    return null;
  } catch (error) {
    return error instanceof postgres.PostgresError ? error.code : String(error);
  } finally {
    await sql.end();
  }
}

const tenantRowsSchema = z.array(z.object({ tenant_id: z.uuid() }));

// A statement in tenant A's context, as the API's role. Its rows are checked by the caller.
async function asAppInA(run: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<unknown> {
  const sql = postgres(pg.appUrl, { max: 1 });
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
      return run(tx);
    });
  } finally {
    await sql.end();
  }
}

describe('the change log and the devices as omnivo_app', () => {
  it("reads only its own tenant's lines and devices", async () => {
    const lines = tenantRowsSchema.parse(
      await asAppInA((tx) => tx`SELECT DISTINCT tenant_id FROM sync_changes`),
    );
    expect(lines).toEqual([{ tenant_id: a.tenantId }]);
    const devices = tenantRowsSchema.parse(
      await asAppInA((tx) => tx`SELECT tenant_id FROM devices`),
    );
    expect(devices).toEqual([{ tenant_id: a.tenantId }]);
  });

  it("cannot add a line for tenant B, nor change B's device", async () => {
    // 42501: a row that breaks the policy's WITH CHECK is refused as a privilege error
    expect(
      await errorCodeAs(pg.appUrl, (sql) =>
        sql.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
          await tx`INSERT INTO sync_changes (tenant_id, entity, entity_key)
                   VALUES (${b.tenantId}, 'product', ${b.product.id})`;
        }),
      ),
    ).toBe('42501');
    // B's device is not there to change: the UPDATE finds no row
    const updated = await asAppInA(
      (tx) => tx`UPDATE devices SET name = 'Taken' WHERE id = ${b.device.id} RETURNING id`,
    );
    expect(updated).toEqual([]);
  });

  it('cannot edit or delete a line, nor delete a device, even its own', async () => {
    const inA = (statement: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      errorCodeAs(pg.appUrl, (sql) =>
        sql.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
          await statement(tx);
        }),
      );
    expect(await inA((tx) => tx`UPDATE sync_changes SET entity_key = 'x'`)).toBe('42501');
    expect(await inA((tx) => tx`DELETE FROM sync_changes`)).toBe('42501');
    expect(await inA((tx) => tx`DELETE FROM devices`)).toBe('42501');
  });
});

describe('omnivo_worker, the cleanup role', () => {
  it('sees the lines of every tenant, without a tenant context', async () => {
    const sql = postgres(pg.workerUrl, { max: 1 });
    const rows = tenantRowsSchema.parse(await sql`SELECT DISTINCT tenant_id FROM sync_changes`);
    await sql.end();
    expect(rows.map((row) => row.tenant_id).sort()).toEqual([a.tenantId, b.tenantId].sort());
  });

  it('cannot read the devices, nor add a line', async () => {
    expect(await errorCodeAs(pg.workerUrl, (sql) => sql`SELECT 1 FROM devices LIMIT 1`)).toBe(
      '42501',
    );
    expect(
      await errorCodeAs(
        pg.workerUrl,
        (sql) => sql`INSERT INTO sync_changes (tenant_id, entity, entity_key)
                     VALUES (${a.tenantId}, 'product', ${a.product.id})`,
      ),
    ).toBe('42501');
  });
});
