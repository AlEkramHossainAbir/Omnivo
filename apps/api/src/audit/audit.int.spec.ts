import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuditEntry,
  auditPageSchema,
  meResponseSchema,
  preferencesSchema,
  problemSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
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
let owner: SignedIn;
let viewer: SignedIn;
let tenantId: string;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
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
  const me = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: bearer(owner.accessToken),
  });
  tenantId = meResponseSchema.parse(me.json()).tenant.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function list(query: string, as = owner) {
  return app.inject({
    method: 'GET',
    url: `/audit-logs?${query}`,
    headers: bearer(as.accessToken),
  });
}

async function everyPage(query: string, limit: number): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  let cursor: string | null = null;
  do {
    const page = auditPageSchema.parse(
      (await list(`${query}&limit=${String(limit)}${cursor ? `&cursor=${cursor}` : ''}`)).json(),
    );
    entries.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return entries;
}

describe('audit log', () => {
  it('records the workspace creation and every sign-in, newest first', async () => {
    const { items } = auditPageSchema.parse((await list('limit=50')).json());
    expect(items.map((entry) => [entry.action, entry.actor?.fullName])).toEqual([
      ['auth.signed_in', 'Nasrin Akter'],
      ['workspace.created', 'Farhana Rahman'],
    ]);
    expect(items[1]?.changes).toEqual({
      name: { from: null, to: 'Rahman Garments Ltd.' },
      slug: { from: null, to: 'rahman-garments' },
    });
  });

  it('pages through rows that share a millisecond without skipping any', async () => {
    // একই মিলিসেকেন্ডে পাঁচটা রো, মাইক্রোসেকেন্ডে আলাদা — Date-এর cursor এখানে রো হারাত।
    // ::text::timestamptz: শুধু ::timestamptz লিখলে postgres.js মানটা Date বানিয়ে পাঠাত, মাইক্রোসেকেন্ড
    // insert-এর সময়েই হারাত, আর টেস্টটা কিছুই যাচাই করত না (প্রথমবার ঠিক এটাই হয়েছিল)
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    for (const micro of ['100', '200', '300', '400', '500']) {
      await superuser`
        INSERT INTO audit_logs (id, tenant_id, action, entity_type, entity_id, created_at)
        VALUES (gen_random_uuid(), ${tenantId}, 'branch.updated', 'branch', gen_random_uuid(),
                ${`2026-09-23 10:15:30.123${micro}+00`}::text::timestamptz)`;
    }
    await superuser.end();

    const all = await everyPage('entityType=branch', 2);
    expect(all).toHaveLength(5);
    expect(new Set(all.map((entry) => entry.id)).size).toBe(5);
  });

  it('filters one entity type', async () => {
    const all = await everyPage('entityType=workspace', 10);
    expect(all.map((entry) => entry.action)).toEqual(['workspace.created']);
  });

  it('is only for members with core.audit.read', async () => {
    const res = await list('limit=10', viewer);
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json()).params).toEqual({ permissions: 'core.audit.read' });
  });
});

describe('preferences', () => {
  function patch(payload: object) {
    return app.inject({
      method: 'PATCH',
      url: '/me/preferences',
      headers: bearer(viewer.accessToken),
      payload,
    });
  }

  it('saves language and theme separately, and returns them with /auth/me', async () => {
    expect(preferencesSchema.parse((await patch({ language: 'bn' })).json())).toEqual({
      language: 'bn',
      theme: 'system',
    });
    // শুধু থিম পাঠালে ভাষা অক্ষত থাকে
    expect(preferencesSchema.parse((await patch({ theme: 'dark' })).json())).toEqual({
      language: 'bn',
      theme: 'dark',
    });
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(viewer.accessToken),
    });
    expect(meResponseSchema.parse(me.json()).preferences).toEqual({
      language: 'bn',
      theme: 'dark',
    });
  });

  it('refuses a language the app does not have', async () => {
    const res = await patch({ language: 'fr' });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({ language: ['invalid_value'] });
  });
});
