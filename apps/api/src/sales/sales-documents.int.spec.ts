import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  auditPageSchema,
  type Customer,
  customerSchema,
  type Delivery,
  type DeliveryFormValues,
  deliveryPageSchema,
  deliverySchema,
  journalEntrySchema,
  type PriceList,
  priceListSchema,
  priceLookupSchema,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  type Quotation,
  type QuotationFormValues,
  quotationPageSchema,
  quotationSchema,
  type SalesLineFormValues,
  type SalesOrder,
  type SalesOrderFormValues,
  salesOrderPageSchema,
  salesOrderSchema,
  type Settings,
  settingsSchema,
  setupSchema,
  stockCardSchema,
  stockMovementPageSchema,
  stockPageSchema,
  type TaxRate,
  taxRateListSchema,
  taxRateSchema,
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
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// Step 15b: quotation → order → delivery, for one distributor. Juice sold by the piece, the 6-pack
// and the 24-bottle case (a dealer price list has two of them); Napa in batches; phones by IMEI; a
// delivery charge that is a service. Bhairab Bazar Traders buys on the dealer list, Ashulia Super
// Shop at the products' own prices. Each test builds on the ones before it, like the stock tests.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// A member with no role: reads every sales document, writes none, sees no cost
let viewer: SignedIn;
let units: Unit[];
let accounts: Account[];
let rates: TaxRate[];
let main: Warehouse;
let juice: Product;
let napa: Product;
let phone: Product;
let carriage: Product;
let dealer: PriceList;
let bhairab: Customer;
let ashulia: Customer;
let quotation: Quotation;
// The order the deliveries take goods against
let order: SalesOrder;

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

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function unitId(code: string): string {
  const found = units.find((unit) => unit.code === code);
  if (!found) throw new Error(`no unit ${code}`);
  return found.id;
}

function rateId(name: string): string {
  const found = rates.find((rate) => rate.name === name);
  if (!found) throw new Error(`no VAT rate ${name}`);
  return found.id;
}

function codeOf(id: string): string {
  return accounts.find((account) => account.id === id)?.code ?? id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function addressOf(customer: Customer): string {
  const [address] = customer.addresses;
  if (!address) throw new Error(`${customer.name} has no address`);
  return address.id;
}

// The order line of a product, for a delivery line to point at
function orderLine(saved: SalesOrder, product: Product): string {
  const found = saved.lines.find((item) => item.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} on ${saved.number ?? 'the order'}`);
  return found.id;
}

async function addProduct(name: string, extra: Partial<ProductFormValues> = {}) {
  const res = await send('POST', '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: unitId('pcs'),
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
  } satisfies ProductFormValues);
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

function salePrice(price: string) {
  return [{ id: null, sku: '', optionValues: [], barcode: '', salePrice: price, archived: false }];
}

async function addCustomer(name: string, extra: object = {}) {
  const res = await send('POST', '/customers', {
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
  });
  expect(res.statusCode, res.body).toBe(201);
  return customerSchema.parse(res.json());
}

function settingsForm(settings: Settings, pricesIncludeVat: boolean) {
  return {
    version: settings.version,
    companyName: settings.companyName,
    legalName: settings.legalName ?? '',
    bin: settings.bin ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    address: settings.address ?? '',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
    allowNegativeStock: settings.allowNegativeStock,
    pricesIncludeVat,
  };
}

async function setPricesIncludeVat(on: boolean): Promise<void> {
  const settings = settingsSchema.parse((await send('GET', '/settings')).json());
  const res = await send('PUT', '/settings', settingsForm(settings, on));
  expect(res.statusCode, res.body).toBe(200);
}

// A line as the form sends it: by the piece, at 15% VAT, no discount, the product's own name
function salesLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<SalesLineFormValues> = {},
): SalesLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: rateId('VAT 15%'),
    ...extra,
  };
}

function quotationForm(
  lines: SalesLineFormValues[],
  extra: Partial<QuotationFormValues> = {},
): Omit<QuotationFormValues, 'version'> {
  return {
    customerId: bhairab.id,
    date: '2026-10-01',
    validUntil: '2026-10-15',
    note: '',
    lines,
    ...extra,
  };
}

async function quoted(body: object): Promise<Quotation> {
  const res = await send('POST', '/quotations', body);
  expect(res.statusCode, res.body).toBe(201);
  return quotationSchema.parse(res.json());
}

function orderForm(
  lines: SalesLineFormValues[],
  extra: Partial<SalesOrderFormValues> & { quotationId?: string } = {},
) {
  return {
    customerId: bhairab.id,
    date: '2026-10-02',
    deliveryDate: '',
    customerReference: '',
    warehouseId: main.id,
    shippingAddressId: '',
    note: '',
    lines,
    confirm: false,
    ...extra,
  };
}

async function ordered(body: object): Promise<SalesOrder> {
  const res = await send('POST', '/sales-orders', body);
  expect(res.statusCode, res.body).toBe(201);
  return salesOrderSchema.parse(res.json());
}

async function orderNow(id: string): Promise<SalesOrder> {
  return salesOrderSchema.parse((await send('GET', `/sales-orders/${id}`)).json());
}

function deliveryLine(product: Product, quantity: string, extra: object = {}) {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    serialNumbers: [],
    orderLineId: '',
    ...extra,
  };
}

function deliveryForm(lines: object[], extra: Partial<DeliveryFormValues> = {}) {
  return {
    customerId: bhairab.id,
    orderId: order.id,
    date: '2026-10-05',
    warehouseId: main.id,
    shippingAddressId: '',
    vehicle: '',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

async function delivered(body: object): Promise<Delivery> {
  const res = await send('POST', '/deliveries', body);
  expect(res.statusCode, res.body).toBe(201);
  return deliverySchema.parse(res.json());
}

async function postDraft(draft: Delivery) {
  return send('POST', `/deliveries/${draft.id}/post`, { version: draft.version });
}

// A journal entry as [account code, debit, credit] rows — what an accountant reads
async function entryLines(id: string) {
  const entry = journalEntrySchema.parse((await send('GET', `/journal-entries/${id}`)).json());
  return entry.lines.map((item) => [codeOf(item.accountId), item.debit, item.credit]);
}

// What /stock shows for the main warehouse: on hand and still to deliver, per product name
async function stockNow() {
  const page = stockPageSchema.parse((await send('GET', `/stock?warehouseId=${main.id}`)).json());
  return Object.fromEntries(
    page.items.map((item) => [item.productName, [item.onHand, item.onOrder]]),
  );
}

async function batchOf(product: Product, lotNumber: string): Promise<string> {
  const card = stockCardSchema.parse(
    (await send('GET', `/stock/variants/${variantOf(product)}`)).json(),
  );
  const found = card.batches.find((batch) => batch.lotNumber === lotNumber);
  if (!found) throw new Error(`no batch ${lotNumber}`);
  return found.batchId;
}

// A line of the opening stock adjustment: by the piece unless extra says otherwise
function openingLine(product: Product, quantity: string, unitCost: string, extra: object = {}) {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost,
    ...extra,
  };
}

function lookup(customerId: string | null, items: { variantId: string; unitId: string }[]) {
  return send('POST', '/sales/price-lookup', { customerId, items });
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
  owner = await signUp(app, {
    companyName: 'Meghna Distributors',
    workspaceSlug: 'meghna-distributors',
    fullName: 'Shafiq Ahmed',
    email: 'shafiq@meghnadistributors.com',
    password: 'Narsingdi-depot-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const [first] = warehouseListSchema.parse((await send('GET', '/warehouses')).json()).items;
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;

  juice = await addProduct('Mango juice 250 ml', {
    variants: salePrice('25'),
    units: [
      { unitId: unitId('pack'), factor: '6', barcode: '' },
      { unitId: unitId('case'), factor: '24', barcode: '' },
    ],
  });
  napa = await addProduct('Napa 500 mg', {
    tracking: 'batch',
    hasExpiry: true,
    taxRateId: rateId('Exempt'),
    variants: salePrice('1.2'),
  });
  // Priced by hand on every order: no sale price
  phone = await addProduct('Walton Primo NH5', { tracking: 'serial' });
  carriage = await addProduct('Delivery charge', { type: 'service', variants: salePrice('500') });

  dealer = priceListSchema.parse(
    (await send('POST', '/price-lists', { name: 'Dealer', description: '' })).json(),
  );
  const priced = await send('PUT', `/price-lists/${dealer.id}/items`, {
    changes: [
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '22' },
      { variantId: variantOf(juice), unitId: unitId('case'), price: '504' },
    ],
  });
  expect(priced.statusCode, priced.body).toBe(200);
  bhairab = await addCustomer('Bhairab Bazar Traders', {
    priceListId: dealer.id,
    addresses: [
      {
        id: null,
        kind: 'shipping',
        label: 'Bhairab godown',
        address: 'Station Road, Bhairab, Kishoreganj',
        phone: '01712-334455',
      },
    ],
  });
  ashulia = await addCustomer('Ashulia Super Shop', {
    addresses: [
      { id: null, kind: 'shipping', label: '', address: 'Baipail, Ashulia, Savar', phone: '' },
    ],
  });

  // Opening stock: 10 cases of juice at ৳1,200 a case (৳50 a piece), Napa in two lots at ৳0.80,
  // two phones at ৳18,000
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      openingLine(juice, '10', '1200', { unitId: unitId('case') }),
      openingLine(napa, '120', '0.80', { lotNumber: 'NP24090', expiresOn: '2027-01-31' }),
      openingLine(napa, '100', '0.80', { lotNumber: 'NP24117', expiresOn: '2027-06-30' }),
      openingLine(phone, '2', '18000', { serialNumbers: ['356938035643809', '356938035643817'] }),
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);

  await signUp(app, {
    companyName: 'Rina Store',
    workspaceSlug: 'rina-store',
    fullName: 'Rina Akter',
    email: 'rina@meghnadistributors.com',
    password: 'Counter-cash-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'rina@meghnadistributors.com',
    workspace: 'meghna-distributors',
  });
  viewer = await logIn(app, {
    workspace: 'meghna-distributors',
    email: 'rina@meghnadistributors.com',
    password: 'Counter-cash-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('price lookup', () => {
  it("starts a line at the customer's list price, else the product's price for the unit", async () => {
    const res = await lookup(bhairab.id, [
      { variantId: variantOf(juice), unitId: unitId('pcs') },
      { variantId: variantOf(juice), unitId: unitId('case') },
      // Not on the dealer list: the product's ৳25 × 6
      { variantId: variantOf(juice), unitId: unitId('pack') },
      { variantId: variantOf(napa), unitId: unitId('pcs') },
      { variantId: variantOf(phone), unitId: unitId('pcs') },
      // Napa is never sold by the case, and the last one is no product at all: both left out
      { variantId: variantOf(napa), unitId: unitId('case') },
      { variantId: '01939d1c-0000-7000-8000-000000000000', unitId: unitId('pcs') },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const prices = priceLookupSchema.parse(res.json());
    expect(prices.pricesIncludeVat).toBe(false);
    expect(prices.items.map((item) => [item.price, item.source, item.taxRateId])).toEqual([
      ['22.0000', 'price_list', rateId('VAT 15%')],
      ['504.0000', 'price_list', rateId('VAT 15%')],
      ['150.0000', 'product', rateId('VAT 15%')],
      ['1.2000', 'product', rateId('Exempt')],
      // Nobody set a price: the person types it
      [null, null, rateId('VAT 15%')],
    ]);
  });

  it("uses the products' own prices with no customer, and while the customer's list is archived", async () => {
    const juicePiece = [{ variantId: variantOf(juice), unitId: unitId('pcs') }];
    const anyone = priceLookupSchema.parse((await lookup(null, juicePiece)).json());
    expect(anyone.items[0]).toMatchObject({ price: '25.0000', source: 'product' });

    dealer = priceListSchema.parse((await send('GET', `/price-lists/${dealer.id}`)).json());
    const archived = await send('POST', `/price-lists/${dealer.id}/archive`, {
      version: dealer.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const fallback = priceLookupSchema.parse((await lookup(bhairab.id, juicePiece)).json());
    expect(fallback.items[0]).toMatchObject({ price: '25.0000', source: 'product' });
    const restored = await send('POST', `/price-lists/${dealer.id}/restore`, {
      version: priceListSchema.parse(archived.json()).version,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const back = priceLookupSchema.parse((await lookup(bhairab.id, juicePiece)).json());
    expect(back.items[0]).toMatchObject({ price: '22.0000', source: 'price_list' });
  });

  it("falls back to the default VAT rate while the product's own rate is archived", async () => {
    const exempt = rates.find((rate) => rate.id === rateId('Exempt'));
    if (!exempt) throw new Error('no Exempt rate');
    const archived = await send('POST', `/tax-rates/${exempt.id}/archive`, {
      version: exempt.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const napaPiece = [{ variantId: variantOf(napa), unitId: unitId('pcs') }];
    const prices = priceLookupSchema.parse((await lookup(null, napaPiece)).json());
    expect(prices.items[0]?.taxRateId).toBe(rateId('VAT 15%'));
    const restored = await send('POST', `/tax-rates/${exempt.id}/restore`, {
      version: taxRateSchema.parse(archived.json()).version,
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });
});

describe('quotations', () => {
  it('get their number when saved, and work each line out to the paisa', async () => {
    quotation = await quoted(
      quotationForm([
        // 2 cases at the dealer's ৳504, 10% off: ৳1,008 − ৳100.80 = ৳907.20, + 15% VAT ৳136.08
        salesLine(juice, '2', '504', { unitId: unitId('case'), discount: '10' }),
        // 200 tablets at ৳1.20, ৳40 off: ৳200, exempt
        salesLine(napa, '200', '1.2', {
          discountType: 'amount',
          discount: '40',
          taxRateId: rateId('Exempt'),
          description: 'Napa 500 mg, 10 × 10 strips',
        }),
      ]),
    );
    expect(quotation).toMatchObject({
      number: 'QT-2026-27-0001',
      status: 'open',
      pricesIncludeVat: false,
      customer: { id: bhairab.id, name: 'Bhairab Bazar Traders' },
      discount: '140.8000',
      net: '1107.2000',
      vat: '136.0800',
      total: '1243.2800',
      lineCount: 2,
      order: null,
    });
    expect(
      quotation.lines.map((item) => [item.description, item.baseQuantity, item.net, item.vat]),
    ).toEqual([
      // No description typed: the product's name
      ['Mango juice 250 ml', '48.0000', '907.2000', '136.0800'],
      ['Napa 500 mg, 10 × 10 strips', '200.0000', '200.0000', '0.0000'],
    ]);
    expect(quotation.lines[1]?.taxRate).toMatchObject({ name: 'Exempt', kind: 'exempt' });

    const { items: log } = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=quotation&entityId=${quotation.id}`)).json(),
    );
    expect(log[0]?.action).toBe('quotation.created');
  });

  it('refuse every line they cannot use, each under its own field', async () => {
    const res = await send(
      'POST',
      '/quotations',
      quotationForm([
        salesLine(juice, '1', '22'),
        { ...salesLine(juice, '1', '22'), variantId: '01939d1c-0000-7000-8000-000000000000' },
        salesLine(napa, '1', '120', { unitId: unitId('case') }),
        salesLine(juice, '1', '22', { taxRateId: '01939d1c-0000-7000-8000-000000000001' }),
      ]),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.1.variantId': ['sales_item_invalid'],
      'lines.2.unitId': ['stock_unit_invalid'],
      'lines.3.taxRateId': ['tax_rate_invalid'],
    });

    // The form's own rules: a discount larger than the line, an offer that ends before it starts
    const form = await send(
      'POST',
      '/quotations',
      quotationForm([salesLine(juice, '2', '22', { discountType: 'amount', discount: '45' })], {
        validUntil: '2026-09-30',
      }),
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      validUntil: ['quotation_valid_until'],
      'lines.0.discount': ['sales_discount_too_large'],
    });
  });

  it('change while open; declined, they wait for the customer to come back', async () => {
    const stale = await send('PUT', `/quotations/${quotation.id}`, {
      ...quotationForm([salesLine(juice, '24', '22')]),
      version: quotation.version + 1,
    });
    expect(problemOf(stale).code).toBe('version_conflict');

    const declined = quotationSchema.parse(
      (
        await send('POST', `/quotations/${quotation.id}/decline`, { version: quotation.version })
      ).json(),
    );
    expect(declined.status).toBe('declined');
    const edit = await send('PUT', `/quotations/${quotation.id}`, {
      ...quotationForm([salesLine(juice, '24', '22')]),
      version: declined.version,
    });
    expect(edit.statusCode).toBe(409);
    expect(problemOf(edit).code).toBe('quotation_not_open');

    const reopened = quotationSchema.parse(
      (
        await send('POST', `/quotations/${quotation.id}/reopen`, { version: declined.version })
      ).json(),
    );
    expect(reopened.status).toBe('open');
    const again = await send('POST', `/quotations/${quotation.id}/reopen`, {
      version: reopened.version,
    });
    expect(problemOf(again).code).toBe('quotation_not_declined');

    // The same quotation, with the juice by the piece now: the totals follow the lines
    const changed = await send('PUT', `/quotations/${quotation.id}`, {
      ...quotationForm([salesLine(juice, '24', '22')]),
      version: reopened.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    quotation = quotationSchema.parse(changed.json());
    expect(quotation).toMatchObject({
      number: 'QT-2026-27-0001',
      net: '528.0000',
      vat: '79.2000',
      total: '607.2000',
    });
  });

  it('are deleted while open, and the next one takes the next number', async () => {
    const spare = await quoted(quotationForm([salesLine(juice, '6', '22')]));
    expect(spare.number).toBe('QT-2026-27-0002');
    const res = await send('DELETE', `/quotations/${spare.id}?version=${String(spare.version)}`);
    expect(res.statusCode).toBe(204);
    expect((await send('GET', `/quotations/${spare.id}`)).statusCode).toBe(404);
    const page = quotationPageSchema.parse((await send('GET', '/quotations?status=open')).json());
    expect(page.items.map((item) => item.number)).toEqual(['QT-2026-27-0001']);
  });
});

describe('sales orders', () => {
  it('accept the quotation they are made from, and give it back when the draft is deleted', async () => {
    const fromQuotation = await ordered(
      orderForm([salesLine(juice, '24', '22')], { quotationId: quotation.id }),
    );
    expect(fromQuotation).toMatchObject({
      number: null,
      status: 'draft',
      quotation: { id: quotation.id, number: 'QT-2026-27-0001' },
    });
    let answered = quotationSchema.parse((await send('GET', `/quotations/${quotation.id}`)).json());
    expect(answered).toMatchObject({
      status: 'accepted',
      order: { id: fromQuotation.id, number: null },
    });

    // Accepted once: a second order from it, or one for another customer, is refused
    const twice = await send(
      'POST',
      '/sales-orders',
      orderForm([salesLine(juice, '24', '22')], { quotationId: quotation.id }),
    );
    expect(problemOf(twice).code).toBe('quotation_not_open');
    const otherCustomer = await send(
      'POST',
      '/sales-orders',
      orderForm([salesLine(juice, '24', '25')], {
        customerId: ashulia.id,
        quotationId: quotation.id,
      }),
    );
    expect(problemOf(otherCustomer).fieldErrors).toEqual({
      quotationId: ['order_quotation_invalid'],
    });

    const removed = await send(
      'DELETE',
      `/sales-orders/${fromQuotation.id}?version=${String(fromQuotation.version)}`,
    );
    expect(removed.statusCode).toBe(204);
    answered = quotationSchema.parse((await send('GET', `/quotations/${quotation.id}`)).json());
    expect(answered).toMatchObject({ status: 'open', order: null });
  });

  it("read prices the quotation's way, whatever the workspace says now", async () => {
    await setPricesIncludeVat(true);
    // Written when prices were without VAT: ৳528 + ৳79.20, as the quotation said
    const fromQuotation = await ordered(
      orderForm([salesLine(juice, '24', '22')], { quotationId: quotation.id }),
    );
    expect(fromQuotation).toMatchObject({ pricesIncludeVat: false, total: '607.2000' });
    // A new order takes the setting now: ৳504 holds ৳65.74 of VAT
    const fresh = await ordered(
      orderForm([salesLine(juice, '1', '504', { unitId: unitId('case') })]),
    );
    expect(fresh).toMatchObject({
      pricesIncludeVat: true,
      net: '438.2600',
      vat: '65.7400',
      total: '504.0000',
    });
    await setPricesIncludeVat(false);

    const { items: log } = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=sales_order&entityId=${fromQuotation.id}`)).json(),
    );
    expect(log[0]).toMatchObject({ action: 'sales_order.created' });
    expect(log[0]?.changes).toMatchObject({ quotation: { from: null, to: 'QT-2026-27-0001' } });
    const gone = await send('DELETE', `/sales-orders/${fresh.id}?version=${String(fresh.version)}`);
    expect(gone.statusCode).toBe(204);
  });

  it('get their number when confirmed, and keep the shipping address as text', async () => {
    const wrongAddress = await send(
      'POST',
      '/sales-orders',
      orderForm([salesLine(juice, '1', '22')], { shippingAddressId: addressOf(ashulia) }),
    );
    expect(problemOf(wrongAddress).fieldErrors).toEqual({
      shippingAddressId: ['sales_address_invalid'],
    });
    const early = await send(
      'POST',
      '/sales-orders',
      orderForm([salesLine(juice, '1', '22')], { deliveryDate: '2026-10-01' }),
    );
    expect(problemOf(early).fieldErrors).toEqual({ deliveryDate: ['order_delivery_date'] });

    // Five cases of juice, Napa, a phone and the delivery charge, written and confirmed at once
    order = await ordered(
      orderForm(
        [
          salesLine(juice, '5', '504', { unitId: unitId('case') }),
          salesLine(napa, '150', '1.2', { taxRateId: rateId('Exempt') }),
          salesLine(phone, '1', '21500'),
          salesLine(carriage, '1', '500'),
        ],
        {
          shippingAddressId: addressOf(bhairab),
          customerReference: 'PO-BBT-0915',
          deliveryDate: '2026-10-08',
          confirm: true,
        },
      ),
    );
    expect(order).toMatchObject({
      number: 'SO-2026-27-0001',
      status: 'confirmed',
      partlyDelivered: false,
      shippingAddressId: addressOf(bhairab),
      shippingAddress: 'Bhairab godown\nStation Road, Bhairab, Kishoreganj\n01712-334455',
      customerReference: 'PO-BBT-0915',
    });
    expect(order.confirmedAt).not.toBeNull();
    expect(order.lines.map((item) => item.deliveredQuantity)).toEqual([
      '0.0000',
      '0.0000',
      '0.0000',
      '0.0000',
    ]);
  });

  it('go back to draft while nothing is delivered, keeping their number and customer', async () => {
    const small = await ordered(orderForm([salesLine(juice, '12', '22')], { confirm: true }));
    expect(small.number).toBe('SO-2026-27-0002');
    const edit = await send('PUT', `/sales-orders/${small.id}`, {
      ...orderForm([salesLine(juice, '24', '22')]),
      version: small.version,
    });
    expect(problemOf(edit).code).toBe('sales_not_draft');

    const reopened = salesOrderSchema.parse(
      (await send('POST', `/sales-orders/${small.id}/reopen`, { version: small.version })).json(),
    );
    expect(reopened).toMatchObject({
      status: 'draft',
      number: 'SO-2026-27-0002',
      confirmedAt: null,
    });
    // Its number was given out: cancelled, never deleted, and never moved to another customer
    const removed = await send(
      'DELETE',
      `/sales-orders/${small.id}?version=${String(reopened.version)}`,
    );
    expect(problemOf(removed).code).toBe('order_numbered');
    const moved = await send('PUT', `/sales-orders/${small.id}`, {
      ...orderForm([salesLine(juice, '24', '25')], { customerId: ashulia.id }),
      version: reopened.version,
    });
    expect(problemOf(moved).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });

    const confirmed = salesOrderSchema.parse(
      (
        await send('PUT', `/sales-orders/${small.id}`, {
          ...orderForm([salesLine(juice, '24', '22')], { confirm: true }),
          version: reopened.version,
        })
      ).json(),
    );
    expect(confirmed).toMatchObject({ status: 'confirmed', number: 'SO-2026-27-0002' });

    // Nothing delivered: cancelled, not closed; and a cancelled order stays cancelled
    const close = await send('POST', `/sales-orders/${small.id}/close`, {
      version: confirmed.version,
    });
    expect(problemOf(close).code).toBe('order_nothing_delivered');
    const cancelled = salesOrderSchema.parse(
      (
        await send('POST', `/sales-orders/${small.id}/cancel`, { version: confirmed.version })
      ).json(),
    );
    expect(cancelled.status).toBe('cancelled');
    const again = await send('POST', `/sales-orders/${small.id}/cancel`, {
      version: cancelled.version,
    });
    expect(problemOf(again).code).toBe('order_not_confirmed');
  });

  it('show what confirmed orders still have to deliver next to the stock', async () => {
    // The draft from the quotation and the cancelled order hold nothing; the service is not stock
    expect(await stockNow()).toEqual({
      'Mango juice 250 ml': ['240.0000', '120.0000'],
      'Napa 500 mg': ['220.0000', '150.0000'],
      'Walton Primo NH5': ['2.0000', '1.0000'],
    });
    const page = salesOrderPageSchema.parse(
      (await send('GET', '/sales-orders?status=confirmed')).json(),
    );
    expect(page.items.map((item) => item.number)).toEqual(['SO-2026-27-0001']);
  });
});

describe('deliveries', () => {
  it('take part of an order out at its average cost, and book the cost of goods sold', async () => {
    const first = await delivered(
      deliveryForm(
        [
          deliveryLine(juice, '2', {
            unitId: unitId('case'),
            orderLineId: orderLine(order, juice),
          }),
          // The lot that expires first
          deliveryLine(napa, '100', {
            batchId: await batchOf(napa, 'NP24090'),
            orderLineId: orderLine(order, napa),
          }),
          deliveryLine(phone, '1', {
            serialNumbers: ['356938035643809'],
            orderLineId: orderLine(order, phone),
          }),
        ],
        { shippingAddressId: addressOf(bhairab), vehicle: 'Dhaka Metro-Ta 11-2233, Rahim' },
      ),
    );
    expect(first).toMatchObject({
      number: 'DC-2026-27-0001',
      status: 'posted',
      order: { id: order.id, number: 'SO-2026-27-0001' },
      shippingAddress: 'Bhairab godown\nStation Road, Bhairab, Kishoreganj\n01712-334455',
    });
    // 48 pieces at ৳50, 100 tablets at ৳0.80, one phone at ৳18,000
    expect(first.lines.map((item) => [item.baseQuantity, item.value])).toEqual([
      ['48.0000', '2400.0000'],
      ['100.0000', '80.0000'],
      ['1.0000', '18000.0000'],
    ]);
    if (!first.entry) throw new Error('expected a cost of goods sold entry');
    expect(await entryLines(first.entry.id)).toEqual([
      ['5110', '20480.0000', '0.0000'],
      ['1150', '0.0000', '20480.0000'],
    ]);

    order = await orderNow(order.id);
    expect(order).toMatchObject({ status: 'confirmed', partlyDelivered: true });
    expect(order.lines.map((item) => item.deliveredQuantity)).toEqual([
      '48.0000',
      '100.0000',
      '1.0000',
      // The delivery charge is never delivered
      '0.0000',
    ]);
    expect(order.deliveries).toEqual([
      { id: first.id, number: 'DC-2026-27-0001', date: '2026-10-05', status: 'posted' },
    ]);
    expect(await stockNow()).toEqual({
      'Mango juice 250 ml': ['192.0000', '72.0000'],
      'Napa 500 mg': ['120.0000', '50.0000'],
      'Walton Primo NH5': ['1.0000', '0.0000'],
    });
    const history = stockMovementPageSchema.parse(
      (await send('GET', `/stock/variants/${variantOf(juice)}/movements`)).json(),
    );
    expect(history.items.at(-1)).toMatchObject({
      kind: 'delivery',
      documentNumber: 'DC-2026-27-0001',
      quantity: '-48.0000',
    });
  });

  it('never deliver more than the order still has to, at save and again at posting', async () => {
    const juiceLine = orderLine(order, juice);
    // 72 pieces left: four cases is 96
    const tooMuch = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '4', { unitId: unitId('case'), orderLineId: juiceLine })]),
    );
    expect(tooMuch.statusCode).toBe(409);
    expect(problemOf(tooMuch).fieldErrors).toEqual({ 'lines.0.quantity': ['delivery_over_order'] });
    // Two lines on one order line count together, and both are marked
    const split = await send(
      'POST',
      '/deliveries',
      deliveryForm([
        deliveryLine(juice, '2', { unitId: unitId('case'), orderLineId: juiceLine }),
        deliveryLine(juice, '2', { unitId: unitId('case'), orderLineId: juiceLine }),
      ]),
    );
    expect(problemOf(split).fieldErrors).toEqual({
      'lines.0.quantity': ['delivery_over_order'],
      'lines.1.quantity': ['delivery_over_order'],
    });

    // Drafts hold nothing: two of them may each take all 72. The second to post is refused.
    const draft = (quantity: string) =>
      delivered(
        deliveryForm(
          [deliveryLine(juice, quantity, { unitId: unitId('case'), orderLineId: juiceLine })],
          { post: false },
        ),
      );
    const one = await draft('3');
    const two = await draft('3');
    expect([one.number, two.number]).toEqual([null, null]);
    const posted = await postDraft(one);
    expect(posted.statusCode, posted.body).toBe(200);
    expect(deliverySchema.parse(posted.json()).number).toBe('DC-2026-27-0002');
    const late = await postDraft(two);
    expect(late.statusCode).toBe(409);
    expect(problemOf(late).fieldErrors).toEqual({ 'lines.0.quantity': ['delivery_over_order'] });
    // Nothing of it moved, and no number was used
    const still = deliverySchema.parse((await send('GET', `/deliveries/${two.id}`)).json());
    expect(still).toMatchObject({ status: 'draft', number: null });
    const removed = await send('DELETE', `/deliveries/${two.id}?version=${String(still.version)}`);
    expect(removed.statusCode).toBe(204);
  });

  it("deliver only the order's goods, for the order's customer", async () => {
    // A juice line pointing at the Napa line of the order
    const wrongLine = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1', { orderLineId: orderLine(order, napa) })]),
    );
    expect(problemOf(wrongLine).fieldErrors).toEqual({
      'lines.0.orderLineId': ['delivery_order_line_invalid'],
    });
    const otherCustomer = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1', { orderLineId: orderLine(order, juice) })], {
        customerId: ashulia.id,
      }),
    );
    expect(problemOf(otherCustomer).fieldErrors).toEqual({ orderId: ['delivery_order_invalid'] });
    // The form's rule: from an order, every line names its order line; without one, none does
    const noLine = await send('POST', '/deliveries', deliveryForm([deliveryLine(juice, '1')]));
    expect(noLine.statusCode).toBe(400);
    expect(problemOf(noLine).fieldErrors).toEqual({
      'lines.0.orderLineId': ['delivery_order_line_required'],
    });
    // A service never leaves a warehouse, and a batch-tracked item names its batch
    const service = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(carriage, '1', { orderLineId: orderLine(order, carriage) })]),
    );
    expect(problemOf(service).fieldErrors).toEqual({
      'lines.0.variantId': ['stock_variant_invalid'],
    });
    const noBatch = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(napa, '10', { orderLineId: orderLine(order, napa) })]),
    );
    expect(problemOf(noBatch).fieldErrors).toEqual({ 'lines.0.batchId': ['stock_batch_required'] });
  });

  it('finish the order with the last delivery; the service line does not count', async () => {
    // Every posting against it gave the order a new version
    order = await orderNow(order.id);
    const reopen = await send('POST', `/sales-orders/${order.id}/reopen`, {
      version: order.version,
    });
    expect(problemOf(reopen).code).toBe('order_has_deliveries');
    order = await orderNow(order.id);
    const cancel = await send('POST', `/sales-orders/${order.id}/cancel`, {
      version: order.version,
    });
    expect(problemOf(cancel).code).toBe('order_partly_delivered');

    // The last 50 tablets: the 20 left of the first lot and 30 of the next, on one order line
    const last = await delivered(
      deliveryForm([
        deliveryLine(napa, '20', {
          batchId: await batchOf(napa, 'NP24090'),
          orderLineId: orderLine(order, napa),
        }),
        deliveryLine(napa, '30', {
          batchId: await batchOf(napa, 'NP24117'),
          orderLineId: orderLine(order, napa),
        }),
      ]),
    );
    expect(last.number).toBe('DC-2026-27-0003');
    order = await orderNow(order.id);
    expect(order).toMatchObject({ status: 'delivered', partlyDelivered: false });
    expect(order.lines.map((item) => item.deliveredQuantity)).toEqual([
      '120.0000',
      '150.0000',
      '1.0000',
      '0.0000',
    ]);
    // The line says it is a service, so the order page and the delivery form can skip it (15b.6)
    expect(order.lines.map((item) => item.productType)).toEqual([
      'goods',
      'goods',
      'goods',
      'service',
    ]);
    expect(order.deliveries.map((item) => item.number)).toEqual([
      'DC-2026-27-0001',
      'DC-2026-27-0002',
      'DC-2026-27-0003',
    ]);
    const after = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1', { orderLineId: orderLine(order, juice) })]),
    );
    expect(problemOf(after).fieldErrors).toEqual({ orderId: ['order_not_confirmed'] });
  });

  it('close a partly delivered order; a draft left on it cannot be posted', async () => {
    const shopOrder = await ordered(
      orderForm([salesLine(juice, '2', '600', { unitId: unitId('case') })], {
        customerId: ashulia.id,
        confirm: true,
      }),
    );
    const lineId = orderLine(shopOrder, juice);
    await delivered(
      deliveryForm([deliveryLine(juice, '1', { unitId: unitId('case'), orderLineId: lineId })], {
        customerId: ashulia.id,
        orderId: shopOrder.id,
      }),
    );
    const leftOver = await delivered(
      deliveryForm([deliveryLine(juice, '1', { unitId: unitId('case'), orderLineId: lineId })], {
        customerId: ashulia.id,
        orderId: shopOrder.id,
        post: false,
      }),
    );
    const now = await orderNow(shopOrder.id);
    const closed = salesOrderSchema.parse(
      (await send('POST', `/sales-orders/${shopOrder.id}/close`, { version: now.version })).json(),
    );
    expect(closed.status).toBe('closed');
    const late = await postDraft(leftOver);
    expect(problemOf(late).fieldErrors).toEqual({ orderId: ['order_not_confirmed'] });
    const removed = await send(
      'DELETE',
      `/deliveries/${leftOver.id}?version=${String(leftOver.version)}`,
    );
    expect(removed.statusCode).toBe(204);
  });

  it('go out without an order, to a customer who collects the goods', async () => {
    const counter = await delivered(
      deliveryForm([deliveryLine(juice, '6')], {
        customerId: ashulia.id,
        orderId: '',
        vehicle: 'Customer’s own van',
      }),
    );
    expect(counter).toMatchObject({ order: null, status: 'posted', vehicle: 'Customer’s own van' });
    expect(counter.lines[0]).toMatchObject({ orderLineId: null, value: '300.0000' });
    // An order line on a delivery without an order is the form's mistake
    const stray = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1', { orderLineId: orderLine(order, juice) })], {
        orderId: '',
      }),
    );
    expect(problemOf(stray).fieldErrors).toEqual({
      'lines.0.orderLineId': ['delivery_order_line_invalid'],
    });
    // 240 − 48 − 72 − 24 − 6
    expect((await stockNow())['Mango juice 250 ml']).toEqual(['90.0000', '0.0000']);
    const page = deliveryPageSchema.parse(
      (await send('GET', `/deliveries?customerId=${ashulia.id}`)).json(),
    );
    expect(page.items).toHaveLength(2);
  });

  it('stay as they are once posted', async () => {
    const [posted] = deliveryPageSchema.parse(
      (await send('GET', '/deliveries?status=posted&limit=1')).json(),
    ).items;
    if (!posted) throw new Error('no posted delivery');
    const attempts = [
      send('PUT', `/deliveries/${posted.id}`, {
        ...deliveryForm([deliveryLine(juice, '1')], { customerId: ashulia.id, orderId: '' }),
        version: posted.version,
      }),
      send('POST', `/deliveries/${posted.id}/post`, { version: posted.version }),
      send('DELETE', `/deliveries/${posted.id}?version=${String(posted.version)}`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).code).toBe('stock_not_draft');
    }
  });

  it('refuse a date in the future and a date in closed books', async () => {
    const counter = { customerId: ashulia.id, orderId: '' };
    const future = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1')], { ...counter, date: '2099-01-01' }),
    );
    expect(problemOf(future).fieldErrors).toEqual({ date: ['stock_date_future'] });
    expect(
      (await send('PUT', '/period-lock', { lockDate: '2026-09-30', version: 0 })).statusCode,
    ).toBe(200);
    const locked = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1')], { ...counter, date: '2026-09-20' }),
    );
    expect(problemOf(locked).code).toBe('journal_period_locked');
  });
});

describe('who may do what', () => {
  it('lets anyone read sales documents, but not write them or see what the goods cost', async () => {
    const [first] = deliveryPageSchema
      .parse((await send('GET', `/deliveries?customerId=${bhairab.id}`, undefined, viewer)).json())
      .items.slice(-1);
    if (!first) throw new Error('no delivery');
    const seen = deliverySchema.parse(
      (await send('GET', `/deliveries/${first.id}`, undefined, viewer)).json(),
    );
    expect(seen.number).toBe('DC-2026-27-0001');
    expect(seen.lines.map((item) => item.value)).toEqual([null, null, null]);
    expect((await send('GET', `/sales-orders/${order.id}`, undefined, viewer)).statusCode).toBe(
      200,
    );
    expect((await send('GET', '/quotations', undefined, viewer)).statusCode).toBe(200);
    const prices = await lookup(bhairab.id, [
      { variantId: variantOf(juice), unitId: unitId('pcs') },
    ]);
    expect(prices.statusCode).toBe(200);

    const writes = [
      send('POST', '/quotations', quotationForm([salesLine(juice, '1', '22')]), viewer),
      send('POST', '/sales-orders', orderForm([salesLine(juice, '1', '22')]), viewer),
      send(
        'POST',
        '/deliveries',
        deliveryForm([deliveryLine(juice, '1')], { orderId: '', post: false }),
        viewer,
      ),
      send('POST', `/sales-orders/${order.id}/close`, { version: order.version }, viewer),
    ];
    for (const res of await Promise.all(writes)) expect(res.statusCode).toBe(403);
  });
});

describe('what sales documents hold on to', () => {
  it('keeps a customer or a product that a document names', async () => {
    // A customer with nothing but a quotation
    const pharmacy = await addCustomer('Narsingdi Pharmacy');
    await quoted(quotationForm([salesLine(juice, '6', '25')], { customerId: pharmacy.id }));
    const customer = await send(
      'DELETE',
      `/customers/${pharmacy.id}?version=${String(pharmacy.version)}`,
    );
    expect(customer.statusCode).toBe(409);
    expect(problemOf(customer).code).toBe('customer_in_use');
    // The delivery charge is only on an order line
    const product = await send(
      'DELETE',
      `/products/${carriage.id}?version=${String(carriage.version)}`,
    );
    expect(product.statusCode).toBe(409);
    expect(problemOf(product).code).toBe('product_in_use');
  });
});
