import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type Member, memberPageSchema, problemSchema } from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let owner: SignedIn;

// দুজন "Abdul Karim" ইচ্ছা করে: শুধু নাম দিয়ে cursor বানালে একজন বাদ পড়ত বা দুবার আসত
const TEAM = ['Abdul Karim', 'Abdul Karim', 'Nasrin Akter', 'Shafiq Islam'];

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

  // ধাপ ৭-এর invite আসার আগে পর্যন্ত সদস্য যোগ সরাসরি SQL-এ (RLS-এর বাইরে, superuser)
  const superuser = postgres(pg.superuserUrl, { max: 1 });
  await superuser.begin(async (sql) => {
    const [tenant] = await sql<
      { id: string }[]
    >`SELECT id FROM tenants WHERE slug = 'rahman-garments'`;
    if (!tenant) throw new Error('setup: tenant missing');
    for (const [index, fullName] of TEAM.entries()) {
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO users (id, email, full_name)
        VALUES (gen_random_uuid(), ${`member${String(index)}@rahmangarments.com`}, ${fullName})
        RETURNING id`;
      if (!user) throw new Error('setup: user insert failed');
      await sql`INSERT INTO memberships (id, tenant_id, user_id) VALUES (gen_random_uuid(), ${tenant.id}, ${user.id})`;
    }
  });
  await superuser.end();
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function list(query: string) {
  return app.inject({
    method: 'GET',
    url: `/members?${query}`,
    headers: bearer(owner.accessToken),
  });
}

// cursor ধরে ধরে শেষ পাতা পর্যন্ত
async function everyPage(sort: string, limit: number): Promise<Member[][]> {
  const pages: Member[][] = [];
  let cursor: string | null = null;
  do {
    const query = `sort=${sort}&limit=${String(limit)}${cursor ? `&cursor=${cursor}` : ''}`;
    const page = memberPageSchema.parse((await list(query)).json());
    pages.push(page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

describe('keyset pagination', () => {
  it('walks the whole list in pages without skipping or repeating anyone', async () => {
    const pages = await everyPage('name', 2);
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);

    const everyone = pages.flat();
    expect(everyone.map((m) => m.fullName)).toEqual([
      'Abdul Karim',
      'Abdul Karim',
      'Farhana Rahman',
      'Nasrin Akter',
      'Shafiq Islam',
    ]);
    expect(new Set(everyone.map((m) => m.membershipId)).size).toBe(5);
    // শুধু সেই পাতার রোল — মালিকের Owner রোল ঠিক জায়গায়
    expect(everyone.find((m) => m.fullName === 'Farhana Rahman')?.roles.map((r) => r.name)).toEqual(
      ['Owner'],
    );
  });

  it('pages the same way in reverse order', async () => {
    const names = (await everyPage('-name', 2)).flat().map((m) => m.fullName);
    expect(names).toEqual([
      'Shafiq Islam',
      'Nasrin Akter',
      'Farhana Rahman',
      'Abdul Karim',
      'Abdul Karim',
    ]);
  });

  it('refuses a cursor from one sort order in another, instead of returning the wrong page', async () => {
    const first = memberPageSchema.parse((await list('sort=name&limit=2')).json());
    const res = await list(`sort=-name&limit=2&cursor=${first.nextCursor ?? ''}`);
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).code).toBe('invalid_cursor');
  });

  it('rejects a made-up cursor with 400, not a database error', async () => {
    const res = await list('cursor=bm90LWEtY3Vyc29y');
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).code).toBe('invalid_cursor');
  });

  it('rejects a page size over the limit with a field error', async () => {
    const res = await list('limit=1000');
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({ limit: ['too_large'] });
  });
});
