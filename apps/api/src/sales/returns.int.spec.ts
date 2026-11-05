import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  amountDueOf,
  auditPageSchema,
  branchSchema,
  canCreditWhole,
  type CreditNote,
  type CreditNoteFormValues,
  type CreditNoteLineFormValues,
  creditNotePageSchema,
  creditNoteSchema,
  creditStateOf,
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
  receiptSchema,
  type Refund,
  type RefundFormValues,
  refundPageSchema,
  refundSchema,
  roleSchema,
  salesAccountsSchema,
  type SalesLineFormValues,
  type SalesOrder,
  salesOrderSchema,
  type SalesReturn,
  type SalesReturnFormValues,
  type SalesReturnLineFormValues,
  salesReturnPageSchema,
  salesReturnSchema,
  type Settings,
  settingsSchema,
  setupSchema,
  stockCardSchema,
  stockMovementPageSchema,
  stockPageSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
  wholeInvoiceCreditLines,
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

// Step 15d: sales returns, credit notes and refunds, for a medicine distributor in Chattogram.
// Napa by the tablet and the strip, in batches; a syrup and an injection by the piece; glucometers
// by serial number. Tamanna Pharmacy buys on 30 days, Agrabad Medicine Corner pays on the day.
// What comes back goes into the "Damage and expiry" store of another branch. Each test builds on
// the ones before it, like the 15b and 15c tests: read the first failure first.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
let tenantId: string;
// A member with no role: reads every return, credit note and refund, writes none
let viewer: SignedIn;
// The store keeper who takes goods back: writes returns, nothing that moves money
let storeKeeper: SignedIn;
let units: Unit[];
let accounts: Account[];
let rates: TaxRate[];
let main: Warehouse;
let damage: Warehouse;
let napa: Product;
let syrup: Product;
let injection: Product;
let meter: Product;
// Never stocked: it has no average cost
let omeprazole: Product;
let napaBatch: string;
let tamanna: Customer;
let agrabad: Customer;
// Tamanna's order and its challan: 60 bottles of syrup and 20 strips of Napa
let order: SalesOrder;
let challan: Delivery;
// A draft challan of Tamanna's: its lines cannot come back
let draftChallan: Delivery;
let firstReturn: SalesReturn;
// The invoice of what was left on the challan
let firstInvoice: Invoice;
// 5 bottles back after the invoice: billed, so a credit note gives the money back
let billedReturn: SalesReturn;
let firstCreditNote: CreditNote;
// A price cut posted after the invoice was paid: all of it is Tamanna's advance
let advanceNote: CreditNote;
// Tamanna's second invoice, which the advance is applied to
let laterInvoice: Invoice;
let tamannaReceipt: Receipt;
let receiptRefund: Refund;
// The credit note that won the race for INV-0003: ৳50 of it is Tamanna's advance
let racedNote: CreditNote;

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

function lineOf<T extends { id: string; variantId: string }>(
  lines: readonly T[],
  product: Product,
): T {
  const found = lines.find((item) => item.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} line`);
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
    // The pharma template makes the generic name required
    customFields: { generic_name: name },
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

async function setPricesIncludeVat(on: boolean): Promise<void> {
  const settings: Settings = settingsSchema.parse((await send('GET', '/settings')).json());
  const res = await send('PUT', '/settings', {
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
    pricesIncludeVat: on,
    // Step 17b: the whole form, the over-receipt percent too
    overReceiptPercent: settings.overReceiptPercent,
  });
  expect(res.statusCode, res.body).toBe(200);
}

// A line as the form sends it: by the piece, at 15% VAT, no discount
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

async function ordered(lines: SalesLineFormValues[], customer: Customer): Promise<SalesOrder> {
  const res = await send('POST', '/sales-orders', {
    customerId: customer.id,
    date: '2026-10-02',
    deliveryDate: '',
    customerReference: '',
    warehouseId: main.id,
    shippingAddressId: '',
    note: '',
    lines,
    confirm: true,
  });
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

async function delivered(
  customer: Customer,
  orderId: string,
  lines: object[],
  post = true,
): Promise<Delivery> {
  const res = await send('POST', '/deliveries', {
    customerId: customer.id,
    orderId,
    date: '2026-10-05',
    warehouseId: main.id,
    shippingAddressId: '',
    vehicle: '',
    note: '',
    lines,
    post,
  });
  expect(res.statusCode, res.body).toBe(201);
  return deliverySchema.parse(res.json());
}

async function deliveryNow(id: string): Promise<Delivery> {
  return deliverySchema.parse((await send('GET', `/deliveries/${id}`)).json());
}

async function deliveryNumbers(query: string): Promise<(string | null)[]> {
  const page = deliveryPageSchema.parse((await send('GET', `/deliveries?${query}`)).json());
  return page.items.map((item) => item.number);
}

// A return line: from a challan line when extra names one, else a line on its own
function returnLine(
  product: Product,
  quantity: string,
  extra: Partial<SalesReturnLineFormValues> = {},
): SalesReturnLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    serialNumbers: [],
    deliveryLineId: '',
    ...extra,
  };
}

function returnForm(
  lines: SalesReturnLineFormValues[],
  extra: Partial<SalesReturnFormValues> = {},
): Omit<SalesReturnFormValues, 'version'> {
  return {
    customerId: tamanna.id,
    date: '2026-10-06',
    warehouseId: damage.id,
    reason: 'damaged',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

async function returned(body: object, as = owner): Promise<SalesReturn> {
  const res = await send('POST', '/sales-returns', body, as);
  expect(res.statusCode, res.body).toBe(201);
  return salesReturnSchema.parse(res.json());
}

async function returnNow(id: string): Promise<SalesReturn> {
  return salesReturnSchema.parse((await send('GET', `/sales-returns/${id}`)).json());
}

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
    customerId: tamanna.id,
    date: '2026-10-07',
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

async function invoiced(body: object): Promise<Invoice> {
  const res = await send('POST', '/invoices', body);
  expect(res.statusCode, res.body).toBe(201);
  return invoiceSchema.parse(res.json());
}

async function invoiceNow(id: string): Promise<Invoice> {
  return invoiceSchema.parse((await send('GET', `/invoices/${id}`)).json());
}

async function invoiceNumbers(query: string): Promise<(string | null)[]> {
  const page = invoicePageSchema.parse((await send('GET', `/invoices?${query}`)).json());
  return page.items.map((item) => item.number);
}

// A credit note line: a price cut unless extra names a return line
function creditLine(
  invoiceLineId: string,
  quantity: string,
  unitPrice: string,
  extra: Partial<CreditNoteLineFormValues> = {},
): CreditNoteLineFormValues {
  return {
    invoiceLineId,
    returnLineId: '',
    unitId: unitId('pcs'),
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    ...extra,
  };
}

function creditForm(
  invoice: Invoice,
  lines: CreditNoteLineFormValues[],
  extra: Partial<CreditNoteFormValues> = {},
): Omit<CreditNoteFormValues, 'version'> {
  return {
    invoiceId: invoice.id,
    date: '2026-10-08',
    reason: 'goods_returned',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

async function credited(body: object): Promise<CreditNote> {
  const res = await send('POST', '/credit-notes', body);
  expect(res.statusCode, res.body).toBe(201);
  return creditNoteSchema.parse(res.json());
}

async function creditNoteNow(id: string): Promise<CreditNote> {
  return creditNoteSchema.parse((await send('GET', `/credit-notes/${id}`)).json());
}

async function receiptNow(id: string): Promise<Receipt> {
  return receiptSchema.parse((await send('GET', `/receipts/${id}`)).json());
}

function refundForm(amount: string, extra: Partial<RefundFormValues> = {}): RefundFormValues {
  return {
    customerId: tamanna.id,
    date: '2026-10-10',
    amount,
    accountId: account('1110'),
    method: 'cash',
    reference: '',
    branchId: main.branchId,
    note: '',
    receiptId: '',
    creditNoteId: '',
    ...extra,
  };
}

async function refunded(body: object): Promise<Refund> {
  const res = await send('POST', '/refunds', body);
  expect(res.statusCode, res.body).toBe(201);
  return refundSchema.parse(res.json());
}

// A journal entry as [account code, debit, credit] rows — what an accountant reads
async function entryLines(id: string) {
  const entry = journalEntrySchema.parse((await send('GET', `/journal-entries/${id}`)).json());
  return entry.lines.map((item) => [codeOf(item.accountId), item.debit, item.credit]);
}

async function auditActions(entityType: string, entityId: string): Promise<string[]> {
  const page = auditPageSchema.parse(
    (await send('GET', `/audit-logs?entityType=${entityType}&entityId=${entityId}`)).json(),
  );
  return page.items.map((item) => item.action).toSorted();
}

async function stockIn(warehouse: Warehouse) {
  const page = stockPageSchema.parse(
    (await send('GET', `/stock?warehouseId=${warehouse.id}`)).json(),
  );
  return Object.fromEntries(page.items.map((item) => [item.productName, item.onHand]));
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
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'karnaphuli-medicine' });
  if (permissions !== null) {
    const made = await send('POST', '/roles', { name: 'Return desk', description: '' });
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
  return logIn(app, { workspace: 'karnaphuli-medicine', email, password, keepSignedIn: false });
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
    companyName: 'Karnaphuli Medicine Distributors',
    workspaceSlug: 'karnaphuli-medicine',
    fullName: 'Nasrin Chowdhury',
    email: 'nasrin@karnaphulimedicine.com',
    password: 'Agrabad-depot-2026',
  });
  tenantId = meResponseSchema.parse((await send('GET', '/auth/me')).json()).tenant.id;
  expect((await send('POST', '/setup', { industry: 'pharma' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const [first] = warehouseListSchema.parse((await send('GET', '/warehouses')).json()).items;
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;
  // The returns store sits under a branch of its own, so the entries show which branch is which
  const branch = await send('POST', '/branches', {
    code: 'KLG',
    name: 'Kalurghat central store',
    phone: '',
    address: '',
  });
  expect(branch.statusCode, branch.body).toBe(201);
  const store = await send('POST', '/warehouses', {
    branchId: branchSchema.parse(branch.json()).id,
    code: 'DMG',
    name: 'Damage and expiry',
    address: '',
  });
  expect(store.statusCode, store.body).toBe(201);
  damage = warehouseSchema.parse(store.json());
  // A bKash account inside "Mobile wallets": it holds money through its group
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const wallet = await send('POST', '/accounts', {
    parentId: account('1130'),
    code: '1131',
    name: 'bKash merchant 01811-223344',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  expect(wallet.statusCode, wallet.body).toBe(201);
  accounts = [...accounts, accountSchema.parse(wallet.json())];

  napa = await addProduct('Napa 500 mg', {
    tracking: 'batch',
    hasExpiry: true,
    units: [{ unitId: unitId('strip'), factor: '10', barcode: '' }],
    customFields: { generic_name: 'Paracetamol' },
  });
  syrup = await addProduct('Paracetamol syrup 60 ml');
  injection = await addProduct('Ceftriaxone 1 g injection');
  meter = await addProduct('Glucometer', { tracking: 'serial' });
  omeprazole = await addProduct('Omeprazole 20 mg');
  tamanna = await addCustomer('Tamanna Pharmacy');
  agrabad = await addCustomer('Agrabad Medicine Corner', { paymentTermsDays: 0 });

  // Opening stock: 500 tablets of Napa at ৳0.80, 100 bottles of syrup at ৳25, three injections
  // bought at two prices (2 at ৳300, 1 at ৳400: ৳1,000 together) and three glucometers at ৳1,500
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      openingLine(napa, '500', '0.80', { lotNumber: 'NP2409', expiresOn: '2027-01-31' }),
      openingLine(syrup, '100', '25'),
      openingLine(injection, '2', '300'),
      openingLine(injection, '1', '400'),
      openingLine(meter, '3', '1500', { serialNumbers: ['GM-1001', 'GM-1002', 'GM-1003'] }),
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);
  const card = stockCardSchema.parse(
    (await send('GET', `/stock/variants/${variantOf(napa)}`)).json(),
  );
  napaBatch = card.batches.find((batch) => batch.lotNumber === 'NP2409')?.batchId ?? '';

  viewer = await member('rumana@karnaphulimedicine.com', 'Rumana Akter', 'Counter-desk-2026', null);
  storeKeeper = await member('jamal@karnaphulimedicine.com', 'Jamal Uddin', 'Return-desk-2026', [
    'sales.delivery.manage',
    'sales.return.manage',
  ]);
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('sales returns', () => {
  it('takes goods back from a challan before it is billed, at what they cost', async () => {
    order = await ordered(
      [salesLine(syrup, '60', '40'), salesLine(napa, '20', '12', { unitId: unitId('strip') })],
      tamanna,
    );
    challan = await delivered(tamanna, order.id, [
      deliveryLine(syrup, '60', { orderLineId: lineOf(order.lines, syrup).id }),
      deliveryLine(napa, '20', {
        unitId: unitId('strip'),
        batchId: napaBatch,
        orderLineId: lineOf(order.lines, napa).id,
      }),
    ]);
    expect((await orderNow(order.id)).status).toBe('delivered');

    // 10 bottles, and 30 tablets of the 20 strips: any unit of the item
    firstReturn = await returned(
      returnForm([
        returnLine(syrup, '10', { deliveryLineId: lineOf(challan.lines, syrup).id }),
        returnLine(napa, '30', { deliveryLineId: lineOf(challan.lines, napa).id }),
      ]),
    );
    expect(firstReturn).toMatchObject({
      number: 'SR-2026-27-0001',
      status: 'posted',
      warehouseId: damage.id,
      deliveries: [{ id: challan.id, number: challan.number }],
      creditNotes: [],
    });
    // At the challan's cost: 10/60 of ৳1,500 and 30/200 of ৳160. The batch is the challan line's.
    expect(
      firstReturn.lines.map((line) => [line.deliveryNumber, line.batchId, line.billed, line.value]),
    ).toEqual([
      ['DC-2026-27-0001', null, false, '250.0000'],
      ['DC-2026-27-0001', napaBatch, false, '24.0000'],
    ]);
    // Inventory comes back where the goods are now, cost of goods sold comes off where it was booked
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${firstReturn.entry?.id ?? ''}`)).json(),
    );
    expect(entry.source).toBe('sales_return');
    expect(await entryLines(entry.id)).toEqual([
      ['1154', '274.0000', '0.0000'],
      ['5110', '0.0000', '274.0000'],
    ]);
    expect(entry.lines.map((item) => item.branchId)).toEqual([damage.branchId, main.branchId]);

    expect(await stockIn(damage)).toMatchObject({
      'Napa 500 mg': '30.0000',
      'Paracetamol syrup 60 ml': '10.0000',
    });
    expect(await stockIn(main)).toMatchObject({
      'Napa 500 mg': '300.0000',
      'Paracetamol syrup 60 ml': '40.0000',
    });
    const moves = stockMovementPageSchema.parse(
      (await send('GET', `/stock/variants/${variantOf(syrup)}/movements`)).json(),
    );
    expect(moves.items.find((move) => move.documentId === firstReturn.id)).toMatchObject({
      kind: 'sales_return',
      documentNumber: 'SR-2026-27-0001',
      warehouseId: damage.id,
      quantity: '10.0000',
      value: '250.0000',
    });

    // Not billed yet: the order can deliver them again (in the base unit), and is open again
    const reopened = await orderNow(order.id);
    expect(reopened.status).toBe('confirmed');
    expect(reopened.version).toBe(order.version + 2);
    expect(reopened.lines.map((line) => line.deliveredQuantity)).toEqual(['50.0000', '170.0000']);
    const after = await deliveryNow(challan.id);
    expect(after).toMatchObject({
      returnState: 'partly_returned',
      returns: [{ id: firstReturn.id, number: 'SR-2026-27-0001' }],
    });
    expect(after.lines.map((line) => line.returnedQuantity)).toEqual(['10.0000', '30.0000']);
    expect(await auditActions('sales_return', firstReturn.id)).toEqual([
      'sales_return.created',
      'sales_return.posted',
    ]);
  });

  it('refuses goods that did not leave on that challan line, each under its own box', async () => {
    draftChallan = await delivered(tamanna, '', [deliveryLine(syrup, '5')], false);
    const syrupLine = lineOf(challan.lines, syrup).id;

    const tooMany = await send(
      'POST',
      '/sales-returns',
      returnForm([returnLine(syrup, '51', { deliveryLineId: syrupLine })]),
    );
    expect(tooMany.statusCode).toBe(409);
    expect(problemOf(tooMany).fieldErrors).toEqual({
      'lines.0.quantity': ['return_over_delivered'],
    });
    // Another item than the challan line's, and a line of a draft challan: both at once
    const wrong = await send(
      'POST',
      '/sales-returns',
      returnForm([
        returnLine(napa, '1', { deliveryLineId: syrupLine }),
        returnLine(syrup, '1', { deliveryLineId: lineOf(draftChallan.lines, syrup).id }),
      ]),
    );
    expect(problemOf(wrong).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['return_delivery_line_invalid'],
      'lines.1.deliveryLineId': ['return_delivery_line_invalid'],
    });
    // Another customer's challan
    const notTheirs = await send(
      'POST',
      '/sales-returns',
      returnForm([returnLine(syrup, '1', { deliveryLineId: syrupLine })], {
        customerId: agrabad.id,
      }),
    );
    expect(problemOf(notTheirs).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['return_delivery_line_invalid'],
    });
    // Tomorrow's goods cannot come back today
    const future = await send(
      'POST',
      '/sales-returns',
      returnForm([returnLine(syrup, '1', { deliveryLineId: syrupLine })], { date: '2099-01-01' }),
    );
    expect(problemOf(future).fieldErrors).toEqual({ date: ['stock_date_future'] });

    // What the form itself can see is a 400 from the contract
    const withBatch = await send(
      'POST',
      '/sales-returns',
      returnForm([
        returnLine(napa, '1', {
          deliveryLineId: lineOf(challan.lines, napa).id,
          batchId: napaBatch,
        }),
      ]),
    );
    expect(withBatch.statusCode).toBe(400);
    expect(problemOf(withBatch).fieldErrors).toEqual({
      'lines.0.batchId': ['return_batch_not_allowed'],
    });
    const twice = await send(
      'POST',
      '/sales-returns',
      returnForm([
        returnLine(syrup, '1', { deliveryLineId: syrupLine }),
        returnLine(syrup, '2', { deliveryLineId: syrupLine }),
      ]),
    );
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({
      'lines.1.deliveryLineId': ['return_line_twice'],
    });
  });

  it('bills only what is left, and a return after the bill points at its invoice line', async () => {
    const syrupLine = lineOf(challan.lines, syrup).id;
    const napaLine = lineOf(challan.lines, napa).id;
    const whole = await send(
      'POST',
      '/invoices',
      invoiceForm([
        invoiceLine(syrup, '60', '40', { deliveryLineId: syrupLine }),
        invoiceLine(napa, '20', '12', { unitId: unitId('strip'), deliveryLineId: napaLine }),
      ]),
    );
    expect(problemOf(whole).fieldErrors).toEqual({
      'lines.0.deliveryLineId': ['invoice_delivery_line_invalid'],
      'lines.1.deliveryLineId': ['invoice_delivery_line_invalid'],
    });
    // 50 bottles at ৳40 and 17 strips at ৳12: ৳2,204 plus ৳330.60 VAT
    firstInvoice = await invoiced(
      invoiceForm([
        invoiceLine(syrup, '50', '40', { deliveryLineId: syrupLine }),
        invoiceLine(napa, '17', '12', { unitId: unitId('strip'), deliveryLineId: napaLine }),
      ]),
    );
    expect(firstInvoice).toMatchObject({
      number: 'INV-2026-27-0001',
      total: '2534.6000',
      amountCredited: '0.0000',
      creditNoteTotal: '0.0000',
      creditNotes: [],
    });
    expect(await deliveryNumbers('invoice=to_invoice')).toEqual([]);

    const before = await orderNow(order.id);
    billedReturn = await returned(
      returnForm([returnLine(syrup, '5', { deliveryLineId: syrupLine })], {
        date: '2026-10-08',
        reason: 'quality',
      }),
    );
    // Billed: the invoice line a credit note gives the money back on. 15/60 of ৳1,500 less the
    // ৳250 that came back before.
    expect(billedReturn.lines[0]).toMatchObject({
      billed: true,
      invoiceId: firstInvoice.id,
      invoiceLineId: lineOf(firstInvoice.lines, syrup).id,
      invoiceNumber: 'INV-2026-27-0001',
      creditedQuantity: '0.0000',
      value: '125.0000',
    });
    // The sale stands: the order is left alone
    const orderAfter = await orderNow(order.id);
    expect(orderAfter.version).toBe(before.version);
    expect(lineOf(orderAfter.lines, syrup).deliveredQuantity).toBe('50.0000');
    expect(lineOf((await deliveryNow(challan.id)).lines, syrup).returnedQuantity).toBe('15.0000');
  });

  it("gives a challan line's value back to the paisa, however many goes it takes", async () => {
    // Three injections that cost ৳1,000 together leave on one line, and come back one at a time
    const injections = await delivered(agrabad, '', [deliveryLine(injection, '3')]);
    const values: (string | null)[] = [];
    for (const number of ['0003', '0004', '0005']) {
      const back = await returned(
        returnForm(
          [returnLine(injection, '1', { deliveryLineId: lineOf(injections.lines, injection).id })],
          { customerId: agrabad.id, reason: 'unsold' },
        ),
      );
      expect(back.number).toBe(`SR-2026-27-${number}`);
      values.push(back.lines[0]?.value ?? null);
    }
    expect(values).toEqual(['333.3300', '333.3400', '333.3300']);
    expect((await deliveryNow(injections.id)).returnState).toBe('returned');
    // Nothing left to return or to bill
    expect(await deliveryNumbers('return=returnable')).toEqual([challan.number]);
    expect(await deliveryNumbers('invoice=to_invoice')).toEqual([]);
    const fourth = await send(
      'POST',
      '/sales-returns',
      returnForm(
        [returnLine(injection, '1', { deliveryLineId: lineOf(injections.lines, injection).id })],
        { customerId: agrabad.id },
      ),
    );
    expect(problemOf(fourth).fieldErrors).toEqual({
      'lines.0.quantity': ['return_over_delivered'],
    });
  });

  it('takes back goods with no challan at the average cost, if the item has one', async () => {
    // Sold before the system: no challan, so the batch printed on the strips is named
    const own = await returned(
      returnForm([returnLine(napa, '2', { unitId: unitId('strip'), batchId: napaBatch })], {
        customerId: agrabad.id,
        reason: 'expired',
      }),
    );
    expect(own.number).toBe('SR-2026-27-0006');
    expect(own.lines[0]).toMatchObject({
      deliveryLineId: null,
      billed: false,
      batchId: napaBatch,
      value: '16.0000',
    });
    const noBatch = await send(
      'POST',
      '/sales-returns',
      returnForm([returnLine(napa, '2')], { customerId: agrabad.id }),
    );
    expect(problemOf(noBatch).fieldErrors).toEqual({ 'lines.0.batchId': ['stock_batch_required'] });
    const noCost = await send(
      'POST',
      '/sales-returns',
      returnForm([returnLine(omeprazole, '10')], { customerId: agrabad.id }),
    );
    expect(noCost.statusCode).toBe(409);
    expect(problemOf(noCost).fieldErrors).toEqual({
      'lines.0.variantId': ['return_cost_unknown'],
    });
  });

  it('takes back only serial numbers that left on the line', async () => {
    const meters = await delivered(tamanna, '', [
      deliveryLine(meter, '2', { serialNumbers: ['GM-1001', 'GM-1002'] }),
    ]);
    const meterLine = lineOf(meters.lines, meter).id;
    const stranger = await send(
      'POST',
      '/sales-returns',
      returnForm([
        returnLine(meter, '1', { deliveryLineId: meterLine, serialNumbers: ['GM-1003'] }),
      ]),
    );
    expect(problemOf(stranger).fieldErrors).toEqual({
      'lines.0.serialNumbers': ['return_serial_invalid'],
    });
    const back = await returned(
      returnForm([
        returnLine(meter, '1', { deliveryLineId: meterLine, serialNumbers: ['GM-1002'] }),
      ]),
    );
    expect(back.lines[0]).toMatchObject({ serialNumbers: ['GM-1002'], value: '1500.0000' });
    const card = stockCardSchema.parse(
      (await send('GET', `/stock/variants/${variantOf(meter)}`)).json(),
    );
    expect(card.serials.find((serial) => serial.serialNumber === 'GM-1002')?.warehouseId).toBe(
      damage.id,
    );
  });

  it('keeps drafts free, and checks them again when they are posted', async () => {
    const napaLine = lineOf(challan.lines, napa).id;
    // 170 tablets are still out on the line. Two drafts of 100 each: drafts hold nothing.
    const form = (quantity: string) =>
      returnForm([returnLine(napa, quantity, { deliveryLineId: napaLine })], {
        date: '2026-10-08',
        reason: 'expired',
        post: false,
      });
    const one = await returned(form('100'));
    const two = await returned(form('100'));
    expect([one.number, two.number, one.lines[0]?.value]).toEqual([null, null, null]);
    // The draft keeps the challan line's batch
    expect(one.lines[0]?.batchId).toBe(napaBatch);

    const posted = await send('POST', `/sales-returns/${one.id}/post`, { version: one.version });
    expect(posted.statusCode, posted.body).toBe(200);
    expect(salesReturnSchema.parse(posted.json()).number).toBe('SR-2026-27-0008');
    const refused = await send('POST', `/sales-returns/${two.id}/post`, { version: two.version });
    expect(problemOf(refused).fieldErrors).toEqual({
      'lines.0.quantity': ['return_over_delivered'],
    });
    expect((await returnNow(two.id)).status).toBe('draft');

    const fixed = await send('PUT', `/sales-returns/${two.id}`, {
      ...form('50'),
      post: true,
      version: two.version,
    });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(salesReturnSchema.parse(fixed.json())).toMatchObject({
      number: 'SR-2026-27-0009',
      lines: [{ billed: true, value: '40.0000' }],
    });
    expect(await auditActions('sales_return', two.id)).toEqual([
      'sales_return.created',
      'sales_return.posted',
      'sales_return.updated',
    ]);

    // A posted return is final
    const change = await send('PUT', `/sales-returns/${one.id}`, {
      ...form('1'),
      version: one.version + 1,
    });
    expect(problemOf(change).code).toBe('stock_not_draft');
    const remove = await send(
      'DELETE',
      `/sales-returns/${one.id}?version=${String(one.version + 1)}`,
    );
    expect(problemOf(remove).code).toBe('stock_not_draft');

    // A draft that is deleted is gone, and never had a number
    const third = await returned(form('1'));
    expect(
      (await send('DELETE', `/sales-returns/${third.id}?version=${String(third.version)}`))
        .statusCode,
    ).toBe(204);
    expect((await send('GET', `/sales-returns/${third.id}`)).statusCode).toBe(404);
    expect(await auditActions('sales_return', third.id)).toEqual([
      'sales_return.created',
      'sales_return.deleted',
    ]);

    const drafts = salesReturnPageSchema.parse(
      (await send('GET', '/sales-returns?status=draft')).json(),
    );
    expect(drafts.items).toEqual([]);
    const agrabads = salesReturnPageSchema.parse(
      (await send('GET', `/sales-returns?customerId=${agrabad.id}`)).json(),
    );
    expect(agrabads.items.map((item) => item.number)).toEqual([
      'SR-2026-27-0006',
      'SR-2026-27-0005',
      'SR-2026-27-0004',
      'SR-2026-27-0003',
    ]);
  });

  it('leaves a closed order closed', async () => {
    const small = await ordered([salesLine(syrup, '10', '40')], agrabad);
    const part = await delivered(agrabad, small.id, [
      deliveryLine(syrup, '4', { orderLineId: lineOf(small.lines, syrup).id }),
    ]);
    const now = await orderNow(small.id);
    const closed = await send('POST', `/sales-orders/${small.id}/close`, { version: now.version });
    expect(closed.statusCode, closed.body).toBe(200);
    const closedOrder = salesOrderSchema.parse(closed.json());
    await returned(
      returnForm([returnLine(syrup, '1', { deliveryLineId: lineOf(part.lines, syrup).id })], {
        customerId: agrabad.id,
      }),
    );
    const after = await orderNow(small.id);
    expect(after).toMatchObject({ status: 'closed', version: closedOrder.version });
    expect(lineOf(after.lines, syrup).deliveredQuantity).toBe('3.0000');
  });
});

describe('credit notes', () => {
  it('gives the money back for a billed return, on the invoice it came from', async () => {
    const syrupInvoiceLine = lineOf(firstInvoice.lines, syrup).id;
    const backLine = billedReturn.lines[0]?.id ?? '';
    firstCreditNote = await credited(
      creditForm(firstInvoice, [
        creditLine(syrupInvoiceLine, '5', '40', { returnLineId: backLine }),
      ]),
    );
    expect(firstCreditNote).toMatchObject({
      number: 'CN-2026-27-0001',
      status: 'posted',
      customer: { id: tamanna.id },
      invoice: { id: firstInvoice.id, number: 'INV-2026-27-0001', date: '2026-10-07' },
      branchId: main.branchId,
      pricesIncludeVat: false,
      net: '200.0000',
      vat: '30.0000',
      total: '230.0000',
      applied: '230.0000',
      refunded: '0.0000',
    });
    expect(firstCreditNote.lines[0]).toMatchObject({
      invoiceLineId: syrupInvoiceLine,
      returnLineId: backLine,
      returnNumber: billedReturn.number,
      variantId: variantOf(syrup),
      taxRate: { name: 'VAT 15%', rate: '15.00' },
    });
    expect(firstCreditNote.allocations.map((item) => [item.invoiceNumber, item.amount])).toEqual([
      ['INV-2026-27-0001', '230.0000'],
    ]);
    // The sale back from Sales returns (4120, the pharma template's choice), the VAT back, and
    // the receivable down with Tamanna on the line
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${firstCreditNote.entry?.id ?? ''}`)).json(),
    );
    expect(entry.source).toBe('sales_credit_note');
    expect(await entryLines(entry.id)).toEqual([
      ['4120', '200.0000', '0.0000'],
      ['2120', '30.0000', '0.0000'],
      ['1140', '0.0000', '230.0000'],
    ]);
    expect(entry.lines.map((item) => item.party?.id ?? null)).toEqual([null, null, tamanna.id]);
    expect(new Set(entry.lines.map((item) => item.branchId))).toEqual(new Set([main.branchId]));

    const invoice = await invoiceNow(firstInvoice.id);
    expect(invoice).toMatchObject({
      amountCredited: '230.0000',
      creditNoteTotal: '230.0000',
      creditNotes: [{ id: firstCreditNote.id, number: 'CN-2026-27-0001', total: '230.0000' }],
    });
    expect(invoice.lines.map((line) => line.credited)).toEqual(['230.0000', '0.0000']);
    expect(creditStateOf(invoice)).toBe('partly_credited');
    const back = await returnNow(billedReturn.id);
    expect(back.lines[0]?.creditedQuantity).toBe('5.0000');
    expect(back.creditNotes.map((note) => note.number)).toEqual(['CN-2026-27-0001']);
    expect(await auditActions('credit_note', firstCreditNote.id)).toEqual([
      'credit_note.created',
      'credit_note.posted',
    ]);
  });

  it('refuses lines the invoice did not bill, each under its own box', async () => {
    const syrupInvoiceLine = lineOf(firstInvoice.lines, syrup).id;
    const napaInvoiceLine = lineOf(firstInvoice.lines, napa).id;
    const backLine = billedReturn.lines[0]?.id ?? '';
    const refuse = async (body: object) => {
      const res = await send('POST', '/credit-notes', body);
      expect(res.statusCode, res.body).toBe(409);
      return problemOf(res).fieldErrors;
    };
    // The same return's money twice
    expect(
      await refuse(
        creditForm(firstInvoice, [
          creditLine(syrupInvoiceLine, '1', '40', { returnLineId: backLine }),
        ]),
      ),
    ).toEqual({ 'lines.0.quantity': ['credit_note_over_return'] });
    // A return line that came back before the bill (the invoice billed less instead), and a
    // return line on another invoice line than the one that billed it
    expect(
      await refuse(
        creditForm(firstInvoice, [
          creditLine(syrupInvoiceLine, '1', '40', {
            returnLineId: lineOf(firstReturn.lines, syrup).id,
          }),
          creditLine(napaInvoiceLine, '1', '12', { returnLineId: backLine }),
        ]),
      ),
    ).toEqual({
      'lines.0.returnLineId': ['credit_note_return_invalid'],
      'lines.1.returnLineId': ['credit_note_return_invalid'],
    });
    // More than the line billed, and a unit the item does not have
    expect(
      await refuse(creditForm(firstInvoice, [creditLine(syrupInvoiceLine, '51', '1')])),
    ).toEqual({ 'lines.0.quantity': ['credit_note_over_quantity'] });
    expect(
      await refuse(
        creditForm(firstInvoice, [
          creditLine(syrupInvoiceLine, '1', '1', { unitId: unitId('strip') }),
        ]),
      ),
    ).toEqual({ 'lines.0.unitId': ['stock_unit_invalid'] });
    // Dated before the invoice
    expect(
      await refuse(
        creditForm(firstInvoice, [creditLine(syrupInvoiceLine, '1', '1')], { date: '2026-10-06' }),
      ),
    ).toEqual({ date: ['credit_note_date'] });
    // A draft invoice: nothing to credit yet
    const draft = await invoiced(
      invoiceForm([invoiceLine(syrup, '1', '40')], { warehouseId: main.id, post: false }),
    );
    expect(
      await refuse(creditForm(draft, [creditLine(draft.lines[0]?.id ?? '', '1', '40')])),
    ).toEqual({ invoiceId: ['credit_note_invoice_invalid'] });
    expect(
      (await send('DELETE', `/invoices/${draft.id}?version=${String(draft.version)}`)).statusCode,
    ).toBe(204);

    // What the form can see: the same return line twice
    const twice = await send(
      'POST',
      '/credit-notes',
      creditForm(firstInvoice, [
        creditLine(syrupInvoiceLine, '1', '40', { returnLineId: backLine }),
        creditLine(syrupInvoiceLine, '1', '40', { returnLineId: backLine }),
      ]),
    );
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({
      'lines.1.returnLineId': ['credit_note_return_twice'],
    });
  });

  it('caps the money on each invoice line, under every line that takes from it', async () => {
    const syrupInvoiceLine = lineOf(firstInvoice.lines, syrup).id;
    const napaInvoiceLine = lineOf(firstInvoice.lines, napa).id;
    // The syrup line charged ৳2,300, and ৳230 came back: ৳2,070 is left. ৳2,070 + ৳1.15 is not.
    const over = await send(
      'POST',
      '/credit-notes',
      creditForm(
        firstInvoice,
        [creditLine(syrupInvoiceLine, '45', '40'), creditLine(syrupInvoiceLine, '1', '1')],
        { reason: 'price_adjustment' },
      ),
    );
    expect(problemOf(over).fieldErrors).toEqual({
      'lines.0.unitPrice': ['credit_note_over_line'],
      'lines.1.unitPrice': ['credit_note_over_line'],
    });
    // A price cut of ৳1 a strip on all 17 strips: ৳17 plus ৳2.55 VAT, applied to the invoice
    const cut = await credited(
      creditForm(
        firstInvoice,
        [creditLine(napaInvoiceLine, '17', '1', { unitId: unitId('strip') })],
        { reason: 'price_adjustment' },
      ),
    );
    expect(cut).toMatchObject({
      number: 'CN-2026-27-0002',
      total: '19.5500',
      applied: '19.5500',
    });
    expect((await invoiceNow(firstInvoice.id)).amountCredited).toBe('249.5500');
  });

  it('credits a whole invoice in one click, to the paisa, the way the invoice worked it out', async () => {
    // A counter sale while prices included VAT, with a percent and an amount discount
    await setPricesIncludeVat(true);
    const counter = await invoiced(
      invoiceForm(
        [
          invoiceLine(napa, '7', '12.35', {
            unitId: unitId('strip'),
            batchId: napaBatch,
            discount: '3.5',
          }),
          invoiceLine(syrup, '3', '41.50', { discountType: 'amount', discount: '2' }),
        ],
        { customerId: agrabad.id, warehouseId: main.id },
      ),
    );
    expect(counter.number).toBe('INV-2026-27-0002');
    await setPricesIncludeVat(false);

    const draft = await credited(
      creditForm(counter, wholeInvoiceCreditLines(counter), {
        reason: 'billing_error',
        post: false,
      }),
    );
    // The invoice's own setting, not the workspace's: every line gives back exactly what it charged
    expect(draft).toMatchObject({
      number: null,
      pricesIncludeVat: true,
      net: counter.net,
      vat: counter.vat,
      total: counter.total,
      applied: '0.0000',
      entry: null,
    });
    const amounts = (lines: readonly { net: string; vat: string; total: string }[]) =>
      lines.map((line) => [line.net, line.vat, line.total]);
    expect(amounts(draft.lines)).toEqual(amounts(counter.lines));
    const posted = await send('POST', `/credit-notes/${draft.id}/post`, { version: draft.version });
    expect(posted.statusCode, posted.body).toBe(200);
    expect(creditNoteSchema.parse(posted.json())).toMatchObject({
      number: 'CN-2026-27-0003',
      applied: counter.total,
    });

    const after = await invoiceNow(counter.id);
    expect(after.amountCredited).toBe(counter.total);
    expect(creditStateOf(after)).toBe('credited');
    // Settled by the credit note: not open, and counted with the paid ones
    expect(await invoiceNumbers(`payment=open&customerId=${agrabad.id}`)).toEqual([]);
    expect(await invoiceNumbers(`payment=paid&customerId=${agrabad.id}`)).toEqual([
      'INV-2026-27-0002',
    ]);
    // Once a credit note is posted, the button is gone, and the server refuses the full amounts
    expect(canCreditWhole(after)).toBe(false);
    const again = await send(
      'POST',
      '/credit-notes',
      creditForm(after, wholeInvoiceCreditLines(after), { reason: 'billing_error' }),
    );
    expect(problemOf(again).code).toBe('credit_note_over_line');
    // A line of this invoice on a credit note for another one
    const elsewhere = await send(
      'POST',
      '/credit-notes',
      creditForm(firstInvoice, [creditLine(counter.lines[1]?.id ?? '', '1', '1')]),
    );
    expect(problemOf(elsewhere).fieldErrors).toEqual({
      'lines.0.invoiceLineId': ['credit_note_line_invalid'],
    });
  });

  it("keeps what the invoice no longer owes as the customer's advance, and applies it later", async () => {
    // Tamanna pays the rest of INV-0001 and ৳714.95 more
    const due = '2285.0500';
    expect(amountDueOf(await invoiceNow(firstInvoice.id))).toBe(due);
    const paid = await send('POST', '/receipts', {
      customerId: tamanna.id,
      date: '2026-10-09',
      amount: '3000',
      accountId: account('1110'),
      method: 'cash',
      reference: '',
      branchId: main.branchId,
      note: '',
      allocations: [{ invoiceId: firstInvoice.id, amount: due }],
    });
    expect(paid.statusCode, paid.body).toBe(201);
    tamannaReceipt = receiptSchema.parse(paid.json());

    // A price cut on the paid invoice: nothing left to apply it to there, so all of it is advance
    advanceNote = await credited(
      creditForm(firstInvoice, [creditLine(lineOf(firstInvoice.lines, syrup).id, '50', '1')], {
        date: '2026-10-09',
        reason: 'price_adjustment',
      }),
    );
    expect(advanceNote).toMatchObject({ total: '57.5000', applied: '0.0000', allocations: [] });

    laterInvoice = await invoiced(
      invoiceForm([invoiceLine(syrup, '2', '40')], { date: '2026-10-09', warehouseId: main.id }),
    );
    expect(laterInvoice).toMatchObject({ number: 'INV-2026-27-0003', total: '92.0000' });
    const over = await send('PUT', `/credit-notes/${advanceNote.id}/allocations`, {
      version: advanceNote.version,
      allocations: [{ invoiceId: laterInvoice.id, amount: '57.51' }],
    });
    expect(problemOf(over).fieldErrors).toEqual({ allocations: ['credit_note_over_allocated'] });
    const applied = await send('PUT', `/credit-notes/${advanceNote.id}/allocations`, {
      version: advanceNote.version,
      allocations: [{ invoiceId: laterInvoice.id, amount: '50' }],
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(creditNoteSchema.parse(applied.json())).toMatchObject({
      applied: '50.0000',
      version: advanceNote.version + 1,
    });
    const stale = await send('PUT', `/credit-notes/${advanceNote.id}/allocations`, {
      version: advanceNote.version,
      allocations: [],
    });
    expect(problemOf(stale).code).toBe('version_conflict');
    expect((await invoiceNow(laterInvoice.id)).amountCredited).toBe('50.0000');
    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=credit_note&entityId=${advanceNote.id}`)).json(),
    );
    expect(log.items.find((item) => item.action === 'credit_note.allocated')?.changes).toEqual({
      'INV-2026-27-0003': { from: null, to: '50.0000' },
    });
    advanceNote = await creditNoteNow(advanceNote.id);

    // A draft has no money to apply
    const draft = await credited(
      creditForm(laterInvoice, [creditLine(laterInvoice.lines[0]?.id ?? '', '1', '1')], {
        date: '2026-10-09',
        post: false,
      }),
    );
    const early = await send('PUT', `/credit-notes/${draft.id}/allocations`, {
      version: draft.version,
      allocations: [],
    });
    expect(problemOf(early).code).toBe('credit_note_not_posted');
    expect(
      (await send('DELETE', `/credit-notes/${draft.id}?version=${String(draft.version)}`))
        .statusCode,
    ).toBe(204);
  });

  it('lets a credit note wait for another one of the same invoice, then answers under its line', async () => {
    // Hold the invoice's lock as another posting would, and send two credit notes for all of
    // INV-0003's line (৳92 each). Both wait on the lock. The first then posts; the second waits
    // for it, reads what it took back, and answers under its line.
    const line = laterInvoice.lines[0]?.id ?? '';
    const body = creditForm(laterInvoice, [creditLine(line, '2', '40')], { date: '2026-10-09' });
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let first: ReturnType<typeof send> | undefined;
    let second: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      await tx`SELECT id FROM invoices WHERE id = ${laterInvoice.id} FOR UPDATE`;
      first = send('POST', '/credit-notes', body);
      await new Promise((resolve) => setTimeout(resolve, 150));
      second = send('POST', '/credit-notes', body);
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await superuser.end();
    const [one, two] = await Promise.all([first, second]);
    if (!one || !two) throw new Error('the credit notes were never sent');
    expect(one.statusCode, one.body).toBe(201);
    // ৳42 was still due on INV-0003: that much is applied, ৳50 is advance
    racedNote = creditNoteSchema.parse(one.json());
    expect(racedNote).toMatchObject({ number: 'CN-2026-27-0005', applied: '42.0000' });
    expect(two.statusCode).toBe(409);
    expect(problemOf(two).fieldErrors).toEqual({ 'lines.0.unitPrice': ['credit_note_over_line'] });
  });

  it('takes the sale back from the account the settings name', async () => {
    const chosen = salesAccountsSchema.parse((await send('GET', '/sales-accounts')).json());
    expect(chosen.returns).toBe(account('4120'));
    // Only an active income account that is not a group
    for (const code of ['1110', '4100']) {
      const bad = await send('PUT', '/sales-accounts', { returns: account(code) });
      expect(problemOf(bad).fieldErrors, code).toEqual({ returns: ['sales_account_invalid'] });
    }
    // While it is chosen, the account cannot be archived. Deleting it is refused anyway: credit
    // notes booked to it, and an account with entries is never deleted.
    const returnsAccount = accountSchema.parse(
      (await send('GET', `/accounts/${account('4120')}`)).json(),
    );
    const archive = await send('POST', `/accounts/${returnsAccount.id}/archive`, {
      version: returnsAccount.version,
    });
    expect(problemOf(archive).code).toBe('account_used_by_sales');
    const remove = await send(
      'DELETE',
      `/accounts/${returnsAccount.id}?version=${String(returnsAccount.version)}`,
    );
    expect(problemOf(remove).code).toBe('account_in_use');
    // A new account with no entries: only the setting holds on to it
    const made = await send('POST', '/accounts', {
      parentId: account('4100'),
      code: '4130',
      name: 'Returns from pharmacies',
      isGroup: false,
      holdsMoney: false,
      description: '',
    });
    expect(made.statusCode, made.body).toBe(201);
    const fresh = accountSchema.parse(made.json());
    accounts = [...accounts, fresh];
    expect((await send('PUT', '/sales-accounts', { returns: fresh.id })).statusCode).toBe(200);
    const unused = await send('DELETE', `/accounts/${fresh.id}?version=${String(fresh.version)}`);
    expect(problemOf(unused).code).toBe('account_used_by_sales');

    // None chosen: the sale comes back off Sales itself
    const cleared = await send('PUT', '/sales-accounts', { returns: '' });
    expect(salesAccountsSchema.parse(cleared.json())).toEqual({ returns: null });
    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=workspace&entityId=${tenantId}`)).json(),
    );
    expect(
      log.items
        .filter((item) => item.action === 'sales_accounts.changed')
        .map((item) => item.changes),
    ).toEqual([{ returns: { from: '4130', to: null } }, { returns: { from: '4120', to: '4130' } }]);
    const note = await credited(
      creditForm(
        firstInvoice,
        [creditLine(lineOf(firstInvoice.lines, napa).id, '1', '1', { unitId: unitId('strip') })],
        { date: '2026-10-09', reason: 'billing_error' },
      ),
    );
    expect((await entryLines(note.entry?.id ?? ''))[0]).toEqual(['4110', '1.0000', '0.0000']);
    expect((await send('PUT', '/sales-accounts', { returns: account('4120') })).statusCode).toBe(
      200,
    );

    // The journal's Reverse refuses both kinds of entry: a stock one and a sales one
    for (const [id, code] of [
      [firstReturn.entry?.id ?? '', 'journal_is_stock'],
      [note.entry?.id ?? '', 'journal_is_sales'],
    ] as const) {
      const entry = journalEntrySchema.parse((await send('GET', `/journal-entries/${id}`)).json());
      const reverse = await send('POST', `/journal-entries/${id}/reverse`, {
        version: entry.version,
        date: '2026-10-10',
      });
      expect(problemOf(reverse).code).toBe(code);
    }
  });

  it('refuses a credit note for an archived customer, and lists by invoice', async () => {
    const halishahar = await addCustomer('Halishahar Drug House');
    const invoice = await invoiced(
      invoiceForm([invoiceLine(syrup, '1', '40')], {
        customerId: halishahar.id,
        warehouseId: main.id,
      }),
    );
    const now = customerSchema.parse((await send('GET', `/customers/${halishahar.id}`)).json());
    const archived = await send('POST', `/customers/${halishahar.id}/archive`, {
      version: now.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const res = await send(
      'POST',
      '/credit-notes',
      creditForm(invoice, [creditLine(invoice.lines[0]?.id ?? '', '1', '40')]),
    );
    expect(problemOf(res).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });

    const page = creditNotePageSchema.parse(
      (await send('GET', `/credit-notes?invoiceId=${firstInvoice.id}`)).json(),
    );
    expect(page.items.map((item) => item.number)).toEqual([
      'CN-2026-27-0006',
      'CN-2026-27-0004',
      'CN-2026-27-0002',
      'CN-2026-27-0001',
    ]);
  });
});

describe('refunds', () => {
  it('pays an advance back from a receipt, and gives it back when voided', async () => {
    // ৳3,000 came in, ৳2,285.05 is applied: ৳714.95 is left
    const tooMuch = await send(
      'POST',
      '/refunds',
      refundForm('714.96', { receiptId: tamannaReceipt.id }),
    );
    expect(tooMuch.statusCode).toBe(409);
    expect(problemOf(tooMuch).fieldErrors).toEqual({ amount: ['refund_over_source'] });
    receiptRefund = await refunded(refundForm('500', { receiptId: tamannaReceipt.id }));
    expect(receiptRefund).toMatchObject({
      number: 'RF-2026-27-0001',
      status: 'posted',
      amount: '500.0000',
      source: { type: 'receipt', id: tamannaReceipt.id, number: tamannaReceipt.number },
      voidEntry: null,
    });
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${receiptRefund.entry.id}`)).json(),
    );
    expect(entry.source).toBe('sales_refund');
    expect(await entryLines(entry.id)).toEqual([
      ['1140', '500.0000', '0.0000'],
      ['1110', '0.0000', '500.0000'],
    ]);
    expect(entry.lines.map((item) => item.party?.id ?? null)).toEqual([tamanna.id, null]);
    expect((await receiptNow(tamannaReceipt.id)).refunded).toBe('500.0000');

    // What was paid back cannot be applied: ৳3,000 − ৳500 = ৳2,500 at most
    const receipt = await receiptNow(tamannaReceipt.id);
    const overApplied = await send('PUT', `/receipts/${receipt.id}/allocations`, {
      version: receipt.version,
      allocations: [
        { invoiceId: firstInvoice.id, amount: '2285.05' },
        { invoiceId: laterInvoice.id, amount: '215' },
      ],
    });
    expect(problemOf(overApplied).code).toBe('receipt_over_allocated');
    // A receipt with a refund on it is not voided: the refund first
    const voidReceipt = await send('POST', `/receipts/${receipt.id}/void`, {
      version: receipt.version,
      date: '2026-10-10',
      reason: 'Counted twice',
    });
    expect(problemOf(voidReceipt).code).toBe('receipt_has_refunds');

    const early = await send('POST', `/refunds/${receiptRefund.id}/void`, {
      version: receiptRefund.version,
      date: '2026-10-09',
      reason: 'Paid by mistake',
    });
    expect(problemOf(early).fieldErrors).toEqual({ date: ['receipt_void_date'] });
    const noReason = await send('POST', `/refunds/${receiptRefund.id}/void`, {
      version: receiptRefund.version,
      date: '2026-10-10',
      reason: ' ',
    });
    expect(noReason.statusCode).toBe(400);
    expect(problemOf(noReason).fieldErrors).toEqual({ reason: ['receipt_void_reason_required'] });
    const voided = await send('POST', `/refunds/${receiptRefund.id}/void`, {
      version: receiptRefund.version,
      date: '2026-10-10',
      reason: 'The customer kept the advance',
    });
    expect(voided.statusCode, voided.body).toBe(200);
    receiptRefund = refundSchema.parse(voided.json());
    expect(receiptRefund).toMatchObject({
      status: 'voided',
      voidDate: '2026-10-10',
      voidReason: 'The customer kept the advance',
    });
    const reversal = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${receiptRefund.voidEntry?.id ?? ''}`)).json(),
    );
    expect(reversal.source).toBe('reversal');
    expect(await entryLines(reversal.id)).toEqual([
      ['1140', '0.0000', '500.0000'],
      ['1110', '500.0000', '0.0000'],
    ]);
    expect((await receiptNow(tamannaReceipt.id)).refunded).toBe('0.0000');
    const twice = await send('POST', `/refunds/${receiptRefund.id}/void`, {
      version: receiptRefund.version,
      date: '2026-10-10',
      reason: 'Again',
    });
    expect(problemOf(twice).code).toBe('refund_voided');
    const voidedList = refundPageSchema.parse((await send('GET', '/refunds?status=voided')).json());
    expect(voidedList.items.map((item) => item.number)).toEqual(['RF-2026-27-0001']);
    // Its entry is voided on its own page, not reversed in the journal
    const reverse = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-10',
    });
    expect(problemOf(reverse).code).toBe('journal_is_sales');
    expect(await auditActions('refund', receiptRefund.id)).toEqual([
      'refund.created',
      'refund.voided',
    ]);
  });

  it("pays back a credit note's advance, from a posted source of the same customer only", async () => {
    // ৳57.50 credited, ৳50 applied to INV-0003: ৳7.50 goes back by bKash
    const back = await refunded(
      refundForm('7.50', {
        creditNoteId: advanceNote.id,
        accountId: account('1131'),
        method: 'mobile_wallet',
        reference: 'TrxID 9KD71HQ2ZP',
      }),
    );
    expect(back).toMatchObject({
      number: 'RF-2026-27-0002',
      source: { type: 'credit_note', id: advanceNote.id, number: advanceNote.number },
    });
    const note = await creditNoteNow(advanceNote.id);
    expect(note).toMatchObject({ applied: '50.0000', refunded: '7.5000' });
    const more = await send('PUT', `/credit-notes/${note.id}/allocations`, {
      version: note.version,
      allocations: [{ invoiceId: laterInvoice.id, amount: '50.01' }],
    });
    expect(problemOf(more).fieldErrors).toEqual({ allocations: ['credit_note_over_allocated'] });

    // Neither source, or both: the contract
    for (const sources of [{}, { receiptId: tamannaReceipt.id, creditNoteId: advanceNote.id }]) {
      const res = await send('POST', '/refunds', refundForm('1', sources));
      expect(res.statusCode).toBe(400);
      expect(problemOf(res).fieldErrors).toEqual({ receiptId: ['refund_source'] });
    }
    // Another customer's receipt, a draft credit note, an account that holds no money
    const notTheirs = await send(
      'POST',
      '/refunds',
      refundForm('1', { customerId: agrabad.id, receiptId: tamannaReceipt.id }),
    );
    expect(problemOf(notTheirs).fieldErrors).toEqual({ receiptId: ['refund_source_invalid'] });
    const draft = await credited(
      creditForm(
        firstInvoice,
        [creditLine(lineOf(firstInvoice.lines, napa).id, '1', '1', { unitId: unitId('strip') })],
        { date: '2026-10-09', post: false },
      ),
    );
    const fromDraft = await send('POST', '/refunds', refundForm('1', { creditNoteId: draft.id }));
    expect(problemOf(fromDraft).fieldErrors).toEqual({ creditNoteId: ['refund_source_invalid'] });
    const sales = await send(
      'POST',
      '/refunds',
      refundForm('1', { receiptId: tamannaReceipt.id, accountId: account('4110') }),
    );
    expect(problemOf(sales).fieldErrors).toEqual({ accountId: ['refund_account_invalid'] });
    expect(
      (await send('DELETE', `/credit-notes/${draft.id}?version=${String(draft.version)}`))
        .statusCode,
    ).toBe(204);
  });

  it("lets a refund wait for the receipt's allocation, then answers under its amount", async () => {
    const fresh = await invoiced(
      invoiceForm([invoiceLine(syrup, '15', '40')], { date: '2026-10-09', warehouseId: main.id }),
    );
    expect(fresh).toMatchObject({ number: 'INV-2026-27-0005', total: '690.0000' });
    // Hold the receipt's lock, then apply its advance to the new invoice and ask for all of the
    // advance back. The allocation goes first; the refund waits for it, and finds ৳24.95 left.
    const receipt = await receiptNow(tamannaReceipt.id);
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let allocate: ReturnType<typeof send> | undefined;
    let refund: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      await tx`SELECT id FROM receipts WHERE id = ${receipt.id} FOR UPDATE`;
      allocate = send('PUT', `/receipts/${receipt.id}/allocations`, {
        version: receipt.version,
        allocations: [
          { invoiceId: firstInvoice.id, amount: '2285.05' },
          { invoiceId: fresh.id, amount: '690' },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      refund = send('POST', '/refunds', refundForm('714.95', { receiptId: receipt.id }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await superuser.end();
    const [applied, paidBack] = await Promise.all([allocate, refund]);
    if (!applied || !paidBack) throw new Error('the requests were never sent');
    expect(applied.statusCode, applied.body).toBe(200);
    expect(paidBack.statusCode).toBe(409);
    expect(problemOf(paidBack).fieldErrors).toEqual({ amount: ['refund_over_source'] });
    // The refused refund used no number
    const rest = await refunded(refundForm('24.95', { receiptId: receipt.id }));
    expect(rest.number).toBe('RF-2026-27-0003');
  });

  it('adds up to what Tamanna owes in the books', async () => {
    // Billed ৳2,534.60 + ৳92 + ৳690 = ৳3,316.60. Credited ৳230 + ৳19.55 + ৳57.50 + ৳92 + ৳1.15 =
    // ৳400.20. Received ৳3,000, paid back ৳7.50 + ৳24.95 (the voided ৳500 came and went).
    // 3,316.60 − 400.20 − 3,000 + 32.45 = −51.15: ৳51.15 is still Tamanna's advance, the ৳50 of
    // CN-0005 that no invoice has used and the ৳1.15 of CN-0006.
    const balance = customerCreditSchema.parse(
      (await send('GET', `/customers/${tamanna.id}/credit`)).json(),
    );
    expect(balance.balance).toBe('-51.1500');
  });
});

describe('who may do what', () => {
  it('lets anyone read returns, credit notes and refunds, and only the right people write them', async () => {
    for (const url of [
      '/sales-returns',
      `/sales-returns/${firstReturn.id}`,
      '/credit-notes',
      `/credit-notes/${firstCreditNote.id}`,
      '/refunds',
      `/refunds/${receiptRefund.id}`,
      '/sales-accounts',
    ]) {
      expect((await send('GET', url, undefined, viewer)).statusCode, url).toBe(200);
    }
    const ownLine = returnLine(napa, '1', { unitId: unitId('strip'), batchId: napaBatch });
    const writes = [
      send('POST', '/sales-returns', returnForm([ownLine]), viewer),
      send(
        'POST',
        '/credit-notes',
        creditForm(firstInvoice, [creditLine(firstInvoice.lines[0]?.id ?? '', '1', '1')]),
        viewer,
      ),
      send(
        'PUT',
        `/credit-notes/${advanceNote.id}/allocations`,
        { version: 1, allocations: [] },
        viewer,
      ),
      send('POST', '/refunds', refundForm('1', { receiptId: tamannaReceipt.id }), viewer),
      send(
        'POST',
        `/refunds/${receiptRefund.id}/void`,
        { version: 1, date: '2026-10-10', reason: 'x' },
        viewer,
      ),
      send('PUT', '/sales-accounts', { returns: '' }, viewer),
    ];
    for (const res of await Promise.all(writes)) {
      expect(res.statusCode).toBe(403);
      expect(problemOf(res).code).toBe('permission_missing');
    }

    // The store keeper takes goods back, and moves no money
    const back = await returned(returnForm([ownLine], { customerId: agrabad.id }), storeKeeper);
    expect(back.status).toBe('posted');
    const money = [
      send(
        'POST',
        '/credit-notes',
        creditForm(firstInvoice, [creditLine(firstInvoice.lines[0]?.id ?? '', '1', '1')]),
        storeKeeper,
      ),
      send('POST', '/refunds', refundForm('1', { receiptId: tamannaReceipt.id }), storeKeeper),
      send('PUT', '/sales-accounts', { returns: '' }, storeKeeper),
    ];
    const refused = await Promise.all(money);
    expect(refused.map((res) => res.statusCode)).toEqual([403, 403, 403]);
    expect(refused.map((res) => problemOf(res).params?.permissions)).toEqual([
      'sales.credit_note.manage',
      'sales.refund.manage',
      'core.settings.manage',
    ]);
  });
});

describe('what returns and refunds hold on to', () => {
  it('keeps a customer, a product and an account that they name', async () => {
    const patenga = await addCustomer('Patenga Pharmacy');
    const vitamin = await addProduct('Vitamin B complex');
    // A draft may name an item with no cost yet: the cost is looked up when it is posted
    await returned(returnForm([returnLine(vitamin, '1')], { customerId: patenga.id, post: false }));
    const customer = await send(
      'DELETE',
      `/customers/${patenga.id}?version=${String(patenga.version)}`,
    );
    expect(problemOf(customer).code).toBe('customer_in_use');
    const product = await send(
      'DELETE',
      `/products/${vitamin.id}?version=${String(vitamin.version)}`,
    );
    expect(problemOf(product).code).toBe('product_in_use');
    // The bKash account a refund paid out of
    const wallet = accountSchema.parse((await send('GET', `/accounts/${account('1131')}`)).json());
    const removed = await send(
      'DELETE',
      `/accounts/${wallet.id}?version=${String(wallet.version)}`,
    );
    expect(problemOf(removed).code).toBe('account_in_use');
  });
});

describe('a return and an invoice of one challan line', () => {
  it('lets the second one see what the first did', async () => {
    const counter = await delivered(agrabad, '', [deliveryLine(syrup, '6')]);
    const line = lineOf(counter.lines, syrup).id;
    // Hold the challan's lock as another posting would. The invoice of all 6 bottles asks first,
    // the return of 2 a moment later: both wait. The invoice then posts, and the return, which
    // waited for it, finds the line billed and points at the invoice line.
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let bill: ReturnType<typeof send> | undefined;
    let back: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      await tx`SELECT id FROM deliveries WHERE id = ${counter.id} FOR UPDATE`;
      bill = send(
        'POST',
        '/invoices',
        invoiceForm([invoiceLine(syrup, '6', '40', { deliveryLineId: line })], {
          customerId: agrabad.id,
          date: '2026-10-08',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      back = send(
        'POST',
        '/sales-returns',
        returnForm([returnLine(syrup, '2', { deliveryLineId: line })], {
          customerId: agrabad.id,
          date: '2026-10-08',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await superuser.end();
    const [billed, came] = await Promise.all([bill, back]);
    if (!billed || !came) throw new Error('the requests were never sent');
    expect(billed.statusCode, billed.body).toBe(201);
    expect(came.statusCode, came.body).toBe(201);
    const invoice = invoiceSchema.parse(billed.json());
    expect(salesReturnSchema.parse(came.json()).lines[0]).toMatchObject({
      billed: true,
      invoiceLineId: invoice.lines[0]?.id,
    });
  });
});

describe('the period lock', () => {
  it('refuses a return, a credit note or a refund on a day the books are closed', async () => {
    const lockedDay = '2026-10-09';
    const draftReturn = await returned(
      returnForm([returnLine(napa, '1', { unitId: unitId('strip'), batchId: napaBatch })], {
        customerId: agrabad.id,
        date: lockedDay,
        post: false,
      }),
    );
    const draftNote = await credited(
      creditForm(
        firstInvoice,
        [creditLine(lineOf(firstInvoice.lines, napa).id, '1', '0.5', { unitId: unitId('strip') })],
        { date: lockedDay, post: false },
      ),
    );
    expect(
      (await send('PUT', '/period-lock', { lockDate: lockedDay, version: 0 })).statusCode,
    ).toBe(200);
    const postReturn = await send('POST', `/sales-returns/${draftReturn.id}/post`, {
      version: draftReturn.version,
    });
    expect(problemOf(postReturn).code).toBe('journal_period_locked');
    expect((await returnNow(draftReturn.id)).status).toBe('draft');
    const postNote = await send('POST', `/credit-notes/${draftNote.id}/post`, {
      version: draftNote.version,
    });
    expect(problemOf(postNote).code).toBe('journal_period_locked');
    expect((await creditNoteNow(draftNote.id)).status).toBe('draft');
    const refund = await send(
      'POST',
      '/refunds',
      refundForm('1', { creditNoteId: racedNote.id, date: lockedDay }),
    );
    expect(problemOf(refund).code).toBe('journal_period_locked');
  });
});
