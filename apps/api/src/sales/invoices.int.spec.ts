import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  auditPageSchema,
  type Customer,
  customerCreditSchema,
  customerSchema,
  type Delivery,
  deliveryPageSchema,
  deliverySchema,
  type Invoice,
  type InvoiceFormValues,
  type InvoiceLineFormValues,
  invoicePageSchema,
  invoiceSchema,
  journalEntrySchema,
  memberPageSchema,
  meResponseSchema,
  type PermissionKey,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  type Receipt,
  type ReceiptFormValues,
  receiptPageSchema,
  receiptSchema,
  roleSchema,
  type SalesLineFormValues,
  type SalesOrder,
  type SalesOrderFormValues,
  salesOrderPageSchema,
  salesOrderSchema,
  type Settings,
  settingsSchema,
  setupSchema,
  stockCardSchema,
  stockPageSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
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
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// Step 15c: invoices, money receipts and the credit limit, for the distributor of step 15b. Juice
// by the piece and the case, Napa in batches, biscuits that get archived, a delivery charge that is
// a service. Bhairab Bazar Traders buys on 30 days with no limit, Ashulia Super Shop pays on the
// day, Madhabdi Bazar Store and Raipura Traders have credit limits. Each test builds on the ones
// before it, like the 15b tests: read the first failure first.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
let tenantId: string;
// A member with no role: reads invoices and receipts, writes neither
let viewer: SignedIn;
// A sales officer: writes orders, challans, invoices and receipts, but may not go over a limit
let clerk: SignedIn;
let units: Unit[];
let accounts: Account[];
let rates: TaxRate[];
let main: Warehouse;
let juice: Product;
let napa: Product;
let biscuit: Product;
let carriage: Product;
let bhairab: Customer;
let ashulia: Customer;
let madhabdi: Customer;
let raipura: Customer;
// Bhairab's order: 48 pieces of juice and the delivery charge
let order: SalesOrder;
let challan: Delivery;
let firstInvoice: Invoice;
// Another confirmed order of Bhairab's, priced without VAT, whose delivery charge nobody billed yet
let carriageOrder: SalesOrder;
// Ashulia's counter sale, a direct invoice
let counterInvoice: Invoice;
// A draft of Ashulia's that stays a draft: the lists, the receipts and the permissions use it
let leftDraft: Invoice;
// Madhabdi's order that fits under the limit
let madhabdiOrder: SalesOrder;
let cashReceipt: Receipt;
let bankReceipt: Receipt;
// Bhairab's invoices, by the number they ended with
const bhairabInvoices = new Map<string, Invoice>();

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

function account(code: string): string {
  const found = accounts.find((item) => item.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function codeOf(id: string): string {
  return accounts.find((item) => item.id === id)?.code ?? id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function orderLine(saved: SalesOrder, product: Product): string {
  const found = saved.lines.find((item) => item.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} on ${saved.number ?? 'the order'}`);
  return found.id;
}

function challanLine(delivery: Delivery, index = 0): string {
  const found = delivery.lines[index];
  if (!found) throw new Error(`no line ${String(index)} on ${delivery.number ?? 'the challan'}`);
  return found.id;
}

function bhairabInvoice(number: string): Invoice {
  const found = bhairabInvoices.get(`INV-2026-27-${number}`);
  if (!found) throw new Error(`no invoice ${number}`);
  return found;
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

async function addCustomer(name: string, extra: object = {}) {
  const res = await send('POST', '/customers', {
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
    // Step 17b: the whole form, the over-receipt percent too
    overReceiptPercent: settings.overReceiptPercent,
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

// An invoice line: a line of its own unless extra names a challan line or an order line
function invoiceLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<InvoiceLineFormValues> = {},
): InvoiceLineFormValues {
  return {
    ...salesLine(product, quantity, unitPrice),
    deliveryLineId: '',
    orderLineId: '',
    batchId: '',
    serialNumbers: [],
    ...extra,
  };
}

function invoiceForm(
  lines: InvoiceLineFormValues[],
  extra: Partial<InvoiceFormValues> = {},
): Omit<InvoiceFormValues, 'version'> {
  return {
    customerId: bhairab.id,
    date: '2026-10-06',
    dueDate: '',
    customerReference: '',
    branchId: main.branchId,
    warehouseId: '',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

async function invoiced(body: object, as = owner): Promise<Invoice> {
  const res = await send('POST', '/invoices', body, as);
  expect(res.statusCode, res.body).toBe(201);
  const saved = invoiceSchema.parse(res.json());
  if (saved.customer.id === bhairab.id && saved.number !== null) {
    bhairabInvoices.set(saved.number, saved);
  }
  return saved;
}

async function invoiceNow(id: string): Promise<Invoice> {
  return invoiceSchema.parse((await send('GET', `/invoices/${id}`)).json());
}

async function invoiceNumbers(query: string): Promise<(string | null)[]> {
  const page = invoicePageSchema.parse((await send('GET', `/invoices?${query}`)).json());
  return page.items.map((item) => item.number);
}

function orderForm(
  lines: SalesLineFormValues[],
  extra: Partial<SalesOrderFormValues> = {},
): Omit<SalesOrderFormValues, 'version'> {
  return {
    customerId: bhairab.id,
    date: '2026-10-02',
    deliveryDate: '',
    customerReference: '',
    warehouseId: main.id,
    shippingAddressId: '',
    note: '',
    lines,
    confirm: true,
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

function deliveryForm(customer: Customer, orderId: string, lines: object[], extra: object = {}) {
  return {
    customerId: customer.id,
    orderId,
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

async function deliveryNow(id: string): Promise<Delivery> {
  return deliverySchema.parse((await send('GET', `/deliveries/${id}`)).json());
}

function receiptForm(
  amount: string,
  allocations: { invoiceId: string; amount: string }[],
  extra: Partial<ReceiptFormValues> = {},
): ReceiptFormValues {
  return {
    customerId: bhairab.id,
    date: '2026-10-07',
    amount,
    accountId: account('1110'),
    method: 'cash',
    reference: '',
    branchId: main.branchId,
    note: '',
    allocations,
    ...extra,
  };
}

async function received(body: object): Promise<Receipt> {
  const res = await send('POST', '/receipts', body);
  expect(res.statusCode, res.body).toBe(201);
  return receiptSchema.parse(res.json());
}

// A journal entry as [account code, debit, credit] rows — what an accountant reads
async function entryLines(id: string) {
  const entry = journalEntrySchema.parse((await send('GET', `/journal-entries/${id}`)).json());
  return entry.lines.map((item) => [codeOf(item.accountId), item.debit, item.credit]);
}

async function credit(customer: Customer) {
  const res = await send('GET', `/customers/${customer.id}/credit`);
  expect(res.statusCode, res.body).toBe(200);
  return customerCreditSchema.parse(res.json());
}

async function auditActions(entityType: string, entityId: string): Promise<string[]> {
  const page = auditPageSchema.parse(
    (await send('GET', `/audit-logs?entityType=${entityType}&entityId=${entityId}`)).json(),
  );
  return page.items.map((item) => item.action).toSorted();
}

async function stockNow() {
  const page = stockPageSchema.parse((await send('GET', `/stock?warehouseId=${main.id}`)).json());
  return Object.fromEntries(page.items.map((item) => [item.productName, item.onHand]));
}

async function batchOf(product: Product, lotNumber: string): Promise<string> {
  const card = stockCardSchema.parse(
    (await send('GET', `/stock/variants/${variantOf(product)}`)).json(),
  );
  const found = card.batches.find((batch) => batch.lotNumber === lotNumber);
  if (!found) throw new Error(`no batch ${lotNumber}`);
  return found.batchId;
}

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

// A user who signs up for a workspace of their own, then joins this one; with a role, if given
async function member(
  email: string,
  fullName: string,
  password: string,
  permissions: PermissionKey[] | null,
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Store`,
    workspaceSlug: email.split('@')[0] ?? 'store',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'meghna-distributors' });
  if (permissions !== null) {
    // Not "Sales officer": the distribution template has a role of that name
    const made = await send('POST', '/roles', { name: 'Route sales', description: '' });
    expect(made.statusCode, made.body).toBe(201);
    const role = roleSchema.parse(made.json());
    const matrix = await send('PUT', '/permission-matrix', {
      roles: [{ id: role.id, version: role.version, permissions }],
    });
    expect(matrix.statusCode, matrix.body).toBe(200);
    const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
    const found = items.find((item) => item.email === email);
    if (!found) throw new Error(`${email} is not a member`);
    const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
      roleIds: [role.id],
      version: found.version,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
  }
  return logIn(app, { workspace: 'meghna-distributors', email, password, keepSignedIn: false });
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
  tenantId = meResponseSchema.parse((await send('GET', '/auth/me')).json()).tenant.id;
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const [first] = warehouseListSchema.parse((await send('GET', '/warehouses')).json()).items;
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;
  // A bank account inside "Bank accounts": it holds money through its group, with no tick
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const bank = await send('POST', '/accounts', {
    parentId: account('1120'),
    code: '1121',
    name: 'Dutch-Bangla Bank CD A/C 1234',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  expect(bank.statusCode, bank.body).toBe(201);
  accounts = [...accounts, accountSchema.parse(bank.json())];

  juice = await addProduct('Mango juice 250 ml', {
    units: [{ unitId: unitId('case'), factor: '24', barcode: '' }],
  });
  napa = await addProduct('Napa 500 mg', {
    tracking: 'batch',
    hasExpiry: true,
    taxRateId: rateId('Exempt'),
  });
  biscuit = await addProduct('Energy Plus biscuit');
  carriage = await addProduct('Delivery charge', { type: 'service' });

  bhairab = await addCustomer('Bhairab Bazar Traders', {
    addresses: [
      {
        id: null,
        kind: 'billing',
        label: 'Head office',
        address: 'Station Road, Bhairab',
        phone: '01712-334455',
      },
    ],
  });
  ashulia = await addCustomer('Ashulia Super Shop', { paymentTermsDays: 0 });
  madhabdi = await addCustomer('Madhabdi Bazar Store', {
    paymentTermsDays: 15,
    creditLimit: '5000',
  });
  raipura = await addCustomer('Raipura Traders', { creditLimit: '1000' });

  // Opening stock: 10 cases of juice at ৳1,200 a case (৳50 a piece), one lot of Napa at ৳0.80,
  // 50 packets of biscuits at ৳8
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
      openingLine(biscuit, '50', '8'),
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);

  viewer = await member('rina@meghnadistributors.com', 'Rina Akter', 'Counter-cash-2026', null);
  clerk = await member('tanvir@meghnadistributors.com', 'Tanvir Hasan', 'Sales-route-2026', [
    'sales.order.manage',
    'sales.delivery.manage',
    'sales.invoice.manage',
    'sales.receipt.manage',
  ]);
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('invoices', () => {
  it("bills a challan line and an order's service line, and books the sale", async () => {
    order = await ordered(
      orderForm([salesLine(juice, '48', '25'), salesLine(carriage, '1', '500')]),
    );
    challan = await delivered(
      deliveryForm(bhairab, order.id, [
        deliveryLine(juice, '24', { orderLineId: orderLine(order, juice) }),
      ]),
    );
    expect(challan.invoiceState).toBe('not_invoiced');
    const toBill = deliveryPageSchema.parse(
      (await send('GET', `/deliveries?invoice=to_invoice&customerId=${bhairab.id}`)).json(),
    );
    expect(toBill.items.map((item) => item.id)).toEqual([challan.id]);

    firstInvoice = await invoiced(
      invoiceForm([
        invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) }),
        invoiceLine(carriage, '1', '500', { orderLineId: orderLine(order, carriage) }),
      ]),
    );
    expect(firstInvoice).toMatchObject({
      number: 'INV-2026-27-0001',
      status: 'posted',
      net: '1100.0000',
      vat: '165.0000',
      total: '1265.0000',
      amountPaid: '0.0000',
      dueDate: '2026-11-05',
      billingAddress: 'Head office\nStation Road, Bhairab\n01712-334455',
      pricesIncludeVat: false,
      deliveries: [{ id: challan.id, number: 'DC-2026-27-0001', date: '2026-10-05' }],
      payments: [],
    });
    expect(firstInvoice.orders.map((item) => item.id)).toEqual([order.id]);
    // The server finds the order line behind the challan line
    expect(firstInvoice.lines.map((item) => item.orderLineId)).toEqual([
      orderLine(order, juice),
      orderLine(order, carriage),
    ]);
    expect(firstInvoice.lines[1]?.deliveryLineId).toBeNull();
    // Their numbers, for the draft's "From DC-…" and the printed invoice (15c.6)
    expect(firstInvoice.lines.map((item) => [item.deliveryNumber, item.orderNumber])).toEqual([
      ['DC-2026-27-0001', order.number],
      [null, order.number],
    ]);

    // The sale only: the challan booked the cost of the goods in 15b
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${firstInvoice.entry?.id ?? ''}`)).json(),
    );
    expect(entry.source).toBe('sales_invoice');
    expect(await entryLines(entry.id)).toEqual([
      ['1140', '1265.0000', '0.0000'],
      ['4110', '0.0000', '1100.0000'],
      ['2120', '0.0000', '165.0000'],
    ]);
    expect(entry.lines.map((item) => item.branchId)).toEqual([
      main.branchId,
      main.branchId,
      main.branchId,
    ]);
    expect(entry.lines.map((item) => item.party?.id ?? null)).toEqual([bhairab.id, null, null]);
    expect(await auditActions('invoice', firstInvoice.id)).toEqual([
      'invoice.created',
      'invoice.posted',
    ]);

    const billed = await deliveryNow(challan.id);
    expect(billed.invoiceState).toBe('invoiced');
    expect(billed.lines.map((item) => item.invoiced)).toEqual([true]);
    expect(billed.invoices.map((item) => item.number)).toEqual(['INV-2026-27-0001']);
    const nothingLeft = deliveryPageSchema.parse(
      (await send('GET', `/deliveries?invoice=to_invoice&customerId=${bhairab.id}`)).json(),
    );
    expect(nothingLeft.items).toEqual([]);
    const orderAfter = await orderNow(order.id);
    expect(orderAfter.lines.map((item) => item.invoicedQuantity)).toEqual(['24.0000', '1.0000']);
  });

  it("refuses lines that are not this invoice's to bill, all of them at once", async () => {
    const draftChallan = await delivered(
      deliveryForm(
        bhairab,
        order.id,
        [deliveryLine(juice, '24', { orderLineId: orderLine(order, juice) })],
        { post: false },
      ),
    );
    const res = await send(
      'POST',
      '/invoices',
      invoiceForm(
        [
          invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) }),
          invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(draftChallan) }),
          invoiceLine(juice, '24', '25', { orderLineId: orderLine(order, juice) }),
          invoiceLine(carriage, '1', '500', { orderLineId: orderLine(order, carriage) }),
        ],
        { post: false },
      ),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['invoice_delivery_line_billed'],
      'lines.1.deliveryLineId': ['invoice_delivery_line_invalid'],
      'lines.2.orderLineId': ['invoice_order_line_invalid'],
      'lines.3.orderLineId': ['invoice_order_line_billed'],
    });

    const posted = await send('POST', `/deliveries/${draftChallan.id}/post`, {
      version: draftChallan.version,
    });
    expect(posted.statusCode, posted.body).toBe(200);
    challan = deliverySchema.parse(posted.json());
    expect(challan.number).toBe('DC-2026-27-0002');
    // Billed whole: half of the line is not this line. Another customer's challan is not theirs.
    const half = await send(
      'POST',
      '/invoices',
      invoiceForm([invoiceLine(juice, '12', '25', { deliveryLineId: challanLine(challan) })]),
    );
    expect(problemOf(half).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['invoice_delivery_line_invalid'],
    });
    const otherCustomer = await send(
      'POST',
      '/invoices',
      invoiceForm([invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) })], {
        customerId: ashulia.id,
      }),
    );
    expect(problemOf(otherCustomer).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['invoice_delivery_line_invalid'],
    });
  });

  it("refuses what the form itself can see: a line twice, two sources, a challan line's batch", async () => {
    const twice = await send(
      'POST',
      '/invoices',
      invoiceForm([
        invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) }),
        invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) }),
      ]),
    );
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({
      'lines.1.deliveryLineId': ['invoice_line_twice'],
    });
    const mixed = await send(
      'POST',
      '/invoices',
      invoiceForm([
        invoiceLine(juice, '24', '25', {
          deliveryLineId: challanLine(challan),
          orderLineId: orderLine(order, juice),
          batchId: await batchOf(napa, 'NP24090'),
        }),
      ]),
    );
    expect(mixed.statusCode).toBe(400);
    expect(problemOf(mixed).fieldErrors).toEqual({
      'lines.0.orderLineId': ['invoice_line_source'],
      'lines.0.batchId': ['invoice_stock_not_allowed'],
    });
  });

  it('lets two drafts name the same challan line; the first to post bills it', async () => {
    const line = invoiceLine(juice, '24', '25', { deliveryLineId: challanLine(challan) });
    const first = await invoiced(invoiceForm([line], { post: false }));
    const second = await invoiced(invoiceForm([line], { post: false }));
    expect([first.number, first.entry, second.number]).toEqual([null, null, null]);
    // A draft claims nothing: the challan is still waiting for its bill
    expect((await deliveryNow(challan.id)).invoiceState).toBe('not_invoiced');

    const won = await send('POST', `/invoices/${first.id}/post`, { version: first.version });
    expect(won.statusCode, won.body).toBe(200);
    bhairabInvoices.set('INV-2026-27-0002', invoiceSchema.parse(won.json()));
    expect(invoiceSchema.parse(won.json()).number).toBe('INV-2026-27-0002');
    const lost = await send('POST', `/invoices/${second.id}/post`, { version: second.version });
    expect(lost.statusCode).toBe(409);
    expect(problemOf(lost).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['invoice_delivery_line_billed'],
    });
    const stillDraft = await invoiceNow(second.id);
    expect([stillDraft.status, stillDraft.number]).toEqual(['draft', null]);

    const removed = await send(
      'DELETE',
      `/invoices/${second.id}?version=${String(stillDraft.version)}`,
    );
    expect(removed.statusCode).toBe(204);
    expect((await send('GET', `/invoices/${second.id}`)).statusCode).toBe(404);
    expect((await orderNow(order.id)).lines.map((item) => item.invoicedQuantity)).toEqual([
      '48.0000',
      '1.0000',
    ]);
  });

  it('delivers the goods of a direct invoice on a challan of its own', async () => {
    counterInvoice = await invoiced(
      invoiceForm(
        [
          invoiceLine(juice, '12', '30'),
          invoiceLine(napa, '50', '1.2', {
            taxRateId: rateId('Exempt'),
            batchId: await batchOf(napa, 'NP24090'),
          }),
          invoiceLine(carriage, '1', '100'),
        ],
        { customerId: ashulia.id, warehouseId: main.id },
      ),
    );
    const counter = counterInvoice;
    expect(counter).toMatchObject({
      number: 'INV-2026-27-0003',
      net: '520.0000',
      vat: '69.0000',
      total: '589.0000',
      // Ashulia pays on the day
      dueDate: '2026-10-06',
      billingAddress: null,
      orders: [],
    });
    expect(counter.deliveries.map((item) => item.number)).toEqual(['DC-2026-27-0003']);
    expect(counter.lines.map((item) => item.deliveryLineId === null)).toEqual([false, false, true]);
    expect([counter.lines[1]?.lotNumber, counter.lines[1]?.expiresOn]).toEqual([
      'NP24090',
      '2027-01-31',
    ]);

    // An ordinary challan: numbered, out of stock, with its own cost of goods sold
    const own = await deliveryNow(counter.deliveries[0]?.id ?? '');
    expect(own).toMatchObject({
      order: null,
      note: 'Invoice INV-2026-27-0003',
      invoiceState: 'invoiced',
    });
    expect(own.lines.map((item) => item.quantity)).toEqual(['12.0000', '50.0000']);
    expect(await entryLines(own.entry?.id ?? '')).toEqual([
      ['5110', '640.0000', '0.0000'],
      ['1150', '0.0000', '640.0000'],
    ]);
    expect(await entryLines(counter.entry?.id ?? '')).toEqual([
      ['1140', '589.0000', '0.0000'],
      ['4110', '0.0000', '520.0000'],
      ['2120', '0.0000', '69.0000'],
    ]);
    const stock = await stockNow();
    expect([stock['Mango juice 250 ml'], stock['Napa 500 mg']]).toEqual(['180.0000', '70.0000']);
  });

  it('checks the goods of a direct invoice like a challan, under the invoice line', async () => {
    const counterForm = (lines: InvoiceLineFormValues[], extra: Partial<InvoiceFormValues> = {}) =>
      invoiceForm(lines, { customerId: ashulia.id, warehouseId: main.id, ...extra });
    const noWarehouse = await send(
      'POST',
      '/invoices',
      counterForm([invoiceLine(carriage, '1', '100'), invoiceLine(juice, '1', '30')], {
        warehouseId: '',
        post: false,
      }),
    );
    expect(problemOf(noWarehouse).fieldErrors).toEqual({
      warehouseId: ['invoice_warehouse_required'],
    });
    const serviceBatch = await send(
      'POST',
      '/invoices',
      counterForm([invoiceLine(carriage, '1', '100', { batchId: await batchOf(napa, 'NP24090') })]),
    );
    expect(problemOf(serviceBatch).fieldErrors).toEqual({
      'lines.0.batchId': ['invoice_stock_not_allowed'],
    });
    const noBatch = await send(
      'POST',
      '/invoices',
      counterForm([
        invoiceLine(carriage, '1', '100'),
        invoiceLine(napa, '10', '1.2', { taxRateId: rateId('Exempt') }),
      ]),
    );
    expect(Object.keys(problemOf(noBatch).fieldErrors ?? {})).toEqual(['lines.1.batchId']);
    expect(problemOf(noBatch).code).toBe('stock_batch_required');

    // Only 180 pieces left: refused at posting, under the invoice's own line 1
    const tooMany = await send(
      'POST',
      '/invoices',
      counterForm([invoiceLine(carriage, '1', '100'), invoiceLine(juice, '9999', '30')]),
    );
    expect(tooMany.statusCode).toBe(409);
    expect(Object.keys(problemOf(tooMany).fieldErrors ?? {})).toEqual(['lines.1.quantity']);
    // Save and post is one step: nothing was kept, no number was used
    expect(await invoiceNumbers(`customerId=${ashulia.id}`)).toEqual(['INV-2026-27-0003']);
  });

  it('bills the challan of a product archived since, but sells it no more', async () => {
    const loose = await delivered(
      deliveryForm(bhairab, '', [deliveryLine(biscuit, '20')], { date: '2026-10-05' }),
    );
    const archived = await send('POST', `/products/${biscuit.id}/archive`, {
      version: biscuit.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    // A challan without an order has no price: the invoice says what it costs
    const bill = await invoiced(
      invoiceForm([invoiceLine(biscuit, '20', '12', { deliveryLineId: challanLine(loose) })]),
    );
    expect(bill).toMatchObject({ number: 'INV-2026-27-0004', total: '276.0000', orders: [] });
    const more = await send(
      'POST',
      '/invoices',
      invoiceForm([invoiceLine(biscuit, '5', '12')], { warehouseId: main.id, post: false }),
    );
    expect(problemOf(more).fieldErrors).toEqual({ 'lines.0.variantId': ['sales_item_invalid'] });
  });

  it('reads prices one way per invoice: the way its orders read them', async () => {
    await setPricesIncludeVat(true);
    const withVat = await ordered(orderForm([salesLine(carriage, '1', '575')]));
    await setPricesIncludeVat(false);
    carriageOrder = await ordered(orderForm([salesLine(carriage, '1', '500')]));

    const mixed = await send(
      'POST',
      '/invoices',
      invoiceForm([
        invoiceLine(carriage, '1', '575', { orderLineId: orderLine(withVat, carriage) }),
        invoiceLine(carriage, '1', '500', { orderLineId: orderLine(carriageOrder, carriage) }),
      ]),
    );
    expect(problemOf(mixed).code).toBe('invoice_vat_mixed');
    // The workspace now prices without VAT; the order still says ৳575 holds the VAT
    const bill = await invoiced(
      invoiceForm([
        invoiceLine(carriage, '1', '575', { orderLineId: orderLine(withVat, carriage) }),
      ]),
    );
    expect(bill).toMatchObject({
      number: 'INV-2026-27-0005',
      pricesIncludeVat: true,
      net: '500.0000',
      vat: '75.0000',
      total: '575.0000',
    });
  });

  it('changes a draft until it is posted, and never after', async () => {
    const early = await send(
      'POST',
      '/invoices',
      invoiceForm([invoiceLine(carriage, '1', '100')], {
        customerId: ashulia.id,
        dueDate: '2026-10-01',
      }),
    );
    expect(early.statusCode).toBe(400);
    expect(problemOf(early).fieldErrors).toEqual({ dueDate: ['invoice_due_date'] });

    const draft = await invoiced(
      invoiceForm([invoiceLine(carriage, '1', '100')], { customerId: ashulia.id, post: false }),
    );
    expect(draft.dueDate).toBe('2026-10-06');
    const changed = await send('PUT', `/invoices/${draft.id}`, {
      ...invoiceForm([invoiceLine(carriage, '1', '100')], {
        customerId: ashulia.id,
        dueDate: '2026-10-20',
        customerReference: 'Indent 77',
      }),
      version: draft.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const posted = invoiceSchema.parse(changed.json());
    expect(posted).toMatchObject({
      number: 'INV-2026-27-0006',
      dueDate: '2026-10-20',
      customerReference: 'Indent 77',
      total: '115.0000',
    });

    const again = await send('PUT', `/invoices/${posted.id}`, {
      ...invoiceForm([invoiceLine(carriage, '1', '1')], { customerId: ashulia.id }),
      version: posted.version,
    });
    expect(problemOf(again).code).toBe('sales_not_draft');
    const repost = await send('POST', `/invoices/${posted.id}/post`, { version: posted.version });
    expect(problemOf(repost).code).toBe('sales_not_draft');
    const remove = await send('DELETE', `/invoices/${posted.id}?version=${String(posted.version)}`);
    expect(problemOf(remove).code).toBe('sales_not_draft');

    // A free sample: a real invoice, with nothing to book and nothing to pay
    const free = await invoiced(
      invoiceForm([invoiceLine(carriage, '1', '0')], { customerId: ashulia.id }),
    );
    expect(free).toMatchObject({ number: 'INV-2026-27-0007', total: '0.0000', entry: null });

    leftDraft = await invoiced(
      invoiceForm([invoiceLine(carriage, '1', '100')], { customerId: ashulia.id, post: false }),
    );
  });

  it("stays out of the journal's Reverse", async () => {
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${firstInvoice.entry?.id ?? ''}`)).json(),
    );
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-07',
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('journal_is_sales');
  });

  it('lists invoices by status, customer and payment, page by page', async () => {
    expect(await invoiceNumbers('status=draft')).toEqual([null]);
    // Newest date first; one date, so the newest made first
    expect(await invoiceNumbers(`customerId=${ashulia.id}`)).toEqual([
      null,
      'INV-2026-27-0007',
      'INV-2026-27-0006',
      'INV-2026-27-0003',
    ]);
    // Open: the oldest due date first, the order a receipt pays them in
    const open = [
      'INV-2026-27-0003',
      'INV-2026-27-0006',
      'INV-2026-27-0001',
      'INV-2026-27-0002',
      'INV-2026-27-0004',
      'INV-2026-27-0005',
    ];
    expect(await invoiceNumbers('payment=open')).toEqual(open);
    expect(await invoiceNumbers('payment=overdue')).toEqual(['INV-2026-27-0003']);
    expect(await invoiceNumbers('payment=paid')).toEqual(['INV-2026-27-0007']);

    const posted = ['0007', '0006', '0005', '0004', '0003', '0002', '0001'].map(
      (number) => `INV-2026-27-${number}`,
    );
    // Four at a time, in both orders: the cursor holds the due date or the date to go on from
    for (const [query, all] of [
      ['payment=open', open],
      ['status=posted', posted],
    ] as const) {
      const first = invoicePageSchema.parse(
        (await send('GET', `/invoices?${query}&limit=4`)).json(),
      );
      expect(first.nextCursor).not.toBeNull();
      const second = invoicePageSchema.parse(
        (
          await send(
            'GET',
            `/invoices?${query}&limit=4&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
          )
        ).json(),
      );
      expect(second.nextCursor).toBeNull();
      expect([...first.items, ...second.items].map((item) => item.number)).toEqual(all);
    }
  });
});

describe('orders that are billed', () => {
  it('keeps an order with a billed service from being reopened or cancelled, and closes it', async () => {
    const draft = await invoiced(
      invoiceForm(
        [invoiceLine(carriage, '1', '500', { orderLineId: orderLine(carriageOrder, carriage) })],
        { post: false },
      ),
    );
    // Even a draft: the reopened order's next save would replace the line it points at
    const reopen = await send('POST', `/sales-orders/${carriageOrder.id}/reopen`, {
      version: carriageOrder.version,
    });
    expect(problemOf(reopen).code).toBe('order_has_invoices');

    const posted = await send('POST', `/invoices/${draft.id}/post`, { version: draft.version });
    expect(posted.statusCode, posted.body).toBe(200);
    bhairabInvoices.set('INV-2026-27-0008', invoiceSchema.parse(posted.json()));
    const now = await orderNow(carriageOrder.id);
    expect(now.lines.map((item) => item.invoicedQuantity)).toEqual(['1.0000']);
    const cancel = await send('POST', `/sales-orders/${now.id}/cancel`, { version: now.version });
    expect(problemOf(cancel).code).toBe('order_has_invoices');
    // Nothing to deliver, everything billed: closing it is the way out
    const closed = await send('POST', `/sales-orders/${now.id}/close`, { version: now.version });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(salesOrderSchema.parse(closed.json()).status).toBe('closed');
  });
});

describe('the credit limit', () => {
  it('shows what a customer owes, has on order, and may still buy', async () => {
    expect(await credit(madhabdi)).toEqual({
      limit: '5000.0000',
      balance: '0.0000',
      onOrder: '0.0000',
      exposure: '0.0000',
      available: '5000.0000',
    });
    // No limit: never checked. Everything Bhairab ordered is billed: 1,265 + 690 + 276 + 575 + 575
    expect(await credit(bhairab)).toEqual({
      limit: null,
      balance: '3381.0000',
      onOrder: '0.0000',
      exposure: '3381.0000',
      available: null,
    });
  });

  it('confirms an order that fits, and stops one that does not', async () => {
    madhabdiOrder = await ordered(
      orderForm([salesLine(juice, '96', '40')], { customerId: madhabdi.id }),
    );
    expect(madhabdiOrder.status).toBe('confirmed');
    expect(await credit(madhabdi)).toMatchObject({ onOrder: '4416.0000', available: '584.0000' });

    const over = await send(
      'POST',
      '/sales-orders',
      orderForm([salesLine(juice, '24', '25')], { customerId: madhabdi.id }),
    );
    expect(over.statusCode).toBe(409);
    expect(problemOf(over)).toMatchObject({
      code: 'credit_limit_exceeded',
      params: { limit: '5000.0000', exposure: '5106.0000' },
    });
    const orders = salesOrderPageSchema.parse(
      (await send('GET', `/sales-orders?customerId=${madhabdi.id}`)).json(),
    );
    expect(orders.items.map((item) => item.id)).toEqual([madhabdiOrder.id]);

    // Saved as a draft, it waits; Confirm asks again
    const draft = await ordered(
      orderForm([salesLine(juice, '24', '25')], { customerId: madhabdi.id, confirm: false }),
    );
    const refused = await send('POST', `/sales-orders/${draft.id}/confirm`, {
      version: draft.version,
    });
    expect(problemOf(refused).code).toBe('credit_limit_exceeded');
    const forbidden = await send(
      'POST',
      `/sales-orders/${draft.id}/confirm`,
      { version: draft.version, overrideCreditLimit: true },
      clerk,
    );
    expect(forbidden.statusCode).toBe(403);
    expect(problemOf(forbidden)).toMatchObject({
      code: 'credit_override_forbidden',
      params: { permissions: 'sales.credit.override' },
    });
    expect(await orderNow(draft.id)).toMatchObject({ status: 'draft', number: null });

    const overridden = await send('POST', `/sales-orders/${draft.id}/confirm`, {
      version: draft.version,
      overrideCreditLimit: true,
    });
    expect(overridden.statusCode, overridden.body).toBe(200);
    expect(salesOrderSchema.parse(overridden.json()).status).toBe('confirmed');
    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=sales_order&entityId=${draft.id}`)).json(),
    );
    const overrides = log.items.filter((item) => item.action === 'credit_limit.overridden');
    expect(overrides.map((item) => [item.action, item.actor?.fullName, item.changes])).toEqual([
      [
        'credit_limit.overridden',
        'Shafiq Ahmed',
        {
          limit: { from: null, to: '5000.0000' },
          exposure: { from: null, to: '5106.0000' },
        },
      ],
    ]);
  });

  it('bills a confirmed order over the limit, but stops a bill that adds to it', async () => {
    const confirmed = await orderNow(madhabdiOrder.id);
    const out = await delivered(
      deliveryForm(madhabdi, confirmed.id, [
        deliveryLine(juice, '96', { orderLineId: orderLine(confirmed, juice) }),
      ]),
    );
    // 4,416 moves from "on order" to "owed": the exposure stays 5,106, over the limit but no higher
    const bill = await invoiced(
      invoiceForm([invoiceLine(juice, '96', '40', { deliveryLineId: challanLine(out) })], {
        customerId: madhabdi.id,
      }),
    );
    expect(bill.number).toBe('INV-2026-27-0009');
    expect(await auditActions('invoice', bill.id)).toEqual(['invoice.created', 'invoice.posted']);
    expect(await credit(madhabdi)).toMatchObject({
      balance: '4416.0000',
      onOrder: '690.0000',
      exposure: '5106.0000',
      available: '-106.0000',
    });

    const extra = invoiceForm([invoiceLine(carriage, '1', '500')], { customerId: madhabdi.id });
    const over = await send('POST', '/invoices', extra);
    expect(problemOf(over)).toMatchObject({
      code: 'credit_limit_exceeded',
      params: { limit: '5000.0000', exposure: '5681.0000' },
    });
    const forbidden = await send(
      'POST',
      '/invoices',
      { ...extra, overrideCreditLimit: true },
      clerk,
    );
    expect(problemOf(forbidden).code).toBe('credit_override_forbidden');
    const overridden = await invoiced({ ...extra, overrideCreditLimit: true });
    // The refused posts used no number
    expect(overridden.number).toBe('INV-2026-27-0010');
    expect(await auditActions('invoice', overridden.id)).toEqual([
      'credit_limit.overridden',
      'invoice.created',
      'invoice.posted',
    ]);
  });

  it('lets only one of two orders that fit alone through at the same time', async () => {
    const one = await ordered(
      orderForm([salesLine(carriage, '1', '700')], { customerId: raipura.id, confirm: false }),
    );
    const two = await ordered(
      orderForm([salesLine(carriage, '1', '700')], { customerId: raipura.id, confirm: false }),
    );
    const results = await Promise.all(
      [one, two].map((draft) =>
        send('POST', `/sales-orders/${draft.id}/confirm`, { version: draft.version }),
      ),
    );
    expect(results.map((res) => res.statusCode).toSorted()).toEqual([200, 409]);
    const refused = results.find((res) => res.statusCode === 409);
    if (!refused) throw new Error('both confirmed');
    expect(problemOf(refused).params).toEqual({ limit: '1000.0000', exposure: '1610.0000' });
    expect((await credit(raipura)).onOrder).toBe('805.0000');
  });

  it("waits for the customer's credit lock before it counts", async () => {
    const draft = await ordered(
      orderForm([salesLine(carriage, '1', '100')], { customerId: raipura.id, confirm: false }),
    );
    // Hold the lock CreditService.lock() takes, as another confirm or posting of Raipura's would,
    // and confirm in the meantime. The confirm must wait: two orders confirmed at the same moment
    // each counting without the other is exactly what the lock is there to stop.
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let settled = false;
    let pending: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`credit:${tenantId}:${raipura.id}`}, 0))`;
      pending = send('POST', `/sales-orders/${draft.id}/confirm`, { version: draft.version });
      void pending.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
    });
    await superuser.end();
    // Released: it counts 805 + 115 = 920, under the limit
    expect((await pending)?.statusCode).toBe(200);
    expect((await credit(raipura)).onOrder).toBe('920.0000');
  });
});

describe('money receipts', () => {
  it('records money and applies it to invoices', async () => {
    cashReceipt = await received(
      receiptForm('2000', [
        { invoiceId: bhairabInvoice('0001').id, amount: '1265' },
        { invoiceId: bhairabInvoice('0002').id, amount: '690' },
      ]),
    );
    expect(cashReceipt).toMatchObject({
      number: 'MR-2026-27-0001',
      status: 'posted',
      amount: '2000.0000',
      applied: '1955.0000',
      voidEntry: null,
    });
    expect(cashReceipt.allocations.map((item) => [item.invoiceNumber, item.amount])).toEqual([
      ['INV-2026-27-0001', '1265.0000'],
      ['INV-2026-27-0002', '690.0000'],
    ]);
    // The receivable comes down by all of it, the ৳45 not applied too
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${cashReceipt.entry.id}`)).json(),
    );
    expect(entry.source).toBe('sales_receipt');
    expect(await entryLines(entry.id)).toEqual([
      ['1110', '2000.0000', '0.0000'],
      ['1140', '0.0000', '2000.0000'],
    ]);
    expect(entry.lines.map((item) => item.party?.id ?? null)).toEqual([null, bhairab.id]);

    const paid = await invoiceNow(bhairabInvoice('0001').id);
    expect(paid.amountPaid).toBe('1265.0000');
    expect(paid.payments).toEqual([
      {
        receiptId: cashReceipt.id,
        receiptNumber: 'MR-2026-27-0001',
        date: '2026-10-07',
        amount: '1265.0000',
      },
    ]);
    expect(await invoiceNumbers(`payment=open&customerId=${bhairab.id}`)).toEqual([
      'INV-2026-27-0004',
      'INV-2026-27-0005',
      'INV-2026-27-0008',
    ]);
    expect((await credit(bhairab)).balance).toBe('1381.0000');
  });

  it('refuses money that cannot be a receipt', async () => {
    const zero = await send('POST', '/receipts', receiptForm('0', []));
    expect(problemOf(zero).fieldErrors).toEqual({ amount: ['receipt_amount_required'] });
    const tooMuch = await send(
      'POST',
      '/receipts',
      receiptForm('100', [{ invoiceId: bhairabInvoice('0004').id, amount: '150' }]),
    );
    expect(problemOf(tooMuch).fieldErrors).toEqual({ allocations: ['receipt_over_allocated'] });
    const twice = await send(
      'POST',
      '/receipts',
      receiptForm('100', [
        { invoiceId: bhairabInvoice('0004').id, amount: '50' },
        { invoiceId: bhairabInvoice('0004').id, amount: '50' },
      ]),
    );
    expect(problemOf(twice).fieldErrors).toEqual({
      'allocations.1.invoiceId': ['receipt_invoice_twice'],
    });

    // The sales account and the bank group are not where money is kept
    for (const code of ['4110', '1120']) {
      const res = await send(
        'POST',
        '/receipts',
        receiptForm('100', [], { accountId: account(code) }),
      );
      expect(problemOf(res).fieldErrors).toEqual({ accountId: ['receipt_account_invalid'] });
    }
    // Another customer's invoice, a draft, more than the invoice owes: each under its row
    const rows = await send(
      'POST',
      '/receipts',
      receiptForm('1000', [
        { invoiceId: counterInvoice.id, amount: '10' },
        { invoiceId: leftDraft.id, amount: '10' },
        { invoiceId: bhairabInvoice('0004').id, amount: '300' },
      ]),
    );
    expect(rows.statusCode).toBe(409);
    expect(problemOf(rows).fieldErrors).toEqual({
      'allocations.0.invoiceId': ['receipt_invoice_invalid'],
      'allocations.1.invoiceId': ['receipt_invoice_invalid'],
      'allocations.2.amount': ['receipt_over_invoice'],
    });
  });

  it('keeps money as an advance, and applies it later', async () => {
    bankReceipt = await received(
      receiptForm('500', [], {
        accountId: account('1121'),
        method: 'bank_transfer',
        reference: 'DBBL TT 88213',
      }),
    );
    // The refusals above used no number
    expect(bankReceipt).toMatchObject({ number: 'MR-2026-27-0002', applied: '0.0000' });
    expect(await entryLines(bankReceipt.entry.id)).toEqual([
      ['1121', '500.0000', '0.0000'],
      ['1140', '0.0000', '500.0000'],
    ]);

    const applied = await send('PUT', `/receipts/${bankReceipt.id}/allocations`, {
      version: bankReceipt.version,
      allocations: [{ invoiceId: bhairabInvoice('0004').id, amount: '276' }],
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const after = receiptSchema.parse(applied.json());
    expect([after.applied, after.version]).toEqual(['276.0000', bankReceipt.version + 1]);
    expect((await invoiceNow(bhairabInvoice('0004').id)).amountPaid).toBe('276.0000');

    const stale = await send('PUT', `/receipts/${bankReceipt.id}/allocations`, {
      version: bankReceipt.version,
      allocations: [],
    });
    expect(problemOf(stale).code).toBe('version_conflict');
    // The amount is the receipt's, so only the server can tell
    const over = await send('PUT', `/receipts/${bankReceipt.id}/allocations`, {
      version: after.version,
      allocations: [{ invoiceId: bhairabInvoice('0005').id, amount: '575' }],
    });
    expect(problemOf(over).fieldErrors).toEqual({ allocations: ['receipt_over_allocated'] });
    bankReceipt = after;

    // The ৳45 left on the cash receipt goes to INV-0005. Its ৳1,265 on INV-0001 stays: what it
    // paid there counts as owed again while the list is replaced.
    const moved = await send('PUT', `/receipts/${cashReceipt.id}/allocations`, {
      version: cashReceipt.version,
      allocations: [
        { invoiceId: bhairabInvoice('0001').id, amount: '1265' },
        { invoiceId: bhairabInvoice('0002').id, amount: '690' },
        { invoiceId: bhairabInvoice('0005').id, amount: '45' },
      ],
    });
    expect(moved.statusCode, moved.body).toBe(200);
    cashReceipt = receiptSchema.parse(moved.json());
    expect(cashReceipt.applied).toBe('2000.0000');
    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=receipt&entityId=${cashReceipt.id}`)).json(),
    );
    expect(log.items[0]).toMatchObject({
      action: 'receipt.allocated',
      changes: { 'INV-2026-27-0005': { from: null, to: '45.0000' } },
    });

    // Taken off INV-0005 and put back: the log names the invoice the money left, too
    const allocations = cashReceipt.allocations.map(({ invoiceId, amount }) => ({
      invoiceId,
      amount,
    }));
    const off = await send('PUT', `/receipts/${cashReceipt.id}/allocations`, {
      version: cashReceipt.version,
      allocations: allocations.filter((row) => row.invoiceId !== bhairabInvoice('0005').id),
    });
    expect(off.statusCode, off.body).toBe(200);
    const offLog = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=receipt&entityId=${cashReceipt.id}`)).json(),
    );
    expect(offLog.items[0]?.changes).toEqual({
      'INV-2026-27-0005': { from: '45.0000', to: null },
    });
    const back = await send('PUT', `/receipts/${cashReceipt.id}/allocations`, {
      version: receiptSchema.parse(off.json()).version,
      allocations,
    });
    expect(back.statusCode, back.body).toBe(200);
    cashReceipt = receiptSchema.parse(back.json());
  });

  it('lets a receipt wait for another one paying the same invoice, then answers under its row', async () => {
    const invoice = bhairabInvoice('0005');
    // Replay the bank receipt's next allocation the way apply() writes it (lock the invoice,
    // replace the rows, the trigger adds them up) and leave it uncommitted for a moment: its ৳224
    // goes to INV-0005, which then owes 306. A cash receipt for the whole 530 starts meanwhile.
    // With the invoice locked FOR UPDATE in apply(), it waits, reads 306 after the commit, and
    // answers under its row. Without the lock it would read 530, pass, and fail on the database's
    // check instead (receipt_over_invoice with no field: the form could not say which row).
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let pending: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      await tx`SELECT id FROM invoices WHERE id = ${invoice.id} FOR UPDATE`;
      await tx`DELETE FROM receipt_allocations WHERE receipt_id = ${bankReceipt.id}`;
      await tx`
        INSERT INTO receipt_allocations (id, tenant_id, receipt_id, customer_id, invoice_id, amount)
        VALUES
          (gen_random_uuid(), ${tenantId}, ${bankReceipt.id}, ${bhairab.id},
           ${bhairabInvoice('0004').id}, 276),
          (gen_random_uuid(), ${tenantId}, ${bankReceipt.id}, ${bhairab.id}, ${invoice.id}, 224)`;
      await tx`UPDATE receipts SET version = version + 1 WHERE id = ${bankReceipt.id}`;
      pending = send(
        'POST',
        '/receipts',
        receiptForm('530', [{ invoiceId: invoice.id, amount: '530' }]),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await superuser.end();

    const res = await pending;
    if (!res) throw new Error('the receipt was never sent');
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'allocations.0.amount': ['receipt_over_invoice'],
    });
    const rest = await received(receiptForm('306', [{ invoiceId: invoice.id, amount: '306' }]));
    // The refused receipt used no number
    expect(rest.number).toBe('MR-2026-27-0003');
    expect((await invoiceNow(invoice.id)).amountPaid).toBe('575.0000');
  });

  it('voids a bounced cheque: its entry reversed, its money off the invoice', async () => {
    const cheque = await received(
      receiptForm('575', [{ invoiceId: bhairabInvoice('0008').id, amount: '575' }], {
        accountId: account('1121'),
        method: 'cheque',
        reference: 'Sonali Bank cheque 004512',
      }),
    );
    expect(cheque.number).toBe('MR-2026-27-0004');
    const early = await send('POST', `/receipts/${cheque.id}/void`, {
      version: cheque.version,
      date: '2026-10-06',
      reason: 'Cheque bounced',
    });
    expect(problemOf(early).fieldErrors).toEqual({ date: ['receipt_void_date'] });
    const noReason = await send('POST', `/receipts/${cheque.id}/void`, {
      version: cheque.version,
      date: '2026-10-08',
      reason: ' ',
    });
    expect(problemOf(noReason).fieldErrors).toEqual({ reason: ['receipt_void_reason_required'] });

    const res = await send('POST', `/receipts/${cheque.id}/void`, {
      version: cheque.version,
      date: '2026-10-08',
      reason: 'Cheque bounced',
    });
    expect(res.statusCode, res.body).toBe(200);
    const gone = receiptSchema.parse(res.json());
    expect(gone).toMatchObject({
      status: 'voided',
      voidDate: '2026-10-08',
      voidReason: 'Cheque bounced',
      applied: '0.0000',
      allocations: [],
    });
    const reversal = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${gone.voidEntry?.id ?? ''}`)).json(),
    );
    expect(reversal).toMatchObject({
      source: 'reversal',
      date: '2026-10-08',
      reversalOf: cheque.entry,
    });
    expect(await entryLines(reversal.id)).toEqual([
      ['1121', '0.0000', '575.0000'],
      ['1140', '575.0000', '0.0000'],
    ]);
    expect((await invoiceNow(bhairabInvoice('0008').id)).amountPaid).toBe('0.0000');

    const twice = await send('POST', `/receipts/${cheque.id}/void`, {
      version: gone.version,
      date: '2026-10-08',
      reason: 'Twice',
    });
    expect(problemOf(twice).code).toBe('receipt_voided');
    const reapply = await send('PUT', `/receipts/${cheque.id}/allocations`, {
      version: gone.version,
      allocations: [],
    });
    expect(problemOf(reapply).code).toBe('receipt_voided');
    const page = receiptPageSchema.parse(
      (await send('GET', `/receipts?status=voided&customerId=${bhairab.id}`)).json(),
    );
    expect(page.items.map((item) => item.number)).toEqual(['MR-2026-27-0004']);
  });

  it("stays out of the journal's Reverse, and leaves the books right", async () => {
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${cashReceipt.entry.id}`)).json(),
    );
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-08',
    });
    expect(problemOf(res).code).toBe('journal_is_sales');
    // 3,381 billed − 2,000 − 500 − 306 received; the bounced cheque came and went. What is left
    // is INV-0008, unpaid
    expect((await credit(bhairab)).balance).toBe('575.0000');
    expect(await invoiceNumbers(`payment=open&customerId=${bhairab.id}`)).toEqual([
      'INV-2026-27-0008',
    ]);
  });
});

describe('who may do what', () => {
  it('lets anyone read invoices and receipts, and only the right people write them', async () => {
    for (const url of [
      '/invoices',
      `/invoices/${firstInvoice.id}`,
      '/receipts',
      `/receipts/${bankReceipt.id}`,
    ]) {
      expect((await send('GET', url, undefined, viewer)).statusCode).toBe(200);
    }
    const balance = await send('GET', `/customers/${bhairab.id}/credit`, undefined, viewer);
    expect(balance.statusCode).toBe(403);
    expect(problemOf(balance).params).toEqual({ permissions: 'sales.customer.balance' });

    const writes = [
      send('POST', '/invoices', invoiceForm([invoiceLine(carriage, '1', '1')]), viewer),
      send('POST', `/invoices/${leftDraft.id}/post`, { version: leftDraft.version }, viewer),
      send(
        'DELETE',
        `/invoices/${leftDraft.id}?version=${String(leftDraft.version)}`,
        undefined,
        viewer,
      ),
      send('POST', '/receipts', receiptForm('10', []), viewer),
      send(
        'PUT',
        `/receipts/${bankReceipt.id}/allocations`,
        { version: 1, allocations: [] },
        viewer,
      ),
      send(
        'POST',
        `/receipts/${bankReceipt.id}/void`,
        { version: 1, date: '2026-10-08', reason: 'x' },
        viewer,
      ),
    ];
    for (const res of await Promise.all(writes)) {
      expect(res.statusCode).toBe(403);
      expect(problemOf(res).code).toBe('permission_missing');
    }
  });
});

describe('what invoices and receipts hold on to', () => {
  it('keeps a customer, a product and an account that they name', async () => {
    const pharmacy = await addCustomer('Palash Medicine Corner');
    const loading = await addProduct('Loading charge', { type: 'service' });
    await invoiced(
      invoiceForm([invoiceLine(loading, '1', '200')], { customerId: pharmacy.id, post: false }),
    );
    const customer = await send(
      'DELETE',
      `/customers/${pharmacy.id}?version=${String(pharmacy.version)}`,
    );
    expect(problemOf(customer).code).toBe('customer_in_use');
    const product = await send(
      'DELETE',
      `/products/${loading.id}?version=${String(loading.version)}`,
    );
    expect(problemOf(product).code).toBe('product_in_use');
    const bank = accountSchema.parse((await send('GET', `/accounts/${account('1121')}`)).json());
    const removed = await send('DELETE', `/accounts/${bank.id}?version=${String(bank.version)}`);
    expect(problemOf(removed).code).toBe('account_in_use');
  });
});

describe('the period lock', () => {
  it('refuses an invoice or a receipt on a day the books are closed', async () => {
    expect(
      (await send('PUT', '/period-lock', { lockDate: '2026-10-06', version: 0 })).statusCode,
    ).toBe(200);
    const invoice = await send('POST', `/invoices/${leftDraft.id}/post`, {
      version: leftDraft.version,
    });
    expect(problemOf(invoice).code).toBe('journal_period_locked');
    expect((await invoiceNow(leftDraft.id)).status).toBe('draft');
    const receipt = await send('POST', '/receipts', receiptForm('100', [], { date: '2026-10-06' }));
    expect(problemOf(receipt).code).toBe('journal_period_locked');
  });
});
