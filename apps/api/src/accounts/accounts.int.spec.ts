import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  auditPageSchema,
  meResponseSchema,
  problemSchema,
  setupSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INDUSTRY_TEMPLATES } from '../setup/templates.js';
import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import { accountCount } from '../testing/chart.js';
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
let viewer: SignedIn;
let tenantId: string;

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  // The chart comes from the setup job, so the real worker runs. No mail server: the welcome
  // email fails quietly in the background, which these tests do not look at.
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
  tenantId = meResponseSchema.parse((await send('GET', '/auth/me')).json()).tenant.id;
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

async function chart(): Promise<Account[]> {
  return accountListSchema.parse((await send('GET', '/accounts')).json()).items;
}

async function byCode(code: string): Promise<Account> {
  const found = (await chart()).find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found;
}

async function create(parentCode: string, code: string, name: string, isGroup = false) {
  const parent = await byCode(parentCode);
  return send('POST', '/accounts', { parentId: parent.id, code, name, isGroup, description: '' });
}

// The form sends every field; these tests change one or two
async function edit(
  account: Account,
  change: Partial<Record<'parentId' | 'code' | 'name', string>>,
) {
  return send('PUT', `/accounts/${account.id}`, {
    parentId: account.parentId,
    code: account.code,
    name: account.name,
    description: account.description ?? '',
    version: account.version,
    ...change,
  });
}

describe('the starting chart', () => {
  it("is the garments template, with every account in its top-level group's type", async () => {
    const accounts = await chart();
    expect(accounts).toHaveLength(accountCount(INDUSTRY_TEMPLATES.garments.chart));

    const roots = accounts.filter((account) => account.parentId === null);
    expect(roots.map((root) => [root.code, root.type, root.isGroup])).toEqual([
      ['1000', 'asset', true],
      ['2000', 'liability', true],
      ['3000', 'equity', true],
      ['4000', 'income', true],
      ['5000', 'expense', true],
    ]);
    const typeOf = new Map(accounts.map((account) => [account.id, account.type]));
    for (const account of accounts) {
      if (account.parentId !== null) expect(typeOf.get(account.parentId)).toBe(account.type);
    }
    expect(await byCode('1154')).toMatchObject({ name: 'Finished garments', purpose: 'inventory' });
  });
});

describe('adding accounts', () => {
  it("takes the group's type and refuses a code already in use", async () => {
    const res = await create('1120', '1121', 'Dutch-Bangla Bank CD A/C 1234');
    expect(res.statusCode).toBe(201);
    const bank = accountSchema.parse(res.json());
    expect(bank).toMatchObject({ type: 'asset', isGroup: false, purpose: null, version: 1 });
    expect(bank.parentId).toBe((await byCode('1120')).id);

    const again = await create('5200', '1121', 'Same code, other group');
    expect(again.statusCode).toBe(409);
    expect(problemSchema.parse(again.json()).fieldErrors).toEqual({ code: ['account_code_taken'] });
  });

  it('refuses a posting account, an unknown id and a malformed code', async () => {
    for (const parentId of [(await byCode('1110')).id, '01939d1c-0000-7000-8000-000000000000']) {
      const res = await send('POST', '/accounts', {
        parentId,
        code: '1199',
        name: 'Petty cash',
        isGroup: false,
        description: '',
      });
      expect(res.statusCode).toBe(409);
      expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
        parentId: ['account_parent_invalid'],
      });
    }
    const malformed = await create('1120', 'DBBL', 'Letters in the code');
    expect(malformed.statusCode).toBe(400);
    expect(problemSchema.parse(malformed.json()).fieldErrors).toEqual({
      code: ['account_code_format'],
    });
  });
});

describe('moving accounts', () => {
  it('moves an account to another group of its type, and logs the groups by code', async () => {
    const bank = await byCode('1121');
    const res = await edit(bank, { parentId: (await byCode('1130')).id });
    expect(res.statusCode).toBe(200);
    expect(accountSchema.parse(res.json())).toMatchObject({ version: 2 });

    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=account')).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'account.updated',
      actor: { fullName: 'Farhana Rahman' },
      changes: { parent: { from: '1120', to: '1130' } },
    });
  });

  it('refuses another type, a top-level move and a group under its own account', async () => {
    const bank = await byCode('1121');
    const otherType = await edit(bank, { parentId: (await byCode('2100')).id });
    expect(problemSchema.parse(otherType.json()).code).toBe('account_parent_invalid');

    const assets = await byCode('1000');
    const topLevel = await edit(assets, { parentId: (await byCode('1100')).id });
    expect(problemSchema.parse(topLevel.json()).code).toBe('account_parent_invalid');

    // Current assets under "Advances…", which is inside Current assets
    const current = await byCode('1100');
    const loop = await edit(current, { parentId: (await byCode('1160')).id });
    expect(loop.statusCode).toBe(409);
    expect(problemSchema.parse(loop.json()).fieldErrors).toEqual({
      parentId: ['account_parent_loop'],
    });
  });

  it('lets two moves at the same time take turns: no deadlock, and the loop is refused', async () => {
    const a = accountSchema.parse(
      (await create('1200', '1260', 'Assets under construction', true)).json(),
    );
    const b = accountSchema.parse(
      (await create('1200', '1270', 'Leasehold improvements', true)).json(),
    );

    // Replay the first move exactly as the service runs it (chart lock, lock A, then update A),
    // and start the second move (B under A) in the middle. With the chart lock the API waits for
    // the first move to commit, then sees A under B and refuses the loop. Without it, each move
    // holds its own row and waits for the other's (the parent FK needs a share lock on the new
    // parent): Postgres finds the deadlock after a second and aborts one of the two — a 500 for
    // the person, or a failed first move.
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let pending: ReturnType<typeof edit> | undefined;
    await superuser.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`ledger_accounts:${tenantId}`}, 0))`;
      await tx`SELECT id FROM ledger_accounts WHERE id = ${a.id} FOR UPDATE`;
      pending = edit(b, { parentId: a.id });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx`UPDATE ledger_accounts SET parent_id = ${b.id}, version = version + 1 WHERE id = ${a.id}`;
    });
    await superuser.end();

    const res = await pending;
    expect(res?.statusCode).toBe(409);
    expect(problemSchema.parse(res?.json()).code).toBe('account_parent_loop');
  });
});

describe('archiving and deleting', () => {
  it('protects top-level groups and system accounts', async () => {
    for (const code of ['1000', '1140']) {
      const account = await byCode(code);
      const archive = await send('POST', `/accounts/${account.id}/archive`, {
        version: account.version,
      });
      expect(problemSchema.parse(archive.json()).code).toBe('account_locked');
      const remove = await send(
        'DELETE',
        `/accounts/${account.id}?version=${String(account.version)}`,
      );
      expect(problemSchema.parse(remove.json()).code).toBe('account_locked');
    }
  });

  it('archives a group only after the accounts in it, and restores in the other order', async () => {
    const wallets = await byCode('1130');
    const first = await send('POST', `/accounts/${wallets.id}/archive`, {
      version: wallets.version,
    });
    expect(problemSchema.parse(first.json()).code).toBe('account_has_active_children');

    const bank = await byCode('1121');
    expect(
      (await send('POST', `/accounts/${bank.id}/archive`, { version: bank.version })).statusCode,
    ).toBe(200);
    const archived = await send('POST', `/accounts/${wallets.id}/archive`, {
      version: wallets.version,
    });
    expect(accountSchema.parse(archived.json()).archivedAt).not.toBeNull();

    const archivedBank = await byCode('1121');
    const early = await send('POST', `/accounts/${bank.id}/restore`, {
      version: archivedBank.version,
    });
    expect(problemSchema.parse(early.json()).code).toBe('account_parent_archived');
    // Refused, but a new account there is refused too: an archived group takes nothing new
    expect(problemSchema.parse((await create('1130', '1131', 'bKash merchant')).json()).code).toBe(
      'account_parent_invalid',
    );
  });

  it('deletes an unused account, but not a group with accounts under it', async () => {
    const wallets = await byCode('1130');
    const group = await send(
      'DELETE',
      `/accounts/${wallets.id}?version=${String(wallets.version)}`,
    );
    expect(group.statusCode).toBe(409);
    expect(problemSchema.parse(group.json()).code).toBe('account_has_children');

    const bank = await byCode('1121');
    const res = await send('DELETE', `/accounts/${bank.id}?version=${String(bank.version)}`);
    expect(res.statusCode).toBe(204);
    expect((await send('GET', `/accounts/${bank.id}`)).statusCode).toBe(404);

    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=account')).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'account.deleted',
      changes: { code: { from: '1121', to: null }, parent: { from: '1130', to: null } },
    });
  });
});

describe('permissions', () => {
  it('lets every member read the chart, but only accounting.account.manage change it', async () => {
    expect((await send('GET', '/accounts', undefined, viewer)).statusCode).toBe(200);
    const parent = await byCode('1120');
    const res = await send(
      'POST',
      '/accounts',
      { parentId: parent.id, code: '1122', name: 'BRAC Bank', isGroup: false, description: '' },
      viewer,
    );
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'accounting.account.manage' },
    });
  });
});
