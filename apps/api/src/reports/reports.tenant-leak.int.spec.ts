import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  branchSchema,
  fiscalYearListSchema,
  fiscalYearOf,
  profitAndLossSchema,
  reportExportPageSchema,
  setupSchema,
  shiftIsoDate,
  todayIn,
  trialBalanceSchema,
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
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// Two workspaces with books of their own. A report is one big SUM over the journal: a single
// missing tenant filter would add B's money into A's totals. Every number A sees must be A's.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let branchOfB: string;
let exportOfB: string;

const today = todayIn('Asia/Dhaka');
const thisYear = fiscalYearOf(today, 7);
const lastYear = fiscalYearOf(shiftIsoDate(thisYear.start, -1), 7);

function as(who: SignedIn, method: 'GET' | 'POST', url: string, payload?: object) {
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
  const [, chartOfB] = await Promise.all([setUp(tenantA, 'garments'), setUp(tenantB, 'pharma')]);

  // Only B has books: last year's sales and this year's, on a branch of B's
  branchOfB = branchSchema.parse(
    (
      await as(tenantB, 'POST', '/branches', {
        code: 'MYM',
        name: 'Mymensingh depot',
        phone: '',
        address: '',
      })
    ).json(),
  ).id;
  for (const date of [lastYear.start, thisYear.start]) {
    const res = await as(tenantB, 'POST', '/journal-entries', {
      date,
      narration: 'Sales at the depot',
      lines: [
        {
          accountId: idIn(chartOfB, '1110'),
          branchId: branchOfB,
          description: '',
          debit: '900000',
          credit: '',
        },
        {
          accountId: idIn(chartOfB, '4110'),
          branchId: branchOfB,
          description: '',
          debit: '',
          credit: '900000',
        },
      ],
      post: true,
    });
    expect(res.statusCode).toBe(201);
  }

  // A finished export of B's, written straight into the table: no storage is needed to ask for it
  const sql = postgres(pg.superuserUrl, { max: 1 });
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO report_exports (id, tenant_id, requested_by, report, format, query, status,
                                file_name, content_type, size_bytes, storage_key, finished_at)
    SELECT gen_random_uuid(), m.tenant_id, m.user_id, 'trial_balance', 'pdf',
           ${sql.json({ from: thisYear.start, to: today })}, 'ready', 'trial-balance.pdf',
           'application/pdf', 1024, 'tenants/b/report-exports/x.pdf', now()
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE u.email = 'karim@karimpharma.com'
    RETURNING id`;
  await sql.end();
  exportOfB = row?.id ?? '';
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('report isolation over HTTP', () => {
  it("adds none of tenant B's money into tenant A's reports", async () => {
    const tb = trialBalanceSchema.parse(
      (
        await as(tenantA, 'GET', `/reports/trial-balance?from=${lastYear.start}&to=${today}`)
      ).json(),
    );
    expect(tb.rows).toEqual([]);
    expect(tb.totals.closingDebit).toBe('0.0000');
    // Even with B's own branch as the filter
    const pl = profitAndLossSchema.parse(
      (
        await as(
          tenantA,
          'GET',
          `/reports/profit-and-loss?from=${lastYear.start}&to=${today}&branchId=${branchOfB}`,
        )
      ).json(),
    );
    expect(pl.netProfit).toBe('0.0000');
    expect(pl.income.rows).toEqual([]);
    // B sees its own sales, so the books above were really there
    const own = trialBalanceSchema.parse(
      (
        await as(tenantB, 'GET', `/reports/trial-balance?from=${lastYear.start}&to=${today}`)
      ).json(),
    );
    expect(own.totals.closingDebit).toBe('1800000.0000');
  });

  it("does not list tenant B's years, and cannot close them", async () => {
    const years = fiscalYearListSchema.parse((await as(tenantA, 'GET', '/fiscal-years')).json());
    // A has no entries: only the current year, with nothing in it
    expect(years.items.map((year) => [year.start, year.netProfit])).toEqual([
      [thisYear.start, '0.0000'],
    ]);
    const close = await as(tenantA, 'POST', '/fiscal-years/close', { end: lastYear.end });
    expect(close.statusCode).toBe(409);
    // B's year is untouched: still open
    const ofB = fiscalYearListSchema.parse((await as(tenantB, 'GET', '/fiscal-years')).json());
    expect(ofB.items.find((year) => year.end === lastYear.end)?.status).toBe('open');
  });

  it("never lists or downloads tenant B's exports", async () => {
    const { items } = reportExportPageSchema.parse(
      (await as(tenantA, 'GET', '/report-exports')).json(),
    );
    expect(items).toEqual([]);
    expect((await as(tenantA, 'GET', `/report-exports/${exportOfB}/download`)).statusCode).toBe(
      404,
    );
  });
});
