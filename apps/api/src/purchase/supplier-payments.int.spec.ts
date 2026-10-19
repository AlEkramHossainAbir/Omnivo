import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  auditPageSchema,
  type Bill,
  type BillFormValues,
  billPageSchema,
  billSchema,
  journalEntrySchema,
  journalPageSchema,
  memberPageSchema,
  type PermissionKey,
  type Product,
  productSchema,
  problemSchema,
  type PurchaseOrder,
  purchaseOrderSchema,
  type Role,
  roleSchema,
  setupSchema,
  type Supplier,
  type SupplierPayment,
  type SupplierPaymentFormValues,
  supplierPaymentPageSchema,
  supplierPaymentSchema,
  supplierSchema,
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

// Step 17c: a denim factory pays its yarn supplier. Three bills are open, the oldest overdue; a
// cheque pays the oldest first, an advance is paid against an order before its bill comes, a cheque
// bounces. Payments from ৳50,000 need the finance manager. Each test builds on the ones before it:
// read the first failure first.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// Farhana, the Owner: books the bills (approved and posted the moment she submits them)
let owner: SignedIn;
// Rina, the cashier: writes the payments (purchase.payment.manage)
let rina: SignedIn;
// Kamal, the finance manager: the one level of the payments' approval
let kamal: SignedIn;
// Mitu, a merchandiser: writes orders, never pays
let mitu: SignedIn;
let financeManager: Role;
let units: Unit[];
let rates: TaxRate[];
let accounts: Account[];
let main: Warehouse;
// The yarn supplier, with a bank account a payment can name
let yarn: Supplier;
let trims: Supplier;
let dyeing: Product;
// An approved order for the yarn dyeing: the advance is paid against it
let orderY: PurchaseOrder;
// The yarn supplier's bills: due 15 Oct (overdue), 4 Nov and 9 Nov
let billA: Bill;
let billB: Bill;
let billC: Bill;
// The trims supplier's bill: never on a payment to the yarn supplier
let billK: Bill;
// The cheque that pays A and part of B, and bounces
let cheque: SupplierPayment;
// A transfer for bill A, written while A still owed everything and submitted after the cheque
let late: SupplierPayment;
// The advance against order Y
let advance: SupplierPayment;

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

function accountId(code: string): string {
  const found = accounts.find((item) => item.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function codeOf(id: string): string {
  const found = accounts.find((item) => item.id === id);
  if (!found) throw new Error(`no account ${id}`);
  return found.code;
}

function bankAccountOf(supplier: Supplier): string {
  const [account] = supplier.bankAccounts;
  if (!account) throw new Error(`${supplier.name} has no bank account`);
  return account.id;
}

const yarnBank = {
  id: null,
  bankName: 'Dutch-Bangla Bank',
  branchName: 'Narayanganj',
  accountName: 'Padma Yarn Traders',
  accountNumber: '1051100045672',
  routingNumber: '090670000',
};

function supplierForm(name: string, bankAccounts: object[]) {
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
    address: '',
    bankAccounts,
    notes: '',
  };
}

async function addSupplier(name: string, bankAccounts: object[] = []): Promise<Supplier> {
  const res = await send('POST', '/suppliers', supplierForm(name, bankAccounts));
  expect(res.statusCode, res.body).toBe(201);
  return supplierSchema.parse(res.json());
}

async function addRole(name: string, permissions: PermissionKey[]): Promise<Role> {
  const made = await send('POST', '/roles', { name, description: '' });
  expect(made.statusCode, made.body).toBe(201);
  const role = roleSchema.parse(made.json());
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  return role;
}

async function member(
  email: string,
  fullName: string,
  password: string,
  role: Role,
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Trading`,
    workspaceSlug: email.split('@')[0] ?? 'trading',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'jamuna-denim' });
  const { items } = memberPageSchema.parse((await send('GET', '/members?limit=50')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'jamuna-denim', email, password, keepSignedIn: false });
}

// A bill of one expense, booked by the Owner, posted at once
async function postedBill(
  supplier: Supplier,
  supplierBillNumber: string,
  date: string,
  dueDate: string,
  amount: string,
  extra: Partial<BillFormValues> = {},
): Promise<Bill> {
  const res = await send('POST', '/bills', {
    supplierId: supplier.id,
    date,
    dueDate,
    supplierBillNumber,
    mushakNumber: '',
    mushakDate: '',
    branchId: main.branchId,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: [],
    expenses: [
      {
        accountId: accountId('5140'),
        description: 'Yarn dyeing, indigo',
        amount,
        taxRateId: rateId('VAT 15%'),
      },
    ],
    submit: true,
    ...extra,
  } satisfies Omit<BillFormValues, 'version'>);
  expect(res.statusCode, res.body).toBe(201);
  const bill = billSchema.parse(res.json());
  expect(bill.status).toBe('posted');
  return bill;
}

async function billNow(id: string): Promise<Bill> {
  const res = await send('GET', `/bills/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return billSchema.parse(res.json());
}

// What a bill has been paid, and what it still owes
async function paidOf(bill: Bill) {
  const now = await billNow(bill.id);
  return [now.amountPaid, now.payments.map((item) => [item.paymentNumber, item.amount])];
}

async function openBills(supplier: Supplier, filter: 'open' | 'overdue' | 'paid' = 'open') {
  const page = billPageSchema.parse(
    (await send('GET', `/bills?payment=${filter}&supplierId=${supplier.id}`)).json(),
  );
  return page.items.map((item) => item.supplierBillNumber);
}

function paymentForm(
  amount: string,
  allocations: { bill: Bill; amount: string }[],
  extra: Partial<SupplierPaymentFormValues> = {},
): Omit<SupplierPaymentFormValues, 'version'> {
  return {
    supplierId: yarn.id,
    date: '2026-10-16',
    amount,
    accountId: accountId('1121'),
    method: 'cheque',
    reference: 'DBBL CHQ 004512',
    supplierBankAccountId: '',
    branchId: main.branchId,
    orderId: '',
    note: '',
    allocations: allocations.map((item) => ({ billId: item.bill.id, amount: item.amount })),
    submit: false,
    ...extra,
  };
}

async function paid(body: object, as = rina): Promise<SupplierPayment> {
  const res = await send('POST', '/supplier-payments', body, as);
  expect(res.statusCode, res.body).toBe(201);
  return supplierPaymentSchema.parse(res.json());
}

async function paymentNow(id: string): Promise<SupplierPayment> {
  const res = await send('GET', `/supplier-payments/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return supplierPaymentSchema.parse(res.json());
}

function act(action: 'submit' | 'reopen' | 'cancel', payment: SupplierPayment, as = rina) {
  return send(
    'POST',
    `/supplier-payments/${payment.id}/${action}`,
    { version: payment.version },
    as,
  );
}

async function acted(action: 'submit' | 'reopen' | 'cancel', payment: SupplierPayment) {
  const res = await act(action, payment);
  expect(res.statusCode, res.body).toBe(200);
  return supplierPaymentSchema.parse(res.json());
}

function allocate(payment: SupplierPayment, allocations: { bill: Bill; amount: string }[]) {
  return send(
    'PUT',
    `/supplier-payments/${payment.id}/allocations`,
    {
      version: payment.version,
      allocations: allocations.map((item) => ({ billId: item.bill.id, amount: item.amount })),
    },
    rina,
  );
}

async function entryLines(id: string | undefined) {
  const entry = journalEntrySchema.parse(
    (await send('GET', `/journal-entries/${id ?? 'none'}`)).json(),
  );
  return entry.lines.map((item) => [
    codeOf(item.accountId),
    item.debit,
    item.credit,
    item.party?.name ?? null,
  ]);
}

async function entryCount(): Promise<number> {
  const page = journalPageSchema.parse((await send('GET', '/journal-entries?limit=100')).json());
  return page.items.length;
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
    companyName: 'Jamuna Denim Mills Ltd.',
    workspaceSlug: 'jamuna-denim',
    fullName: 'Farhana Haque',
    email: 'farhana@jamunadenim.com',
    password: 'Jamuna-denim-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const bank = await send('POST', '/accounts', {
    parentId: accountId('1120'),
    code: '1121',
    name: 'Dutch-Bangla Bank CD A/C 7781',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  expect(bank.statusCode, bank.body).toBe(201);
  accounts = [...accounts, accountSchema.parse(bank.json())];
  const [firstWarehouse] = warehouseListSchema.parse(
    (await send('GET', '/warehouses')).json(),
  ).items;
  if (!firstWarehouse) throw new Error('sign-up made no warehouse');
  main = firstWarehouse;

  financeManager = await addRole('Finance manager', ['purchase.payment.manage']);
  rina = await member(
    'rina@jamunadenim.com',
    'Rina Begum',
    'Cash-counter-2026',
    await addRole('Payments desk', ['purchase.payment.manage']),
  );
  kamal = await member(
    'kamal@jamunadenim.com',
    'Kamal Hossain',
    'Finance-desk-2026',
    financeManager,
  );
  mitu = await member(
    'mitu@jamunadenim.com',
    'Mitu Akter',
    'Buyer-orders-2026',
    await addRole('Buying desk', ['purchase.order.manage']),
  );

  yarn = await addSupplier('Padma Yarn Traders', [yarnBank]);
  trims = await addSupplier('Karim Trims & Accessories', [
    { ...yarnBank, accountName: 'Karim Trims', accountNumber: '2205500011223' },
  ]);
  const made = await send('POST', '/products', {
    code: '',
    name: 'Yarn dyeing',
    type: 'service',
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
  });
  expect(made.statusCode, made.body).toBe(201);
  dyeing = productSchema.parse(made.json());
  const order = await send('POST', '/purchase-orders', {
    supplierId: yarn.id,
    date: '2026-10-12',
    expectedDate: '',
    warehouseId: main.id,
    supplierReference: 'PYT-PI-2210',
    paymentTermsDays: 30,
    pricesIncludeVat: false,
    note: '',
    lines: [
      {
        variantId: dyeing.variants[0]?.id ?? '',
        unitId: dyeing.baseUnitId,
        quantity: '1',
        description: '',
        unitPrice: '20000',
        discountType: 'percent',
        discount: '',
        taxRateId: rateId('VAT 15%'),
        requisitionLineId: '',
      },
    ],
  });
  expect(order.statusCode, order.body).toBe(201);
  const draft = purchaseOrderSchema.parse(order.json());
  const submitted = await send('POST', `/purchase-orders/${draft.id}/submit`, {
    version: draft.version,
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  orderY = purchaseOrderSchema.parse(submitted.json());

  // ৳46,000, ৳23,000 and ৳11,500 with VAT; the first was due on 15 Oct
  billA = await postedBill(yarn, 'PYT-0931', '2026-10-01', '2026-10-15', '40000');
  billB = await postedBill(yarn, 'PYT-0957', '2026-10-05', '2026-11-04', '20000');
  billC = await postedBill(yarn, 'PYT-0978', '2026-10-10', '2026-11-09', '10000');
  billK = await postedBill(trims, 'KTA-311', '2026-10-10', '2026-11-09', '5000');
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('supplier payments', () => {
  it('start from the open bills, oldest due date first', async () => {
    expect([billA.number, billA.total, billB.total, billC.total]).toEqual([
      'BILL-2026-27-0001',
      '46000.0000',
      '23000.0000',
      '11500.0000',
    ]);
    expect(await openBills(yarn)).toEqual(['PYT-0931', 'PYT-0957', 'PYT-0978']);
    // Overdue in the workspace's time zone: the day after its due date
    expect(await openBills(yarn, 'overdue')).toEqual(['PYT-0931']);
    expect(await openBills(yarn, 'paid')).toEqual([]);
  });

  it("keep a draft's allocations as a plan, which no bill counts", async () => {
    cheque = await paid(
      paymentForm(
        '60000',
        [
          { bill: billA, amount: '46000' },
          { bill: billB, amount: '14000' },
        ],
        { supplierBankAccountId: bankAccountOf(yarn) },
      ),
    );
    expect(cheque).toMatchObject({
      number: null,
      status: 'draft',
      amount: '60000.0000',
      // The plan counts on the payment itself: "never more than the payment"
      applied: '60000.0000',
      method: 'cheque',
      reference: 'DBBL CHQ 004512',
      supplierBankAccount: { bankName: 'Dutch-Bangla Bank', accountNumber: '1051100045672' },
      entry: null,
    });
    expect(cheque.allocations.map((item) => [item.billNumber, item.amount])).toEqual([
      ['BILL-2026-27-0001', '46000.0000'],
      ['BILL-2026-27-0002', '14000.0000'],
    ]);
    // ...but not on the bills: nothing is paid until it is posted
    expect(await paidOf(billA)).toEqual(['0.0000', []]);
    expect(await openBills(yarn, 'overdue')).toEqual(['PYT-0931']);
    // So a second draft may plan the same money: it holds nothing either
    late = await paid(
      paymentForm('20000', [{ bill: billA, amount: '20000' }], { method: 'bank_transfer' }),
    );
    expect(late.allocations.map((item) => item.amount)).toEqual(['20000.0000']);
  });

  it('refuse what the contract sees, then what only the server knows, each under its box', async () => {
    const over = await send(
      'POST',
      '/supplier-payments',
      paymentForm('10000', [
        { bill: billA, amount: '6000' },
        { bill: billA, amount: '6000' },
      ]),
      rina,
    );
    expect(over.statusCode).toBe(400);
    expect(problemOf(over).fieldErrors).toEqual({
      'allocations.1.billId': ['payment_bill_twice'],
      allocations: ['payment_over_allocated'],
    });
    // Another supplier's bill, and more than a bill still owes
    const bills = await send(
      'POST',
      '/supplier-payments',
      paymentForm('40000', [
        { bill: billK, amount: '5750' },
        { bill: billB, amount: '25000' },
      ]),
      rina,
    );
    expect(bills.statusCode).toBe(409);
    expect(problemOf(bills).fieldErrors).toEqual({
      'allocations.0.billId': ['payment_bill_invalid'],
      'allocations.1.amount': ['payment_over_bill'],
    });
    // Money leaves a cash, bank or wallet account; to one of this supplier's own bank accounts;
    // against an order of this supplier
    const account = await send(
      'POST',
      '/supplier-payments',
      paymentForm('1000', [], { accountId: accountId('5140') }),
      rina,
    );
    expect(problemOf(account).fieldErrors).toEqual({ accountId: ['payment_account_invalid'] });
    const theirBank = await send(
      'POST',
      '/supplier-payments',
      paymentForm('1000', [], { supplierBankAccountId: bankAccountOf(trims) }),
      rina,
    );
    expect(problemOf(theirBank).fieldErrors).toEqual({
      supplierBankAccountId: ['payment_bank_account_invalid'],
    });
    const theirOrder = await send(
      'POST',
      '/supplier-payments',
      paymentForm('1000', [], { supplierId: trims.id, orderId: orderY.id }),
      rina,
    );
    expect(problemOf(theirOrder).fieldErrors).toEqual({ orderId: ['payment_order_invalid'] });
    // The merchandiser agreed the price; paying is the cashier's job
    const notHers = await send('POST', '/supplier-payments', paymentForm('1000', []), mitu);
    expect(notHers.statusCode).toBe(403);
  });
});

describe('approval and posting', () => {
  it('waits for the finance manager from ৳50,000, and posting applies the plan', async () => {
    const rule = await send('PUT', '/approval-rules/supplier_payment', {
      levels: [{ minAmount: '50000', roleId: financeManager.id }],
      version: 0,
    });
    expect(rule.statusCode, rule.body).toBe(200);
    cheque = await acted('submit', cheque);
    expect(cheque).toMatchObject({ number: 'PV-2026-27-0001', status: 'pending' });
    expect(cheque.approval.rounds[0]).toMatchObject({
      status: 'pending',
      amount: '60000.0000',
      submittedBy: { name: 'Rina Begum' },
    });
    // Still a plan while it waits
    expect(await paidOf(billA)).toEqual(['0.0000', []]);
    const [round] = cheque.approval.rounds;
    const approved = await send(
      'POST',
      `/approvals/supplier_payment/${cheque.id}/approve`,
      { roundId: round?.id ?? '', comment: '' },
      kamal,
    );
    expect(approved.statusCode, approved.body).toBe(204);
    cheque = await paymentNow(cheque.id);
    expect(cheque).toMatchObject({ status: 'posted', applied: '60000.0000' });
    expect(await entryLines(cheque.entry?.id)).toEqual([
      ['2110', '60000.0000', '0.0000', 'Padma Yarn Traders'],
      ['1121', '0.0000', '60000.0000', null],
    ]);
    expect(await paidOf(billA)).toEqual(['46000.0000', [['PV-2026-27-0001', '46000.0000']]]);
    expect(await paidOf(billB)).toEqual(['14000.0000', [['PV-2026-27-0001', '14000.0000']]]);
    expect(await openBills(yarn)).toEqual(['PYT-0957', 'PYT-0978']);
    expect(await openBills(yarn, 'paid')).toEqual(['PYT-0931']);
  });

  it('check the plan again when submitted: a bill paid since does not take it', async () => {
    // Written while A still owed everything, submitted after the cheque paid it. Saved now, the
    // same plan would be refused at once.
    const refused = await act('submit', late);
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused).fieldErrors).toEqual({
      'allocations.0.amount': ['payment_over_bill'],
    });
    const still = await paymentNow(late.id);
    expect(still).toMatchObject({ status: 'draft', number: null, approval: { rounds: [] } });
    // Deleted, it was never numbered
    const removed = await send(
      'DELETE',
      `/supplier-payments/${late.id}?version=${String(still.version)}`,
      undefined,
      rina,
    );
    expect(removed.statusCode).toBe(204);
  });
});

describe('advances', () => {
  it('are what a payment does not apply, and may name the order they were paid against', async () => {
    // A cash advance with no order, older, then ৳30,000 by transfer against order Y. Below
    // ৳50,000, so each posts the moment it is submitted.
    const cash = await paid(
      paymentForm('5000', [], {
        date: '2026-10-08',
        accountId: accountId('1110'),
        method: 'cash',
        reference: '',
        submit: true,
      }),
    );
    expect(cash).toMatchObject({ number: 'PV-2026-27-0002', status: 'posted', applied: '0.0000' });
    advance = await paid(
      paymentForm('30000', [], {
        method: 'bank_transfer',
        reference: 'BEFTN 26101700451',
        supplierBankAccountId: bankAccountOf(yarn),
        orderId: orderY.id,
        submit: true,
      }),
    );
    expect(advance).toMatchObject({
      number: 'PV-2026-27-0003',
      status: 'posted',
      order: { id: orderY.id, number: orderY.number },
    });
    const order = purchaseOrderSchema.parse(
      (await send('GET', `/purchase-orders/${orderY.id}`)).json(),
    );
    expect(order.advances).toMatchObject([
      { number: 'PV-2026-27-0003', amount: '30000.0000', applied: '0.0000' },
    ]);
    const byOrder = supplierPaymentPageSchema.parse(
      (await send('GET', `/supplier-payments?orderId=${orderY.id}`)).json(),
    );
    expect(byOrder.items.map((item) => item.number)).toEqual(['PV-2026-27-0003']);
  });

  it('are offered first on the bill of their order, and applied later with no entry', async () => {
    // The dyeing house's bill for order Y: ৳23,000
    const lineY = orderY.lines[0];
    if (!lineY) throw new Error('order Y has no line');
    const billY = await postedBill(yarn, 'PYT-1004', '2026-10-17', '', '0', {
      expenses: [],
      lines: [
        {
          variantId: lineY.variantId,
          unitId: lineY.unitId,
          quantity: lineY.quantity,
          description: '',
          unitPrice: lineY.unitPrice,
          discountType: 'percent',
          discount: '',
          taxRateId: lineY.taxRate.id,
          receiptLineId: '',
          orderLineId: lineY.id,
          accountId: '',
          lotNumber: '',
          expiresOn: '',
          manufacturedOn: '',
          serialNumbers: [],
        },
      ],
    });
    // The order's advance first, though the cash one is older
    expect(billY.advances.map((item) => [item.paymentNumber, item.unapplied])).toEqual([
      ['PV-2026-27-0003', '30000.0000'],
      ['PV-2026-27-0002', '5000.0000'],
    ]);
    const entries = await entryCount();
    // Too much for the payment, and too much for a bill
    const tooMuch = await allocate(advance, [
      { bill: billY, amount: '23000' },
      { bill: billC, amount: '11500' },
    ]);
    expect(problemOf(tooMuch).code).toBe('payment_over_allocated');
    const overBill = await allocate(advance, [{ bill: billC, amount: '12000' }]);
    expect(problemOf(overBill).fieldErrors).toEqual({
      'allocations.0.amount': ['payment_over_bill'],
    });
    const res = await allocate(advance, [{ bill: billY, amount: '23000' }]);
    expect(res.statusCode, res.body).toBe(200);
    advance = supplierPaymentSchema.parse(res.json());
    expect(advance.applied).toBe('23000.0000');
    expect(await paidOf(billY)).toEqual(['23000.0000', [['PV-2026-27-0003', '23000.0000']]]);
    // Only which bill the money settles changed: the books did not
    expect(await entryCount()).toBe(entries);
    const audit = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=supplier_payment&entityId=${advance.id}`)).json(),
    );
    expect(audit.items[0]?.action).toBe('supplier_payment.allocated');
    // A draft is changed with its form, not applied
    const draft = await paid(paymentForm('1000', []));
    expect(problemOf(await allocate(draft, [])).code).toBe('payment_not_posted');
  });
});

describe('a posted payment', () => {
  it('is voided, not changed: its money comes off the bills and its entry is reversed', async () => {
    const edit = await send(
      'PUT',
      `/supplier-payments/${cheque.id}`,
      { ...paymentForm('60000', []), version: cheque.version },
      rina,
    );
    expect(problemOf(edit).code).toBe('purchase_not_draft');
    expect(problemOf(await act('cancel', cheque)).code).toBe('purchase_cannot_cancel');
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${cheque.entry?.id ?? ''}`)).json(),
    );
    const reversed = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-18',
    });
    expect(problemOf(reversed).code).toBe('journal_is_purchase');

    const early = await send(
      'POST',
      `/supplier-payments/${cheque.id}/void`,
      { version: cheque.version, date: '2026-10-15', reason: 'Cheque bounced' },
      rina,
    );
    expect(problemOf(early).fieldErrors).toEqual({ date: ['payment_void_date'] });
    const res = await send(
      'POST',
      `/supplier-payments/${cheque.id}/void`,
      { version: cheque.version, date: '2026-10-18', reason: 'Cheque bounced: insufficient funds' },
      rina,
    );
    expect(res.statusCode, res.body).toBe(200);
    cheque = supplierPaymentSchema.parse(res.json());
    expect(cheque).toMatchObject({
      status: 'voided',
      number: 'PV-2026-27-0001',
      applied: '0.0000',
      allocations: [],
      voidDate: '2026-10-18',
      voidReason: 'Cheque bounced: insufficient funds',
    });
    expect(await entryLines(cheque.voidEntry?.id)).toEqual([
      ['2110', '0.0000', '60000.0000', 'Padma Yarn Traders'],
      ['1121', '60000.0000', '0.0000', null],
    ]);
    const reversal = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${cheque.voidEntry?.id ?? ''}`)).json(),
    );
    expect(reversal).toMatchObject({ date: '2026-10-18', source: 'reversal' });
    // A is owed again, and overdue; the voided payment is not among what it was paid
    expect(await paidOf(billA)).toEqual(['0.0000', []]);
    expect(await paidOf(billB)).toEqual(['0.0000', []]);
    expect(await openBills(yarn, 'overdue')).toEqual(['PYT-0931']);
    const again = await send(
      'POST',
      `/supplier-payments/${cheque.id}/void`,
      { version: cheque.version, date: '2026-10-18', reason: 'Again' },
      rina,
    );
    expect(problemOf(again).code).toBe('payment_not_posted');
  });

  it("forgets the supplier's bank account when the supplier's form removes it", async () => {
    const current = supplierSchema.parse((await send('GET', `/suppliers/${yarn.id}`)).json());
    const res = await send('PUT', `/suppliers/${yarn.id}`, {
      ...supplierForm('Padma Yarn Traders', []),
      code: current.code,
      version: current.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    yarn = supplierSchema.parse(res.json());
    // Voided and posted alike: only the link goes
    expect((await paymentNow(cheque.id)).supplierBankAccount).toBeNull();
    expect((await paymentNow(advance.id)).supplierBankAccount).toBeNull();
  });
});

describe('reopen and cancel', () => {
  it('take a waiting payment back, and a cancelled one keeps its plan as history', async () => {
    let big = await paid(
      paymentForm(
        '57500',
        [
          { bill: billA, amount: '46000' },
          { bill: billC, amount: '11500' },
        ],
        { submit: true },
      ),
    );
    expect(big).toMatchObject({ number: 'PV-2026-27-0004', status: 'pending' });
    big = await acted('reopen', big);
    expect(big.status).toBe('draft');
    expect(big.approval.rounds[0]?.status).toBe('reopened');
    const remove = await send(
      'DELETE',
      `/supplier-payments/${big.id}?version=${String(big.version)}`,
      undefined,
      rina,
    );
    expect(problemOf(remove).code).toBe('purchase_was_submitted');
    big = await acted('submit', big);
    big = await acted('cancel', big);
    expect(big).toMatchObject({ status: 'cancelled', number: 'PV-2026-27-0004' });
    expect(big.approval.rounds[0]?.status).toBe('reopened');
    expect(big.allocations.map((item) => item.billNumber)).toEqual([
      'BILL-2026-27-0001',
      'BILL-2026-27-0003',
    ]);
    expect(await paidOf(billC)).toEqual(['0.0000', []]);
    // A draft nobody submitted is deleted instead
    const draft = await paid(paymentForm('1000', []));
    expect(problemOf(await act('cancel', draft)).code).toBe('purchase_delete_instead');
  });
});

describe('two payments at the same moment', () => {
  it("pay a bill's last money once: the second waits, then finds it paid", async () => {
    // Two cashiers each pay the overdue bill in full, by transfer (below ৳50,000: posted at once)
    const [a, b] = await Promise.all(
      ['BEFTN 26101800101', 'BEFTN 26101800102'].map((reference) =>
        paid(
          paymentForm('46000', [{ bill: billA, amount: '46000' }], {
            method: 'bank_transfer',
            reference,
          }),
        ),
      ),
    );
    if (!a || !b) throw new Error('two drafts expected');
    const [first, second] = await Promise.all([act('submit', a), act('submit', b)]);
    const codes = [first, second].map((res) =>
      res.statusCode === 200 ? 'posted' : problemOf(res).code,
    );
    expect(codes.toSorted()).toEqual(['payment_over_bill', 'posted']);
    const loser = first.statusCode === 200 ? b : a;
    expect(await paymentNow(loser.id)).toMatchObject({ status: 'draft', number: null });
    const [amountPaid] = await paidOf(billA);
    expect(amountPaid).toBe('46000.0000');
    expect(await openBills(yarn, 'overdue')).toEqual([]);
  });

  it('keep the payable equal to what the bills owe less the advances', async () => {
    const [row] = await superuserSql(
      (sql) => sql<{ payable: string; owed: string; ahead: string }[]>`
        WITH t AS (SELECT id FROM tenants WHERE slug = 'jamuna-denim')
        SELECT
          (SELECT coalesce(sum(l.credit - l.debit), 0)::text FROM journal_lines l
             JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
            WHERE a.code = '2110' AND a.tenant_id = (SELECT id FROM t)
              AND l.party_id = ${yarn.id}) AS payable,
          (SELECT coalesce(sum(total - amount_paid), 0)::text FROM bills
            WHERE status = 'posted' AND supplier_id = ${yarn.id}) AS owed,
          (SELECT coalesce(sum(amount - applied), 0)::text FROM supplier_payments
            WHERE status = 'posted' AND supplier_id = ${yarn.id}) AS ahead`,
    );
    // Owed: B ৳23,000 and C ৳11,500 (A paid, Y paid). Ahead: the cash ৳5,000 and ৳7,000 left of
    // the transfer. The payable is ৳34,500 − ৳12,000.
    expect(row).toEqual({ payable: '22500.0000', owed: '34500.0000', ahead: '12000.0000' });
  });
});
