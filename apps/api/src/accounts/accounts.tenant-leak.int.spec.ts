import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type Account, accountListSchema, problemSchema, setupSchema } from '@omnivo/contracts';
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

// Two workspaces with a chart each: A must never see, use or change B's accounts. Every answer is
// 404 or the same "invalid group" as for an id that does not exist — never a hint that it does.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let chartOfB: Account[];

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

async function setUp(who: SignedIn, industry: 'garments' | 'pharma'): Promise<void> {
  expect((await as(who, 'POST', '/setup', { industry })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
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
  await Promise.all([setUp(tenantA, 'garments'), setUp(tenantB, 'pharma')]);
  chartOfB = accountListSchema.parse((await as(tenantB, 'GET', '/accounts')).json()).items;
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function ofB(code: string): Account {
  const found = chartOfB.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code} in B`);
  return found;
}

describe('chart of accounts isolation over HTTP', () => {
  it("never lists or reads tenant B's accounts", async () => {
    const { items } = accountListSchema.parse((await as(tenantA, 'GET', '/accounts')).json());
    const idsOfB = new Set(chartOfB.map((account) => account.id));
    expect(items.some((account) => idsOfB.has(account.id))).toBe(false);
    // Garments' finished goods, not pharma's
    expect(items.find((account) => account.code === '1154')?.name).toBe('Finished garments');
    expect((await as(tenantA, 'GET', `/accounts/${ofB('1120').id}`)).statusCode).toBe(404);
  });

  it("cannot put an account under tenant B's group", async () => {
    const res = await as(tenantA, 'POST', '/accounts', {
      parentId: ofB('1120').id,
      code: '1129',
      name: 'Borrowed group',
      isGroup: false,
      description: '',
    });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('account_parent_invalid');
  });

  it("cannot edit, archive, restore or delete tenant B's account", async () => {
    const target = ofB('5330');
    const edit = {
      parentId: target.parentId,
      code: '5330',
      name: 'Taken over',
      description: '',
      version: 1,
    };
    expect((await as(tenantA, 'PUT', `/accounts/${target.id}`, edit)).statusCode).toBe(404);
    for (const action of ['archive', 'restore']) {
      const res = await as(tenantA, 'POST', `/accounts/${target.id}/${action}`, { version: 1 });
      expect(res.statusCode).toBe(404);
    }
    expect((await as(tenantA, 'DELETE', `/accounts/${target.id}?version=1`)).statusCode).toBe(404);

    const stillThere = accountListSchema.parse((await as(tenantB, 'GET', '/accounts')).json());
    expect(stillThere.items.find((account) => account.id === target.id)).toMatchObject({
      name: 'Medical promotion and samples',
      version: 1,
      archivedAt: null,
    });
  });
});
