import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  type AgingReport,
  agingBucketOf,
  agingReportSchema,
  apAgingPartySchema,
  arAgingPartySchema,
  accountListSchema,
  type Bill,
  billSchema,
  type Branch,
  branchListSchema,
  creditNoteSchema,
  type Customer,
  customerGroupSchema,
  customerSchema,
  debitNoteSchema,
  type Invoice,
  invoiceSchema,
  type PermissionKey,
  problemSchema,
  type Product,
  productSchema,
  type Receipt,
  receiptSchema,
  refundSchema,
  roleSchema,
  memberPageSchema,
  settingsSchema,
  setupSchema,
  shiftIsoDate,
  type Supplier,
  supplierGroupSchema,
  type SupplierPayment,
  supplierPaymentSchema,
  supplierRefundSchema,
  supplierSchema,
  type TaxRate,
  taxRateListSchema,
  todayIn,
  unitListSchema,
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
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// Step 21b. Surma Distributors in Sylhet bills pharmacies for delivery and handling (a service, so
// no stock is needed) and pays its suppliers' bills. Every amount is VAT exempt, so a document's
// total is its net. Each customer and supplier shows one thing the aging must get right on any
// day, and every as-of answer is checked against the ledger, which knows nothing of due dates or
// allocations:
// - Agrabad Medicine Corner: eight invoices due on the edge days of the buckets;
// - Tamanna Pharmacy: a receipt with money left over, an advance applied today, a credit note;
// - Halishahar Pharmacy: a receipt voided later (the known gap of decision 5);
// - Sylhet Pharmacy: only an advance, with a refund that was voided;
// - Chawkbazar Store: a credit note on a paid invoice, kept as an advance;
// - Zindabazar Store and Juki Parts Centre: money applied again (the day of each allocation);
// - Padma Yarn Traders: a posted payment, a draft, one waiting for approval, a voided one and a
//   debit note; Meghna Poly Packaging: an advance, a debit note on a paid bill and a refund.
// The documents are dated a number of days before today, so the tests run on any day.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: the allocations' applied_on, which no route shows
let sql: postgres.Sql;
let owner: SignedIn;
// Reads the sales reports only
let shirin: SignedIn;
// Pays suppliers; not the Owner, so a payment over the level waits for approval
let rina: SignedIn;
let today: string;
let accounts: Account[];
let exempt: TaxRate;
let pcs: string;
let branch: Branch;
let handling: Product;
let pharmacies: string;
let yarnMills: string;
let agrabad: Customer;
let tamanna: Customer;
let halishahar: Customer;
let sylhet: Customer;
let chawkbazar: Customer;
let zindabazar: Customer;
// Never billed
let lalbagh: Customer;
let padma: Supplier;
let meghna: Supplier;
let juki: Supplier;
let tamannaInvoice: Invoice;
let zindabazarReceipt: Receipt;
let zindabazarInvoices: Invoice[];
let jukiPayment: SupplierPayment;
let jukiBills: Bill[];
let draftPayment: SupplierPayment;

const day = (days: number) => shiftIsoDate(today, days);

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({ method, url, headers: bearer(as.accessToken), ...(payload && { payload }) });
}

async function created<T>(schema: z.ZodType<T>, url: string, payload: object): Promise<T> {
  const res = await send('POST', url, payload);
  expect(res.statusCode, res.body).toBe(201);
  return schema.parse(res.json());
}

async function changed<T>(
  schema: z.ZodType<T>,
  method: 'POST' | 'PUT',
  url: string,
  payload: object,
) {
  const res = await send(method, url, payload);
  expect(res.statusCode, res.body).toBe(200);
  return schema.parse(res.json());
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

async function receivables(query: string, as = owner): Promise<AgingReport> {
  const res = await send('GET', `/reports/ar-aging?${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return agingReportSchema.parse(res.json());
}

async function payables(query: string, as = owner): Promise<AgingReport> {
  const res = await send('GET', `/reports/ap-aging?${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return agingReportSchema.parse(res.json());
}

async function customerPage(customerId: string, asOf: string) {
  const res = await send('GET', `/reports/ar-aging/${customerId}?asOf=${asOf}`);
  expect(res.statusCode, res.body).toBe(200);
  return arAgingPartySchema.parse(res.json());
}

async function supplierPage(supplierId: string, asOf: string) {
  const res = await send('GET', `/reports/ap-aging/${supplierId}?asOf=${asOf}`);
  expect(res.statusCode, res.body).toBe(200);
  return apAgingPartySchema.parse(res.json());
}

// A row as the test reads it: the name, then current, 1–30, 31–60, 61–90, over 90, advances and
// balance, in whole taka (every amount here is)
function rowOf(row: AgingReport['items'][number]) {
  return [
    row.party.name,
    ...[
      row.current,
      row.days1To30,
      row.days31To60,
      row.days61To90,
      row.over90,
      row.advances,
      row.balance,
    ].map(Number),
  ];
}

function rowNamed(report: AgingReport, name: string) {
  const found = report.items.find((row) => row.party.name === name);
  if (!found) throw new Error(`no row for ${name}`);
  return rowOf(found);
}

function accountId(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function only<T>(items: readonly T[], what: string): T {
  const [first] = items;
  if (first === undefined || items.length !== 1) throw new Error(`not one ${what}`);
  return first;
}

async function addCustomer(name: string, groupId = ''): Promise<Customer> {
  return created(customerSchema, '/customers', {
    code: '',
    name,
    groupId,
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
}

async function addSupplier(name: string, groupId = ''): Promise<Supplier> {
  return created(supplierSchema, '/suppliers', {
    code: '',
    name,
    groupId,
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
}

// An invoice for delivery and handling, dated and due on the days given
async function invoiced(customer: Customer, date: string, dueDate: string, amount: string) {
  const invoice = await created(invoiceSchema, '/invoices', {
    customerId: customer.id,
    date,
    dueDate,
    customerReference: '',
    branchId: branch.id,
    warehouseId: '',
    note: '',
    lines: [
      {
        variantId: variantOf(handling),
        unitId: pcs,
        quantity: '1',
        description: '',
        unitPrice: amount,
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
  expect(invoice.total).toBe(`${amount}.0000`);
  return invoice;
}

async function received(
  customer: Customer,
  date: string,
  amount: string,
  allocations: { invoice: Invoice; amount: string }[],
): Promise<Receipt> {
  return created(receiptSchema, '/receipts', {
    customerId: customer.id,
    date,
    amount,
    accountId: accountId('1110'),
    method: 'cash',
    reference: '',
    branchId: branch.id,
    note: '',
    allocations: allocations.map((item) => ({ invoiceId: item.invoice.id, amount: item.amount })),
  });
}

// A credit note that only cuts the price: one line of the invoice, `amount` off
async function credited(invoice: Invoice, date: string, amount: string) {
  return created(creditNoteSchema, '/credit-notes', {
    invoiceId: invoice.id,
    date,
    reason: 'price_adjustment',
    note: '',
    lines: [
      {
        invoiceLineId: only(invoice.lines, 'invoice line').id,
        returnLineId: '',
        unitId: pcs,
        quantity: '1',
        description: '',
        unitPrice: amount,
        discountType: 'percent',
        discount: '',
      },
    ],
    post: true,
  });
}

// A bill with one expense and no goods, posted when submitted (no bill levels are set)
async function billed(supplier: Supplier, date: string, dueDate: string, amount: string) {
  const bill = await created(billSchema, '/bills', {
    supplierId: supplier.id,
    date,
    dueDate,
    supplierBillNumber: `${supplier.code}-${date}-${amount}`,
    mushakNumber: '',
    mushakDate: '',
    branchId: branch.id,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: [],
    expenses: [
      {
        accountId: accountId('5240'),
        description: 'Carriage and handling',
        amount,
        taxRateId: exempt.id,
      },
    ],
    submit: true,
  });
  expect(bill).toMatchObject({ status: 'posted', total: `${amount}.0000` });
  return bill;
}

function paymentForm(
  supplier: Supplier,
  date: string,
  amount: string,
  allocations: { bill: Bill; amount: string }[],
  submit = true,
) {
  return {
    supplierId: supplier.id,
    date,
    amount,
    accountId: accountId('1110'),
    method: 'cash',
    reference: '',
    supplierBankAccountId: '',
    branchId: branch.id,
    orderId: '',
    note: '',
    allocations: allocations.map((item) => ({ billId: item.bill.id, amount: item.amount })),
    submit,
  };
}

async function paid(
  supplier: Supplier,
  date: string,
  amount: string,
  allocations: { bill: Bill; amount: string }[],
  submit = true,
): Promise<SupplierPayment> {
  return created(
    supplierPaymentSchema,
    '/supplier-payments',
    paymentForm(supplier, date, amount, allocations, submit),
  );
}

// A debit note that takes money off the bill's one expense
async function debited(bill: Bill, date: string, amount: string) {
  return created(debitNoteSchema, '/debit-notes', {
    supplierId: bill.supplier.id,
    billId: bill.id,
    date,
    branchId: '',
    pricesIncludeVat: false,
    reason: 'price_adjustment',
    supplierCreditNumber: '',
    supplierCreditDate: '',
    note: '',
    lines: [],
    expenses: [{ billExpenseId: only(bill.expenses, 'expense').id, amount }],
    post: true,
  });
}

function voidForm(version: number, date: string) {
  return { version, date, reason: 'The cheque bounced' };
}

// The four allocation tables: the paying document's column, and the documents it pays
const ALLOCATIONS = {
  receipt: { table: 'receipt_allocations', from: 'receipt_id', to: 'invoice_id', paid: 'invoices' },
  credit_note: {
    table: 'credit_note_allocations',
    from: 'credit_note_id',
    to: 'invoice_id',
    paid: 'invoices',
  },
  payment: {
    table: 'supplier_payment_allocations',
    from: 'payment_id',
    to: 'bill_id',
    paid: 'bills',
  },
  debit_note: {
    table: 'debit_note_allocations',
    from: 'debit_note_id',
    to: 'bill_id',
    paid: 'bills',
  },
} as const;

// The day each allocation of a paying document counts, as [invoice or bill number, amount, day]
async function appliedOn(
  kind: keyof typeof ALLOCATIONS,
  id: string,
): Promise<[string, string, string][]> {
  const of = ALLOCATIONS[kind];
  const rows = await sql<{ number: string; amount: string; applied_on: string }[]>`
    SELECT d.number, round(a.amount)::text AS amount, a.applied_on::text AS applied_on
      FROM ${sql(of.table)} a
      JOIN ${sql(of.paid)} d ON d.id = a.${sql(of.to)}
     WHERE a.${sql(of.from)} = ${id}
     ORDER BY d.number`;
  return rows.map((row) => [row.number, row.amount, row.applied_on]);
}

// A member of the workspace with one role of exactly these permissions
async function memberWith(
  person: { fullName: string; email: string; password: string },
  permissions: PermissionKey[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${person.fullName} Store`,
    workspaceSlug: `${person.email.split('@')[0] ?? 'member'}-store`,
    ...person,
  });
  await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'surma-distributors' });
  const role = await created(roleSchema, '/roles', {
    name: `${person.fullName}'s role`,
    description: '',
  });
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const found = items.find((item) => item.email === person.email);
  if (!found) throw new Error(`${person.email} is not a member`);
  const roles = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(roles.statusCode, roles.body).toBe(200);
  return logIn(app, {
    workspace: 'surma-distributors',
    email: person.email,
    password: person.password,
    keepSignedIn: false,
  });
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
  sql = postgres(pg.superuserUrl, { max: 2 });
  owner = await signUp(app, {
    companyName: 'Surma Distributors',
    workspaceSlug: 'surma-distributors',
    fullName: 'Nasrin Chowdhury',
    email: 'nasrin@surmadistributors.com',
    password: 'Zindabazar-depot-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  today = todayIn(settingsSchema.parse((await send('GET', '/settings')).json()).timezone);
  const [first] = branchListSchema.parse((await send('GET', '/branches')).json()).items;
  if (!first) throw new Error('sign-up made no branch');
  branch = first;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const rate = taxRateListSchema
    .parse((await send('GET', '/tax-rates')).json())
    .items.find((item) => item.name === 'Exempt');
  if (!rate) throw new Error('no Exempt rate');
  exempt = rate;
  pcs =
    unitListSchema.parse((await send('GET', '/units')).json()).items.find((u) => u.code === 'pcs')
      ?.id ?? '';
  handling = await created(productSchema, '/products', {
    code: '',
    name: 'Delivery and handling',
    type: 'service',
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
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
  });
  pharmacies = (await created(customerGroupSchema, '/customer-groups', { name: 'Pharmacies' })).id;
  yarnMills = (await created(supplierGroupSchema, '/supplier-groups', { name: 'Yarn mills' })).id;
  agrabad = await addCustomer('Agrabad Medicine Corner');
  tamanna = await addCustomer('Tamanna Pharmacy', pharmacies);
  halishahar = await addCustomer('Halishahar Pharmacy', pharmacies);
  sylhet = await addCustomer('Sylhet Pharmacy', pharmacies);
  chawkbazar = await addCustomer('Chawkbazar Store');
  zindabazar = await addCustomer('Zindabazar Store');
  lalbagh = await addCustomer('Lalbagh Store');
  padma = await addSupplier('Padma Yarn Traders', yarnMills);
  meghna = await addSupplier('Meghna Poly Packaging');
  juki = await addSupplier('Juki Parts Centre');

  shirin = await memberWith(
    {
      fullName: 'Shirin Akter',
      email: 'shirin@surmadistributors.com',
      password: 'Sales-desk-2026',
    },
    ['sales.report.read'],
  );
  rina = await memberWith(
    { fullName: 'Rina Begum', email: 'rina@surmadistributors.com', password: 'Payments-desk-2026' },
    ['purchase.payment.manage'],
  );
}, 240_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('The documents', () => {
  // Dozens of documents go through the API here, so the 5 seconds of a normal test are not enough
  // when the whole suite runs at once.
  it('are posted over the last three months', async () => {
    // Agrabad: ৳100 due today, ৳200 a day ago, ৳300 30 days ago … ৳800 91 days ago
    for (const [index, days] of [0, 1, 30, 31, 60, 61, 90, 91].entries()) {
      await invoiced(agrabad, day(-days), day(-days), String((index + 1) * 100));
    }

    // Tamanna: ৳10,000, due 10 days ago. ৳5,000 came 20 days ago, ৳4,000 of it for the invoice;
    // ৳3,000 more 15 days ago with no invoice named; ৳500 off by a credit note 8 days ago; and
    // today the ৳3,000 is applied to the invoice
    tamannaInvoice = await invoiced(tamanna, day(-40), day(-10), '10000');
    await received(tamanna, day(-20), '5000', [{ invoice: tamannaInvoice, amount: '4000' }]);
    const advance = await received(tamanna, day(-15), '3000', []);
    await credited(tamannaInvoice, day(-8), '500');
    await changed(receiptSchema, 'PUT', `/receipts/${advance.id}/allocations`, {
      version: advance.version,
      allocations: [{ invoiceId: tamannaInvoice.id, amount: '3000' }],
    });

    // Halishahar: ৳2,000, paid 20 days ago by a cheque that bounced 5 days ago
    const halishaharInvoice = await invoiced(halishahar, day(-30), day(-30), '2000');
    const cheque = await received(halishahar, day(-20), '2000', [
      { invoice: halishaharInvoice, amount: '2000' },
    ]);
    await changed(
      receiptSchema,
      'POST',
      `/receipts/${cheque.id}/void`,
      voidForm(cheque.version, day(-5)),
    );

    // Sylhet: ৳5,000 in advance 20 days ago; ৳1,000 of it paid back 15 days ago, but that refund
    // was voided 5 days ago
    const sylhetAdvance = await received(sylhet, day(-20), '5000', []);
    const refund = await created(refundSchema, '/refunds', {
      customerId: sylhet.id,
      date: day(-15),
      amount: '1000',
      accountId: accountId('1110'),
      method: 'cash',
      reference: '',
      branchId: branch.id,
      note: '',
      receiptId: sylhetAdvance.id,
      creditNoteId: '',
    });
    await changed(
      refundSchema,
      'POST',
      `/refunds/${refund.id}/void`,
      voidForm(refund.version, day(-5)),
    );

    // Chawkbazar: ৳1,150 paid in full the next day, then ৳150 off: the credit note has nothing
    // left to take off, so it is money the shop owes Chawkbazar
    const chawkbazarInvoice = await invoiced(chawkbazar, day(-12), day(-12), '1150');
    await received(chawkbazar, day(-11), '1150', [{ invoice: chawkbazarInvoice, amount: '1150' }]);
    await credited(chawkbazarInvoice, day(-6), '150');

    // Zindabazar: two invoices of ৳1,000, a receipt of ৳1,500 dated before the second one
    zindabazarInvoices = [
      await invoiced(zindabazar, day(-30), day(-30), '1000'),
      await invoiced(zindabazar, day(-28), day(-28), '1000'),
    ];
    zindabazarReceipt = await received(zindabazar, day(-29), '1500', [
      { invoice: zindabazarInvoices[0] ?? tamannaInvoice, amount: '1000' },
      { invoice: zindabazarInvoices[1] ?? tamannaInvoice, amount: '500' },
    ]);

    // Padma: ৳20,000 due 10 days ago and ৳5,000 due in 10 days. Posted: ৳8,000 15 days ago and
    // ৳2,000 25 days ago (voided 2 days ago); ৳1,000 off by a debit note 5 days ago. Not in the
    // books: a draft of ৳5,000 and a payment of ৳60,000 waiting for the finance manager.
    const yarn = await billed(padma, day(-40), day(-10), '20000');
    const lateYarn = await billed(padma, day(-20), day(10), '5000');
    await paid(padma, day(-15), '8000', [{ bill: yarn, amount: '8000' }]);
    const bounced = await paid(padma, day(-25), '2000', [{ bill: yarn, amount: '2000' }]);
    await debited(yarn, day(-5), '1000');
    await changed(
      supplierPaymentSchema,
      'POST',
      `/supplier-payments/${bounced.id}/void`,
      voidForm(bounced.version, day(-2)),
    );
    draftPayment = await paid(padma, day(-9), '5000', [{ bill: lateYarn, amount: '5000' }], false);
    expect(draftPayment.status).toBe('draft');
    const financeManager = await created(roleSchema, '/roles', {
      name: 'Finance manager',
      description: '',
    });
    const rule = await send('PUT', '/approval-rules/supplier_payment', {
      levels: [{ minAmount: '50000', roleId: financeManager.id }],
      version: 0,
    });
    expect(rule.statusCode, rule.body).toBe(200);
    // An Owner's own payment is approved at once (step 17c): the clerk writes this one
    const asked = await send(
      'POST',
      '/supplier-payments',
      paymentForm(padma, day(-3), '60000', [{ bill: yarn, amount: '5000' }]),
      rina,
    );
    expect(asked.statusCode, asked.body).toBe(201);
    expect(supplierPaymentSchema.parse(asked.json()).status).toBe('pending');

    // Meghna: ৳1,000 billed 14 days ago, paid with ৳3,000 12 days ago; ৳200 off after it was paid;
    // ৳500 of the advance paid back 3 days ago
    const poly = await billed(meghna, day(-14), day(-14), '1000');
    const polyPayment = await paid(meghna, day(-12), '3000', [{ bill: poly, amount: '1000' }]);
    await debited(poly, day(-6), '200');
    await created(supplierRefundSchema, '/supplier-refunds', {
      supplierId: meghna.id,
      date: day(-3),
      amount: '500',
      accountId: accountId('1110'),
      method: 'cash',
      reference: '',
      branchId: branch.id,
      note: '',
      debitNoteId: '',
      paymentId: polyPayment.id,
    });

    // Juki: two bills of ৳1,000 and a payment of ৳1,500, as Zindabazar's
    jukiBills = [
      await billed(juki, day(-10), day(-10), '1000'),
      await billed(juki, day(-9), day(-9), '1000'),
    ];
    jukiPayment = await paid(juki, day(-11), '1500', [
      { bill: jukiBills[0] ?? yarn, amount: '1000' },
      { bill: jukiBills[1] ?? yarn, amount: '500' },
    ]);
  }, 120_000);
});

describe('The day an allocation counts', () => {
  it("is the receipt's date, or the invoice's when that is later", async () => {
    // The receipt is dated 29 days ago, the second invoice 28: it was paid when it was billed
    expect(await appliedOn('receipt', zindabazarReceipt.id)).toEqual([
      [zindabazarInvoices[0]?.number, '1000', day(-29)],
      [zindabazarInvoices[1]?.number, '500', day(-28)],
    ]);
    const [credit] = await sql<{ id: string }[]>`
      SELECT id FROM credit_notes WHERE invoice_id = ${tamannaInvoice.id}`;
    expect(await appliedOn('credit_note', credit?.id ?? '')).toEqual([
      [tamannaInvoice.number, '500', day(-8)],
    ]);
  });

  it('is today when the money is applied again, and stays for a pair that did not change', async () => {
    // ৳100 of the second invoice goes back to the advance: the first pair keeps its day
    zindabazarReceipt = await changed(
      receiptSchema,
      'PUT',
      `/receipts/${zindabazarReceipt.id}/allocations`,
      {
        version: zindabazarReceipt.version,
        allocations: [
          { invoiceId: zindabazarInvoices[0]?.id ?? '', amount: '1000.00' },
          { invoiceId: zindabazarInvoices[1]?.id ?? '', amount: '400' },
        ],
      },
    );
    expect(await appliedOn('receipt', zindabazarReceipt.id)).toEqual([
      [zindabazarInvoices[0]?.number, '1000', day(-29)],
      [zindabazarInvoices[1]?.number, '400', today],
    ]);

    // The same for a posted supplier payment
    expect(await appliedOn('payment', jukiPayment.id)).toEqual([
      [jukiBills[0]?.number, '1000', day(-10)],
      [jukiBills[1]?.number, '500', day(-9)],
    ]);
    jukiPayment = await changed(
      supplierPaymentSchema,
      'PUT',
      `/supplier-payments/${jukiPayment.id}/allocations`,
      {
        version: jukiPayment.version,
        allocations: [
          { billId: jukiBills[0]?.id ?? '', amount: '1000' },
          { billId: jukiBills[1]?.id ?? '', amount: '400' },
        ],
      },
    );
    expect(await appliedOn('payment', jukiPayment.id)).toEqual([
      [jukiBills[0]?.number, '1000', day(-10)],
      [jukiBills[1]?.number, '400', today],
    ]);
  });

  it("follows a draft payment's date, which posts with it", async () => {
    const yarn = only(draftPayment.allocations, 'allocation');
    expect(await appliedOn('payment', draftPayment.id)).toEqual([
      [yarn.billNumber, '5000', day(-9)],
    ]);
    const form = paymentForm(padma, day(-7), '5000', [], false);
    draftPayment = await changed(
      supplierPaymentSchema,
      'PUT',
      `/supplier-payments/${draftPayment.id}`,
      {
        ...form,
        allocations: [{ billId: yarn.billId, amount: '5000' }],
        version: draftPayment.version,
      },
    );
    expect(await appliedOn('payment', draftPayment.id)).toEqual([
      [yarn.billNumber, '5000', day(-7)],
    ]);
  });
});

describe('The receivables aging', () => {
  it('puts each invoice in its bucket by the days past its due date', async () => {
    const report = await receivables(`asOf=${today}`);
    // Current up to and on the due date; 30 days late is still 1–30, 31 is 31–60, and so on
    expect(rowNamed(report, 'Agrabad Medicine Corner')).toEqual([
      'Agrabad Medicine Corner',
      100,
      500,
      900,
      1300,
      800,
      0,
      3600,
    ]);
    // A day earlier, every invoice is a day less late, and the one of today is not there yet
    const yesterday = await receivables(`asOf=${day(-1)}`);
    expect(rowNamed(yesterday, 'Agrabad Medicine Corner')).toEqual([
      'Agrabad Medicine Corner',
      200,
      700,
      1100,
      1500,
      0,
      0,
      3500,
    ]);
    // The party's page puts each invoice in the bucket of the contract's agingBucketOf(), and its
    // totals are the report's row worked out in SQL: the two agree on every edge day, a month
    // ahead too
    for (const asOf of [today, day(-1), day(30)]) {
      const page = await customerPage(agrabad.id, asOf);
      const row = (await receivables(`asOf=${asOf}`)).items.find(
        (item) => item.party.id === agrabad.id,
      );
      expect(page.totals).toEqual({ ...row, party: undefined, ...page.totals });
      expect(row).toMatchObject(page.totals);
      for (const document of page.documents) {
        expect(document.bucket).toBe(agingBucketOf(document.dueDate, asOf));
      }
    }
    const page = await customerPage(agrabad.id, today);
    expect(page.documents.map((item) => [item.dueDate, item.daysOverdue, item.bucket])).toEqual([
      [day(-91), 91, 'over90'],
      [day(-90), 90, 'days61To90'],
      [day(-61), 61, 'days61To90'],
      [day(-60), 60, 'days31To60'],
      [day(-31), 31, 'days31To60'],
      [day(-30), 30, 'days1To30'],
      [day(-1), 1, 'days1To30'],
      [today, 0, 'current'],
    ]);
  });

  it('takes off on a past day only what was applied by then', async () => {
    const tamannaOn = async (asOf: string) =>
      rowNamed(await receivables(`asOf=${asOf}`), 'Tamanna Pharmacy');
    // Before any money: the whole invoice, not due yet
    expect(await tamannaOn(day(-21))).toEqual(['Tamanna Pharmacy', 10000, 0, 0, 0, 0, 0, 10000]);
    // ৳4,000 applied, ৳1,000 and ৳3,000 held as advances
    expect(await tamannaOn(day(-9))).toEqual(['Tamanna Pharmacy', 0, 6000, 0, 0, 0, 4000, 2000]);
    // The credit note's ৳500 counts from its own day
    expect(await tamannaOn(day(-1))).toEqual(['Tamanna Pharmacy', 0, 5500, 0, 0, 0, 4000, 1500]);
    // Today the ৳3,000 is on the invoice: the balance stays, the buckets move
    expect(await tamannaOn(today)).toEqual(['Tamanna Pharmacy', 0, 2500, 0, 0, 0, 1000, 1500]);
    const page = await customerPage(tamanna.id, day(-1));
    expect(page.advances.map((item) => [item.kind, item.date, item.amount])).toEqual([
      ['receipt', day(-20), '1000.0000'],
      ['receipt', day(-15), '3000.0000'],
    ]);
    expect(page.documents.map((item) => [item.number, item.total, item.open])).toEqual([
      [tamannaInvoice.number, '10000.0000', '5500.0000'],
    ]);
    expect(page.ledger).toBe('1500.0000');
  });

  it('shows a voided receipt as an advance until its void day, so the balance is the books', async () => {
    const halishaharOn = async (asOf: string) =>
      rowNamed(await receivables(`asOf=${asOf}`), 'Halishahar Pharmacy');
    expect(await halishaharOn(day(-25))).toEqual([
      'Halishahar Pharmacy',
      0,
      2000,
      0,
      0,
      0,
      0,
      2000,
    ]);
    // The void deleted the allocation: the invoice shows open, the cheque as an advance
    expect(await halishaharOn(day(-10))).toEqual([
      'Halishahar Pharmacy',
      0,
      2000,
      0,
      0,
      0,
      2000,
      0,
    ]);
    expect((await customerPage(halishahar.id, day(-10))).ledger).toBe('0.0000');
    expect(await halishaharOn(today)).toEqual(['Halishahar Pharmacy', 0, 2000, 0, 0, 0, 0, 2000]);
  });

  it('counts a refund until it is voided, and an advance alone is a row', async () => {
    const sylhetOn = async (asOf: string) =>
      rowNamed(await receivables(`asOf=${asOf}`), 'Sylhet Pharmacy');
    expect(await sylhetOn(day(-17))).toEqual(['Sylhet Pharmacy', 0, 0, 0, 0, 0, 5000, -5000]);
    expect(await sylhetOn(day(-10))).toEqual(['Sylhet Pharmacy', 0, 0, 0, 0, 0, 4000, -4000]);
    expect(await sylhetOn(today)).toEqual(['Sylhet Pharmacy', 0, 0, 0, 0, 0, 5000, -5000]);

    // A paid invoice is no row; the credit note after it is an advance of its own kind
    const before = await receivables(`asOf=${day(-7)}`);
    expect(before.items.map((row) => row.party.name)).not.toContain('Chawkbazar Store');
    const page = await customerPage(chawkbazar.id, today);
    expect(page.documents).toEqual([]);
    expect(page.advances.map((item) => [item.kind, item.amount])).toEqual([
      ['credit_note', '150.0000'],
    ]);
    expect(page.totals).toMatchObject({
      due: '0.0000',
      advances: '150.0000',
      balance: '-150.0000',
    });

    // The customer with nothing has no row, but its page is there, empty
    const report = await receivables(`asOf=${today}`);
    expect(report.items.map((row) => row.party.id)).not.toContain(lalbagh.id);
    expect((await customerPage(lalbagh.id, today)).totals.balance).toBe('0.0000');
  });

  it('adds up to the ledger on every day, and sorts by the balance', async () => {
    const report = await receivables(`asOf=${today}`);
    expect(report.items.map(rowOf)).toEqual([
      ['Agrabad Medicine Corner', 100, 500, 900, 1300, 800, 0, 3600],
      ['Halishahar Pharmacy', 0, 2000, 0, 0, 0, 0, 2000],
      ['Tamanna Pharmacy', 0, 2500, 0, 0, 0, 1000, 1500],
      // ৳600 of the second invoice open, ৳100 left of the receipt
      ['Zindabazar Store', 0, 600, 0, 0, 0, 100, 500],
      ['Chawkbazar Store', 0, 0, 0, 0, 0, 150, -150],
      ['Sylhet Pharmacy', 0, 0, 0, 0, 0, 5000, -5000],
    ]);
    expect(report.totals).toEqual({
      current: '100.0000',
      days1To30: '5600.0000',
      days31To60: '900.0000',
      days61To90: '1300.0000',
      over90: '800.0000',
      due: '8700.0000',
      advances: '6250.0000',
      balance: '2450.0000',
    });
    expect(report.asOf).toBe(today);
    expect(report.ledger).toBe('2450.0000');
    // Every day of the story, and a year back with nothing yet
    for (const asOf of [
      day(-400),
      day(-91),
      day(-29),
      day(-20),
      day(-12),
      day(-6),
      day(-1),
      day(30),
    ]) {
      const past = await receivables(`asOf=${asOf}`);
      expect(past.ledger, asOf).toBe(past.totals.balance);
      for (const row of past.items) {
        const page = await customerPage(row.party.id, asOf);
        expect(page.ledger, `${row.party.name} on ${asOf}`).toBe(row.balance);
      }
    }
    expect((await receivables(`asOf=${day(-400)}`)).items).toEqual([]);
  });

  it('pages, filters by group and shows only the overdue', async () => {
    const all = await receivables(`asOf=${today}&sort=name`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: AgingReport = await receivables(
        `asOf=${today}&sort=name&limit=4${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      expect(page.totals).toEqual(all.totals);
      expect(page.ledger).toBe(all.ledger);
      seen.push(...page.items.map((row) => row.party.name));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([
      'Agrabad Medicine Corner',
      'Chawkbazar Store',
      'Halishahar Pharmacy',
      'Sylhet Pharmacy',
      'Tamanna Pharmacy',
      'Zindabazar Store',
    ]);

    const group = await receivables(`asOf=${today}&customerGroupId=${pharmacies}&sort=-advances`);
    expect(group.items.map((row) => row.party.name)).toEqual([
      'Sylhet Pharmacy',
      'Tamanna Pharmacy',
      'Halishahar Pharmacy',
    ]);
    expect(group.totals.balance).toBe('-1500.0000');
    // The ledger of the group's customers only
    expect(group.ledger).toBe('-1500.0000');

    // Past their due date: the advances alone are not overdue. The whole row still shows.
    const overdue = await receivables(`asOf=${today}&show=overdue&sort=-over90`);
    expect(overdue.items.map(rowOf)).toEqual([
      ['Agrabad Medicine Corner', 100, 500, 900, 1300, 800, 0, 3600],
      ['Halishahar Pharmacy', 0, 2000, 0, 0, 0, 0, 2000],
      ['Tamanna Pharmacy', 0, 2500, 0, 0, 0, 1000, 1500],
      ['Zindabazar Store', 0, 600, 0, 0, 0, 100, 500],
    ]);
    // The books know no due dates
    expect(overdue.ledger).toBeNull();
  });

  it('finds only a customer of the workspace, and needs the sales report permission', async () => {
    expect((await send('GET', `/reports/ar-aging/${padma.id}?asOf=${today}`)).statusCode).toBe(404);
    expect((await send('GET', `/reports/ar-aging/${randomUUID()}?asOf=${today}`)).statusCode).toBe(
      404,
    );
    expect((await send('GET', `/reports/ar-aging/${agrabad.id}`)).statusCode).toBe(400);
    const mine = await receivables(`asOf=${today}`, shirin);
    expect(mine.totals.balance).toBe('2450.0000');
    const refused = await send('GET', `/reports/ap-aging?asOf=${today}`, undefined, shirin);
    expect(refused.statusCode).toBe(403);
    expect(problemOf(refused).code).toBe('permission_missing');
  });
});

describe('The payables aging', () => {
  it('counts only posted payments, and takes off on a past day what was paid by then', async () => {
    const report = await payables(`asOf=${today}`);
    // The draft and the waiting payment are not in the books: they pay nothing and hold nothing
    expect(report.items.map(rowOf)).toEqual([
      ['Padma Yarn Traders', 5000, 11000, 0, 0, 0, 0, 16000],
      ['Juki Parts Centre', 0, 600, 0, 0, 0, 100, 500],
      // ৳2,000 of the payment less the ৳500 refund, and the ৳200 debit note
      ['Meghna Poly Packaging', 0, 0, 0, 0, 0, 1700, -1700],
    ]);
    expect(report.totals).toMatchObject({
      due: '16600.0000',
      advances: '1800.0000',
      balance: '14800.0000',
    });
    expect(report.ledger).toBe('14800.0000');

    // 16 days ago: before the ৳8,000 and the debit note; the voided ৳2,000 was still paid then
    // (it shows as an advance, its allocation deleted with the void)
    const before = await payables(`asOf=${day(-16)}`);
    expect(rowNamed(before, 'Padma Yarn Traders')).toEqual([
      'Padma Yarn Traders',
      25000,
      0,
      0,
      0,
      0,
      2000,
      23000,
    ]);
    // 4 days ago: the debit note is on the bill, the refund is not paid yet
    const recent = await payables(`asOf=${day(-4)}`);
    expect(rowNamed(recent, 'Padma Yarn Traders')).toEqual([
      'Padma Yarn Traders',
      5000,
      11000,
      0,
      0,
      0,
      2000,
      14000,
    ]);
    expect(rowNamed(recent, 'Meghna Poly Packaging')).toEqual([
      'Meghna Poly Packaging',
      0,
      0,
      0,
      0,
      0,
      2200,
      -2200,
    ]);
    for (const asOf of [day(-41), day(-25), day(-16), day(-6), day(-4), day(-2), today, day(30)]) {
      const past = await payables(`asOf=${asOf}`);
      expect(past.ledger, asOf).toBe(past.totals.balance);
    }
  });

  it("lists a supplier's open bills with their numbers, and its advances by kind", async () => {
    const page = await supplierPage(padma.id, today);
    expect(page.documents.map((item) => [item.supplierBillNumber, item.open, item.bucket])).toEqual(
      [
        [`${padma.code}-${day(-40)}-20000`, '11000.0000', 'days1To30'],
        [`${padma.code}-${day(-20)}-5000`, '5000.0000', 'current'],
      ],
    );
    expect(page.ledger).toBe('16000.0000');
    const meghnaPage = await supplierPage(meghna.id, today);
    expect(meghnaPage.advances.map((item) => [item.kind, item.amount])).toEqual([
      ['payment', '1500.0000'],
      ['debit_note', '200.0000'],
    ]);
    expect(meghnaPage.ledger).toBe('-1700.0000');
    expect((await send('GET', `/reports/ap-aging/${agrabad.id}?asOf=${today}`)).statusCode).toBe(
      404,
    );
  });

  it('filters by supplier group and shows only the overdue', async () => {
    const group = await payables(`asOf=${today}&supplierGroupId=${yarnMills}`);
    expect(group.items.map((row) => row.party.name)).toEqual(['Padma Yarn Traders']);
    expect(group.ledger).toBe('16000.0000');
    const overdue = await payables(`asOf=${today}&show=overdue`);
    expect(overdue.items.map((row) => row.party.name)).toEqual([
      'Padma Yarn Traders',
      'Juki Parts Centre',
    ]);
    expect(overdue.ledger).toBeNull();
  });
});
