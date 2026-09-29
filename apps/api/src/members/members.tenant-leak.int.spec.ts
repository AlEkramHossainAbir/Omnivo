import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { memberPageSchema, meResponseSchema } from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// HTTP স্তরের leak test: আসল লগইন করা টোকেন দিয়ে, প্রতিটা এন্ডপয়েন্টে অন্য টেন্যান্টের ডেটা চাওয়া
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let tenantA: SignedIn;
let tenantBId: string;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));

  tenantA = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  const tenantB = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  const meB = meResponseSchema.parse(
    (
      await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(tenantB.accessToken) })
    ).json(),
  );
  tenantBId = meB.tenant.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('tenant isolation over HTTP', () => {
  it("tenant A's member list contains only tenant A's people", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/members',
      headers: bearer(tenantA.accessToken),
    });
    const { items } = memberPageSchema.parse(res.json());
    expect(items.map((m) => m.email)).toEqual(['farhana@rahmangarments.com']);
  });

  it('ignores a tenant id smuggled in through the old header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/members',
      headers: { ...bearer(tenantA.accessToken), 'x-tenant-id': tenantBId },
    });
    const { items } = memberPageSchema.parse(res.json());
    expect(items.map((m) => m.email)).toEqual(['farhana@rahmangarments.com']);
  });

  it('refuses to switch tenant A into tenant B', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/switch-tenant',
      headers: bearer(tenantA.accessToken),
      cookies: { omnivo_rt: tenantA.refreshToken },
      payload: { tenantId: tenantBId },
    });
    expect(res.statusCode).toBe(403);
  });
});
