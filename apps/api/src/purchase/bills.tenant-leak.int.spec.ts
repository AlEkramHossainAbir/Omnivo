import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  type Bill,
  billPageSchema,
  billSchema,
  type GoodsReceipt,
  goodsReceiptPageSchema,
  goodsReceiptSchema,
  memberPageSchema,
  type PermissionKey,
  type Product,
  productSchema,
  problemSchema,
  type PurchaseOrder,
  purchaseOrderPageSchema,
  purchaseOrderSchema,
  roleSchema,
  setupSchema,
  type Supplier,
  type SupplierPayment,
  supplierPaymentPageSchema,
  supplierPaymentSchema,
  supplierSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  waitingApprovalPageSchema,
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

// Step 17c. Two workspaces: A must never see, change, approve, pay or apply money to B's bills and
// supplier payments, nor bill B's goods receipts or order lines, post to B's accounts, or pay from
// B's money or to B's supplier's bank. Every answer is 404, or the same "pick one from the list" as
// for an id that does not exist.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
// B's accountant: B's bills from ৳100 wait for B's Owner
let clerkOfB: SignedIn;
let unitsOfA: Unit[];
let ratesOfA: TaxRate[];
let ratesOfB: TaxRate[];
let accountsOfA: Account[];
let accountsOfB: Account[];
let warehouseOfA: Warehouse;
let warehouseOfB: Warehouse;
let productOfA: Product;
let supplierOfA: Supplier;
let supplierOfB: Supplier;
// Approved: a goods line, received, and a service line not billed yet
let orderOfB: PurchaseOrder;
let receiptOfB: GoodsReceipt;
// Posted: bills B's receipt line, partly paid
let billOfB: Bill;
// Waiting for B's Owner
let pendingBillOfB: Bill;
// Posted, ৳1,000 on billOfB
let paymentOfB: SupplierPayment;
let draftPaymentOfB: SupplierPayment;

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

async function setUp(who: SignedIn): Promise<void> {
  expect((await as(who, 'POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
}

function pcsOf(units: Unit[]): string {
  const pcs = units.find((unit) => unit.code === 'pcs');
  if (!pcs) throw new Error('no pcs');
  return pcs.id;
}

function vatOf(rates: TaxRate[]): string {
  const found = rates.find((rate) => rate.name === 'VAT 15%');
  if (!found) throw new Error('no VAT 15%');
  return found.id;
}

function codeIn(accounts: Account[], code: string): string {
  const found = accounts.find((item) => item.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

async function firstWarehouse(who: SignedIn): Promise<Warehouse> {
  const [found] = warehouseListSchema.parse((await as(who, 'GET', '/warehouses')).json()).items;
  if (!found) throw new Error('no warehouse');
  return found;
}

async function addProduct(
  who: SignedIn,
  name: string,
  units: Unit[],
  type: 'goods' | 'service' = 'goods',
): Promise<Product> {
  const res = await as(who, 'POST', '/products', {
    code: '',
    name,
    type,
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
  });
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

async function addSupplier(who: SignedIn, name: string): Promise<Supplier> {
  const res = await as(who, 'POST', '/suppliers', {
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
    bankAccounts: [
      {
        id: null,
        bankName: 'BRAC Bank',
        branchName: '',
        accountName: name,
        accountNumber: '1501203344556',
        routingNumber: '',
      },
    ],
    notes: '',
  });
  expect(res.statusCode, res.body).toBe(201);
  return supplierSchema.parse(res.json());
}

// B's accountant, in a role of B that books bills and pays them
async function clerk(permissions: PermissionKey[]): Promise<{ who: SignedIn; roleId: string }> {
  const email = 'tania@tongitextile.com';
  const password = 'Tongi-books-2026';
  await signUp(app, {
    companyName: 'Tania Trading',
    workspaceSlug: 'tania',
    fullName: 'Tania Sultana',
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'tongi-textile' });
  const made = await as(tenantB, 'POST', '/roles', { name: 'Bills desk', description: '' });
  const role = roleSchema.parse(made.json());
  const matrix = await as(tenantB, 'PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = memberPageSchema.parse((await as(tenantB, 'GET', '/members')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await as(tenantB, 'PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  const who = await logIn(app, {
    workspace: 'tongi-textile',
    email,
    password,
    keepSignedIn: false,
  });
  return { who, roleId: role.id };
}

function line(variantId: string, unitId: string, taxRateId: string, extra: object = {}) {
  return {
    variantId,
    unitId,
    quantity: '1',
    description: '',
    unitPrice: '1000',
    discountType: 'percent',
    discount: '',
    taxRateId,
    receiptLineId: '',
    orderLineId: '',
    accountId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    ...extra,
  };
}

function billForm(supplierId: string, warehouse: Warehouse, extra: object = {}) {
  return {
    supplierId,
    date: '2026-10-16',
    dueDate: '',
    supplierBillNumber: 'INV-2210',
    mushakNumber: '',
    mushakDate: '',
    branchId: warehouse.branchId,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: [],
    expenses: [],
    submit: false,
    ...extra,
  };
}

function expenseOf(accounts: Account[], rates: TaxRate[], extra: object = {}) {
  return {
    accountId: codeIn(accounts, '5270'),
    description: 'Knitting machine repair',
    amount: '1000',
    taxRateId: vatOf(rates),
    ...extra,
  };
}

function paymentForm(supplierId: string, warehouse: Warehouse, accounts: Account[], extra = {}) {
  return {
    supplierId,
    date: '2026-10-17',
    amount: '1000',
    accountId: codeIn(accounts, '1110'),
    method: 'cash',
    reference: '',
    supplierBankAccountId: '',
    branchId: warehouse.branchId,
    orderId: '',
    note: '',
    allocations: [],
    submit: false,
    ...extra,
  };
}

async function billOfBNow(id: string): Promise<Bill> {
  return billSchema.parse((await as(tenantB, 'GET', `/bills/${id}`)).json());
}

async function paymentOfBNow(id: string): Promise<SupplierPayment> {
  return supplierPaymentSchema.parse((await as(tenantB, 'GET', `/supplier-payments/${id}`)).json());
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
  [tenantA, tenantB] = await Promise.all([
    signUp(app, {
      companyName: 'Gazipur Sweaters Ltd.',
      workspaceSlug: 'gazipur-sweater',
      fullName: 'Arif Chowdhury',
      email: 'arif@gazipursweater.com',
      password: 'Gazipur-sweater-2026',
    }),
    signUp(app, {
      companyName: 'Tongi Textile Ltd.',
      workspaceSlug: 'tongi-textile',
      fullName: 'Bilkis Rahman',
      email: 'bilkis@tongitextile.com',
      password: 'Tongi-textile-2026',
    }),
  ]);
  await Promise.all([setUp(tenantA), setUp(tenantB)]);
  unitsOfA = unitListSchema.parse((await as(tenantA, 'GET', '/units')).json()).items;
  const unitsOfB = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;
  ratesOfA = taxRateListSchema.parse((await as(tenantA, 'GET', '/tax-rates')).json()).items;
  ratesOfB = taxRateListSchema.parse((await as(tenantB, 'GET', '/tax-rates')).json()).items;
  accountsOfA = accountListSchema.parse((await as(tenantA, 'GET', '/accounts')).json()).items;
  accountsOfB = accountListSchema.parse((await as(tenantB, 'GET', '/accounts')).json()).items;
  warehouseOfA = await firstWarehouse(tenantA);
  warehouseOfB = await firstWarehouse(tenantB);
  productOfA = await addProduct(tenantA, 'Acrylic yarn 2/32', unitsOfA);
  const productOfB = await addProduct(tenantB, 'Cotton yarn 30/1', unitsOfB);
  const serviceOfB = await addProduct(tenantB, 'Yarn carriage', unitsOfB, 'service');
  supplierOfA = await addSupplier(tenantA, 'Gazipur Yarn House');
  supplierOfB = await addSupplier(tenantB, 'Tongi Spinning Mills');

  // B's order: 100 cones at ৳250 and the carriage, approved at once (B has no order levels)
  const ordered = await as(tenantB, 'POST', '/purchase-orders', {
    supplierId: supplierOfB.id,
    date: '2026-10-12',
    expectedDate: '',
    warehouseId: warehouseOfB.id,
    supplierReference: '',
    paymentTermsDays: 30,
    pricesIncludeVat: false,
    note: '',
    lines: [productOfB, serviceOfB].map((product) => ({
      variantId: variantOf(product),
      unitId: pcsOf(unitsOfB),
      quantity: product === productOfB ? '100' : '1',
      description: '',
      unitPrice: product === productOfB ? '250' : '2000',
      discountType: 'percent',
      discount: '',
      taxRateId: vatOf(ratesOfB),
      requisitionLineId: '',
    })),
  });
  expect(ordered.statusCode, ordered.body).toBe(201);
  const draftOrder = purchaseOrderSchema.parse(ordered.json());
  const approved = await as(tenantB, 'POST', `/purchase-orders/${draftOrder.id}/submit`, {
    version: draftOrder.version,
  });
  expect(approved.statusCode, approved.body).toBe(200);
  orderOfB = purchaseOrderSchema.parse(approved.json());
  const goodsLine = orderOfB.lines.find((item) => item.variantId === variantOf(productOfB));
  const received = await as(tenantB, 'POST', '/goods-receipts', {
    orderId: orderOfB.id,
    date: '2026-10-14',
    warehouseId: warehouseOfB.id,
    supplierChallan: '',
    vehicle: '',
    note: '',
    lines: [
      {
        variantId: variantOf(productOfB),
        unitId: pcsOf(unitsOfB),
        quantity: '100',
        batchId: '',
        lotNumber: '',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
        orderLineId: goodsLine?.id ?? '',
        rejectedQuantity: '',
        rejectionReason: '',
      },
    ],
    post: true,
  });
  expect(received.statusCode, received.body).toBe(201);
  receiptOfB = goodsReceiptSchema.parse(received.json());

  // B's Owner bills the receipt line: posted at once
  const [receiptLine] = receiptOfB.lines;
  const billed = await as(
    tenantB,
    'POST',
    '/bills',
    billForm(supplierOfB.id, warehouseOfB, {
      lines: [
        line(variantOf(productOfB), pcsOf(unitsOfB), vatOf(ratesOfB), {
          quantity: '100',
          unitPrice: '250',
          receiptLineId: receiptLine?.id ?? '',
        }),
      ],
      submit: true,
    }),
  );
  expect(billed.statusCode, billed.body).toBe(201);
  billOfB = billSchema.parse(billed.json());
  expect(billOfB.status).toBe('posted');

  // From ৳100 B's bills wait for B's "Bills desk" role; its own writer cannot approve, so the
  // clerk's bill waits for B's Owner
  const desk = await clerk(['purchase.bill.manage', 'purchase.payment.manage']);
  clerkOfB = desk.who;
  const rule = await as(tenantB, 'PUT', '/approval-rules/bill', {
    levels: [{ minAmount: '100', roleId: desk.roleId }],
    version: 0,
  });
  expect(rule.statusCode, rule.body).toBe(200);
  const pending = await as(
    clerkOfB,
    'POST',
    '/bills',
    billForm(supplierOfB.id, warehouseOfB, {
      supplierBillNumber: 'INV-2211',
      expenses: [expenseOf(accountsOfB, ratesOfB)],
      submit: true,
    }),
  );
  expect(pending.statusCode, pending.body).toBe(201);
  pendingBillOfB = billSchema.parse(pending.json());
  expect(pendingBillOfB.status).toBe('pending');

  const payment = await as(
    tenantB,
    'POST',
    '/supplier-payments',
    paymentForm(supplierOfB.id, warehouseOfB, accountsOfB, {
      allocations: [{ billId: billOfB.id, amount: '1000' }],
      submit: true,
    }),
  );
  expect(payment.statusCode, payment.body).toBe(201);
  paymentOfB = supplierPaymentSchema.parse(payment.json());
  expect(paymentOfB.status).toBe('posted');
  const draft = await as(
    clerkOfB,
    'POST',
    '/supplier-payments',
    paymentForm(supplierOfB.id, warehouseOfB, accountsOfB, { amount: '500' }),
  );
  expect(draft.statusCode, draft.body).toBe(201);
  draftPaymentOfB = supplierPaymentSchema.parse(draft.json());
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe("another workspace's bills", () => {
  it('are not read, changed, deleted, submitted, reopened or cancelled', async () => {
    for (const bill of [billOfB, pendingBillOfB]) {
      const version = { version: bill.version };
      const answers = await Promise.all([
        as(tenantA, 'GET', `/bills/${bill.id}`),
        as(tenantA, 'PUT', `/bills/${bill.id}`, {
          ...billForm(supplierOfA.id, warehouseOfA, {
            expenses: [expenseOf(accountsOfA, ratesOfA)],
          }),
          version: bill.version,
        }),
        as(tenantA, 'DELETE', `/bills/${bill.id}?version=${String(bill.version)}`),
        as(tenantA, 'POST', `/bills/${bill.id}/submit`, version),
        as(tenantA, 'POST', `/bills/${bill.id}/reopen`, version),
        as(tenantA, 'POST', `/bills/${bill.id}/cancel`, version),
      ]);
      expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
      const after = await billOfBNow(bill.id);
      expect([after.status, after.version]).toEqual([bill.status, bill.version]);
    }
    const page = billPageSchema.parse(
      (await as(tenantA, 'GET', `/bills?supplierId=${supplierOfB.id}`)).json(),
    );
    expect(page.items).toEqual([]);
    const all = billPageSchema.parse((await as(tenantA, 'GET', '/bills?payment=open')).json());
    expect(all.items).toEqual([]);
  });

  it("are not approved from A, nor in A's waiting list", async () => {
    const [round] = pendingBillOfB.approval.rounds;
    const res = await as(tenantA, 'POST', `/approvals/bill/${pendingBillOfB.id}/approve`, {
      roundId: round?.id ?? '',
      comment: '',
    });
    expect(res.statusCode).toBe(404);
    const waiting = waitingApprovalPageSchema.parse(
      (await as(tenantA, 'GET', '/approvals/waiting')).json(),
    );
    expect(waiting.items).toEqual([]);
    expect((await billOfBNow(pendingBillOfB.id)).status).toBe('pending');
  });
});

describe("nothing of B's on A's bill", () => {
  it("bills none of B's receipt lines or order lines", async () => {
    const [receiptLine] = receiptOfB.lines;
    const serviceLine = orderOfB.lines[1];
    const res = await as(
      tenantA,
      'POST',
      '/bills',
      billForm(supplierOfA.id, warehouseOfA, {
        lines: [
          line(receiptLine?.variantId ?? '', pcsOf(unitsOfA), vatOf(ratesOfA), {
            quantity: '100',
            receiptLineId: receiptLine?.id ?? '',
          }),
          line(serviceLine?.variantId ?? '', pcsOf(unitsOfA), vatOf(ratesOfA), {
            orderLineId: serviceLine?.id ?? '',
          }),
        ],
      }),
    );
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.0.receiptLineId': ['bill_receipt_line_invalid'],
      'lines.1.orderLineId': ['bill_order_line_invalid'],
    });
    // A's own lists offer nothing of B's
    const receipts = goodsReceiptPageSchema.parse(
      (await as(tenantA, 'GET', '/goods-receipts?bill=to_bill')).json(),
    );
    expect(receipts.items).toEqual([]);
    const orders = purchaseOrderPageSchema.parse(
      (await as(tenantA, 'GET', '/purchase-orders?bill=to_bill')).json(),
    );
    expect(orders.items).toEqual([]);
  });

  it("takes none of B's suppliers, branches, stores, accounts or VAT rates", async () => {
    const supplier = await as(
      tenantA,
      'POST',
      '/bills',
      billForm(supplierOfB.id, warehouseOfA, { expenses: [expenseOf(accountsOfA, ratesOfA)] }),
    );
    expect(problemOf(supplier).fieldErrors).toEqual({ supplierId: ['purchase_supplier_invalid'] });
    const branch = await as(tenantA, 'POST', '/bills', {
      ...billForm(supplierOfA.id, warehouseOfA, { expenses: [expenseOf(accountsOfA, ratesOfA)] }),
      branchId: warehouseOfB.branchId,
    });
    expect(problemOf(branch).fieldErrors).toEqual({ branchId: ['purchase_branch_invalid'] });
    const store = await as(
      tenantA,
      'POST',
      '/bills',
      billForm(supplierOfA.id, warehouseOfA, {
        warehouseId: warehouseOfB.id,
        lines: [line(variantOf(productOfA), pcsOf(unitsOfA), vatOf(ratesOfA))],
      }),
    );
    expect(problemOf(store).fieldErrors).toEqual({ warehouseId: ['purchase_warehouse_invalid'] });
    const rate = await as(
      tenantA,
      'POST',
      '/bills',
      billForm(supplierOfA.id, warehouseOfA, {
        expenses: [expenseOf(accountsOfA, ratesOfA, { taxRateId: vatOf(ratesOfB) })],
      }),
    );
    expect(problemOf(rate).fieldErrors).toEqual({ 'expenses.0.taxRateId': ['tax_rate_invalid'] });
    const account = await as(
      tenantA,
      'POST',
      '/bills',
      billForm(supplierOfA.id, warehouseOfA, { expenses: [expenseOf(accountsOfB, ratesOfA)] }),
    );
    expect(problemOf(account).fieldErrors).toEqual({
      'expenses.0.accountId': ['bill_account_invalid'],
    });
    // Nor in Settings → Purchase
    const settings = await as(tenantA, 'PUT', '/purchase-accounts', {
      priceDifference: codeIn(accountsOfB, '5180'),
      services: codeIn(accountsOfA, '5170'),
    });
    expect(problemOf(settings).code).toBe('purchase_account_invalid');
  });
});

describe("another workspace's supplier payments", () => {
  it('are not read, changed, deleted, submitted, applied or voided', async () => {
    for (const payment of [paymentOfB, draftPaymentOfB]) {
      const version = { version: payment.version };
      const answers = await Promise.all([
        as(tenantA, 'GET', `/supplier-payments/${payment.id}`),
        as(tenantA, 'PUT', `/supplier-payments/${payment.id}`, {
          ...paymentForm(supplierOfA.id, warehouseOfA, accountsOfA),
          version: payment.version,
        }),
        as(
          tenantA,
          'DELETE',
          `/supplier-payments/${payment.id}?version=${String(payment.version)}`,
        ),
        as(tenantA, 'POST', `/supplier-payments/${payment.id}/submit`, version),
        as(tenantA, 'PUT', `/supplier-payments/${payment.id}/allocations`, {
          ...version,
          allocations: [],
        }),
        as(tenantA, 'POST', `/supplier-payments/${payment.id}/void`, {
          ...version,
          date: '2026-10-18',
          reason: 'Cheque bounced',
        }),
      ]);
      expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
      const after = await paymentOfBNow(payment.id);
      expect([after.status, after.version, after.applied]).toEqual([
        payment.status,
        payment.version,
        payment.applied,
      ]);
    }
    const page = supplierPaymentPageSchema.parse(
      (await as(tenantA, 'GET', '/supplier-payments')).json(),
    );
    expect(page.items).toEqual([]);
    // B's bill was paid only by B's payment
    expect((await billOfBNow(billOfB.id)).amountPaid).toBe('1000.0000');
  });

  it("are not where A's payment goes: B's bills, money, supplier's bank or orders", async () => {
    const bill = await as(
      tenantA,
      'POST',
      '/supplier-payments',
      paymentForm(supplierOfA.id, warehouseOfA, accountsOfA, {
        allocations: [{ billId: billOfB.id, amount: '1000' }],
      }),
    );
    expect(problemOf(bill).fieldErrors).toEqual({
      'allocations.0.billId': ['payment_bill_invalid'],
    });
    const money = await as(
      tenantA,
      'POST',
      '/supplier-payments',
      paymentForm(supplierOfA.id, warehouseOfA, accountsOfB),
    );
    expect(problemOf(money).fieldErrors).toEqual({ accountId: ['payment_account_invalid'] });
    const bank = await as(
      tenantA,
      'POST',
      '/supplier-payments',
      paymentForm(supplierOfA.id, warehouseOfA, accountsOfA, {
        supplierBankAccountId: supplierOfB.bankAccounts[0]?.id ?? '',
      }),
    );
    expect(problemOf(bank).fieldErrors).toEqual({
      supplierBankAccountId: ['payment_bank_account_invalid'],
    });
    const order = await as(
      tenantA,
      'POST',
      '/supplier-payments',
      paymentForm(supplierOfA.id, warehouseOfA, accountsOfA, { orderId: orderOfB.id }),
    );
    expect(problemOf(order).fieldErrors).toEqual({ orderId: ['payment_order_invalid'] });
    const supplier = await as(
      tenantA,
      'POST',
      '/supplier-payments',
      paymentForm(supplierOfB.id, warehouseOfA, accountsOfA),
    );
    expect(problemOf(supplier).fieldErrors).toEqual({ supplierId: ['purchase_supplier_invalid'] });
  });
});
