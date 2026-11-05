import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  billSchema,
  branchSchema,
  customerSchema,
  type Dashboard,
  dashboardSchema,
  invoiceSchema,
  productSchema,
  setupSchema,
  shiftIsoDate,
  supplierSchema,
  taxRateListSchema,
  todayIn,
  unitListSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
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

// Two shops. Only B has a day of business: sales, a bank account, an overdue invoice, an overdue
// bill and an item below its reorder level. The dashboard is a handful of SUMs over the day totals
// and the documents: one missing tenant filter would add B's money into A's cards.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let chartOfA: Account[];
let branchOfB: string;

const today = todayIn('Asia/Dhaka');

function as(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload && { payload }),
  });
}

async function created<T>(who: SignedIn, schema: z.ZodType<T>, url: string, payload: object) {
  const res = await as(who, 'POST', url, payload);
  expect(res.statusCode, res.body).toBe(201);
  return schema.parse(res.json());
}

async function dashboard(who: SignedIn, query = ''): Promise<Dashboard> {
  const res = await as(who, 'GET', `/dashboard${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return dashboardSchema.parse(res.json());
}

async function setUp(who: SignedIn): Promise<Account[]> {
  expect((await as(who, 'POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
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
    companyName: 'Nabil Super Shop',
    workspaceSlug: 'nabil-super-shop',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nabilshop.com',
    password: 'Mirpur-grocery-2026',
  });
  tenantB = await signUp(app, {
    companyName: 'Sylhet Pharmacy',
    workspaceSlug: 'sylhet-pharmacy',
    fullName: 'Karim Uddin',
    email: 'karim@sylhetpharmacy.com',
    password: 'Zindabazar-shop-2026',
  });
  let chartOfB: Account[];
  [chartOfA, chartOfB] = await Promise.all([setUp(tenantA), setUp(tenantB)]);

  // B's day: a sale on a branch of B's, paid into a bank account of B's
  branchOfB = (
    await created(tenantB, branchSchema, '/branches', {
      code: 'ZND',
      name: 'Zindabazar shop',
      phone: '',
      address: '',
    })
  ).id;
  const bank = await created(tenantB, accountSchema, '/accounts', {
    parentId: idIn(chartOfB, '1120'),
    code: '1121',
    name: 'Sonali Bank CD A/C',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  const sale = await as(tenantB, 'POST', '/journal-entries', {
    date: today,
    narration: 'Sales at the shop',
    lines: [
      { accountId: bank.id, branchId: branchOfB, description: '', debit: '75000', credit: '' },
      {
        accountId: idIn(chartOfB, '4110'),
        branchId: branchOfB,
        description: '',
        debit: '',
        credit: '75000',
      },
    ],
    post: true,
  });
  expect(sale.statusCode, sale.body).toBe(201);

  // A service sold on credit 20 days ago, due on the day: no stock needed, overdue now
  const units = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;
  const pcs = units.find((unit) => unit.code === 'pcs')?.id ?? '';
  const rates = taxRateListSchema.parse((await as(tenantB, 'GET', '/tax-rates')).json()).items;
  const exempt = rates.find((rate) => rate.name === 'Exempt')?.id ?? '';
  const product = (name: string, type: 'goods' | 'service') =>
    created(tenantB, productSchema, '/products', {
      code: '',
      name,
      type,
      categoryId: '',
      description: '',
      baseUnitId: pcs,
      salesUnitId: '',
      purchaseUnitId: '',
      tracking: 'none',
      hasExpiry: false,
      taxRateId: '',
      options: [],
      variants: [
        { id: null, sku: '', optionValues: [], barcode: '', salePrice: '500', archived: false },
      ],
      units: [],
      customFields: {},
    });
  const delivery = await product('Home delivery', 'service');
  const inhaler = await product('Salbutamol inhaler', 'goods');
  const clinic = await created(tenantB, customerSchema, '/customers', {
    code: '',
    name: 'Sylhet Clinic',
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
  await created(tenantB, invoiceSchema, '/invoices', {
    customerId: clinic.id,
    date: shiftIsoDate(today, -20),
    dueDate: '',
    customerReference: '',
    branchId: branchOfB,
    warehouseId: '',
    note: '',
    lines: [
      {
        variantId: delivery.variants[0]?.id ?? '',
        unitId: pcs,
        quantity: '10',
        description: '',
        unitPrice: '500',
        discountType: 'percent',
        discount: '',
        taxRateId: exempt,
        deliveryLineId: '',
        orderLineId: '',
        batchId: '',
        serialNumbers: [],
      },
    ],
    post: true,
  });

  // The shop's rent, overdue
  const landlord = await created(tenantB, supplierSchema, '/suppliers', {
    code: '',
    name: 'Zindabazar Properties',
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 0,
    address: '',
    bankAccounts: [],
    notes: '',
  });
  await created(tenantB, billSchema, '/bills', {
    supplierId: landlord.id,
    date: shiftIsoDate(today, -15),
    dueDate: shiftIsoDate(today, -5),
    supplierBillNumber: 'ZP-0042',
    mushakNumber: '',
    mushakDate: '',
    branchId: branchOfB,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: [],
    expenses: [
      {
        accountId: idIn(chartOfB, '5220'),
        description: 'Shop rent',
        amount: '20000',
        taxRateId: exempt,
      },
    ],
    submit: true,
  });

  // An inhaler that never came in, with a reorder level: B's low stock
  const [store] = warehouseListSchema.parse((await as(tenantB, 'GET', '/warehouses')).json()).items;
  const level = await as(tenantB, 'PUT', '/stock/reorder-levels', {
    warehouseId: store?.id ?? '',
    variantId: inhaler.variants[0]?.id ?? '',
    minQuantity: '5',
    reorderQuantity: '',
  });
  expect(level.statusCode, level.body).toBe(200);
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('dashboard isolation over HTTP', () => {
  // What A's own empty shop shows: its own cash account at zero, nothing else
  const emptyShop = () => ({
    sales: {
      today: '0.0000',
      yesterday: '0.0000',
      monthToDate: '0.0000',
      lastMonthToDate: '0.0000',
    },
    margin: {
      monthToDate: { sales: '0.0000', cost: '0.0000' },
      lastMonthToDate: { sales: '0.0000', cost: '0.0000' },
    },
    cash: {
      accounts: [
        {
          accountId: idIn(chartOfA, '1110'),
          code: '1110',
          name: 'Cash in hand',
          balance: '0.0000',
        },
      ],
      total: '0.0000',
      yesterday: '0.0000',
    },
    topProducts: [],
    receivables: { total: '0.0000', overdue: '0.0000', overdueCount: 0 },
    payables: { total: '0.0000', overdue: '0.0000', overdueCount: 0 },
    lowStock: { count: 0, items: [] },
  });

  it("adds none of tenant B's numbers into tenant A's dashboard", async () => {
    const ofA = await dashboard(tenantA);
    expect(ofA).toMatchObject(emptyShop());
    expect(ofA.sales?.days.every((point) => point.amount === '0.0000')).toBe(true);
  });

  it("shows nothing of B's even with B's own branch as the filter", async () => {
    const ofA = await dashboard(tenantA, `?branchId=${branchOfB}`);
    expect(ofA.branchId).toBe(branchOfB);
    expect(ofA).toMatchObject(emptyShop());
  });

  it('shows B its own numbers, so the data above was really there', async () => {
    const ofB = await dashboard(tenantB);
    expect(ofB.sales?.today).toBe('75000.0000');
    expect(ofB.cash?.total).toBe('75000.0000');
    expect(ofB.topProducts?.map((item) => [item.productName, item.amount])).toEqual([
      ['Home delivery', '5000.0000'],
    ]);
    expect(ofB.receivables).toEqual({
      total: '5000.0000',
      overdue: '5000.0000',
      overdueCount: 1,
    });
    expect(ofB.payables).toEqual({ total: '20000.0000', overdue: '20000.0000', overdueCount: 1 });
    expect(ofB.lowStock?.count).toBe(1);
  });
});
