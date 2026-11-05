import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  approvalRuleListSchema,
  type Bill,
  type BillFormValues,
  type BillLineFormValues,
  billPageSchema,
  billSchema,
  branchSchema,
  costLookupSchema,
  type GoodsReceipt,
  goodsReceiptPageSchema,
  goodsReceiptSchema,
  journalEntrySchema,
  memberPageSchema,
  type PermissionKey,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  purchaseAccountsSchema,
  type PurchaseOrder,
  type PurchaseOrderFormValues,
  type PurchaseOrderLineFormValues,
  purchaseOrderPageSchema,
  purchaseOrderSchema,
  type Role,
  roleSchema,
  setupSchema,
  stockCardSchema,
  type Supplier,
  supplierSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  waitingApprovalPageSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
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

// Step 17c: a knitwear factory books its suppliers' bills. The mill bills the fabric that came in
// (goods receipt lines) and the carriage on its order (a service line); a dyeing house bills its
// work; a thread shop sells without an order, so its bill receives the goods itself; the landlord
// bills the rent (an expense). Bills from ৳1,00,000 need the finance manager. Each test builds on
// the ones before it: read the first failure first.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// Nasir, the Owner: writes the orders, whose submit approves them at once (no order levels)
let owner: SignedIn;
// Shirin, the accountant: books the bills (purchase.bill.manage)
let shirin: SignedIn;
// Kamal, the finance manager: the one level of the bills' approval
let kamal: SignedIn;
// Jamal, the store keeper: receives the goods, and books no bill
let jamal: SignedIn;
let financeManager: Role;
let units: Unit[];
let rates: TaxRate[];
let accounts: Account[];
let main: Warehouse;
// A second branch's store: its goods receipt owed "goods received not billed" for that branch
let ashulia: Warehouse;
let mill: Supplier;
let dyer: Supplier;
let threadShop: Supplier;
let landlord: Supplier;
// Cotton twill by the metre
let twill: Product;
// Buttons by the piece, bought by the box of 144
let buttons: Product;
// Sewing thread by the cone, kept by lot: bought from a shop with no order
let thread: Product;
// Services: the mill's truck, the dyeing house's work, the generator mechanic's visit
let carriage: Product;
let dyeing: Product;
let servicing: Product;
// Twill and buttons from the mill, 45 days
let orderA: PurchaseOrder;
// The mill's carriage, 30 days
let orderC: PurchaseOrder;
// The dyeing house's work, services only, 15 days
let orderD: PurchaseOrder;
// Another carriage, priced with VAT
let orderE: PurchaseOrder;
// 600 m of twill and 10 boxes of buttons into the main store; 400 m into Ashulia
let grn1: GoodsReceipt;
let grn2: GoodsReceipt;
// The mill's bill for the fabric and the carriage
let bill1: Bill;

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

function codeOf(id: string | null): string | null {
  if (id === null) return null;
  const found = accounts.find((item) => item.id === id);
  if (!found) throw new Error(`no account ${id}`);
  return found.code;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function orderLineOf(order: PurchaseOrder, product: Product): string {
  const found = order.lines.find((line) => line.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} on ${order.number ?? 'the order'}`);
  return found.id;
}

function receiptLineOf(receipt: GoodsReceipt, product: Product) {
  const found = receipt.lines.find((line) => line.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} on ${receipt.number ?? 'the receipt'}`);
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

async function addSupplier(name: string, paymentTermsDays = 30): Promise<Supplier> {
  const res = await send('POST', '/suppliers', {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays,
    address: '',
    bankAccounts: [],
    notes: '',
  });
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

// A user who signs up for a workspace of their own, then joins this one with one role
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
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'rupsha-knit' });
  const { items } = memberPageSchema.parse((await send('GET', '/members?limit=50')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'rupsha-knit', email, password, keepSignedIn: false });
}

// An order line in the product's base unit, 15% VAT, no discount
function orderLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<PurchaseOrderLineFormValues> = {},
): PurchaseOrderLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: product.baseUnitId,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: rateId('VAT 15%'),
    requisitionLineId: '',
    ...extra,
  };
}

// Written and submitted by the Owner: with no order levels, approved at once
async function approvedOrder(
  supplier: Supplier,
  lines: PurchaseOrderLineFormValues[],
  extra: Partial<PurchaseOrderFormValues> = {},
): Promise<PurchaseOrder> {
  const made = await send('POST', '/purchase-orders', {
    supplierId: supplier.id,
    date: '2026-10-12',
    expectedDate: '',
    warehouseId: main.id,
    supplierReference: '',
    paymentTermsDays: 30,
    pricesIncludeVat: false,
    note: '',
    lines,
    ...extra,
  });
  expect(made.statusCode, made.body).toBe(201);
  const draft = purchaseOrderSchema.parse(made.json());
  const res = await send('POST', `/purchase-orders/${draft.id}/submit`, {
    version: draft.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  const order = purchaseOrderSchema.parse(res.json());
  expect(order.status).toBe('approved');
  return order;
}

async function orderNow(id: string): Promise<PurchaseOrder> {
  const res = await send('GET', `/purchase-orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseOrderSchema.parse(res.json());
}

// A goods receipt the store keeper posts: everything accepted, in the base unit unless named
async function received(
  order: PurchaseOrder,
  warehouse: Warehouse,
  lines: { product: Product; quantity: string; unit?: string }[],
  date = '2026-10-14',
): Promise<GoodsReceipt> {
  const res = await send(
    'POST',
    '/goods-receipts',
    {
      orderId: order.id,
      date,
      warehouseId: warehouse.id,
      supplierChallan: '',
      vehicle: '',
      note: '',
      lines: lines.map((line) => ({
        variantId: variantOf(line.product),
        unitId: line.unit === undefined ? line.product.baseUnitId : unitId(line.unit),
        quantity: line.quantity,
        batchId: '',
        lotNumber: '',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
        orderLineId: orderLineOf(order, line.product),
        rejectedQuantity: '',
        rejectionReason: '',
      })),
      post: true,
    },
    jamal,
  );
  expect(res.statusCode, res.body).toBe(201);
  return goodsReceiptSchema.parse(res.json());
}

async function receiptNow(id: string): Promise<GoodsReceipt> {
  const res = await send('GET', `/goods-receipts/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return goodsReceiptSchema.parse(res.json());
}

// A bill line as the form sends it: 15% VAT, no discount, nothing it bills, no account, no lot
function billLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<BillLineFormValues> = {},
): BillLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: product.baseUnitId,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: rateId('VAT 15%'),
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

// A goods receipt line on the bill, as "Add from goods receipts" fills it: the receipt's unit and
// quantity, the price the person types
function receiptBillLine(
  receipt: GoodsReceipt,
  product: Product,
  unitPrice: string,
  extra: Partial<BillLineFormValues> = {},
): BillLineFormValues {
  const line = receiptLineOf(receipt, product);
  return billLine(product, line.quantity, unitPrice, {
    unitId: line.unitId,
    receiptLineId: line.id,
    ...extra,
  });
}

// An order's service line on the bill: its unit, quantity and price
function serviceBillLine(
  order: PurchaseOrder,
  product: Product,
  extra: Partial<BillLineFormValues> = {},
): BillLineFormValues {
  const line = order.lines.find((item) => item.variantId === variantOf(product));
  if (!line) throw new Error(`no ${product.name} on ${order.number ?? 'the order'}`);
  return billLine(product, line.quantity, line.unitPrice, {
    unitId: line.unitId,
    orderLineId: line.id,
    taxRateId: line.taxRate.id,
    ...extra,
  });
}

function expense(code: string, description: string, amount: string, rate = 'VAT 15%') {
  return { accountId: accountId(code), description, amount, taxRateId: rateId(rate) };
}

function billForm(
  supplier: Supplier,
  lines: BillLineFormValues[],
  extra: Partial<BillFormValues> = {},
): Omit<BillFormValues, 'version'> {
  return {
    supplierId: supplier.id,
    date: '2026-10-16',
    dueDate: '',
    supplierBillNumber: '',
    mushakNumber: '',
    mushakDate: '',
    branchId: main.branchId,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines,
    expenses: [],
    submit: false,
    ...extra,
  };
}

// The edit form from a saved bill, as the edit page fills it. The API sends amounts with 4
// decimals; the boxes take 2. A stored receipt line keeps a copy of its order line, which the form
// does not send back (bill_line_source).
function formOf(bill: Bill, extra: Partial<BillFormValues> = {}): BillFormValues {
  const two = (value: string) => value.replace(/(\.\d{2})\d*$/, '$1');
  return {
    supplierId: bill.supplier.id,
    date: bill.date,
    dueDate: bill.dueDate,
    supplierBillNumber: bill.supplierBillNumber,
    mushakNumber: bill.mushakNumber ?? '',
    mushakDate: bill.mushakDate ?? '',
    branchId: bill.branchId,
    warehouseId: bill.warehouseId ?? '',
    pricesIncludeVat: bill.pricesIncludeVat,
    note: bill.note ?? '',
    lines: bill.lines.map((line) => ({
      variantId: line.variantId,
      unitId: line.unitId,
      quantity: line.quantity,
      description: line.description,
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discount: two(line.discount),
      taxRateId: line.taxRate.id,
      receiptLineId: line.receiptLineId ?? '',
      orderLineId: line.receiptLineId === null ? (line.orderLineId ?? '') : '',
      accountId: line.accountId ?? '',
      lotNumber: line.lotNumber ?? '',
      expiresOn: line.expiresOn ?? '',
      manufacturedOn: line.manufacturedOn ?? '',
      serialNumbers: line.serialNumbers,
    })),
    expenses: bill.expenses.map((item) => ({
      accountId: item.accountId,
      description: item.description,
      amount: two(item.amount),
      taxRateId: item.taxRate.id,
    })),
    submit: false,
    version: bill.version,
    ...extra,
  };
}

async function billed(body: object, as = shirin): Promise<Bill> {
  const res = await send('POST', '/bills', body, as);
  expect(res.statusCode, res.body).toBe(201);
  return billSchema.parse(res.json());
}

async function billNow(id: string): Promise<Bill> {
  const res = await send('GET', `/bills/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return billSchema.parse(res.json());
}

// A bill action that takes the version: submit, reopen, cancel
function act(action: 'submit' | 'reopen' | 'cancel', bill: Bill, as = shirin) {
  return send('POST', `/bills/${bill.id}/${action}`, { version: bill.version }, as);
}

async function acted(action: 'submit' | 'reopen' | 'cancel', bill: Bill, as = shirin) {
  const res = await act(action, bill, as);
  expect(res.statusCode, res.body).toBe(200);
  return billSchema.parse(res.json());
}

// Approve or reject the round the bill page showed
function decide(bill: Bill, decision: 'approve' | 'reject', comment = '', as = kamal) {
  const [round] = bill.approval.rounds;
  if (!round) throw new Error(`${bill.number ?? 'the bill'} has no round`);
  return send('POST', `/approvals/bill/${bill.id}/${decision}`, { roundId: round.id, comment }, as);
}

// A journal entry as [account code, debit, credit, branch code] rows, sorted: summed per account
// and branch, the entry's own order is not the point
async function entryLines(id: string | undefined) {
  const entry = journalEntrySchema.parse(
    (await send('GET', `/journal-entries/${id ?? 'none'}`)).json(),
  );
  return entry.lines
    .map((item) => [
      codeOf(item.accountId),
      item.debit,
      item.credit,
      item.branchId === ashulia.branchId ? 'ASH' : 'HO',
    ])
    .toSorted(
      (a, b) =>
        String(a[0]).localeCompare(String(b[0])) || String(a[3]).localeCompare(String(b[3])),
    );
}

// The bill form's "Add from goods receipts" list for a supplier: [number, bill state]
async function toBill(supplier: Supplier) {
  const page = goodsReceiptPageSchema.parse(
    (await send('GET', `/goods-receipts?bill=to_bill&supplierId=${supplier.id}`)).json(),
  );
  return page.items.map((item) => [item.number, item.billState]);
}

// The orders with a service line still to bill, for a supplier
async function servicesToBill(supplier: Supplier) {
  const page = purchaseOrderPageSchema.parse(
    (await send('GET', `/purchase-orders?bill=to_bill&supplierId=${supplier.id}`)).json(),
  );
  return page.items.map((item) => item.number);
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
    companyName: 'Rupsha Knitwear Ltd.',
    workspaceSlug: 'rupsha-knit',
    fullName: 'Nasir Uddin',
    email: 'nasir@rupshaknit.com',
    password: 'Rupsha-factory-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const [firstWarehouse] = warehouseListSchema.parse(
    (await send('GET', '/warehouses')).json(),
  ).items;
  if (!firstWarehouse) throw new Error('sign-up made no warehouse');
  main = firstWarehouse;
  const branch = branchSchema.parse(
    (
      await send('POST', '/branches', { code: 'ASH', name: 'Ashulia', phone: '', address: '' })
    ).json(),
  );
  const store = await send('POST', '/warehouses', {
    branchId: branch.id,
    code: 'ASH',
    name: 'Ashulia store',
    address: '',
  });
  expect(store.statusCode, store.body).toBe(201);
  ashulia = warehouseSchema.parse(store.json());

  financeManager = await addRole('Finance manager', ['purchase.bill.manage']);
  shirin = await member(
    'shirin@rupshaknit.com',
    'Shirin Akter',
    'Ledger-books-2026',
    await addRole('Bills desk', ['purchase.bill.manage']),
  );
  kamal = await member(
    'kamal@rupshaknit.com',
    'Kamal Hossain',
    'Finance-desk-2026',
    financeManager,
  );
  jamal = await member(
    'jamal@rupshaknit.com',
    'Jamal Uddin',
    'Gate-register-2026',
    await addRole('Gate store', ['purchase.receipt.manage']),
  );

  mill = await addSupplier('Nayapara Weaving Mills', 45);
  dyer = await addSupplier('Shapla Dyeing & Washing', 15);
  threadShop = await addSupplier('Bismillah Thread House', 0);
  landlord = await addSupplier('Hazi Kashem Properties');
  twill = await addProduct('Cotton twill 3/1, khaki', { baseUnitId: unitId('m') });
  buttons = await addProduct('Polo button 18L', {
    units: [{ unitId: unitId('box'), factor: '144', barcode: '' }],
  });
  thread = await addProduct('Sewing thread 40/2, black', { tracking: 'batch' });
  carriage = await addProduct('Carriage inward', { type: 'service' });
  dyeing = await addProduct('Garment dyeing', { type: 'service' });
  servicing = await addProduct('Generator servicing', { type: 'service' });

  // ৳3,12,500 of twill and ৳1,500 of buttons, at 45 days (the order's terms, not the supplier's)
  orderA = await approvedOrder(
    mill,
    [
      orderLine(twill, '1000', '312.50'),
      orderLine(buttons, '10', '150', { unitId: unitId('box') }),
    ],
    { paymentTermsDays: 45 },
  );
  orderC = await approvedOrder(mill, [orderLine(carriage, '1', '5000')]);
  orderD = await approvedOrder(dyer, [orderLine(dyeing, '1', '40000')], {
    paymentTermsDays: 15,
  });
  orderE = await approvedOrder(mill, [orderLine(carriage, '1', '1150')], {
    pricesIncludeVat: true,
  });
  grn1 = await received(orderA, main, [
    { product: twill, quantity: '600' },
    { product: buttons, quantity: '10', unit: 'box' },
  ]);
  grn2 = await received(orderA, ashulia, [{ product: twill, quantity: '400' }], '2026-10-15');
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('a bill of goods receipts', () => {
  it('starts from what the form offers: the receipts and the services still to bill', async () => {
    expect([grn1.number, grn2.number, grn1.billState]).toEqual([
      'GRN-2026-27-0001',
      'GRN-2026-27-0002',
      'not_billed',
    ]);
    expect(await toBill(mill)).toEqual([
      ['GRN-2026-27-0002', 'not_billed'],
      ['GRN-2026-27-0001', 'not_billed'],
    ]);
    expect(await toBill(dyer)).toEqual([]);
    // Goods are billed from their receipts, so an order offers only its services
    expect(await servicesToBill(mill)).toEqual([orderE.number, orderC.number]);
    expect(await servicesToBill(dyer)).toEqual([orderD.number]);
  });

  it("is priced line by line, shows where it differs from the order's price, and is due by the shortest terms", async () => {
    // The mill bills ৳315 a metre for what was ordered at ৳312.50: ৳1,500 more on 600 m
    bill1 = await billed(
      billForm(
        mill,
        [
          receiptBillLine(grn1, twill, '315'),
          receiptBillLine(grn2, twill, '312.50'),
          serviceBillLine(orderC, carriage),
        ],
        {
          supplierBillNumber: 'NWM/2026/0412',
          mushakNumber: '0412',
          mushakDate: '2026-10-15',
        },
      ),
    );
    expect(bill1).toMatchObject({
      number: null,
      status: 'draft',
      supplier: { name: 'Nayapara Weaving Mills' },
      supplierBillNumber: 'NWM/2026/0412',
      mushakNumber: '0412',
      mushakDate: '2026-10-15',
      // 16 Oct plus the shorter of the two orders' terms (45 and 30 days)
      dueDate: '2026-11-15',
      pricesIncludeVat: false,
      net: '319000.0000',
      vat: '47850.0000',
      total: '366850.0000',
      amountPaid: '0.0000',
      priceDifference: '1500.0000',
      // Nothing of its own to receive
      warehouseId: null,
      lineCount: 3,
      entry: null,
      approval: { rounds: [] },
    });
    expect(
      bill1.lines.map((line) => [
        line.receiptNumber,
        line.orderNumber,
        line.net,
        line.orderValue,
        codeOf(line.accountId),
      ]),
    ).toEqual([
      ['GRN-2026-27-0001', orderA.number, '189000.0000', '187500.0000', null],
      ['GRN-2026-27-0002', orderA.number, '125000.0000', '125000.0000', null],
      // An empty account is Settings → Purchase's "Purchased services", stored as the line's own
      [null, orderC.number, '5000.0000', null, '5170'],
    ]);
    expect(bill1.receipts.map((item) => item.number)).toEqual([grn1.number, grn2.number]);
    expect(bill1.orders.map((item) => item.number)).toEqual([orderA.number, orderC.number]);
    // A draft holds nothing: the receipts and the carriage are still offered
    expect(await toBill(mill)).toHaveLength(2);
    expect(await servicesToBill(mill)).toContain(orderC.number);
  });

  it("refuses by the contract's rules first, then by what is true, each under its line", async () => {
    const twillLine = receiptBillLine(grn1, twill, '315');
    const rules = await send(
      'POST',
      '/bills',
      billForm(mill, [{ ...twillLine, orderLineId: orderLineOf(orderC, carriage) }, twillLine], {
        supplierBillNumber: 'NWM/2026/0413',
        dueDate: '2026-10-01',
        mushakDate: '2026-10-15',
      }),
      shirin,
    );
    expect(rules.statusCode).toBe(400);
    expect(problemOf(rules).fieldErrors).toEqual({
      'lines.0.orderLineId': ['bill_line_source'],
      'lines.1.receiptLineId': ['bill_line_twice'],
      dueDate: ['bill_due_date'],
      mushakNumber: ['bill_mushak_number_required'],
    });
    const empty = await send(
      'POST',
      '/bills',
      billForm(mill, [], { supplierBillNumber: 'NWM/2026/0413' }),
      shirin,
    );
    expect(problemOf(empty).fieldErrors).toEqual({ lines: ['purchase_lines_required'] });

    // A receipt line is billed whole; goods on an order come through their receipt; a service
    // line is billed as ordered
    const lines = await send(
      'POST',
      '/bills',
      billForm(
        mill,
        [
          receiptBillLine(grn1, twill, '315', { quantity: '500' }),
          billLine(buttons, '10', '150', {
            unitId: unitId('box'),
            orderLineId: orderLineOf(orderA, buttons),
          }),
          serviceBillLine(orderC, carriage, { quantity: '2' }),
        ],
        { supplierBillNumber: 'NWM/2026/0413' },
      ),
      shirin,
    );
    expect(lines.statusCode).toBe(409);
    expect(problemOf(lines).fieldErrors).toEqual({
      'lines.0.quantity': ['bill_receipt_line_quantity'],
      'lines.1.orderLineId': ['bill_order_line_invalid'],
      'lines.2.orderLineId': ['bill_order_line_invalid'],
    });
    // Another supplier's goods receipt, and another supplier's order
    const theirs = await send(
      'POST',
      '/bills',
      billForm(dyer, [receiptBillLine(grn2, twill, '312.50'), serviceBillLine(orderC, carriage)], {
        supplierBillNumber: 'SDW-118',
      }),
      shirin,
    );
    expect(problemOf(theirs).fieldErrors).toEqual({
      'lines.0.receiptLineId': ['bill_receipt_line_invalid'],
      'lines.1.orderLineId': ['bill_order_line_invalid'],
    });

    // The accounts only the system posts to: cash, goods received not billed, VAT input, the
    // payable, and a group
    const books = await send(
      'POST',
      '/bills',
      billForm(mill, [serviceBillLine(orderC, carriage, { accountId: accountId('2110') })], {
        supplierBillNumber: 'NWM/2026/0413',
        expenses: [
          expense('1110', 'Loading charge', '500'),
          expense('2115', 'Loading charge', '500'),
          expense('1170', 'Loading charge', '500'),
          expense('5200', 'Loading charge', '500'),
          expense('5240', 'Loading charge', '500'),
        ],
      }),
      shirin,
    );
    expect(problemOf(books).fieldErrors).toEqual({
      'lines.0.accountId': ['bill_account_invalid'],
      'expenses.0.accountId': ['bill_account_invalid'],
      'expenses.1.accountId': ['bill_account_invalid'],
      'expenses.2.accountId': ['bill_account_invalid'],
      'expenses.3.accountId': ['bill_account_invalid'],
    });

    // One bill reads its prices one way
    const mixed = await send(
      'POST',
      '/bills',
      billForm(mill, [receiptBillLine(grn1, twill, '315'), serviceBillLine(orderE, carriage)], {
        supplierBillNumber: 'NWM/2026/0413',
      }),
      shirin,
    );
    expect(problemOf(mixed).code).toBe('bill_vat_mixed');

    // The store keeper signed for the goods; booking the bill is the accountant's job
    const notHis = await send('POST', '/bills', billForm(mill, [twillLine]), jamal);
    expect(notHis.statusCode).toBe(403);
  });

  it("takes the supplier's bill number once, whatever its case and spaces", async () => {
    const twice = await send(
      'POST',
      '/bills',
      billForm(mill, [serviceBillLine(orderE, carriage)], {
        supplierBillNumber: ' nwm/2026/0412 ',
      }),
      shirin,
    );
    expect(twice.statusCode).toBe(409);
    expect(problemOf(twice).fieldErrors).toEqual({
      supplierBillNumber: ['bill_supplier_number_taken'],
    });
    // Another supplier may use the same number
    const other = await billed(
      billForm(dyer, [serviceBillLine(orderD, dyeing)], { supplierBillNumber: 'NWM/2026/0412' }),
    );
    // A draft nobody submitted is deleted, and its number is free again
    const removed = await send(
      'DELETE',
      `/bills/${other.id}?version=${String(other.version)}`,
      undefined,
      shirin,
    );
    expect(removed.statusCode).toBe(204);
    expect((await send('GET', `/bills/${other.id}`)).statusCode).toBe(404);
  });
});

describe('approval and posting', () => {
  it('waits for the finance manager from ৳1,00,000, numbered when submitted', async () => {
    const rule = await send('PUT', '/approval-rules/bill', {
      levels: [{ minAmount: '100000', roleId: financeManager.id }],
      version: 0,
    });
    expect(rule.statusCode, rule.body).toBe(200);
    const { items } = approvalRuleListSchema.parse((await send('GET', '/approval-rules')).json());
    expect(items.map((item) => [item.document, item.levels.length])).toEqual([
      ['requisition', 0],
      ['purchase_order', 0],
      ['bill', 1],
      ['supplier_payment', 0],
    ]);

    bill1 = await acted('submit', bill1);
    expect(bill1).toMatchObject({ number: 'BILL-2026-27-0001', status: 'pending' });
    expect(bill1.approval.rounds[0]).toMatchObject({
      status: 'pending',
      amount: '366850.0000',
      submittedBy: { name: 'Shirin Akter' },
      steps: [{ position: 1, role: { name: 'Finance manager' }, decision: null }],
    });
    // A pending bill is not changed; its writer does not approve it
    const late = await send('PUT', `/bills/${bill1.id}`, formOf(bill1), shirin);
    expect(problemOf(late).code).toBe('purchase_not_draft');
    expect(problemOf(await decide(bill1, 'approve', '', shirin)).code).toBe(
      'approval_own_document',
    );
    const waiting = waitingApprovalPageSchema.parse(
      (await send('GET', '/approvals/waiting', undefined, kamal)).json(),
    );
    expect(waiting.items).toMatchObject([
      {
        document: 'bill',
        id: bill1.id,
        number: 'BILL-2026-27-0001',
        subject: 'Nayapara Weaving Mills',
        amount: '366850.0000',
      },
    ]);
    // Pending holds nothing either: it is posted only by the approval
    expect(await toBill(mill)).toHaveLength(2);
  });

  it('fails the approval when the posting fails, and decides nothing', async () => {
    const lock = await send('PUT', '/period-lock', { lockDate: '2026-10-16', version: 0 });
    expect(lock.statusCode, lock.body).toBe(200);
    const refused = await decide(bill1, 'approve');
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused).code).toBe('journal_period_locked');
    const still = await billNow(bill1.id);
    expect(still).toMatchObject({ status: 'pending', entry: null, version: bill1.version });
    expect(still.approval.rounds[0]).toMatchObject({
      status: 'pending',
      steps: [{ decision: null }],
    });
    expect((await receiptNow(grn1.id)).lines.map((line) => line.billed)).toEqual([false, false]);
    const unlock = await send('PUT', '/period-lock', { lockDate: '', version: 1 });
    expect(unlock.statusCode, unlock.body).toBe(200);
  });

  it('posts at the last approval: goods received not billed per branch, the difference, the service, VAT and the payable', async () => {
    const approved = await decide(bill1, 'approve', 'Checked against the mill’s PI');
    expect(approved.statusCode, approved.body).toBe(204);
    bill1 = await billNow(bill1.id);
    expect(bill1).toMatchObject({ status: 'posted', number: 'BILL-2026-27-0001' });
    expect(bill1.postedAt).not.toBeNull();
    expect(bill1.approval.rounds[0]?.status).toBe('approved');
    expect(await entryLines(bill1.entry?.id)).toEqual([
      ['1170', '47850.0000', '0.0000', 'HO'],
      ['2110', '0.0000', '366850.0000', 'HO'],
      // Each receipt's own branch: the account clears to zero branch by branch
      ['2115', '125000.0000', '0.0000', 'ASH'],
      ['2115', '187500.0000', '0.0000', 'HO'],
      ['5170', '5000.0000', '0.0000', 'HO'],
      ['5180', '1500.0000', '0.0000', 'HO'],
    ]);
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${bill1.entry?.id ?? ''}`)).json(),
    );
    expect(entry).toMatchObject({ source: 'purchase_bill', narration: 'Bill BILL-2026-27-0001' });
    expect(entry.lines.find((line) => codeOf(line.accountId) === '2110')?.party?.id).toBe(mill.id);

    // The receipts: Ashulia's is billed; the main store's still has its buttons to bill
    const first = await receiptNow(grn1.id);
    expect([first.billState, first.lines.map((line) => line.billed)]).toEqual([
      'partly_billed',
      [true, false],
    ]);
    expect(first.bills.map((item) => item.number)).toEqual(['BILL-2026-27-0001']);
    expect((await receiptNow(grn2.id)).billState).toBe('billed');
    expect(await toBill(mill)).toEqual([['GRN-2026-27-0001', 'partly_billed']]);
    // The carriage is billed: only the order priced with VAT has a service to bill
    expect(await servicesToBill(mill)).toEqual([orderE.number]);
    const order = await orderNow(orderA.id);
    expect(order.lines.map((line) => line.billedQuantity)).toEqual(['1000.0000', '0.0000']);
    expect(order.bills.map((item) => item.number)).toEqual(['BILL-2026-27-0001']);
  });

  it('bills a receipt line in any unit of its item, and the receipt is billed', async () => {
    // 10 boxes came in; the mill bills 1,440 pieces at ৳1.05: ৳12 over the order's ৳1,500.
    // Below ৳1,00,000, so "Post" posts it at once.
    const line = receiptLineOf(grn1, buttons);
    const small = await billed(
      billForm(mill, [billLine(buttons, '1440', '1.05', { receiptLineId: line.id })], {
        supplierBillNumber: 'NWM/2026/0418',
        submit: true,
      }),
    );
    expect(small).toMatchObject({
      number: 'BILL-2026-27-0002',
      status: 'posted',
      net: '1512.0000',
      total: '1738.8000',
      priceDifference: '12.0000',
      approval: { rounds: [{ status: 'approved', steps: [] }] },
    });
    expect(await entryLines(small.entry?.id)).toEqual([
      ['1170', '226.8000', '0.0000', 'HO'],
      ['2110', '0.0000', '1738.8000', 'HO'],
      ['2115', '1500.0000', '0.0000', 'HO'],
      ['5180', '12.0000', '0.0000', 'HO'],
    ]);
    expect((await receiptNow(grn1.id)).billState).toBe('billed');
    expect(await toBill(mill)).toEqual([]);
    expect((await orderNow(orderA.id)).lines.map((item) => item.billedQuantity)).toEqual([
      '1000.0000',
      '1440.0000',
    ]);
    // Billed once: the form would not offer it, and a bill typed by hand is refused
    const again = await send(
      'POST',
      '/bills',
      billForm(
        mill,
        [billLine(buttons, '10', '150', { unitId: unitId('box'), receiptLineId: line.id })],
        {
          supplierBillNumber: 'NWM/2026/0419',
        },
      ),
      shirin,
    );
    expect(problemOf(again).fieldErrors).toEqual({
      'lines.0.receiptLineId': ['bill_receipt_line_billed'],
    });
  });

  it('goes back to draft when rejected, and a cancelled bill lets its number go', async () => {
    // The landlord's rent: an expense, no product. ৳1,38,000 with VAT, so Kamal decides.
    let rent = await billed(
      billForm(landlord, [], {
        supplierBillNumber: 'HKP-10/2026',
        expenses: [expense('5220', 'Factory rent, October 2026', '120000')],
        submit: true,
      }),
    );
    expect(rent).toMatchObject({
      number: 'BILL-2026-27-0003',
      status: 'pending',
      net: '120000.0000',
      total: '138000.0000',
    });
    expect(rent.expenses).toMatchObject([
      { description: 'Factory rent, October 2026', net: '120000.0000', vat: '18000.0000' },
    ]);
    const rejected = await decide(rent, 'reject', 'The new rent is ৳1,10,000 from October');
    expect(rejected.statusCode, rejected.body).toBe(204);
    rent = await billNow(rent.id);
    expect(rent).toMatchObject({ status: 'draft', number: 'BILL-2026-27-0003' });
    expect(rent.approval.rounds[0]).toMatchObject({
      status: 'rejected',
      steps: [{ decision: 'rejected', comment: 'The new rent is ৳1,10,000 from October' }],
    });
    // Changed and submitted again: round 2, for the new total
    const changed = await send(
      'PUT',
      `/bills/${rent.id}`,
      formOf(rent, {
        expenses: [expense('5220', 'Factory rent, October 2026', '110000')],
        submit: true,
      }),
      shirin,
    );
    expect(changed.statusCode, changed.body).toBe(200);
    rent = billSchema.parse(changed.json());
    expect(rent.approval.rounds.map((round) => [round.status, round.amount])).toEqual([
      ['pending', '126500.0000'],
      ['rejected', '138000.0000'],
    ]);
    // Taken back: the round ends as reopened, the number stays, so it is not deleted
    rent = await acted('reopen', rent);
    expect(rent.approval.rounds[0]?.status).toBe('reopened');
    const remove = await send(
      'DELETE',
      `/bills/${rent.id}?version=${String(rent.version)}`,
      undefined,
      shirin,
    );
    expect(problemOf(remove).code).toBe('purchase_was_submitted');
    // Cancelled while waiting: reopened first, in the same step
    rent = await acted('submit', rent);
    rent = await acted('cancel', rent);
    expect(rent).toMatchObject({ status: 'cancelled', number: 'BILL-2026-27-0003' });
    expect(rent.approval.rounds[0]?.status).toBe('reopened');
    expect(problemOf(await act('reopen', rent)).code).toBe('purchase_cannot_reopen');
    expect(problemOf(await act('submit', rent)).code).toBe('purchase_not_draft');
    const waiting = waitingApprovalPageSchema.parse(
      (await send('GET', '/approvals/waiting', undefined, kamal)).json(),
    );
    expect(waiting.items).toEqual([]);

    // The landlord's corrected bill uses the same number. The Owner approves by submitting.
    const right = await billed(
      billForm(landlord, [], {
        supplierBillNumber: 'HKP-10/2026',
        expenses: [expense('5220', 'Factory rent, October 2026', '110000')],
        submit: true,
      }),
      owner,
    );
    expect(right).toMatchObject({ number: 'BILL-2026-27-0004', status: 'posted' });
    expect(await entryLines(right.entry?.id)).toEqual([
      ['1170', '16500.0000', '0.0000', 'HO'],
      ['2110', '0.0000', '126500.0000', 'HO'],
      ['5220', '110000.0000', '0.0000', 'HO'],
    ]);
    // An unnumbered draft is deleted, not cancelled
    const draft = await billed(
      billForm(landlord, [], {
        supplierBillNumber: 'HKP-11/2026',
        expenses: [expense('5220', 'Factory rent, November 2026', '110000')],
      }),
    );
    expect(problemOf(await act('cancel', draft)).code).toBe('purchase_delete_instead');
    expect(
      (
        await send(
          'DELETE',
          `/bills/${draft.id}?version=${String(draft.version)}`,
          undefined,
          shirin,
        )
      ).statusCode,
    ).toBe(204);
  });
});

describe("an order's services", () => {
  it('hold the order while a bill bills them, are billed once, and let a services-only order close', async () => {
    let dyed = await billed(
      billForm(dyer, [serviceBillLine(orderD, dyeing, { accountId: accountId('5140') })], {
        supplierBillNumber: 'SDW-0091',
      }),
    );
    // 15 days: the order's terms
    expect(dyed.dueDate).toBe('2026-10-31');
    // A draft bill of its service: the order is not reopened or cancelled under it
    orderD = await orderNow(orderD.id);
    for (const action of ['reopen', 'cancel'] as const) {
      const res = await send('POST', `/purchase-orders/${orderD.id}/${action}`, {
        version: orderD.version,
      });
      expect(problemOf(res).code).toBe('purchase_order_billed');
    }
    dyed = await acted('submit', dyed);
    expect(dyed).toMatchObject({ number: 'BILL-2026-27-0005', status: 'posted' });
    expect(await entryLines(dyed.entry?.id)).toEqual([
      ['1170', '6000.0000', '0.0000', 'HO'],
      ['2110', '0.0000', '46000.0000', 'HO'],
      ['5140', '40000.0000', '0.0000', 'HO'],
    ]);
    // Once posted, the service is billed: a second bill is refused when it is saved
    const twice = await send(
      'POST',
      '/bills',
      billForm(dyer, [serviceBillLine(orderD, dyeing)], { supplierBillNumber: 'SDW-0092' }),
      shirin,
    );
    expect(problemOf(twice).fieldErrors).toEqual({
      'lines.0.orderLineId': ['bill_order_line_billed'],
    });
    expect(await servicesToBill(dyer)).toEqual([]);
    // Services never get a goods receipt: the posted bill lets the order close
    orderD = await orderNow(orderD.id);
    expect(orderD.lines.map((line) => line.billedQuantity)).toEqual(['1.0000']);
    const closed = await send('POST', `/purchase-orders/${orderD.id}/close`, {
      version: orderD.version,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(purchaseOrderSchema.parse(closed.json()).status).toBe('closed');
  });
});

describe('a bill with no order', () => {
  it('checks its own goods like a goods receipt', async () => {
    const own = billLine(thread, '200', '95', { lotNumber: 'TH-2610' });
    const noStore = await send(
      'POST',
      '/bills',
      billForm(threadShop, [own], { supplierBillNumber: 'BTH-5521' }),
      shirin,
    );
    expect(problemOf(noStore).fieldErrors).toEqual({ warehouseId: ['bill_warehouse_required'] });
    const wrongFields = await send(
      'POST',
      '/bills',
      billForm(
        threadShop,
        [
          { ...own, accountId: accountId('5290') },
          billLine(servicing, '1', '3000', { lotNumber: 'GEN-1' }),
        ],
        { supplierBillNumber: 'BTH-5521', warehouseId: main.id },
      ),
      shirin,
    );
    expect(problemOf(wrongFields).fieldErrors).toEqual({
      'lines.0.accountId': ['bill_account_not_allowed'],
      'lines.1.lotNumber': ['bill_stock_not_allowed'],
    });
    // A lot for a product kept by lot, checked by the goods receipt's own rules, under its line
    const noLot = await send(
      'POST',
      '/bills',
      billForm(threadShop, [billLine(servicing, '1', '3000'), { ...own, lotNumber: '' }], {
        supplierBillNumber: 'BTH-5521',
        warehouseId: main.id,
      }),
      shirin,
    );
    expect(problemOf(noLot).fieldErrors).toEqual({ 'lines.1.lotNumber': ['stock_lot_required'] });
  });

  it('receives its own goods when it is posted, on a goods receipt of its own', async () => {
    // 200 cones at ৳95, the mechanic's visit (to Purchased services) and the alternator repair
    // (an expense): ৳30,000 + ৳4,500 VAT, posted at once
    const shop = await billed(
      billForm(
        threadShop,
        [billLine(thread, '200', '95', { lotNumber: 'TH-2610' }), billLine(servicing, '1', '3000')],
        {
          supplierBillNumber: 'BTH-5521',
          warehouseId: main.id,
          expenses: [expense('5270', 'Generator repair, burnt alternator', '8000')],
          submit: true,
        },
      ),
    );
    expect(shop).toMatchObject({
      number: 'BILL-2026-27-0006',
      status: 'posted',
      // 0 days: due the day it is dated
      dueDate: '2026-10-16',
      warehouseId: main.id,
      net: '30000.0000',
      vat: '4500.0000',
      total: '34500.0000',
      priceDifference: '0.0000',
    });
    const [threadLine, serviceLine] = shop.lines;
    expect(threadLine).toMatchObject({
      receiptNumber: 'GRN-2026-27-0003',
      orderNumber: null,
      orderValue: null,
      lotNumber: 'TH-2610',
    });
    expect(threadLine?.batchId).not.toBeNull();
    expect(codeOf(serviceLine?.accountId ?? null)).toBe('5170');
    expect(shop.receipts.map((item) => item.number)).toEqual(['GRN-2026-27-0003']);

    // The receipt the bill made: no order, the bill's, billed, and not offered to another bill
    const page = goodsReceiptPageSchema.parse(
      (await send('GET', `/goods-receipts?supplierId=${threadShop.id}`)).json(),
    );
    expect(page.items).toMatchObject([
      {
        number: 'GRN-2026-27-0003',
        order: null,
        bill: { id: shop.id, number: 'BILL-2026-27-0006' },
        status: 'posted',
        billState: 'billed',
      },
    ]);
    const made = await receiptNow(page.items[0]?.id ?? '');
    expect(made.lines).toMatchObject([{ orderLineId: null, billed: true, value: '19000.0000' }]);
    expect(await toBill(threadShop)).toEqual([]);
    // It came in at the bill's net, and the bill cleared what the receipt owed
    expect(await entryLines(made.entry?.id)).toEqual([
      ['1154', '19000.0000', '0.0000', 'HO'],
      ['2115', '0.0000', '19000.0000', 'HO'],
    ]);
    expect(await entryLines(shop.entry?.id)).toEqual([
      ['1170', '4500.0000', '0.0000', 'HO'],
      ['2110', '0.0000', '34500.0000', 'HO'],
      ['2115', '19000.0000', '0.0000', 'HO'],
      ['5170', '3000.0000', '0.0000', 'HO'],
      ['5270', '8000.0000', '0.0000', 'HO'],
    ]);
    const card = stockCardSchema.parse(
      (await send('GET', `/stock/variants/${variantOf(thread)}`)).json(),
    );
    expect(card.item.onHand).toBe('200.0000');
  });

  it("teaches the cost lookup the shop's price", async () => {
    const res = await send('POST', '/purchase/cost-lookup', {
      supplierId: threadShop.id,
      items: [{ variantId: variantOf(thread), unitId: unitId('pcs') }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(costLookupSchema.parse(res.json()).items).toMatchObject([
      { cost: '95.0000', source: 'supplier_price' },
    ]);
  });
});

describe('Settings → Purchase', () => {
  it('starts with the two accounts of the chart, which stay while chosen', async () => {
    const chosen = purchaseAccountsSchema.parse((await send('GET', '/purchase-accounts')).json());
    expect([codeOf(chosen.priceDifference), codeOf(chosen.services)]).toEqual(['5180', '5170']);
    const services = accounts.find((item) => item.code === '5170');
    const archive = await send('POST', `/accounts/${accountId('5170')}/archive`, {
      version: services?.version ?? 0,
    });
    expect(problemOf(archive).code).toBe('account_used_by_purchase');
    // Settings are the Owner's (core.settings.manage), and only an expense ledger fits
    const notHers = await send(
      'PUT',
      '/purchase-accounts',
      { priceDifference: '', services: '' },
      shirin,
    );
    expect(notHers.statusCode).toBe(403);
    const cash = await send('PUT', '/purchase-accounts', {
      priceDifference: accountId('1110'),
      services: accountId('5170'),
    });
    expect(problemOf(cash).code).toBe('purchase_account_invalid');
  });

  it('with none chosen, a service line needs its own account and a difference goes to cost of goods sold', async () => {
    const cleared = await send('PUT', '/purchase-accounts', { priceDifference: '', services: '' });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(purchaseAccountsSchema.parse(cleared.json())).toEqual({
      priceDifference: null,
      services: null,
    });
    const noAccount = await send(
      'POST',
      '/bills',
      billForm(mill, [serviceBillLine(orderE, carriage)], {
        supplierBillNumber: 'NWM/2026/0430',
        pricesIncludeVat: true,
      }),
      shirin,
    );
    expect(problemOf(noAccount).fieldErrors).toEqual({
      'lines.0.accountId': ['bill_account_required'],
    });
  });
});

describe('two bills at the same moment', () => {
  it('bill a receipt line once: the second waits, then finds it billed, and uses no number', async () => {
    const orderF = await approvedOrder(mill, [orderLine(twill, '100', '300')]);
    const grn3 = await received(orderF, main, [{ product: twill, quantity: '100' }]);
    // Two clerks type the same delivery note at ৳310 a metre (৳1,000 over the order)
    const [a, b] = await Promise.all(
      ['NWM/2026/0450', 'NWM/2026/0451'].map((number) =>
        billed(
          billForm(mill, [receiptBillLine(grn3, twill, '310')], { supplierBillNumber: number }),
        ),
      ),
    );
    if (!a || !b) throw new Error('two drafts expected');
    const [first, second] = await Promise.all([act('submit', a), act('submit', b)]);
    const codes = [first, second].map((res) =>
      res.statusCode === 200 ? 'posted' : problemOf(res).code,
    );
    expect(codes.toSorted()).toEqual(['bill_receipt_line_billed', 'posted']);
    const winner = first.statusCode === 200 ? a : b;
    const loser = winner === a ? b : a;
    const posted = await billNow(winner.id);
    expect(posted.number).toBe('BILL-2026-27-0007');
    // Settings → Purchase has no price difference account now: the difference is a cost of sale
    expect(await entryLines(posted.entry?.id)).toEqual([
      ['1170', '4650.0000', '0.0000', 'HO'],
      ['2110', '0.0000', '35650.0000', 'HO'],
      ['2115', '30000.0000', '0.0000', 'HO'],
      ['5110', '1000.0000', '0.0000', 'HO'],
    ]);
    // The loser rolled back whole: still a draft, no number, no round
    const after = await billNow(loser.id);
    expect(after).toMatchObject({ status: 'draft', number: null, approval: { rounds: [] } });
    const again = await act('submit', after);
    expect(problemOf(again).fieldErrors).toEqual({
      'lines.0.receiptLineId': ['bill_receipt_line_billed'],
    });
    const next = await billed(
      billForm(landlord, [], {
        supplierBillNumber: 'HKP-11/2026',
        expenses: [expense('5220', 'Factory rent, November 2026', '1000')],
        submit: true,
      }),
    );
    expect(next.number).toBe('BILL-2026-27-0008');
    // Settings back as they were, for the tests after this one
    const restored = await send('PUT', '/purchase-accounts', {
      priceDifference: accountId('5180'),
      services: accountId('5170'),
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });
});

describe('a posted bill', () => {
  it('is final: not changed, deleted, cancelled or reversed', async () => {
    const edit = await send('PUT', `/bills/${bill1.id}`, formOf(bill1), shirin);
    expect(problemOf(edit).code).toBe('purchase_not_draft');
    const remove = await send(
      'DELETE',
      `/bills/${bill1.id}?version=${String(bill1.version)}`,
      undefined,
      shirin,
    );
    expect(problemOf(remove).code).toBe('purchase_not_draft');
    expect(problemOf(await act('cancel', bill1)).code).toBe('purchase_cannot_cancel');
    expect(problemOf(await act('reopen', bill1)).code).toBe('purchase_cannot_reopen');
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${bill1.entry?.id ?? ''}`)).json(),
    );
    const reversed = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-17',
    });
    expect(problemOf(reversed).code).toBe('journal_is_purchase');
  });

  it('keeps its supplier, its products and its accounts', async () => {
    const supplier = await send(
      'DELETE',
      `/suppliers/${threadShop.id}?version=${String(threadShop.version)}`,
    );
    expect(problemOf(supplier).code).toBe('supplier_in_use');
    const product = await send(
      'DELETE',
      `/products/${servicing.id}?version=${String(servicing.version)}`,
    );
    expect(problemOf(product).code).toBe('product_in_use');
    // An account a draft's expense names, with no entry yet
    const made = await send('POST', '/accounts', {
      parentId: accountId('5200'),
      code: '5295',
      name: 'Factory canteen',
      isGroup: false,
      holdsMoney: false,
      description: '',
    });
    expect(made.statusCode, made.body).toBe(201);
    const canteen = accountSchema.parse(made.json());
    accounts = [...accounts, canteen];
    await billed(
      billForm(landlord, [], {
        supplierBillNumber: 'HKP-C-10',
        expenses: [expense('5295', 'Canteen space, October 2026', '5000')],
      }),
    );
    const account = await send(
      'DELETE',
      `/accounts/${canteen.id}?version=${String(canteen.version)}`,
    );
    expect(problemOf(account).code).toBe('account_in_use');
  });

  it('lists by what is still owed, and the books agree', async () => {
    const open = billPageSchema.parse((await send('GET', '/bills?payment=open')).json());
    // Oldest due date first: the order a payment pays them in
    const dues = open.items.map((item) => item.dueDate);
    expect(dues).toEqual(dues.toSorted());
    expect(dues[0]).toBe('2026-10-16');
    expect(open.items.map((item) => item.number).toSorted()).toEqual([
      'BILL-2026-27-0001',
      'BILL-2026-27-0002',
      'BILL-2026-27-0004',
      'BILL-2026-27-0005',
      'BILL-2026-27-0006',
      'BILL-2026-27-0007',
      'BILL-2026-27-0008',
    ]);
    const [row] = await superuserSql(
      (sql) => sql<{ unbilled: string; payable: string; owed: string }[]>`
        WITH t AS (SELECT id FROM tenants WHERE slug = 'rupsha-knit')
        SELECT
          (SELECT coalesce(sum(l.credit - l.debit), 0)::text FROM journal_lines l
             JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
            WHERE a.code = '2115' AND a.tenant_id = (SELECT id FROM t)) AS unbilled,
          (SELECT coalesce(sum(l.credit - l.debit), 0)::text FROM journal_lines l
             JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
            WHERE a.code = '2110' AND a.tenant_id = (SELECT id FROM t)) AS payable,
          (SELECT coalesce(sum(total - amount_paid), 0)::text FROM bills
            WHERE status = 'posted' AND tenant_id = (SELECT id FROM t)) AS owed`,
    );
    // Every receipt is billed, so goods received not billed is back to zero; the payable is
    // what the posted bills still owe
    expect(row?.unbilled).toBe('0.0000');
    expect(row?.payable).toBe(row?.owed);
  });
});
