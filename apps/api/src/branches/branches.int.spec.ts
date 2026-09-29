import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type Branch,
  branchListSchema,
  branchSchema,
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
  // দ্বিতীয় জন: নিজের workspace আছে, আর Rahman Garments-এ কোনো রোল ছাড়া সদস্য
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
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, as = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function create(code: string, name: string): Promise<Branch> {
  const res = await send('POST', '/branches', { code, name, phone: '', address: '' });
  expect(res.statusCode).toBe(201);
  return branchSchema.parse(res.json());
}

async function activeCodes(): Promise<string[]> {
  const { items } = branchListSchema.parse((await send('GET', '/branches')).json());
  return items.map((branch) => branch.code);
}

describe('branches', () => {
  it('starts every workspace with a head office', async () => {
    expect(await activeCodes()).toEqual(['HO']);
  });

  it('creates a branch and refuses the same code in another case', async () => {
    const gazipur = await create('gzp', 'Gazipur factory');
    expect(gazipur).toMatchObject({ code: 'GZP', version: 1, archivedAt: null });

    const res = await send('POST', '/branches', {
      code: 'GZP',
      name: 'Again',
      phone: '',
      address: '',
    });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({ code: ['branch_code_taken'] });
  });

  it('saves an edit once, then refuses the same stale version', async () => {
    const ctg = await create('CTG', 'Chattogram depot');
    const edit = { code: 'CTG', name: 'Chattogram port depot', phone: '', address: '', version: 1 };

    const first = await send('PUT', `/branches/${ctg.id}`, edit);
    expect(branchSchema.parse(first.json())).toMatchObject({ name: edit.name, version: 2 });

    const second = await send('PUT', `/branches/${ctg.id}`, { ...edit, name: 'Someone else' });
    expect(second.statusCode).toBe(409);
    expect(problemSchema.parse(second.json()).code).toBe('version_conflict');
  });

  it('answers an unknown id with 404 and a malformed one with 400', async () => {
    expect((await send('GET', '/branches/01939d1c-0000-7000-8000-000000000000')).statusCode).toBe(
      404,
    );
    const malformed = await send('GET', '/branches/not-a-uuid');
    expect(malformed.statusCode).toBe(400);
    expect(problemSchema.parse(malformed.json()).fieldErrors).toEqual({ id: ['invalid_format'] });
  });

  it('keeps at least one branch active, even when two archives race', async () => {
    // এখন চালু: CTG, GZP, HO। CTG আগে archive — বাকি দুটো নিয়ে দৌড়
    const { items } = branchListSchema.parse((await send('GET', '/branches')).json());
    const byCode = new Map(items.map((branch) => [branch.code, branch]));
    const ctg = byCode.get('CTG');
    const gzp = byCode.get('GZP');
    const ho = byCode.get('HO');
    if (!ctg || !gzp || !ho) throw new Error('setup: branches missing');
    expect(
      (await send('POST', `/branches/${ctg.id}/archive`, { version: ctg.version })).statusCode,
    ).toBe(200);

    // দৌড়টা নিশ্চিতভাবে ঘটানো: আরেকটা transaction GZP archive করে commit না করে ধরে রাখে, আর সেই
    // ফাঁকে API HO archive করতে চায়। দুটো request একসাথে পাঠালে (Promise.all) প্রায়ই একটা আরেকটার
    // আগে শেষ হয়ে যেত — lock মুছে দিলেও টেস্ট পাস করত (যাচাই করা), মানে কিছুই প্রমাণ করত না
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let pending: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      await tx`UPDATE branches SET archived_at = now(), version = version + 1 WHERE id = ${gzp.id}`;
      pending = send('POST', `/branches/${ho.id}/archive`, { version: ho.version });
      // lock থাকলে API এখানে GZP-র রো-তে আটকে থাকে; না থাকলে এর মধ্যেই 200 দিয়ে শেষ
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await superuser.end();

    const res = await pending;
    expect(res?.statusCode).toBe(409);
    expect(problemSchema.parse(res?.json()).code).toBe('branch_last_active');
    expect(await activeCodes()).toEqual(['HO']);
  });

  it('writes who changed what to the audit log', async () => {
    const res = await send('GET', '/audit-logs?entityType=branch&limit=100');
    const { items } = auditPageSchema.parse(res.json());
    const edit = items.find((entry) => entry.action === 'branch.updated');
    expect(edit).toMatchObject({
      actor: { fullName: 'Farhana Rahman' },
      // শুধু বদলানো ঘর — কোড, ফোন, ঠিকানা একই ছিল
      changes: { name: { from: 'Chattogram depot', to: 'Chattogram port depot' } },
      ipAddress: '127.0.0.1',
    });
    expect(items.filter((entry) => entry.action === 'branch.created')).toHaveLength(2);
    // CTG API দিয়ে; GZP টেস্টের SQL দিয়ে (audit ছাড়া) — তাই একটাই
    expect(items.filter((entry) => entry.action === 'branch.archived')).toHaveLength(1);
  });

  it('lets a member without the permission read branches but not change them', async () => {
    expect((await send('GET', '/branches', undefined, viewer)).statusCode).toBe(200);
    const res = await send(
      'POST',
      '/branches',
      { code: 'MYM', name: 'Mymensingh', phone: '', address: '' },
      viewer,
    );
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'core.branch.manage' },
    });
  });
});
