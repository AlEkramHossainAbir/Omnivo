import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  fiscalYearOf,
  memberPageSchema,
  notificationPageSchema,
  problemSchema,
  type ReportExport,
  reportExportPageSchema,
  reportExportSchema,
  roleSchema,
  setupSchema,
  signedUrlSchema,
  todayIn,
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
  startStorage,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// The whole way of an export: the API stores the row and the event, the real worker writes the
// file into a real MinIO, the bell says it is ready, and the download link gives the file.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// Nasrin in Farhana's workspace, allowed to read and export reports herself
let colleague: SignedIn;
// Nasrin in her own workspace, where she is the owner
let outsider: SignedIn;
let accounts: Account[];

const today = todayIn('Asia/Dhaka');
const thisYear = fiscalYearOf(today, 7);

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, as = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

function id(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

async function exportOf(body: object): Promise<ReportExport> {
  const res = await send('POST', '/report-exports', body);
  expect(res.statusCode).toBe(201);
  return reportExportSchema.parse(res.json());
}

// Waits for the worker: the export in "My exports" with its final status
async function finished(exportId: string, as = owner): Promise<ReportExport> {
  return eventually(async () => {
    const { items } = reportExportPageSchema.parse(
      (await send('GET', '/report-exports', undefined, as)).json(),
    );
    const found = items.find((item) => item.id === exportId);
    expect(found?.status).not.toBe('pending');
    if (!found) throw new Error('export not listed');
    return found;
  }, 8_000);
}

async function download(exportId: string) {
  const res = await send('GET', `/report-exports/${exportId}/download`);
  expect(res.statusCode).toBe(200);
  const file = await fetch(signedUrlSchema.parse(res.json()).url);
  expect(file.status).toBe(200);
  return { file, bytes: new Uint8Array(await file.arrayBuffer()) };
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  [pg, redis, storage] = await Promise.all([startPostgres(), startRedis(), startStorage()]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      storageUrl: storage.url,
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
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const posted = await send('POST', '/journal-entries', {
    date: thisYear.start,
    narration: 'Export sale to H&M, Stockholm',
    lines: [
      { accountId: id('1180'), branchId: null, description: '', debit: '1842600.50', credit: '' },
      { accountId: id('4110'), branchId: null, description: '', debit: '', credit: '1842600.50' },
    ],
    post: true,
  });
  expect(posted.statusCode).toBe(201);

  // Nasrin owns a workspace of her own, and reads reports in Farhana's
  outsider = await signUp(app, {
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
  const role = roleSchema.parse(
    (await send('POST', '/roles', { name: 'Report reader', description: '' })).json(),
  );
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions: ['accounting.report.read'] }],
  });
  expect(matrix.statusCode).toBe(200);
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const nasrin = items.find((item) => item.email === 'nasrin@rahmangarments.com');
  if (!nasrin) throw new Error('Nasrin is not a member');
  const roles = await send('PUT', `/members/${nasrin.membershipId}/roles`, {
    roleIds: [role.id],
    version: nasrin.version,
  });
  expect(roles.statusCode).toBe(200);
  colleague = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), storage.container.stop()]);
});

describe('exporting a report', () => {
  it('writes an Excel file in the background and offers it for download', async () => {
    const asked = await exportOf({
      report: 'trial_balance',
      format: 'xlsx',
      query: { from: thisYear.start, to: today },
    });
    expect(asked).toMatchObject({
      status: 'pending',
      fileName: null,
      query: { from: thisYear.start, to: today },
    });

    const ready = await finished(asked.id);
    expect(ready).toMatchObject({
      status: 'ready',
      fileName: `trial-balance-${thisYear.start}-to-${today}.xlsx`,
    });
    const { file, bytes } = await download(asked.id);
    expect(file.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(file.headers.get('content-disposition')).toContain(
      `filename="trial-balance-${thisYear.start}-to-${today}.xlsx"`,
    );
    // An .xlsx file is a zip archive: it starts with "PK"
    expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toBe('PK');
    expect(bytes.byteLength).toBe(ready.sizeBytes);
  });

  it('writes a PDF, and the bell says each file is ready', async () => {
    const asked = await exportOf({
      report: 'profit_and_loss',
      format: 'pdf',
      query: { from: thisYear.start, to: today },
    });
    expect((await finished(asked.id)).status).toBe('ready');
    const { bytes } = await download(asked.id);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');

    const { items } = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(items.filter((item) => item.type === 'report.ready').map((item) => item.params)).toEqual(
      expect.arrayContaining([
        { report: 'trial_balance', format: 'xlsx' },
        { report: 'profit_and_loss', format: 'pdf' },
      ]),
    );
  });

  it('checks the query with the schema of its own report', async () => {
    const res = await send('POST', '/report-exports', {
      report: 'balance_sheet',
      format: 'pdf',
      query: { from: thisYear.start, to: today },
    });
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      'query.asOf': ['required'],
    });
  });

  it("answers 409 while the file is not written, and 404 for another person's export", async () => {
    const [pending] = await superuserSql(
      (sql) => sql<{ id: string }[]>`
        INSERT INTO report_exports (id, tenant_id, requested_by, report, format, query)
        SELECT gen_random_uuid(), m.tenant_id, m.user_id, 'balance_sheet', 'pdf',
               ${sql.json({ asOf: today })}
          FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE u.email = 'farhana@rahmangarments.com'
        RETURNING id`,
    );
    const res = await send('GET', `/report-exports/${pending?.id ?? ''}/download`);
    expect(problemSchema.parse(res.json()).code).toBe('export_not_ready');

    // Nasrin may export reports in this workspace, but this export is Farhana's: it does not
    // exist for her, in her list or by its id — and not from her own workspace either
    for (const who of [colleague, outsider]) {
      const download = await send(
        'GET',
        `/report-exports/${pending?.id ?? ''}/download`,
        undefined,
        who,
      );
      expect(download.statusCode).toBe(404);
      const { items } = reportExportPageSchema.parse(
        (await send('GET', '/report-exports', undefined, who)).json(),
      );
      expect(items).toEqual([]);
    }
  });

  it('gives up on an export that can never be written, and says so in the bell', async () => {
    // A query no report takes, written past the API (as a bug might): the job fails for good
    const [broken] = await superuserSql(async (sql) => {
      const rows = await sql<{ id: string; tenant_id: string }[]>`
        INSERT INTO report_exports (id, tenant_id, requested_by, report, format, query)
        SELECT gen_random_uuid(), m.tenant_id, m.user_id, 'trial_balance', 'xlsx',
               ${sql.json({ from: 'yesterday' })}
          FROM memberships m JOIN users u ON u.id = m.user_id
          JOIN tenants t ON t.id = m.tenant_id
         WHERE u.email = 'farhana@rahmangarments.com' AND t.slug = 'rahman-garments'
        RETURNING id, tenant_id`;
      const row = rows[0];
      if (!row) throw new Error('no export row');
      await sql`
        INSERT INTO outbox_events (id, tenant_id, type, payload)
        VALUES (gen_random_uuid(), ${row.tenant_id}, 'report.export_requested',
                ${sql.json({ exportId: row.id })})`;
      return rows;
    });
    expect((await finished(broken?.id ?? '')).status).toBe('failed');
    const { items } = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(items.find((item) => item.type === 'report.failed')?.params).toEqual({
      report: 'trial_balance',
      format: 'xlsx',
    });
  });
});
