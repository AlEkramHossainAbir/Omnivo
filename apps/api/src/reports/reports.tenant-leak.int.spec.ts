import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  agingReportSchema,
  billSchema,
  branchSchema,
  customerGroupSchema,
  customerSchema,
  fiscalYearListSchema,
  fiscalYearOf,
  invoiceSchema,
  memberPageSchema,
  productCategoryListSchema,
  productSchema,
  profitAndLossSchema,
  purchaseReportSchema,
  reportExportPageSchema,
  type ReportSchedule,
  reportScheduleCandidateListSchema,
  reportScheduleListSchema,
  reportScheduleSchema,
  salesReportSchema,
  setupSchema,
  shiftIsoDate,
  stockMovementReportSchema,
  supplierGroupSchema,
  supplierSchema,
  taxRateListSchema,
  todayIn,
  trialBalanceSchema,
  unitListSchema,
  vatDocumentPageSchema,
  vatReportSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';

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

// Step 21b: the sales and purchase reports and the agings read documents, not only the journal.
// B sells a delivery to a pharmacy and buys a repair, both on B's own branch, group and category.
describe('trade reports and agings over HTTP', () => {
  let customerOfB: string;
  let supplierOfB: string;
  let customerGroupOfB: string;
  let supplierGroupOfB: string;
  let categoryOfB: string;
  const period = `from=${lastYear.start}&to=${today}`;

  async function created<T>(schema: z.ZodType<T>, url: string, body: object): Promise<T> {
    const res = await as(tenantB, 'POST', url, body);
    expect(res.statusCode, res.body).toBe(201);
    return schema.parse(res.json());
  }

  async function read<T>(who: SignedIn, schema: z.ZodType<T>, url: string): Promise<T> {
    const res = await as(who, 'GET', url);
    expect(res.statusCode, res.body).toBe(200);
    return schema.parse(res.json());
  }

  beforeAll(async () => {
    const chart = accountListSchema.parse((await as(tenantB, 'GET', '/accounts')).json()).items;
    const pcs = unitListSchema
      .parse((await as(tenantB, 'GET', '/units')).json())
      .items.find((unit) => unit.code === 'pcs');
    const exempt = taxRateListSchema
      .parse((await as(tenantB, 'GET', '/tax-rates')).json())
      .items.find((rate) => rate.name === 'Exempt');
    const [category] = productCategoryListSchema.parse(
      (await as(tenantB, 'GET', '/product-categories')).json(),
    ).items;
    if (!pcs || !exempt || !category)
      throw new Error("B's setup is missing a unit, rate or category");
    categoryOfB = category.id;
    const delivery = await created(productSchema, '/products', {
      code: '',
      name: 'Cold-chain delivery',
      type: 'service',
      categoryId: categoryOfB,
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
      // The pharma template asks for the generic name
      customFields: { generic_name: 'Delivery' },
    });
    customerGroupOfB = (
      await created(customerGroupSchema, '/customer-groups', { name: 'Hospital pharmacies' })
    ).id;
    supplierGroupOfB = (
      await created(supplierGroupSchema, '/supplier-groups', { name: 'Service vendors' })
    ).id;
    customerOfB = (
      await created(customerSchema, '/customers', {
        code: '',
        name: 'Mymensingh Medical Pharmacy',
        groupId: customerGroupOfB,
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
      })
    ).id;
    supplierOfB = (
      await created(supplierSchema, '/suppliers', {
        code: '',
        name: 'Brahmaputra Cold Storage',
        groupId: supplierGroupOfB,
        contactPerson: '',
        phone: '',
        email: '',
        documentLanguage: 'en',
        bin: '',
        paymentTermsDays: 0,
        address: '',
        bankAccounts: [],
        notes: '',
      })
    ).id;
    await created(invoiceSchema, '/invoices', {
      customerId: customerOfB,
      date: today,
      dueDate: '',
      customerReference: '',
      branchId: branchOfB,
      warehouseId: '',
      note: '',
      lines: [
        {
          variantId: delivery.variants[0]?.id ?? '',
          unitId: pcs.id,
          quantity: '1',
          description: '',
          unitPrice: '75000',
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
    await created(billSchema, '/bills', {
      supplierId: supplierOfB,
      date: today,
      dueDate: '',
      supplierBillNumber: 'BCS-2026-77',
      mushakNumber: '',
      mushakDate: '',
      branchId: branchOfB,
      warehouseId: '',
      pricesIncludeVat: false,
      note: '',
      lines: [],
      expenses: [
        {
          accountId: idIn(chart, '5270'),
          description: 'Cold room compressor repair',
          amount: '42000',
          taxRateId: exempt.id,
        },
      ],
      submit: true,
    });
  }, 120_000);

  it("adds none of B's documents into A's reports, whatever ids A's query names", async () => {
    for (const filter of [
      '',
      `&branchId=${branchOfB}`,
      `&customerGroupId=${customerGroupOfB}`,
      `&categoryId=${categoryOfB}`,
    ]) {
      for (const groupBy of ['customer', 'product', 'category', 'branch', 'month']) {
        const report = await read(
          tenantA,
          salesReportSchema,
          `/reports/sales?${period}&groupBy=${groupBy}${filter}`,
        );
        expect(report.items, `${groupBy}${filter}`).toEqual([]);
        expect(report.totals.net).toBe('0.0000');
      }
    }
    // B's books have sales on that branch (the journal entries above); A's have none
    expect(
      (await read(tenantA, salesReportSchema, `/reports/sales?${period}&branchId=${branchOfB}`))
        .books,
    ).toBe('0.0000');
    for (const filter of [
      '',
      `&supplierGroupId=${supplierGroupOfB}`,
      `&categoryId=${categoryOfB}`,
    ]) {
      for (const groupBy of ['supplier', 'product', 'account', 'month']) {
        const report = await read(
          tenantA,
          purchaseReportSchema,
          `/reports/purchases?${period}&groupBy=${groupBy}${filter}`,
        );
        expect(report.items, `${groupBy}${filter}`).toEqual([]);
      }
    }
    // B sees its own, so the documents above were really there
    const own = await read(tenantB, salesReportSchema, `/reports/sales?${period}`);
    expect(own.totals.net).toBe('75000.0000');
    const ownPurchases = await read(tenantB, purchaseReportSchema, `/reports/purchases?${period}`);
    expect(ownPurchases.totals.net).toBe('42000.0000');
  });

  it("owes A nothing of B's, and finds none of B's customers or suppliers", async () => {
    for (const url of [
      `/reports/ar-aging?asOf=${today}`,
      `/reports/ar-aging?asOf=${today}&customerGroupId=${customerGroupOfB}`,
      `/reports/ap-aging?asOf=${today}`,
      `/reports/ap-aging?asOf=${today}&supplierGroupId=${supplierGroupOfB}`,
    ]) {
      const aging = await read(tenantA, agingReportSchema, url);
      expect(aging.items, url).toEqual([]);
      expect(aging.ledger).toBe('0.0000');
    }
    for (const url of [
      `/reports/ar-aging/${customerOfB}?asOf=${today}`,
      `/reports/ap-aging/${supplierOfB}?asOf=${today}`,
    ]) {
      expect((await as(tenantA, 'GET', url)).statusCode, url).toBe(404);
    }
    const own = await read(tenantB, agingReportSchema, `/reports/ar-aging?asOf=${today}`);
    expect(own.totals.balance).toBe('75000.0000');
    const ownPayables = await read(tenantB, agingReportSchema, `/reports/ap-aging?asOf=${today}`);
    expect(ownPayables.ledger).toBe('42000.0000');
  });
});

// Step 21c: the VAT report reads B's documents' lines, the stock movement report B's movements and
// balances, and the schedules are rows the worker reads across every workspace.
describe('VAT, stock movement and report schedules over HTTP', () => {
  let warehouseOfB: string;
  let categoryOfB: string;
  let ownerOfB: string;
  let scheduleOfB: ReportSchedule;
  const period = `from=${shiftIsoDate(today, -30)}&to=${today}`;

  async function read<T>(who: SignedIn, schema: z.ZodType<T>, url: string): Promise<T> {
    const res = await as(who, 'GET', url);
    expect(res.statusCode, res.body).toBe(200);
    return schema.parse(res.json());
  }

  async function created<T>(who: SignedIn, schema: z.ZodType<T>, url: string, body: object) {
    const res = await as(who, 'POST', url, body);
    expect(res.statusCode, res.body).toBe(201);
    return schema.parse(res.json());
  }

  // B's stock: 5 insulin cool boxes in its main store, and a daily trial balance by email
  beforeAll(async () => {
    const pcs = unitListSchema
      .parse((await as(tenantB, 'GET', '/units')).json())
      .items.find((unit) => unit.code === 'pcs');
    const [category] = productCategoryListSchema.parse(
      (await as(tenantB, 'GET', '/product-categories')).json(),
    ).items;
    const [warehouse] = warehouseListSchema.parse(
      (await as(tenantB, 'GET', '/warehouses')).json(),
    ).items;
    const [owner] = memberPageSchema.parse((await as(tenantB, 'GET', '/members')).json()).items;
    if (!pcs || !category || !warehouse || !owner) throw new Error("B's setup is incomplete");
    categoryOfB = category.id;
    warehouseOfB = warehouse.id;
    ownerOfB = owner.userId;
    const coolBox = await created(tenantB, productSchema, '/products', {
      code: '',
      name: 'Insulin cool box',
      type: 'goods',
      categoryId: categoryOfB,
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
      customFields: { generic_name: 'Cool box' },
    });
    const stocked = await as(tenantB, 'POST', '/stock-adjustments', {
      date: today,
      warehouseId: warehouseOfB,
      direction: 'in',
      reason: 'opening',
      note: '',
      lines: [
        {
          variantId: coolBox.variants[0]?.id ?? '',
          unitId: pcs.id,
          quantity: '5',
          batchId: '',
          lotNumber: '',
          expiresOn: '',
          manufacturedOn: '',
          serialNumbers: [],
          unitCost: '1200',
        },
      ],
      post: true,
    });
    expect(stocked.statusCode, stocked.body).toBe(201);
    scheduleOfB = await created(tenantB, reportScheduleSchema, '/report-schedules', {
      report: 'trial_balance',
      format: 'pdf',
      query: { from: today, to: today },
      when: { frequency: 'daily', hour: 8 },
      recipientIds: [ownerOfB],
    });
  }, 60_000);

  it("adds none of B's VAT or stock into A's reports, whatever ids A's query names", async () => {
    for (const filter of ['', `&branchId=${branchOfB}`]) {
      const vat = await read(tenantA, vatReportSchema, `/reports/vat?${period}${filter}`);
      expect(vat.rows, filter).toEqual([]);
      expect(vat.totals.outputNet).toBe('0.0000');
      expect(vat.totals.inputNet).toBe('0.0000');
      // A's journal has sales, but no VAT
      expect(vat.books).toEqual({ output: '0.0000', input: '0.0000' });
      for (const side of ['output', 'input']) {
        const documents = await read(
          tenantA,
          vatDocumentPageSchema,
          `/reports/vat/documents?${period}${filter}&side=${side}`,
        );
        expect(documents.items, `${side}${filter}`).toEqual([]);
      }
    }
    for (const filter of ['', `&warehouseId=${warehouseOfB}`, `&categoryId=${categoryOfB}`]) {
      const stock = await read(
        tenantA,
        stockMovementReportSchema,
        `/reports/stock-movement?${period}&show=all${filter}`,
      );
      expect(stock.items, filter).toEqual([]);
      expect(stock.totals).toEqual({ variants: 0, openingValue: '0.0000', closingValue: '0.0000' });
    }
    // B sees its own, so the documents and the stock were really there
    const ownVat = await read(tenantB, vatReportSchema, `/reports/vat?${period}`);
    expect(ownVat.totals).toMatchObject({ outputNet: '75000.0000', inputNet: '42000.0000' });
    const ownStock = await read(
      tenantB,
      stockMovementReportSchema,
      `/reports/stock-movement?${period}`,
    );
    expect(ownStock.items.map((row) => [row.productName, row.closing, row.closingValue])).toEqual([
      ['Insulin cool box', '5.0000', '6000.0000'],
    ]);
  });

  it("never lists, changes or sends B's schedules, nor to B's people", async () => {
    expect((await read(tenantA, reportScheduleListSchema, '/report-schedules')).items).toEqual([]);
    for (const [method, url, body] of [
      [
        'PUT',
        `/report-schedules/${scheduleOfB.id}`,
        {
          format: 'xlsx',
          when: { frequency: 'daily', hour: 9 },
          recipientIds: [ownerOfB],
          version: scheduleOfB.version,
        },
      ],
      ['POST', `/report-schedules/${scheduleOfB.id}/pause`, { version: scheduleOfB.version }],
      ['POST', `/report-schedules/${scheduleOfB.id}/resume`, { version: scheduleOfB.version }],
      ['DELETE', `/report-schedules/${scheduleOfB.id}`, undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: bearer(tenantA.accessToken),
        ...(body && { payload: body }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // B's owner is not someone A may send to, and is not offered
    const candidates = await read(
      tenantA,
      reportScheduleCandidateListSchema,
      '/report-schedules/recipients?report=trial_balance',
    );
    expect(candidates.items.map((item) => item.userId)).not.toContain(ownerOfB);
    const toB = await as(tenantA, 'POST', '/report-schedules', {
      report: 'trial_balance',
      format: 'pdf',
      query: { from: today, to: today },
      when: { frequency: 'daily', hour: 8 },
      recipientIds: [ownerOfB],
    });
    expect(toB.statusCode).toBe(409);
    // Still there, unchanged, for B
    const own = await read(tenantB, reportScheduleListSchema, '/report-schedules');
    expect(own.items.map((item) => [item.id, item.version, item.status])).toEqual([
      [scheduleOfB.id, 1, 'active'],
    ]);
  });

  it('lets the worker role read only which schedules are due, in every workspace', async () => {
    // The sweep's connection (decision 37): no tenant is set, and it needs none for these columns
    const sql = postgres(pg.workerUrl, { max: 1, onnotice: () => undefined });
    try {
      const due = await sql<{ id: string }[]>`
        SELECT id, tenant_id, next_run_at FROM report_schedules WHERE id = ${scheduleOfB.id}`;
      expect(due.map((row) => row.id)).toEqual([scheduleOfB.id]);
      // Never what a schedule sends, or to whom
      await expect(sql`SELECT filters FROM report_schedules`).rejects.toMatchObject({
        code: '42501',
      });
      await expect(sql`SELECT user_id FROM report_schedule_recipients`).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await sql.end();
    }
  });
});
