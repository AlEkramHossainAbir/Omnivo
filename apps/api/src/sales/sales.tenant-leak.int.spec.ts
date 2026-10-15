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
  customerCreditSchema,
  customerSchema,
  type CreditNote,
  creditNotePageSchema,
  creditNoteSchema,
  type Delivery,
  deliveryPageSchema,
  deliverySchema,
  type Invoice,
  invoicePageSchema,
  invoiceSchema,
  type PriceList,
  priceListListSchema,
  priceListSchema,
  priceLookupSchema,
  type Product,
  productSchema,
  problemSchema,
  type Quotation,
  quotationPageSchema,
  quotationSchema,
  type Receipt,
  receiptPageSchema,
  receiptSchema,
  type Refund,
  refundPageSchema,
  refundSchema,
  salesAccountsSchema,
  type SalesOrder,
  salesOrderPageSchema,
  salesOrderSchema,
  type SalesReturn,
  salesReturnPageSchema,
  salesReturnSchema,
  setupSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
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
// Step 15b: B's quotation, its confirmed order and a draft delivery against it
let quotationOfB: Quotation;
let orderOfB: SalesOrder;
let deliveryOfB: Delivery;
let warehouseOfB: Warehouse;

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
    documentLanguage: 'en',
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

describe('sales document isolation over HTTP', () => {
  let customerOfA: Customer;
  let productOfA: Product;
  let warehouseOfA: Warehouse;
  let rateOfA: string;

  function lineOf(product: Product, taxRateId: string) {
    return {
      variantId: product.variants[0]?.id,
      unitId: product.baseUnitId,
      quantity: '12',
      description: '',
      unitPrice: '22',
      discountType: 'percent',
      discount: '',
      taxRateId,
    };
  }

  function orderBody(customerId: string, warehouseId: string, line: object, extra: object = {}) {
    return {
      customerId,
      date: '2026-10-02',
      deliveryDate: '',
      customerReference: '',
      warehouseId,
      shippingAddressId: '',
      note: '',
      lines: [line],
      confirm: false,
      ...extra,
    };
  }

  function deliveryBody(customerId: string, orderId: string, warehouseId: string, line: object) {
    return {
      customerId,
      orderId,
      date: '2026-10-05',
      warehouseId,
      shippingAddressId: '',
      vehicle: '',
      note: '',
      lines: [line],
      post: false,
    };
  }

  beforeAll(async () => {
    // B: a quotation, the order made from it (confirmed), and a draft delivery of half of it
    const [warehouse] = warehouseListSchema.parse(
      (await as(tenantB, 'GET', '/warehouses')).json(),
    ).items;
    if (!warehouse) throw new Error('B has no warehouse');
    warehouseOfB = warehouse;
    const quote = await as(tenantB, 'POST', '/quotations', {
      customerId: customerOfB.id,
      date: '2026-10-01',
      validUntil: '',
      note: '',
      lines: [lineOf(productOfB, rateOfB.id)],
    });
    expect(quote.statusCode, quote.body).toBe(201);
    quotationOfB = quotationSchema.parse(quote.json());
    const order = await as(
      tenantB,
      'POST',
      '/sales-orders',
      orderBody(customerOfB.id, warehouseOfB.id, lineOf(productOfB, rateOfB.id), {
        quotationId: quotationOfB.id,
        confirm: true,
      }),
    );
    expect(order.statusCode, order.body).toBe(201);
    orderOfB = salesOrderSchema.parse(order.json());
    // Accepted by the order: a new version. A's attempts below send the current one, so only the
    // tenant check stands between them and B's rows.
    quotationOfB = quotationSchema.parse(
      (await as(tenantB, 'GET', `/quotations/${quotationOfB.id}`)).json(),
    );
    const delivery = await as(
      tenantB,
      'POST',
      '/deliveries',
      deliveryBody(customerOfB.id, orderOfB.id, warehouseOfB.id, {
        variantId: productOfB.variants[0]?.id,
        unitId: productOfB.baseUnitId,
        quantity: '6',
        batchId: '',
        serialNumbers: [],
        orderLineId: orderOfB.lines[0]?.id,
      }),
    );
    expect(delivery.statusCode, delivery.body).toBe(201);
    deliveryOfB = deliverySchema.parse(delivery.json());

    // A: its own customer, product, warehouse and VAT rate
    customerOfA = customerSchema.parse(
      (await as(tenantA, 'POST', '/customers', customerForm('Lindqvist Knitwear AB'))).json(),
    );
    const product = await as(
      tenantA,
      'POST',
      '/products',
      productForm('Knit polo shirt', unitsOfA, {
        variants: [
          { id: null, sku: '', optionValues: [], barcode: '', salePrice: '450', archived: false },
        ],
      }),
    );
    expect(product.statusCode, product.body).toBe(201);
    productOfA = productSchema.parse(product.json());
    const [own] = warehouseListSchema.parse((await as(tenantA, 'GET', '/warehouses')).json()).items;
    if (!own) throw new Error('A has no warehouse');
    warehouseOfA = own;
    const rates = taxRateListSchema.parse((await as(tenantA, 'GET', '/tax-rates')).json()).items;
    const standard = rates.find((rate) => rate.isDefault);
    if (!standard) throw new Error('A has no default rate');
    rateOfA = standard.id;
  });

  it("never lists or reads B's quotations, orders or deliveries", async () => {
    const quotations = quotationPageSchema.parse((await as(tenantA, 'GET', '/quotations')).json());
    expect(quotations.items).toEqual([]);
    const orders = salesOrderPageSchema.parse((await as(tenantA, 'GET', '/sales-orders')).json());
    expect(orders.items).toEqual([]);
    const deliveries = deliveryPageSchema.parse((await as(tenantA, 'GET', '/deliveries')).json());
    expect(deliveries.items).toEqual([]);
    // Not even when A filters by B's customer
    const byCustomer = await as(tenantA, 'GET', `/sales-orders?customerId=${customerOfB.id}`);
    expect(salesOrderPageSchema.parse(byCustomer.json()).items).toEqual([]);
    for (const url of [
      `/quotations/${quotationOfB.id}`,
      `/sales-orders/${orderOfB.id}`,
      `/deliveries/${deliveryOfB.id}`,
    ]) {
      expect((await as(tenantA, 'GET', url)).statusCode, url).toBe(404);
    }
  });

  it('cannot change, answer, confirm, deliver, post or delete any of them', async () => {
    const line = lineOf(productOfA, rateOfA);
    const quotation = { version: quotationOfB.version };
    const order = { version: orderOfB.version };
    const attempts = [
      as(tenantA, 'PUT', `/quotations/${quotationOfB.id}`, {
        customerId: customerOfA.id,
        date: '2026-10-01',
        validUntil: '',
        note: '',
        lines: [line],
        ...quotation,
      }),
      as(tenantA, 'POST', `/quotations/${quotationOfB.id}/decline`, quotation),
      as(tenantA, 'POST', `/quotations/${quotationOfB.id}/reopen`, quotation),
      as(tenantA, 'DELETE', `/quotations/${quotationOfB.id}?version=1`),
      as(tenantA, 'PUT', `/sales-orders/${orderOfB.id}`, {
        ...orderBody(customerOfA.id, warehouseOfA.id, line),
        ...order,
      }),
      as(tenantA, 'POST', `/sales-orders/${orderOfB.id}/confirm`, order),
      as(tenantA, 'POST', `/sales-orders/${orderOfB.id}/reopen`, order),
      as(tenantA, 'POST', `/sales-orders/${orderOfB.id}/close`, order),
      as(tenantA, 'POST', `/sales-orders/${orderOfB.id}/cancel`, order),
      as(tenantA, 'DELETE', `/sales-orders/${orderOfB.id}?version=1`),
      as(tenantA, 'PUT', `/deliveries/${deliveryOfB.id}`, {
        ...deliveryBody(customerOfA.id, '', warehouseOfA.id, {
          variantId: productOfA.variants[0]?.id,
          unitId: productOfA.baseUnitId,
          quantity: '1',
          batchId: '',
          serialNumbers: [],
          orderLineId: '',
        }),
        version: deliveryOfB.version,
      }),
      as(tenantA, 'POST', `/deliveries/${deliveryOfB.id}/post`, { version: deliveryOfB.version }),
      as(tenantA, 'DELETE', `/deliveries/${deliveryOfB.id}?version=1`),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode, res.body).toBe(404);

    // B's documents are as B left them
    const quotationNow = quotationSchema.parse(
      (await as(tenantB, 'GET', `/quotations/${quotationOfB.id}`)).json(),
    );
    expect(quotationNow).toMatchObject({ status: 'accepted', version: quotationOfB.version });
    const orderNow = salesOrderSchema.parse(
      (await as(tenantB, 'GET', `/sales-orders/${orderOfB.id}`)).json(),
    );
    expect(orderNow).toMatchObject({ status: 'confirmed', version: orderOfB.version });
    const deliveryNow = deliverySchema.parse(
      (await as(tenantB, 'GET', `/deliveries/${deliveryOfB.id}`)).json(),
    );
    expect(deliveryNow).toMatchObject({ status: 'draft', version: deliveryOfB.version });
  });

  it("cannot write its own documents with B's customer, item, VAT rate, quotation or order", async () => {
    const quotation = (customerId: string, line: object) =>
      as(tenantA, 'POST', '/quotations', {
        customerId,
        date: '2026-10-01',
        validUntil: '',
        note: '',
        lines: [line],
      });
    const forB = await quotation(customerOfB.id, lineOf(productOfA, rateOfA));
    expect(problemOf(forB).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });
    const itemOfB = await quotation(customerOfA.id, lineOf(productOfB, rateOfA));
    expect(problemOf(itemOfB).fieldErrors).toEqual({ 'lines.0.variantId': ['sales_item_invalid'] });
    const vatOfB = await quotation(customerOfA.id, lineOf(productOfA, rateOfB.id));
    expect(problemOf(vatOfB).fieldErrors).toEqual({ 'lines.0.taxRateId': ['tax_rate_invalid'] });

    const fromQuotationOfB = await as(
      tenantA,
      'POST',
      '/sales-orders',
      orderBody(customerOfA.id, warehouseOfA.id, lineOf(productOfA, rateOfA), {
        quotationId: quotationOfB.id,
      }),
    );
    expect(problemOf(fromQuotationOfB).fieldErrors).toEqual({
      quotationId: ['order_quotation_invalid'],
    });
    const fromWarehouseOfB = await as(
      tenantA,
      'POST',
      '/sales-orders',
      orderBody(customerOfA.id, warehouseOfB.id, lineOf(productOfA, rateOfA)),
    );
    expect(problemOf(fromWarehouseOfB).fieldErrors).toEqual({
      warehouseId: ['stock_warehouse_invalid'],
    });

    const againstOrderOfB = await as(
      tenantA,
      'POST',
      '/deliveries',
      deliveryBody(customerOfA.id, orderOfB.id, warehouseOfA.id, {
        variantId: productOfA.variants[0]?.id,
        unitId: productOfA.baseUnitId,
        quantity: '1',
        batchId: '',
        serialNumbers: [],
        orderLineId: orderOfB.lines[0]?.id,
      }),
    );
    expect(problemOf(againstOrderOfB).fieldErrors).toEqual({ orderId: ['delivery_order_invalid'] });
  });

  it("prices nothing from B's price lists or items", async () => {
    const res = await as(tenantA, 'POST', '/sales/price-lookup', {
      customerId: customerOfB.id,
      items: [
        { variantId: productOfB.variants[0]?.id, unitId: productOfB.baseUnitId },
        { variantId: productOfA.variants[0]?.id, unitId: productOfA.baseUnitId },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    // B's juice is left out; A's shirt has its own price, never one from B's dealer list
    expect(priceLookupSchema.parse(res.json()).items).toEqual([
      {
        variantId: productOfA.variants[0]?.id,
        unitId: productOfA.baseUnitId,
        price: '450.0000',
        source: 'product',
        taxRateId: rateOfA,
      },
    ]);
  });

  it("numbers its sales documents on its own: B's numbers take nothing from A", async () => {
    const res = await as(tenantA, 'POST', '/quotations', {
      customerId: customerOfA.id,
      date: '2026-10-01',
      validUntil: '',
      note: '',
      lines: [lineOf(productOfA, rateOfA)],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(quotationSchema.parse(res.json()).number).toBe(quotationOfB.number);
  });
});

describe('invoice and receipt isolation over HTTP', () => {
  let customerOfA: Customer;
  let serviceOfA: Product;
  let branchOfA: string;
  let rateOfA: string;
  let invoiceOfB: Invoice;
  let draftOfB: Invoice;
  let receiptOfB: Receipt;
  let cashOfB: string;

  function invoiceBody(customerId: string, branchId: string, line: object, extra: object = {}) {
    return {
      customerId,
      date: '2026-10-06',
      dueDate: '',
      customerReference: '',
      branchId,
      warehouseId: '',
      note: '',
      lines: [line],
      post: true,
      ...extra,
    };
  }

  function serviceLine(product: Product, taxRateId: string, extra: object = {}) {
    return {
      variantId: product.variants[0]?.id,
      unitId: product.baseUnitId,
      quantity: '1',
      description: '',
      unitPrice: '500',
      discountType: 'percent',
      discount: '',
      taxRateId,
      deliveryLineId: '',
      orderLineId: '',
      batchId: '',
      serialNumbers: [],
      ...extra,
    };
  }

  function receiptBody(
    customerId: string,
    accountId: string,
    branchId: string,
    allocations: object[],
  ) {
    return {
      customerId,
      date: '2026-10-07',
      amount: '200',
      accountId,
      method: 'cash',
      reference: '',
      branchId,
      note: '',
      allocations,
    };
  }

  beforeAll(async () => {
    // B: a posted invoice for a delivery charge (no stock needed), a draft, and a cash receipt
    // that pays part of the posted one
    const unitsOfB = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;
    const service = await as(
      tenantB,
      'POST',
      '/products',
      productForm('Delivery charge', unitsOfB, { type: 'service' }),
    );
    expect(service.statusCode, service.body).toBe(201);
    const serviceOfB = productSchema.parse(service.json());
    const posted = await as(
      tenantB,
      'POST',
      '/invoices',
      invoiceBody(customerOfB.id, warehouseOfB.branchId, serviceLine(serviceOfB, rateOfB.id)),
    );
    expect(posted.statusCode, posted.body).toBe(201);
    const draft = await as(
      tenantB,
      'POST',
      '/invoices',
      invoiceBody(customerOfB.id, warehouseOfB.branchId, serviceLine(serviceOfB, rateOfB.id), {
        post: false,
      }),
    );
    expect(draft.statusCode, draft.body).toBe(201);
    draftOfB = invoiceSchema.parse(draft.json());
    const accountsOfB = accountListSchema.parse(
      (await as(tenantB, 'GET', '/accounts')).json(),
    ).items;
    cashOfB = accountsOfB.find((account) => account.purpose === 'cash')?.id ?? '';
    const receipt = await as(
      tenantB,
      'POST',
      '/receipts',
      receiptBody(customerOfB.id, cashOfB, warehouseOfB.branchId, [
        { invoiceId: invoiceSchema.parse(posted.json()).id, amount: '200' },
      ]),
    );
    expect(receipt.statusCode, receipt.body).toBe(201);
    receiptOfB = receiptSchema.parse(receipt.json());
    // Paid in part: a new version. A's attempts below send B's current ones.
    invoiceOfB = invoiceSchema.parse(
      (await as(tenantB, 'GET', `/invoices/${invoiceSchema.parse(posted.json()).id}`)).json(),
    );

    // A: its own customer, a service of its own, its branch and its VAT rate
    customerOfA = customerSchema.parse(
      (await as(tenantA, 'POST', '/customers', customerForm('H&M Hennes & Mauritz AB'))).json(),
    );
    const product = await as(
      tenantA,
      'POST',
      '/products',
      productForm('Sample courier charge', unitsOfA, { type: 'service' }),
    );
    expect(product.statusCode, product.body).toBe(201);
    serviceOfA = productSchema.parse(product.json());
    const [own] = warehouseListSchema.parse((await as(tenantA, 'GET', '/warehouses')).json()).items;
    if (!own) throw new Error('A has no warehouse');
    branchOfA = own.branchId;
    const rates = taxRateListSchema.parse((await as(tenantA, 'GET', '/tax-rates')).json()).items;
    const standard = rates.find((rate) => rate.isDefault);
    if (!standard) throw new Error('A has no default rate');
    rateOfA = standard.id;
  });

  it("never lists or reads B's invoices, receipts or credit", async () => {
    const invoices = invoicePageSchema.parse((await as(tenantA, 'GET', '/invoices')).json());
    expect(invoices.items).toEqual([]);
    const open = await as(tenantA, 'GET', `/invoices?payment=open&customerId=${customerOfB.id}`);
    expect(invoicePageSchema.parse(open.json()).items).toEqual([]);
    const receipts = receiptPageSchema.parse((await as(tenantA, 'GET', '/receipts')).json());
    expect(receipts.items).toEqual([]);
    for (const url of [
      `/invoices/${invoiceOfB.id}`,
      `/invoices/${draftOfB.id}`,
      `/receipts/${receiptOfB.id}`,
      `/customers/${customerOfB.id}/credit`,
    ]) {
      expect((await as(tenantA, 'GET', url)).statusCode, url).toBe(404);
    }
    // B's own answer, for comparison: the credit route exists and B can read it
    const own = await as(tenantB, 'GET', `/customers/${customerOfB.id}/credit`);
    expect(customerCreditSchema.parse(own.json()).balance).toBe('13500.0000');
  });

  it('cannot change, post, delete, apply or void any of them', async () => {
    const attempts = [
      as(tenantA, 'PUT', `/invoices/${draftOfB.id}`, {
        ...invoiceBody(customerOfA.id, branchOfA, serviceLine(serviceOfA, rateOfA)),
        version: draftOfB.version,
      }),
      as(tenantA, 'POST', `/invoices/${draftOfB.id}/post`, { version: draftOfB.version }),
      as(tenantA, 'DELETE', `/invoices/${draftOfB.id}?version=${String(draftOfB.version)}`),
      as(tenantA, 'PUT', `/receipts/${receiptOfB.id}/allocations`, {
        version: receiptOfB.version,
        allocations: [],
      }),
      as(tenantA, 'POST', `/receipts/${receiptOfB.id}/void`, {
        version: receiptOfB.version,
        date: '2026-10-08',
        reason: 'Taken over',
      }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode, res.body).toBe(404);

    const draftNow = invoiceSchema.parse(
      (await as(tenantB, 'GET', `/invoices/${draftOfB.id}`)).json(),
    );
    expect(draftNow).toMatchObject({ status: 'draft', version: draftOfB.version, number: null });
    const receiptNow = receiptSchema.parse(
      (await as(tenantB, 'GET', `/receipts/${receiptOfB.id}`)).json(),
    );
    expect(receiptNow).toMatchObject({
      status: 'posted',
      applied: '200.0000',
      version: receiptOfB.version,
    });
  });

  it("cannot bill B's customer, challan, order or branch, or pay B's invoice", async () => {
    const forB = await as(
      tenantA,
      'POST',
      '/invoices',
      invoiceBody(customerOfB.id, branchOfA, serviceLine(serviceOfA, rateOfA)),
    );
    expect(problemOf(forB).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });
    const branchOfB = await as(
      tenantA,
      'POST',
      '/invoices',
      invoiceBody(customerOfA.id, warehouseOfB.branchId, serviceLine(serviceOfA, rateOfA)),
    );
    expect(problemOf(branchOfB).fieldErrors).toEqual({ branchId: ['sales_branch_invalid'] });
    const challanOfB = await as(
      tenantA,
      'POST',
      '/invoices',
      invoiceBody(
        customerOfA.id,
        branchOfA,
        serviceLine(serviceOfA, rateOfA, { deliveryLineId: deliveryOfB.lines[0]?.id }),
      ),
    );
    expect(problemOf(challanOfB).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['invoice_delivery_line_invalid'],
    });
    const orderLineOfB = await as(
      tenantA,
      'POST',
      '/invoices',
      invoiceBody(
        customerOfA.id,
        branchOfA,
        serviceLine(serviceOfA, rateOfA, { orderLineId: orderOfB.lines[0]?.id }),
      ),
    );
    expect(problemOf(orderLineOfB).fieldErrors).toEqual({
      'lines.0.orderLineId': ['invoice_order_line_invalid'],
    });

    const cashOfA = accountOfA('1110');
    const receiptForB = await as(
      tenantA,
      'POST',
      '/receipts',
      receiptBody(customerOfB.id, cashOfA, branchOfA, []),
    );
    expect(problemOf(receiptForB).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });
    const intoCashOfB = await as(
      tenantA,
      'POST',
      '/receipts',
      receiptBody(customerOfA.id, cashOfB, branchOfA, []),
    );
    expect(problemOf(intoCashOfB).fieldErrors).toEqual({ accountId: ['receipt_account_invalid'] });
    const payingB = await as(
      tenantA,
      'POST',
      '/receipts',
      receiptBody(customerOfA.id, cashOfA, branchOfA, [
        { invoiceId: invoiceOfB.id, amount: '100' },
      ]),
    );
    expect(problemOf(payingB).fieldErrors).toEqual({
      'allocations.0.invoiceId': ['receipt_invoice_invalid'],
    });
    // B's invoice is as B left it
    const after = invoiceSchema.parse(
      (await as(tenantB, 'GET', `/invoices/${invoiceOfB.id}`)).json(),
    );
    expect(after.amountPaid).toBe('200.0000');
  });

  it("numbers its invoices and receipts on its own: B's numbers take nothing from A", async () => {
    const invoice = await as(
      tenantA,
      'POST',
      '/invoices',
      invoiceBody(customerOfA.id, branchOfA, serviceLine(serviceOfA, rateOfA)),
    );
    expect(invoice.statusCode, invoice.body).toBe(201);
    expect(invoiceSchema.parse(invoice.json()).number).toBe(invoiceOfB.number);
    const receipt = await as(
      tenantA,
      'POST',
      '/receipts',
      receiptBody(customerOfA.id, accountOfA('1110'), branchOfA, []),
    );
    expect(receipt.statusCode, receipt.body).toBe(201);
    expect(receiptSchema.parse(receipt.json()).number).toBe(receiptOfB.number);
  });
});

describe('return, credit note and refund isolation over HTTP', () => {
  let customerOfA: Customer;
  let goodsOfA: Product;
  let serviceOfA: Product;
  let warehouseOfA: Warehouse;
  let rateOfA: string;
  let invoiceOfA: Invoice;
  let invoiceOfB: Invoice;
  let challanOfB: Delivery;
  let returnOfB: SalesReturn;
  let draftReturnOfB: SalesReturn;
  let noteOfB: CreditNote;
  let draftNoteOfB: CreditNote;
  let receiptOfB: Receipt;
  let refundOfB: Refund;
  let cashOfB: string;
  let salesOfB: string;

  function opening(product: Product, warehouseId: string) {
    return {
      date: '2026-10-01',
      warehouseId,
      direction: 'in',
      reason: 'opening',
      note: '',
      post: true,
      lines: [
        {
          variantId: product.variants[0]?.id,
          unitId: product.baseUnitId,
          quantity: '50',
          batchId: '',
          lotNumber: '',
          expiresOn: '',
          manufacturedOn: '',
          serialNumbers: [],
          unitCost: '20',
        },
      ],
    };
  }

  function returnBody(customerId: string, warehouseId: string, line: object, extra: object = {}) {
    return {
      customerId,
      date: '2026-10-06',
      warehouseId,
      reason: 'damaged',
      note: '',
      lines: [line],
      post: true,
      ...extra,
    };
  }

  function returnLine(product: Product, extra: object = {}) {
    return {
      variantId: product.variants[0]?.id,
      unitId: product.baseUnitId,
      quantity: '1',
      batchId: '',
      serialNumbers: [],
      deliveryLineId: '',
      ...extra,
    };
  }

  function invoiceBody(customerId: string, branchId: string, line: object) {
    return {
      customerId,
      date: '2026-10-06',
      dueDate: '',
      customerReference: '',
      branchId,
      warehouseId: '',
      note: '',
      lines: [line],
      post: true,
    };
  }

  function serviceLine(product: Product, taxRateId: string) {
    return {
      variantId: product.variants[0]?.id,
      unitId: product.baseUnitId,
      quantity: '1',
      description: '',
      unitPrice: '500',
      discountType: 'percent',
      discount: '',
      taxRateId,
      deliveryLineId: '',
      orderLineId: '',
      batchId: '',
      serialNumbers: [],
    };
  }

  function creditBody(invoiceId: string, invoiceLineId: string, extra: object = {}) {
    return {
      invoiceId,
      date: '2026-10-07',
      reason: 'price_adjustment',
      note: '',
      lines: [
        {
          invoiceLineId,
          returnLineId: '',
          unitId: '',
          quantity: '1',
          description: '',
          unitPrice: '100',
          discountType: 'percent',
          discount: '',
        },
      ],
      post: true,
      ...extra,
    };
  }

  function receiptBody(customerId: string, accountId: string, branchId: string) {
    return {
      customerId,
      date: '2026-10-07',
      amount: '50',
      accountId,
      method: 'cash',
      reference: '',
      branchId,
      note: '',
      allocations: [],
    };
  }

  function refundBody(customerId: string, accountId: string, branchId: string, source: object) {
    return {
      customerId,
      date: '2026-10-08',
      amount: '20',
      accountId,
      method: 'cash',
      reference: '',
      branchId,
      note: '',
      receiptId: '',
      creditNoteId: '',
      ...source,
    };
  }

  async function made<T>(pending: ReturnType<typeof as>, schema: { parse: (v: unknown) => T }) {
    const res = await pending;
    expect(res.statusCode, res.body).toBe(201);
    return schema.parse(res.json());
  }

  beforeAll(async () => {
    // B: stock of its juice, a challan of 10, a posted return of 2 and a draft one; an invoice
    // for a loading charge with a posted credit note and a draft one; an advance of ৳50 by a
    // receipt, of which ৳20 is paid back
    expect(
      (await as(tenantB, 'POST', '/stock-adjustments', opening(productOfB, warehouseOfB.id)))
        .statusCode,
    ).toBe(201);
    challanOfB = await made(
      as(tenantB, 'POST', '/deliveries', {
        customerId: customerOfB.id,
        orderId: '',
        date: '2026-10-05',
        warehouseId: warehouseOfB.id,
        shippingAddressId: '',
        vehicle: '',
        note: '',
        lines: [
          {
            variantId: productOfB.variants[0]?.id,
            unitId: productOfB.baseUnitId,
            quantity: '10',
            batchId: '',
            serialNumbers: [],
            orderLineId: '',
          },
        ],
        post: true,
      }),
      deliverySchema,
    );
    const fromChallan = returnLine(productOfB, { deliveryLineId: challanOfB.lines[0]?.id });
    returnOfB = await made(
      as(
        tenantB,
        'POST',
        '/sales-returns',
        returnBody(customerOfB.id, warehouseOfB.id, { ...fromChallan, quantity: '2' }),
      ),
      salesReturnSchema,
    );
    draftReturnOfB = await made(
      as(
        tenantB,
        'POST',
        '/sales-returns',
        returnBody(customerOfB.id, warehouseOfB.id, fromChallan, { post: false }),
      ),
      salesReturnSchema,
    );
    const unitsOfB = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;
    const loading = await made(
      as(
        tenantB,
        'POST',
        '/products',
        productForm('Loading charge', unitsOfB, { type: 'service' }),
      ),
      productSchema,
    );
    invoiceOfB = await made(
      as(
        tenantB,
        'POST',
        '/invoices',
        invoiceBody(customerOfB.id, warehouseOfB.branchId, serviceLine(loading, rateOfB.id)),
      ),
      invoiceSchema,
    );
    const lineOfB = invoiceOfB.lines[0]?.id ?? '';
    noteOfB = await made(
      as(
        tenantB,
        'POST',
        '/credit-notes',
        creditBody(invoiceOfB.id, lineOfB, {
          lines: [{ ...creditBody('', lineOfB).lines[0], unitId: loading.baseUnitId }],
        }),
      ),
      creditNoteSchema,
    );
    draftNoteOfB = await made(
      as(
        tenantB,
        'POST',
        '/credit-notes',
        creditBody(invoiceOfB.id, lineOfB, {
          lines: [{ ...creditBody('', lineOfB).lines[0], unitId: loading.baseUnitId }],
          post: false,
        }),
      ),
      creditNoteSchema,
    );
    const accountsOfB = accountListSchema.parse(
      (await as(tenantB, 'GET', '/accounts')).json(),
    ).items;
    cashOfB = accountsOfB.find((account) => account.purpose === 'cash')?.id ?? '';
    salesOfB = accountsOfB.find((account) => account.purpose === 'sales')?.id ?? '';
    receiptOfB = await made(
      as(tenantB, 'POST', '/receipts', receiptBody(customerOfB.id, cashOfB, warehouseOfB.branchId)),
      receiptSchema,
    );
    refundOfB = await made(
      as(
        tenantB,
        'POST',
        '/refunds',
        refundBody(customerOfB.id, cashOfB, warehouseOfB.branchId, { receiptId: receiptOfB.id }),
      ),
      refundSchema,
    );
    // Paid back in part: a new version. A's attempts below send B's current ones.
    receiptOfB = receiptSchema.parse(
      (await as(tenantB, 'GET', `/receipts/${receiptOfB.id}`)).json(),
    );

    // A: its own customer, goods in stock, a service, a warehouse, a VAT rate and a posted invoice
    customerOfA = customerSchema.parse(
      (await as(tenantA, 'POST', '/customers', customerForm('Nordic Kids Wear AB'))).json(),
    );
    goodsOfA = await made(
      as(tenantA, 'POST', '/products', productForm('Rib knit cardigan', unitsOfA)),
      productSchema,
    );
    serviceOfA = await made(
      as(
        tenantA,
        'POST',
        '/products',
        productForm('Lab dip charge', unitsOfA, { type: 'service' }),
      ),
      productSchema,
    );
    const [own] = warehouseListSchema.parse((await as(tenantA, 'GET', '/warehouses')).json()).items;
    if (!own) throw new Error('A has no warehouse');
    warehouseOfA = own;
    expect(
      (await as(tenantA, 'POST', '/stock-adjustments', opening(goodsOfA, warehouseOfA.id)))
        .statusCode,
    ).toBe(201);
    const rates = taxRateListSchema.parse((await as(tenantA, 'GET', '/tax-rates')).json()).items;
    rateOfA = rates.find((rate) => rate.isDefault)?.id ?? '';
    invoiceOfA = await made(
      as(
        tenantA,
        'POST',
        '/invoices',
        invoiceBody(customerOfA.id, warehouseOfA.branchId, serviceLine(serviceOfA, rateOfA)),
      ),
      invoiceSchema,
    );
  });

  it("never lists or reads B's returns, credit notes, refunds or setting", async () => {
    for (const url of [
      '/sales-returns',
      `/sales-returns?customerId=${customerOfB.id}`,
      '/credit-notes',
      `/credit-notes?invoiceId=${invoiceOfB.id}`,
      '/refunds',
      `/refunds?customerId=${customerOfB.id}`,
    ]) {
      const page: unknown = (await as(tenantA, 'GET', url)).json();
      const items = url.startsWith('/sales-returns')
        ? salesReturnPageSchema.parse(page).items
        : url.startsWith('/credit-notes')
          ? creditNotePageSchema.parse(page).items
          : refundPageSchema.parse(page).items;
      expect(items, url).toEqual([]);
    }
    for (const url of [
      `/sales-returns/${returnOfB.id}`,
      `/sales-returns/${draftReturnOfB.id}`,
      `/credit-notes/${noteOfB.id}`,
      `/credit-notes/${draftNoteOfB.id}`,
      `/refunds/${refundOfB.id}`,
    ]) {
      expect((await as(tenantA, 'GET', url)).statusCode, url).toBe(404);
    }
  });

  it('cannot change, post, delete, apply or void any of them', async () => {
    const attempts = [
      as(tenantA, 'PUT', `/sales-returns/${draftReturnOfB.id}`, {
        ...returnBody(customerOfA.id, warehouseOfA.id, returnLine(goodsOfA)),
        version: draftReturnOfB.version,
      }),
      as(tenantA, 'POST', `/sales-returns/${draftReturnOfB.id}/post`, {
        version: draftReturnOfB.version,
      }),
      as(
        tenantA,
        'DELETE',
        `/sales-returns/${draftReturnOfB.id}?version=${String(draftReturnOfB.version)}`,
      ),
      // A valid form of A's own: a 400 from the contract would never reach the tenant check
      as(tenantA, 'PUT', `/credit-notes/${draftNoteOfB.id}`, {
        ...creditBody(invoiceOfA.id, invoiceOfA.lines[0]?.id ?? '', {
          lines: [
            {
              ...creditBody('', invoiceOfA.lines[0]?.id ?? '').lines[0],
              unitId: serviceOfA.baseUnitId,
            },
          ],
        }),
        version: draftNoteOfB.version,
      }),
      as(tenantA, 'POST', `/credit-notes/${draftNoteOfB.id}/post`, {
        version: draftNoteOfB.version,
      }),
      as(
        tenantA,
        'DELETE',
        `/credit-notes/${draftNoteOfB.id}?version=${String(draftNoteOfB.version)}`,
      ),
      as(tenantA, 'PUT', `/credit-notes/${noteOfB.id}/allocations`, {
        version: noteOfB.version,
        allocations: [],
      }),
      as(tenantA, 'POST', `/refunds/${refundOfB.id}/void`, {
        version: refundOfB.version,
        date: '2026-10-09',
        reason: 'Taken over',
      }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode, res.body).toBe(404);

    const returnNow = salesReturnSchema.parse(
      (await as(tenantB, 'GET', `/sales-returns/${draftReturnOfB.id}`)).json(),
    );
    expect(returnNow).toMatchObject({ status: 'draft', version: draftReturnOfB.version });
    const draftNow = creditNoteSchema.parse(
      (await as(tenantB, 'GET', `/credit-notes/${draftNoteOfB.id}`)).json(),
    );
    expect(draftNow).toMatchObject({ status: 'draft', version: draftNoteOfB.version });
    const noteNow = creditNoteSchema.parse(
      (await as(tenantB, 'GET', `/credit-notes/${noteOfB.id}`)).json(),
    );
    expect(noteNow).toMatchObject({ applied: noteOfB.applied, version: noteOfB.version });
    const refundNow = refundSchema.parse(
      (await as(tenantB, 'GET', `/refunds/${refundOfB.id}`)).json(),
    );
    expect(refundNow).toMatchObject({ status: 'posted', version: refundOfB.version });
  });

  it("cannot take back, credit or pay back with B's customer, challan, invoice, receipt or accounts", async () => {
    const forB = await as(
      tenantA,
      'POST',
      '/sales-returns',
      returnBody(customerOfB.id, warehouseOfA.id, returnLine(goodsOfA)),
    );
    expect(problemOf(forB).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });
    const intoB = await as(
      tenantA,
      'POST',
      '/sales-returns',
      returnBody(customerOfA.id, warehouseOfB.id, returnLine(goodsOfA)),
    );
    expect(problemOf(intoB).fieldErrors).toEqual({ warehouseId: ['stock_warehouse_invalid'] });
    const fromChallanOfB = await as(
      tenantA,
      'POST',
      '/sales-returns',
      returnBody(
        customerOfA.id,
        warehouseOfA.id,
        returnLine(goodsOfA, { deliveryLineId: challanOfB.lines[0]?.id }),
      ),
    );
    expect(problemOf(fromChallanOfB).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['return_delivery_line_invalid'],
    });

    const lineOfA = invoiceOfA.lines[0]?.id ?? '';
    const withUnit = (body: ReturnType<typeof creditBody>, extra: object) => ({
      ...body,
      lines: [{ ...body.lines[0], unitId: serviceOfA.baseUnitId, ...extra }],
    });
    const invoiceOfBForA = await as(
      tenantA,
      'POST',
      '/credit-notes',
      withUnit(creditBody(invoiceOfB.id, lineOfA), {}),
    );
    expect(problemOf(invoiceOfBForA).fieldErrors).toEqual({
      invoiceId: ['credit_note_invoice_invalid'],
    });
    const lineOfB = await as(
      tenantA,
      'POST',
      '/credit-notes',
      withUnit(creditBody(invoiceOfA.id, lineOfA), { invoiceLineId: invoiceOfB.lines[0]?.id }),
    );
    expect(problemOf(lineOfB).fieldErrors).toEqual({
      'lines.0.invoiceLineId': ['credit_note_line_invalid'],
    });
    const returnLineOfB = await as(
      tenantA,
      'POST',
      '/credit-notes',
      withUnit(creditBody(invoiceOfA.id, lineOfA), { returnLineId: returnOfB.lines[0]?.id }),
    );
    expect(problemOf(returnLineOfB).fieldErrors).toEqual({
      'lines.0.returnLineId': ['credit_note_return_invalid'],
    });
    // A's own credit note, applied to B's invoice
    const own = await made(
      as(tenantA, 'POST', '/credit-notes', withUnit(creditBody(invoiceOfA.id, lineOfA), {})),
      creditNoteSchema,
    );
    const applyToB = await as(tenantA, 'PUT', `/credit-notes/${own.id}/allocations`, {
      version: own.version,
      allocations: [{ invoiceId: invoiceOfB.id, amount: '10' }],
    });
    expect(problemOf(applyToB).fieldErrors).toEqual({
      'allocations.0.invoiceId': ['credit_note_allocation_invalid'],
    });

    const cashOfA = accountOfA('1110');
    const fromReceiptOfB = await as(
      tenantA,
      'POST',
      '/refunds',
      refundBody(customerOfA.id, cashOfA, warehouseOfA.branchId, { receiptId: receiptOfB.id }),
    );
    expect(problemOf(fromReceiptOfB).fieldErrors).toEqual({ receiptId: ['refund_source_invalid'] });
    const fromNoteOfB = await as(
      tenantA,
      'POST',
      '/refunds',
      refundBody(customerOfA.id, cashOfA, warehouseOfA.branchId, { creditNoteId: noteOfB.id }),
    );
    expect(problemOf(fromNoteOfB).fieldErrors).toEqual({ creditNoteId: ['refund_source_invalid'] });
    const outOfCashOfB = await as(
      tenantA,
      'POST',
      '/refunds',
      refundBody(customerOfA.id, cashOfB, warehouseOfA.branchId, { creditNoteId: own.id }),
    );
    expect(problemOf(outOfCashOfB).fieldErrors).toEqual({ accountId: ['refund_account_invalid'] });

    const settingOfB = await as(tenantA, 'PUT', '/sales-accounts', { returns: salesOfB });
    expect(problemOf(settingOfB).fieldErrors).toEqual({ returns: ['sales_account_invalid'] });
    for (const who of [tenantA, tenantB]) {
      const setting = salesAccountsSchema.parse((await as(who, 'GET', '/sales-accounts')).json());
      expect(setting.returns).toBeNull();
    }
    // B's money is as B left it
    const receiptNow = receiptSchema.parse(
      (await as(tenantB, 'GET', `/receipts/${receiptOfB.id}`)).json(),
    );
    expect(receiptNow).toMatchObject({ refunded: '20.0000', version: receiptOfB.version });
  });

  it('numbers its returns, credit notes and refunds on its own', async () => {
    const back = await made(
      as(
        tenantA,
        'POST',
        '/sales-returns',
        returnBody(customerOfA.id, warehouseOfA.id, returnLine(goodsOfA)),
      ),
      salesReturnSchema,
    );
    expect(back.number).toBe(returnOfB.number);
    const notes = creditNotePageSchema.parse((await as(tenantA, 'GET', '/credit-notes')).json());
    expect(notes.items.map((item) => item.number)).toEqual([noteOfB.number]);
    const receipt = await made(
      as(
        tenantA,
        'POST',
        '/receipts',
        receiptBody(customerOfA.id, accountOfA('1110'), warehouseOfA.branchId),
      ),
      receiptSchema,
    );
    const refund = await made(
      as(
        tenantA,
        'POST',
        '/refunds',
        refundBody(customerOfA.id, accountOfA('1110'), warehouseOfA.branchId, {
          receiptId: receipt.id,
        }),
      ),
      refundSchema,
    );
    expect(refund.number).toBe(refundOfB.number);
  });
});
