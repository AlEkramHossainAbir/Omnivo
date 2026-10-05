import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  meResponseSchema,
  numberSeriesListSchema,
  numberSeriesSchema,
  periodOf,
  problemSchema,
  todayIn,
} from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import { NumberingService } from './numbering.service.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let owner: SignedIn;
let tenantId: string;
let numbering: NumberingService;
let withTenant: WithTenant;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  owner = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  const me = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: bearer(owner.accessToken),
  });
  tenantId = meResponseSchema.parse(me.json()).tenant.id;
  // পরের ধাপের মডিউল যেভাবে ডাকবে ঠিক সেভাবে: নিজের transaction-এর ভেতর থেকে next()
  numbering = app.get(NumberingService);
  withTenant = app.get<WithTenant>(WITH_TENANT);
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function allocate(date: string): Promise<string> {
  return runWithTenant(tenantId, () =>
    withTenant((tx) => numbering.next(tx, 'sales.invoice', date)),
  );
}

describe('numbering allocation', () => {
  it('hands out 20 concurrent numbers without a duplicate or a gap', async () => {
    const numbers = await Promise.all(Array.from({ length: 20 }, () => allocate('2026-09-23')));
    expect(numbers.toSorted()).toEqual(
      Array.from({ length: 20 }, (_, i) => `INV-2026-27-${String(i + 1).padStart(4, '0')}`),
    );
  });

  it('gives a rolled-back number to the next document, so no gap appears', async () => {
    await expect(
      runWithTenant(tenantId, () =>
        withTenant(async (tx) => {
          expect(await numbering.next(tx, 'sales.invoice', '2026-09-23')).toBe('INV-2026-27-0021');
          throw new Error('invoice failed to save');
        }),
      ),
    ).rejects.toThrow('invoice failed to save');
    expect(await allocate('2026-09-23')).toBe('INV-2026-27-0021');
  });

  it('starts again at 0001 when the fiscal year turns', async () => {
    expect(await allocate('2027-06-30')).toBe('INV-2026-27-0022');
    expect(await allocate('2027-07-01')).toBe('INV-2027-28-0001');
  });
});

describe('number series endpoints', () => {
  function send(method: 'GET' | 'PUT', url: string, payload?: object) {
    return app.inject({
      method,
      url,
      headers: bearer(owner.accessToken),
      ...(payload && { payload }),
    });
  }

  it('lists every document type with its next number, without using it up', async () => {
    const today = periodOf(todayIn('Asia/Dhaka'), 'fiscal', 7);
    const { items } = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
    expect(items.map((series) => series.documentType)).toHaveLength(9);
    // Stock documents (step 13): numbered by fiscal year, like the journal
    expect(items.find((series) => series.documentType === 'inventory.transfer')).toMatchObject({
      prefix: 'TRF',
      nextNumber: `TRF-${today}-0001`,
    });
    // Product codes (step 12): no year in them, five digits
    expect(items.find((series) => series.documentType === 'inventory.product')).toMatchObject({
      prefix: 'P',
      yearStyle: 'none',
      nextNumber: 'P-00001',
    });
    expect(items.find((series) => series.documentType === 'purchase.order')).toMatchObject({
      prefix: 'PO',
      version: 0,
      nextNumber: `PO-${today}-0001`,
    });
    // দুবার দেখলেও একই — প্রিভিউ কাউন্টার বাড়ায় না
    const again = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
    expect(again.items).toEqual(items);
  });

  it('saves a new format on version 0, then refuses a second version-0 save', async () => {
    const change = { prefix: 'jv', yearStyle: 'calendar', padding: 5, version: 0 };
    const res = await send('PUT', '/number-series/accounting.journal', change);
    expect(numberSeriesSchema.parse(res.json())).toMatchObject({
      prefix: 'JV',
      version: 1,
      nextNumber: `JV-${todayIn('Asia/Dhaka').slice(0, 4)}-00001`,
    });

    const stale = await send('PUT', '/number-series/accounting.journal', change);
    expect(stale.statusCode).toBe(409);
    expect(problemSchema.parse(stale.json()).code).toBe('version_conflict');
  });

  it('refuses a document type that does not exist', async () => {
    const res = await send('PUT', '/number-series/sales.quote', {
      prefix: 'QT',
      yearStyle: 'none',
      padding: 4,
      version: 0,
    });
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toHaveProperty('documentType');
  });
});
