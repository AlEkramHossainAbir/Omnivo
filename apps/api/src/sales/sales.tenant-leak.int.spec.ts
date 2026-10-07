import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  type Customer,
  type CustomerGroup,
  customerGroupListSchema,
  customerGroupSchema,
  customerPageSchema,
  customerSchema,
  type PriceList,
  priceListListSchema,
  priceListSchema,
  type Product,
  productSchema,
  problemSchema,
  setupSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
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

// Two workspaces: A must never see, use or change B's customers, customer groups, price lists or
// VAT rates, nor put B's customer on a line of its own books. Every answer is 404, or the same
// "pick one from the list" as for an id that does not exist — never a hint that it does.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let unitsOfA: Unit[];
let accountsOfA: Account[];
let groupOfB: CustomerGroup;
let customerOfB: Customer;
let listOfB: PriceList;
let productOfB: Product;
let rateOfB: TaxRate;

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

function problemOf(res: Awaited<ReturnType<typeof as>>) {
  return problemSchema.parse(res.json());
}

async function setUp(who: SignedIn, industry: 'garments' | 'distribution'): Promise<void> {
  expect((await as(who, 'POST', '/setup', { industry })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
}

function pcsOf(units: Unit[]): string {
  const pcs = units.find((unit) => unit.code === 'pcs');
  if (!pcs) throw new Error('no pcs');
  return pcs.id;
}

function accountOfA(code: string): string {
  const found = accountsOfA.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function customerForm(name: string, extra: object = {}) {
  return {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  };
}

function productForm(name: string, units: Unit[], extra: object = {}) {
  return {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcsOf(units),
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
    ...extra,
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
    companyName: 'Meghna Distributors',
    workspaceSlug: 'meghna-distributors',
    fullName: 'Shafiq Ahmed',
    email: 'shafiq@meghnadistributors.com',
    password: 'Narsingdi-depot-2026',
  });
  await Promise.all([setUp(tenantA, 'garments'), setUp(tenantB, 'distribution')]);
  unitsOfA = unitListSchema.parse((await as(tenantA, 'GET', '/units')).json()).items;
  accountsOfA = accountListSchema.parse((await as(tenantA, 'GET', '/accounts')).json()).items;
  const unitsOfB = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;

  // B's data: a group, a price list with a price, a customer on both, and an invoice in the books
  groupOfB = customerGroupSchema.parse(
    (await as(tenantB, 'POST', '/customer-groups', { name: 'Upazila dealer' })).json(),
  );
  listOfB = priceListSchema.parse(
    (await as(tenantB, 'POST', '/price-lists', { name: 'Dealer', description: '' })).json(),
  );
  const product = await as(
    tenantB,
    'POST',
    '/products',
    productForm('Mango juice 250 ml', unitsOfB),
  );
  expect(product.statusCode, product.body).toBe(201);
  productOfB = productSchema.parse(product.json());
  const priced = await as(tenantB, 'PUT', `/price-lists/${listOfB.id}/items`, {
    changes: [{ variantId: productOfB.variants[0]?.id, unitId: pcsOf(unitsOfB), price: '22' }],
  });
  expect(priced.statusCode, priced.body).toBe(200);
  const customer = await as(
    tenantB,
    'POST',
    '/customers',
    customerForm('Bhairab Bazar Traders', {
      groupId: groupOfB.id,
      priceListId: listOfB.id,
      contactPerson: 'Rafiqul Islam',
      phone: '01712-334455',
    }),
  );
  expect(customer.statusCode, customer.body).toBe(201);
  customerOfB = customerSchema.parse(customer.json());
  const accountsOfB = accountListSchema.parse((await as(tenantB, 'GET', '/accounts')).json()).items;
  const receivableOfB = accountsOfB.find((account) => account.purpose === 'accounts_receivable');
  const salesOfB = accountsOfB.find((account) => account.purpose === 'sales');
  const invoice = await as(tenantB, 'POST', '/journal-entries', {
    date: '2026-09-10',
    narration: 'Invoice to Bhairab Bazar Traders',
    post: true,
    lines: [
      {
        accountId: receivableOfB?.id,
        branchId: '',
        partyId: customerOfB.id,
        description: '',
        debit: '13200',
        credit: '',
      },
      {
        accountId: salesOfB?.id,
        branchId: '',
        partyId: '',
        description: '',
        debit: '',
        credit: '13200',
      },
    ],
  });
  expect(invoice.statusCode, invoice.body).toBe(201);
  const rates = taxRateListSchema.parse((await as(tenantB, 'GET', '/tax-rates')).json()).items;
  const zero = rates.find((rate) => rate.name === 'Zero-rated');
  if (!zero) throw new Error('B has no rates');
  rateOfB = zero;
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('customer isolation over HTTP', () => {
  it("never lists, finds or reads tenant B's customers, groups, price lists or VAT rates", async () => {
    for (const search of ['bhairab', customerOfB.code, '1712', 'rafiqul']) {
      const page = customerPageSchema.parse(
        (await as(tenantA, 'GET', `/customers?search=${search}`)).json(),
      );
      expect(page.items, search).toEqual([]);
    }
    expect((await as(tenantA, 'GET', `/customers/${customerOfB.id}`)).statusCode).toBe(404);
    expect((await as(tenantA, 'GET', `/customers/${customerOfB.id}/statement`)).statusCode).toBe(
      404,
    );
    const groups = customerGroupListSchema.parse(
      (await as(tenantA, 'GET', '/customer-groups')).json(),
    );
    expect(groups.items).toEqual([]);
    const lists = priceListListSchema.parse((await as(tenantA, 'GET', '/price-lists')).json());
    expect(lists.items).toEqual([]);
    expect((await as(tenantA, 'GET', `/price-lists/${listOfB.id}`)).statusCode).toBe(404);
    expect((await as(tenantA, 'GET', `/price-lists/${listOfB.id}/items`)).statusCode).toBe(404);
    // A has its own six rates; none of them is B's
    const rates = taxRateListSchema.parse((await as(tenantA, 'GET', '/tax-rates')).json());
    expect(rates.items).toHaveLength(6);
    expect(rates.items.map((rate) => rate.id)).not.toContain(rateOfB.id);
  });

  it('cannot change, archive or delete any of them', async () => {
    const attempts = [
      as(tenantA, 'PUT', `/customers/${customerOfB.id}`, {
        ...customerForm('Taken over'),
        version: customerOfB.version,
      }),
      as(tenantA, 'POST', `/customers/${customerOfB.id}/archive`, { version: 1 }),
      as(tenantA, 'POST', `/customers/${customerOfB.id}/restore`, { version: 1 }),
      as(tenantA, 'DELETE', `/customers/${customerOfB.id}?version=1`),
      as(tenantA, 'PUT', `/customer-groups/${groupOfB.id}`, { name: 'Taken over', version: 1 }),
      as(tenantA, 'DELETE', `/customer-groups/${groupOfB.id}?version=1`),
      as(tenantA, 'PUT', `/price-lists/${listOfB.id}`, {
        name: 'Taken over',
        description: '',
        version: listOfB.version,
      }),
      as(tenantA, 'POST', `/price-lists/${listOfB.id}/archive`, { version: listOfB.version }),
      as(tenantA, 'PUT', `/price-lists/${listOfB.id}/items`, {
        changes: [
          { variantId: productOfB.variants[0]?.id, unitId: productOfB.baseUnitId, price: '1' },
        ],
      }),
      as(tenantA, 'PUT', `/tax-rates/${rateOfB.id}`, {
        name: 'Taken over',
        kind: 'standard',
        rate: '15',
        isDefault: true,
        version: rateOfB.version,
      }),
      as(tenantA, 'POST', `/tax-rates/${rateOfB.id}/archive`, { version: rateOfB.version }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode, res.body).toBe(404);

    const still = customerSchema.parse(
      (await as(tenantB, 'GET', `/customers/${customerOfB.id}`)).json(),
    );
    expect(still).toMatchObject({ name: 'Bhairab Bazar Traders', version: 1, archivedAt: null });
    expect(still.balance).toBe('13200.0000');
    const list = priceListSchema.parse(
      (await as(tenantB, 'GET', `/price-lists/${listOfB.id}`)).json(),
    );
    expect(list).toMatchObject({ name: 'Dealer', itemCount: 1, archivedAt: null });
  });

  it("cannot point its own records at B's group, price list, item or VAT rate", async () => {
    const withGroup = await as(
      tenantA,
      'POST',
      '/customers',
      customerForm('Ashulia Knit Buyers', { groupId: groupOfB.id }),
    );
    expect(problemOf(withGroup).fieldErrors).toEqual({ groupId: ['customer_group_invalid'] });
    const withList = await as(
      tenantA,
      'POST',
      '/customers',
      customerForm('Ashulia Knit Buyers', { priceListId: listOfB.id }),
    );
    expect(problemOf(withList).fieldErrors).toEqual({ priceListId: ['price_list_invalid'] });

    const own = priceListSchema.parse(
      (await as(tenantA, 'POST', '/price-lists', { name: 'Buying house', description: '' })).json(),
    );
    const borrowed = await as(tenantA, 'PUT', `/price-lists/${own.id}/items`, {
      changes: [{ variantId: productOfB.variants[0]?.id, unitId: pcsOf(unitsOfA), price: '1' }],
    });
    expect(problemOf(borrowed).fieldErrors).toEqual({
      'changes.0.variantId': ['product_variant_unknown'],
    });

    const product = await as(
      tenantA,
      'POST',
      '/products',
      productForm('Knit polo shirt', unitsOfA, { taxRateId: rateOfB.id }),
    );
    expect(product.statusCode).toBe(400);
    expect(problemOf(product).fieldErrors).toEqual({ taxRateId: ['tax_rate_invalid'] });
  });

  it("cannot put B's customer on a line of its own books", async () => {
    const entry = await as(tenantA, 'POST', '/journal-entries', {
      date: '2026-09-11',
      narration: 'Borrowed customer',
      post: true,
      lines: [
        {
          accountId: accountOfA('1140'),
          branchId: '',
          partyId: customerOfB.id,
          description: '',
          debit: '100',
          credit: '',
        },
        {
          accountId: accountOfA('4110'),
          branchId: '',
          partyId: '',
          description: '',
          debit: '',
          credit: '100',
        },
      ],
    });
    expect(problemOf(entry).fieldErrors).toEqual({ 'lines.0.partyId': ['journal_party_invalid'] });

    const opening = await as(tenantA, 'PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [{ accountId: accountOfA('1140'), partyId: customerOfB.id, debit: '100', credit: '' }],
    });
    expect(problemOf(opening).fieldErrors).toEqual({
      'lines.0.partyId': ['journal_party_invalid'],
    });
  });

  it("numbers its customers on its own: B's codes take nothing from A", async () => {
    const res = await as(tenantA, 'POST', '/customers', customerForm('Nordic Apparel AB'));
    expect(res.statusCode, res.body).toBe(201);
    expect(customerSchema.parse(res.json()).code).toBe(customerOfB.code);
  });
});
