import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  branchListSchema,
  type JournalEntry,
  journalEntrySchema,
  journalPageSchema,
  problemSchema,
  setupSchema,
} from '@omnivo/contracts';
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

// Two workspaces with books of their own: A must never see, change or post into B's. Every answer
// is 404, or the same "invalid account" as for an id that does not exist.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let chartOfA: Account[];
let chartOfB: Account[];
let entryOfB: JournalEntry;
let draftOfB: JournalEntry;

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

async function setUp(who: SignedIn, industry: 'garments' | 'pharma'): Promise<Account[]> {
  expect((await as(who, 'POST', '/setup', { industry })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
  return accountListSchema.parse((await as(who, 'GET', '/accounts')).json()).items;
}

function idIn(chart: Account[], code: string): string {
  const found = chart.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function line(accountId: string, side: 'debit' | 'credit', branchId: string | null = null) {
  return {
    accountId,
    branchId,
    description: '',
    debit: side === 'debit' ? '1000' : '',
    credit: side === 'credit' ? '1000' : '',
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
  [chartOfA, chartOfB] = await Promise.all([setUp(tenantA, 'garments'), setUp(tenantB, 'pharma')]);

  const entry = {
    date: '2026-09-15',
    narration: 'Medical samples for Mymensingh',
    lines: [line(idIn(chartOfB, '5330'), 'debit'), line(idIn(chartOfB, '1110'), 'credit')],
  };
  entryOfB = journalEntrySchema.parse(
    (await as(tenantB, 'POST', '/journal-entries', { ...entry, post: true })).json(),
  );
  draftOfB = journalEntrySchema.parse(
    (await as(tenantB, 'POST', '/journal-entries', { ...entry, post: false })).json(),
  );
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('journal isolation over HTTP', () => {
  it("never lists or reads tenant B's entries or ledgers", async () => {
    const { items } = journalPageSchema.parse(
      (await as(tenantA, 'GET', '/journal-entries')).json(),
    );
    expect(items).toEqual([]);
    expect((await as(tenantA, 'GET', `/journal-entries/${entryOfB.id}`)).statusCode).toBe(404);
    const ledger = await as(tenantA, 'GET', `/accounts/${idIn(chartOfB, '1110')}/ledger`);
    expect(ledger.statusCode).toBe(404);
  });

  it("cannot change, post, reverse or delete tenant B's entries", async () => {
    const body = {
      date: '2026-09-15',
      narration: 'Taken over',
      lines: [line(idIn(chartOfA, '5310'), 'debit'), line(idIn(chartOfA, '1110'), 'credit')],
      post: false,
      version: draftOfB.version,
    };
    expect((await as(tenantA, 'PUT', `/journal-entries/${draftOfB.id}`, body)).statusCode).toBe(
      404,
    );
    const post = await as(tenantA, 'POST', `/journal-entries/${draftOfB.id}/post`, {
      version: draftOfB.version,
    });
    expect(post.statusCode).toBe(404);
    const reverse = await as(tenantA, 'POST', `/journal-entries/${entryOfB.id}/reverse`, {
      version: entryOfB.version,
      date: '2026-09-16',
    });
    expect(reverse.statusCode).toBe(404);
    const remove = await as(
      tenantA,
      'DELETE',
      `/journal-entries/${draftOfB.id}?version=${String(draftOfB.version)}`,
    );
    expect(remove.statusCode).toBe(404);

    const still = journalEntrySchema.parse(
      (await as(tenantB, 'GET', `/journal-entries/${draftOfB.id}`)).json(),
    );
    expect(still).toMatchObject({ status: 'draft', version: draftOfB.version });
    const { items } = journalPageSchema.parse(
      (await as(tenantB, 'GET', '/journal-entries')).json(),
    );
    expect(items.find((entry) => entry.id === entryOfB.id)?.reversedBy).toBeNull();
  });

  it("cannot post to tenant B's accounts, branches or opening balances", async () => {
    const accountOfB = await as(tenantA, 'POST', '/journal-entries', {
      date: '2026-09-15',
      narration: 'Borrowed account',
      lines: [line(idIn(chartOfB, '1110'), 'debit'), line(idIn(chartOfA, '3100'), 'credit')],
      post: false,
    });
    expect(problemSchema.parse(accountOfB.json()).fieldErrors).toEqual({
      'lines.0.accountId': ['journal_account_invalid'],
    });

    const branchOfB = branchListSchema.parse((await as(tenantB, 'GET', '/branches')).json())
      .items[0];
    const borrowedBranch = await as(tenantA, 'POST', '/journal-entries', {
      date: '2026-09-15',
      narration: 'Borrowed branch',
      lines: [
        line(idIn(chartOfA, '1110'), 'debit', branchOfB?.id ?? null),
        line(idIn(chartOfA, '3100'), 'credit'),
      ],
      post: false,
    });
    expect(problemSchema.parse(borrowedBranch.json()).fieldErrors).toEqual({
      'lines.0.branchId': ['journal_branch_invalid'],
    });

    const opening = await as(tenantA, 'PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [{ accountId: idIn(chartOfB, '1110'), debit: '500', credit: '' }],
    });
    expect(problemSchema.parse(opening.json()).fieldErrors).toEqual({
      'lines.0.accountId': ['opening_account_invalid'],
    });
  });
});
