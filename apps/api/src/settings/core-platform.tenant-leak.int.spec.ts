import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  branchListSchema,
  branchSchema,
  meResponseSchema,
  settingsSchema,
  uploadTicketSchema,
} from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// ধাপ ৬-এর প্রতিটা নতুন endpoint-এ: টেন্যান্ট A-র টোকেন নিয়ে B-র id চাওয়া। উত্তর সবসময় 404 —
// 403 না, কারণ 403 মানে "আছে, কিন্তু তোমার না", সেটাও একটা ফাঁস
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let tenantA: SignedIn;
let tenantB: SignedIn;
let branchOfB: string;
let fileOfB: string;
let tenantBId: string;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  // storage container লাগে না: নিচের কোনো request ফাইল পর্যন্ত পৌঁছায় না (সই করা স্থানীয় হিসাব)
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
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

  const asB = bearer(tenantB.accessToken);
  const branch = await app.inject({
    method: 'POST',
    url: '/branches',
    headers: asB,
    payload: { code: 'DEPOT', name: 'Tejgaon depot', phone: '', address: '' },
  });
  branchOfB = branchSchema.parse(branch.json()).id;
  const upload = await app.inject({
    method: 'POST',
    url: '/attachments',
    headers: asB,
    payload: {
      purpose: 'company_logo',
      fileName: 'k.png',
      contentType: 'image/png',
      sizeBytes: 10,
    },
  });
  fileOfB = uploadTicketSchema.parse(upload.json()).attachment.id;
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: asB });
  tenantBId = meResponseSchema.parse(me.json()).tenant.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function asA(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(tenantA.accessToken),
    ...(payload && { payload }),
  });
}

describe('core platform isolation over HTTP', () => {
  it("never shows tenant B's branch to tenant A", async () => {
    const { items } = branchListSchema.parse((await asA('GET', '/branches')).json());
    expect(items.map((branch) => branch.code)).toEqual(['HO']);
    expect((await asA('GET', `/branches/${branchOfB}`)).statusCode).toBe(404);
  });

  it("cannot edit, archive or restore tenant B's branch", async () => {
    const edit = { code: 'DEPOT', name: 'Taken over', phone: '', address: '', version: 1 };
    expect((await asA('PUT', `/branches/${branchOfB}`, edit)).statusCode).toBe(404);
    expect((await asA('POST', `/branches/${branchOfB}/archive`, { version: 1 })).statusCode).toBe(
      404,
    );
    expect((await asA('POST', `/branches/${branchOfB}/restore`, { version: 1 })).statusCode).toBe(
      404,
    );
    const stillThere = await app.inject({
      method: 'GET',
      url: `/branches/${branchOfB}`,
      headers: bearer(tenantB.accessToken),
    });
    expect(branchSchema.parse(stillThere.json())).toMatchObject({
      name: 'Tejgaon depot',
      version: 1,
    });
  });

  it("cannot touch tenant B's files or use them as a logo", async () => {
    expect((await asA('POST', `/attachments/${fileOfB}/complete`)).statusCode).toBe(404);
    expect((await asA('GET', `/attachments/${fileOfB}/download`)).statusCode).toBe(404);
    expect((await asA('PUT', '/settings/logo', { attachmentId: fileOfB })).statusCode).toBe(404);
  });

  it('reads only its own settings and audit log', async () => {
    const settings = settingsSchema.parse((await asA('GET', '/settings')).json());
    expect(settings.companyName).toBe('Rahman Garments Ltd.');
    const { items } = auditPageSchema.parse((await asA('GET', '/audit-logs?limit=100')).json());
    expect(items.length).toBeGreaterThan(0);
    expect(
      items.some((entry) => entry.entityId === tenantBId || entry.entityId === branchOfB),
    ).toBe(false);
  });
});
