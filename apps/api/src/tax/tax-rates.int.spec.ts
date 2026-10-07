import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  problemSchema,
  setupSchema,
  type TaxRate,
  taxRateListSchema,
  taxRateSchema,
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

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// Nasrin: a member of Farhana's workspace with no role at all
let viewer: SignedIn;

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, as = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function rates(): Promise<TaxRate[]> {
  return taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
}

async function rate(name: string): Promise<TaxRate> {
  const found = (await rates()).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no rate ${name}`);
  return found;
}

// What the settings page's form sends for a saved rate; each test changes a few fields
function formOf(saved: TaxRate, extra: object = {}) {
  return {
    name: saved.name,
    kind: saved.kind,
    rate: saved.rate,
    isDefault: saved.isDefault,
    version: saved.version,
    ...extra,
  };
}

async function defaults(): Promise<string[]> {
  return (await rates()).filter((candidate) => candidate.isDefault).map((found) => found.name);
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

describe('VAT rates', () => {
  it('are read by anyone, and changed only with the settings permission', async () => {
    const res = await send('GET', '/tax-rates', undefined, viewer);
    expect(res.statusCode).toBe(200);
    expect(taxRateListSchema.parse(res.json()).items).toHaveLength(6);

    const add = await send(
      'POST',
      '/tax-rates',
      { name: 'VAT 2.4%', kind: 'reduced', rate: '2.4', isDefault: false },
      viewer,
    );
    expect(add.statusCode).toBe(403);
    expect(problemSchema.parse(add.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'core.settings.manage' },
    });
  });

  it('adds a rate, and refuses a name in use in any case, or a kind that does not fit', async () => {
    const res = await send('POST', '/tax-rates', {
      name: 'VAT 2.4%',
      kind: 'reduced',
      rate: '2.4',
      isDefault: false,
    });
    expect(res.statusCode).toBe(201);
    expect(taxRateSchema.parse(res.json())).toMatchObject({
      rate: '2.40',
      isDefault: false,
      version: 1,
    });

    const same = await send('POST', '/tax-rates', {
      name: 'vat 2.4%',
      kind: 'reduced',
      rate: '2.4',
      isDefault: false,
    });
    expect(same.statusCode).toBe(409);
    expect(problemSchema.parse(same.json()).fieldErrors).toEqual({
      name: ['tax_rate_name_taken'],
    });
    // A "standard 0%" would put a sale in the wrong box of the VAT return
    const zero = await send('POST', '/tax-rates', {
      name: 'VAT nil',
      kind: 'standard',
      rate: '0',
      isDefault: false,
    });
    expect(zero.statusCode).toBe(400);
    expect(problemSchema.parse(zero.json()).fieldErrors).toEqual({ rate: ['tax_rate_kind_rate'] });
  });

  it('keeps exactly one default: it moves to another rate, it is never switched off', async () => {
    const reduced = await rate('VAT 7.5%');
    const moved = await send(
      'PUT',
      `/tax-rates/${reduced.id}`,
      formOf(reduced, { isDefault: true }),
    );
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await defaults()).toEqual(['VAT 7.5%']);
    // The old default changed too, so a page that still holds it must reload it
    expect((await rate('VAT 15%')).version).toBe(2);

    const now = await rate('VAT 7.5%');
    const off = await send('PUT', `/tax-rates/${now.id}`, formOf(now, { isDefault: false }));
    expect(off.statusCode).toBe(409);
    expect(problemSchema.parse(off.json()).fieldErrors).toEqual({
      isDefault: ['tax_rate_default_needed'],
    });

    const standard = await rate('VAT 15%');
    const back = await send(
      'PUT',
      `/tax-rates/${standard.id}`,
      formOf(standard, { isDefault: true }),
    );
    expect(back.statusCode).toBe(200);
    expect(await defaults()).toEqual(['VAT 15%']);
  });

  it('lets two saves that both move the default take turns', async () => {
    // A third session holds the default row, so both saves are inside their transactions, waiting,
    // at the same moment. Without the advisory lock both would then clear the same old default,
    // neither would see the other's new one, and the unique index would refuse the second insert
    // with a database error (500).
    const sql = postgres(pg.superuserUrl, { max: 2, onnotice: () => undefined });
    const holder = await sql.reserve();
    await holder`BEGIN`;
    await holder`SELECT id FROM tax_rates WHERE is_default FOR UPDATE`;
    const saves = Promise.all([
      send('POST', '/tax-rates', {
        name: 'VAT 4.5%',
        kind: 'reduced',
        rate: '4.5',
        isDefault: true,
      }),
      send('POST', '/tax-rates', {
        name: 'VAT 1.5%',
        kind: 'reduced',
        rate: '1.5',
        isDefault: true,
      }),
    ]);
    await eventually(async () => {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`;
      expect(row?.n).toBe(2);
    });
    await holder`COMMIT`;
    holder.release();
    await sql.end();
    const [first, second] = await saves;
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(await defaults()).toHaveLength(1);

    const standard = await rate('VAT 15%');
    await send('PUT', `/tax-rates/${standard.id}`, formOf(standard, { isDefault: true }));
    expect(await defaults()).toEqual(['VAT 15%']);
  });

  it('archives any rate but the default, and brings it back', async () => {
    const standard = await rate('VAT 15%');
    const refused = await send('POST', `/tax-rates/${standard.id}/archive`, {
      version: standard.version,
    });
    expect(refused.statusCode).toBe(409);
    expect(problemSchema.parse(refused.json()).code).toBe('tax_rate_default_archived');

    const small = await rate('VAT 1.5%');
    const archived = taxRateSchema.parse(
      (await send('POST', `/tax-rates/${small.id}/archive`, { version: small.version })).json(),
    );
    expect(archived.archivedAt).not.toBeNull();
    // Archived twice is still archived, and nothing changed: the version stays
    const again = taxRateSchema.parse(
      (await send('POST', `/tax-rates/${small.id}/archive`, { version: archived.version })).json(),
    );
    expect(again.version).toBe(archived.version);
    // An archived rate cannot become the default
    const asDefault = await send(
      'PUT',
      `/tax-rates/${small.id}`,
      formOf(archived, { isDefault: true }),
    );
    expect(problemSchema.parse(asDefault.json()).code).toBe('tax_rate_default_archived');

    const restored = taxRateSchema.parse(
      (await send('POST', `/tax-rates/${small.id}/restore`, { version: archived.version })).json(),
    );
    expect(restored.archivedAt).toBeNull();
  });

  it('refuses a stale version, and logs each change for the audit', async () => {
    const reduced = await rate('VAT 10%');
    const stale = await send(
      'PUT',
      `/tax-rates/${reduced.id}`,
      formOf(reduced, { rate: '12', version: reduced.version + 1 }),
    );
    expect(problemSchema.parse(stale.json()).code).toBe('version_conflict');

    // The NBR changes a rate: only the rate, so only the rate is in the log
    const changed = await send('PUT', `/tax-rates/${reduced.id}`, formOf(reduced, { rate: '12' }));
    expect(changed.statusCode).toBe(200);
    const { items } = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=tax_rate&entityId=${reduced.id}`)).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'tax_rate.updated',
      changes: { rate: { from: '10.00', to: '12.00' } },
    });
  });
});
