import { inflateRawSync } from 'node:zlib';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  branchListSchema,
  customerSchema,
  fiscalYearOf,
  invoiceSchema,
  memberPageSchema,
  notificationPageSchema,
  problemSchema,
  productSchema,
  type ReportExport,
  reportExportPageSchema,
  reportExportSchema,
  roleListSchema,
  roleSchema,
  setupSchema,
  signedUrlSchema,
  taxRateListSchema,
  todayIn,
  unitListSchema,
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

// Step 21b: the four new kinds, each with its own permission (decision 14), and the cost a file
// shows only to someone who may see it now (decision 38)
describe('exporting the sales and purchase reports and the agings', () => {
  // Shirin reads the sales report and its agings, nothing else: no purchases, no stock value
  let shirin: SignedIn;
  let shirinsRole: { id: string; version: number };
  let shirinsExport: ReportExport;
  const period = { from: thisYear.start, to: today };

  // The text of every file inside an .xlsx, which is a zip archive: each entry found through the
  // central directory at the end, then inflated (method 8) or taken as it is (method 0, stored).
  // The sizes are read from the central directory, because a zip written as a stream leaves them
  // out of the entry's own header.
  function xlsxText(bytes: Uint8Array): string {
    const data = Buffer.from(bytes);
    const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = data.readUInt16LE(end + 10);
    let at = data.readUInt32LE(end + 16);
    const parts: string[] = [];
    for (let entry = 0; entry < count; entry += 1) {
      const method = data.readUInt16LE(at + 10);
      const size = data.readUInt32LE(at + 20);
      const header = data.readUInt32LE(at + 42);
      const start = header + 30 + data.readUInt16LE(header + 26) + data.readUInt16LE(header + 28);
      const body = data.subarray(start, start + size);
      parts.push((method === 8 ? inflateRawSync(body) : body).toString('utf8'));
      at +=
        46 + data.readUInt16LE(at + 28) + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    }
    return parts.join('\n');
  }

  // The two customers in the order the file has them (a name the file lacks is left out)
  function rowsIn(file: string): string[] {
    return ['Alpha Knit', 'Zeta Knit']
      .filter((name) => file.includes(name))
      .toSorted((a, b) => file.indexOf(a) - file.indexOf(b));
  }

  async function exportAs(who: SignedIn, body: object): Promise<ReportExport> {
    const res = await send('POST', '/report-exports', body, who);
    expect(res.statusCode, res.body).toBe(201);
    return reportExportSchema.parse(res.json());
  }

  // The text of a finished export's file, downloaded by the person who asked for it
  async function fileOf(exportId: string, who = owner): Promise<string> {
    expect((await finished(exportId, who)).status).toBe('ready');
    const res = await send('GET', `/report-exports/${exportId}/download`, undefined, who);
    expect(res.statusCode, res.body).toBe(200);
    const file = await fetch(signedUrlSchema.parse(res.json()).url);
    return xlsxText(new Uint8Array(await file.arrayBuffer()));
  }

  beforeAll(async () => {
    // Two washing jobs, billed: Zeta Knit's ৳900 is more than Alpha Knit's ৳100, and a service has
    // no cost, so a file sorted by the cost lists them by name and one sorted by the net does not
    const pcs = unitListSchema
      .parse((await send('GET', '/units')).json())
      .items.find((unit) => unit.code === 'pcs');
    const exempt = taxRateListSchema
      .parse((await send('GET', '/tax-rates')).json())
      .items.find((rate) => rate.name === 'Exempt');
    if (!pcs || !exempt) throw new Error('no pcs or Exempt');
    const [branch] = branchListSchema.parse((await send('GET', '/branches')).json()).items;
    if (!branch) throw new Error('sign-up made no branch');
    const branchId = branch.id;
    const made = await send('POST', '/products', {
      code: '',
      name: 'Garment washing',
      type: 'service',
      categoryId: '',
      description: '',
      baseUnitId: pcs.id,
      salesUnitId: '',
      purchaseUnitId: '',
      tracking: 'none',
      hasExpiry: false,
      taxRateId: '',
      options: [],
      variants: [
        { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
      ],
      units: [],
      customFields: {},
    });
    expect(made.statusCode, made.body).toBe(201);
    const washing = productSchema.parse(made.json());
    for (const [name, price] of [
      ['Alpha Knit', '100'],
      ['Zeta Knit', '900'],
    ] as const) {
      const customer = await send('POST', '/customers', {
        code: '',
        name,
        groupId: '',
        contactPerson: '',
        phone: '',
        email: '',
        documentLanguage: 'en',
        bin: '',
        paymentTermsDays: 0,
        creditLimit: '',
        priceListId: '',
        notes: '',
        addresses: [],
      });
      expect(customer.statusCode, customer.body).toBe(201);
      const invoice = await send('POST', '/invoices', {
        customerId: customerSchema.parse(customer.json()).id,
        date: today,
        dueDate: '',
        customerReference: '',
        branchId: branchId,
        warehouseId: '',
        note: '',
        lines: [
          {
            variantId: washing.variants[0]?.id ?? '',
            unitId: pcs.id,
            quantity: '1',
            description: '',
            unitPrice: price,
            discountType: 'percent',
            discount: '',
            taxRateId: exempt.id,
            deliveryLineId: '',
            orderLineId: '',
            batchId: '',
            serialNumbers: [],
          },
        ],
        post: true,
      });
      expect(invoice.statusCode, invoice.body).toBe(201);
      invoiceSchema.parse(invoice.json());
    }

    await signUp(app, {
      companyName: 'Shirin Fabrics',
      workspaceSlug: 'shirin-fabrics',
      fullName: 'Shirin Akter',
      email: 'shirin@rahmangarments.com',
      password: 'Sales-desk-2026',
    });
    await joinWithoutRoles(pg.superuserUrl, {
      email: 'shirin@rahmangarments.com',
      workspace: 'rahman-garments',
    });
    const role = roleSchema.parse(
      (await send('POST', '/roles', { name: 'Sales desk', description: '' })).json(),
    );
    const matrix = await send('PUT', '/permission-matrix', {
      roles: [{ id: role.id, version: role.version, permissions: ['sales.report.read'] }],
    });
    expect(matrix.statusCode).toBe(200);
    const saved = roleListSchema.parse(matrix.json()).items.find((item) => item.id === role.id);
    if (!saved) throw new Error('the role is gone');
    shirinsRole = { id: saved.id, version: saved.version };
    const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
    const found = items.find((item) => item.email === 'shirin@rahmangarments.com');
    if (!found) throw new Error('Shirin is not a member');
    const roles = await send('PUT', `/members/${found.membershipId}/roles`, {
      roleIds: [role.id],
      version: found.version,
    });
    expect(roles.statusCode).toBe(200);
    shirin = await logIn(app, {
      workspace: 'rahman-garments',
      email: 'shirin@rahmangarments.com',
      password: 'Sales-desk-2026',
      keepSignedIn: false,
    });
  }, 120_000);

  it('writes each new kind, named by its period or its day', async () => {
    const asked = await Promise.all([
      exportOf({
        report: 'sales_report',
        format: 'xlsx',
        query: { ...period, groupBy: 'product' },
      }),
      exportOf({ report: 'purchase_report', format: 'pdf', query: period }),
      exportOf({ report: 'ar_aging', format: 'pdf', query: { asOf: today, show: 'overdue' } }),
      exportOf({ report: 'ap_aging', format: 'xlsx', query: { asOf: today } }),
    ]);
    const ready = await Promise.all(asked.map((item) => finished(item.id)));
    expect(ready.map((item) => [item.report, item.status, item.fileName])).toEqual([
      ['sales_report', 'ready', `sales-${thisYear.start}-to-${today}.xlsx`],
      ['purchase_report', 'ready', `purchases-${thisYear.start}-to-${today}.pdf`],
      ['ar_aging', 'ready', `receivables-aging-${today}.pdf`],
      ['ap_aging', 'ready', `payables-aging-${today}.xlsx`],
    ]);
    // The defaults the schema filled in are kept, so the list shows what the file holds
    expect(asked[2].query).toEqual({ asOf: today, show: 'overdue', sort: '-balance' });
  });

  it("asks for each report's own permission, and for the stock value to sort by the cost", async () => {
    const purchases = await send(
      'POST',
      '/report-exports',
      { report: 'purchase_report', format: 'pdf', query: period },
      shirin,
    );
    expect(purchases.statusCode).toBe(403);
    expect(problemSchema.parse(purchases.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'purchase.report.read' },
    });
    const byCost = await send(
      'POST',
      '/report-exports',
      { report: 'sales_report', format: 'xlsx', query: { ...period, sort: '-margin' } },
      shirin,
    );
    expect(problemSchema.parse(byCost.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'inventory.stock.value' },
    });
    // The accounting reports are not hers either, and the sales report is not Nasrin's
    const trial = await send(
      'POST',
      '/report-exports',
      { report: 'trial_balance', format: 'pdf', query: period },
      shirin,
    );
    expect(trial.statusCode).toBe(403);
    const notNasrins = await send(
      'POST',
      '/report-exports',
      { report: 'ar_aging', format: 'pdf', query: { asOf: today } },
      colleague,
    );
    expect(notNasrins.statusCode).toBe(403);
  });

  it('leaves the cost out of the file of someone who may not see it', async () => {
    const owners = await fileOf(
      (await exportOf({ report: 'sales_report', format: 'xlsx', query: period })).id,
    );
    expect(owners).toContain('Margin %');
    shirinsExport = await exportAs(shirin, {
      report: 'sales_report',
      format: 'xlsx',
      query: period,
    });
    const hers = await fileOf(shirinsExport.id, shirin);
    expect(hers).toContain('Net sales');
    expect(hers).not.toContain('Margin');
    expect(rowsIn(hers)).toEqual(['Zeta Knit', 'Alpha Knit']);
  });

  it('sorts by the net a file asked by the cost, when the cost is no longer allowed', async () => {
    // As if Shirin had the stock value when she asked, and lost it before the worker got there: the
    // row and its event are written past the API, which would refuse this sort today
    const [row] = await superuserSql(async (sql) => {
      const rows = await sql<{ id: string; tenant_id: string }[]>`
        INSERT INTO report_exports (id, tenant_id, requested_by, report, format, query)
        SELECT gen_random_uuid(), m.tenant_id, m.user_id, 'sales_report', 'xlsx',
               ${sql.json({ ...period, groupBy: 'customer', sort: 'cost' })}
          FROM memberships m JOIN users u ON u.id = m.user_id
          JOIN tenants t ON t.id = m.tenant_id
         WHERE u.email = 'shirin@rahmangarments.com' AND t.slug = 'rahman-garments'
        RETURNING id, tenant_id`;
      const first = rows[0];
      if (!first) throw new Error('no export row');
      await sql`
        INSERT INTO outbox_events (id, tenant_id, type, payload)
        VALUES (gen_random_uuid(), ${first.tenant_id}, 'report.export_requested',
                ${sql.json({ exportId: first.id })})`;
      return rows;
    });
    const file = await fileOf(row?.id ?? '', shirin);
    expect((await finished(row?.id ?? '', shirin)).fileName).toBe(
      `sales-${thisYear.start}-to-${today}.xlsx`,
    );
    expect(file).not.toContain('Margin');
    // By the cost (all ৳0) the names would decide: Alpha first. By the net, Zeta first.
    expect(rowsIn(file)).toEqual(['Zeta Knit', 'Alpha Knit']);
  });

  it('hides an export of a report its owner can no longer read, and refuses its download', async () => {
    const matrix = await send('PUT', '/permission-matrix', {
      roles: [{ id: shirinsRole.id, version: shirinsRole.version, permissions: [] }],
    });
    expect(matrix.statusCode, matrix.body).toBe(200);
    const { items } = reportExportPageSchema.parse(
      (await send('GET', '/report-exports', undefined, shirin)).json(),
    );
    expect(items).toEqual([]);
    const refused = await send(
      'GET',
      `/report-exports/${shirinsExport.id}/download`,
      undefined,
      shirin,
    );
    expect(refused.statusCode).toBe(403);
    expect(problemSchema.parse(refused.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'sales.report.read' },
    });
  });
});
