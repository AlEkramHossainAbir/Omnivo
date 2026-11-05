import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  type Bill,
  billAmountDueOf,
  type BillFormValues,
  type BillLineFormValues,
  billPaymentStatusOf,
  billSchema,
  branchSchema,
  canDebitWhole,
  type DebitNote,
  type DebitNoteFormValues,
  type DebitNoteLineFormValues,
  debitNotePageSchema,
  debitNoteSchema,
  debitStateOf,
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
  type PurchaseOrder,
  type PurchaseOrderLineFormValues,
  purchaseOrderSchema,
  type PurchaseReturn,
  type PurchaseReturnFormValues,
  type PurchaseReturnLineFormValues,
  purchaseReturnPageSchema,
  purchaseReturnSchema,
  type Role,
  roleSchema,
  setupSchema,
  stockCardSchema,
  type Supplier,
  type SupplierPayment,
  supplierPaymentSchema,
  type SupplierRefund,
  type SupplierRefundFormValues,
  supplierRefundPageSchema,
  supplierRefundSchema,
  supplierSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
  wholeBillDebit,
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

// Step 17d: a garments factory sends goods back to its suppliers and takes the money off. Torn
// twill goes back to the mill before the bill and after it; zippers go back in three goes; poly
// bags from a receipt leave at what the stock still holds; hangers from before Omnivo go back on
// their own and are debited with no bill; a faulty motor is debited after its bill was paid, and the
// parts centre pays the money back. Each test builds on the ones before it: read the first failure
// first.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// Rafiq, the Owner: writes and approves the orders, and sees what the stock is worth
let owner: SignedIn;
// Jamal, the store keeper: receives the goods and loads them back on the supplier's truck
let jamal: SignedIn;
// Shirin, the accountant: books the bills, the debit notes, the payments and the money back
let shirin: SignedIn;
// Rina, from the buying house: reads everything, writes nothing
let rina: SignedIn;
let units: Unit[];
let rates: TaxRate[];
let accounts: Account[];
let main: Warehouse;
// A second branch's store: its receipt booked goods received not billed for that branch
let ashulia: Warehouse;
let mill: Supplier;
let trims: Supplier;
let packaging: Supplier;
let parts: Supplier;
// Cotton twill by the metre
let twill: Product;
// Buttons by the piece, bought by the box of 144
let buttons: Product;
// Metal zippers by the piece, bought by the box of 144
let zippers: Product;
// Poly bags by the piece: some from before Omnivo at ৳2, some from a receipt at ৳3
let polyBags: Product;
// Hangers by the piece, all from before Omnivo
let hangers: Product;
// Sewing machine motors, each with its serial number
let motors: Product;
// Care labels: never in stock, so they have no cost
let labels: Product;
// Twill and buttons from the mill, 45 days
let orderA: PurchaseOrder;
// 600 m of twill and 10 boxes of buttons into the main store; 400 m into Ashulia
let grn1: GoodsReceipt;
let grn2: GoodsReceipt;
// Two motors from the parts centre
let grn3: GoodsReceipt;
// The mill's bill for both receipts and the truck rent
let bill1: Bill;
// 50 m of torn twill, back before the bill
let firstReturn: PurchaseReturn;
// 30 m of twill and a box of buttons, back after the bill
let billedReturn: PurchaseReturn;
// 40 hangers from before Omnivo
let ownReturn: PurchaseReturn;
// 250 m of Ashulia's twill, back after the bill
let ashuliaReturn: PurchaseReturn;
// The parts centre's motor, debited after its bill was paid: the supplier owes the money
let motorNote: DebitNote;
// The parts centre's second bill: servicing
let serviceBill: Bill;
// ৳50,000 paid to the mill in advance, ৳20,000 of it paid back
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

// The bill line of a product; with a receipt, the one that bills that receipt's line
function billLineOf(bill: Bill, product: Product, receipt?: GoodsReceipt): string {
  const found = bill.lines.find(
    (line) =>
      line.variantId === variantOf(product) &&
      (receipt === undefined || line.receiptLineId === receiptLineOf(receipt, product).id),
  );
  if (!found) throw new Error(`no ${product.name} on ${bill.number ?? 'the bill'}`);
  return found.id;
}

function returnLineOf(back: PurchaseReturn, product: Product): string {
  const found = back.lines.find((line) => line.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} on ${back.number ?? 'the return'}`);
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
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'padma-apparel' });
  const { items } = memberPageSchema.parse((await send('GET', '/members?limit=50')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'padma-apparel', email, password, keepSignedIn: false });
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
  paymentTermsDays = 30,
): Promise<PurchaseOrder> {
  const made = await send('POST', '/purchase-orders', {
    supplierId: supplier.id,
    date: '2026-10-12',
    expectedDate: '',
    warehouseId: main.id,
    supplierReference: '',
    paymentTermsDays,
    pricesIncludeVat: false,
    note: '',
    lines,
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
  lines: { product: Product; quantity: string; unit?: string; serialNumbers?: string[] }[],
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
        serialNumbers: line.serialNumbers ?? [],
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

// Stock counted in or written off in the main store by the Owner (step 13's adjustment): opening
// stock from before Omnivo at its cost, or damaged goods out at the average
async function adjusted(
  direction: 'in' | 'out',
  lines: { product: Product; quantity: string; unitCost?: string; serialNumbers?: string[] }[],
  date = '2026-10-01',
): Promise<void> {
  const res = await send('POST', '/stock-adjustments', {
    date,
    warehouseId: main.id,
    direction,
    reason: direction === 'in' ? 'opening' : 'damaged',
    note: '',
    post: true,
    lines: lines.map((line) => ({
      variantId: variantOf(line.product),
      unitId: line.product.baseUnitId,
      quantity: line.quantity,
      batchId: '',
      lotNumber: '',
      expiresOn: '',
      manufacturedOn: '',
      serialNumbers: line.serialNumbers ?? [],
      unitCost: line.unitCost ?? '',
    })),
  });
  expect(res.statusCode, res.body).toBe(201);
}

// A bill line as the form sends it: 15% VAT, no discount, nothing it bills
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
// what it kept (accepted less what went back before the bill), the price the person types
function receiptBillLine(
  receipt: GoodsReceipt,
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<BillLineFormValues> = {},
): BillLineFormValues {
  const line = receiptLineOf(receipt, product);
  return billLine(product, quantity, unitPrice, {
    unitId: line.unitId,
    receiptLineId: line.id,
    ...extra,
  });
}

function expense(code: string, description: string, amount: string) {
  return { accountId: accountId(code), description, amount, taxRateId: rateId('VAT 15%') };
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
    // No bill levels in this workspace: a submitted bill is posted at once
    submit: true,
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

// A line on its own: goods from before Omnivo, in the base unit
function returnLine(
  product: Product,
  quantity: string,
  extra: Partial<PurchaseReturnLineFormValues> = {},
): PurchaseReturnLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: product.baseUnitId,
    quantity,
    batchId: '',
    serialNumbers: [],
    receiptLineId: '',
    ...extra,
  };
}

// A line from a goods receipt line, as "Add from goods receipts" fills it: the item, in its base
// unit unless named
function fromReceipt(
  receipt: GoodsReceipt,
  product: Product,
  quantity: string,
  extra: Partial<PurchaseReturnLineFormValues> = {},
): PurchaseReturnLineFormValues {
  return returnLine(product, quantity, {
    receiptLineId: receiptLineOf(receipt, product).id,
    ...extra,
  });
}

function returnForm(
  supplier: Supplier,
  lines: PurchaseReturnLineFormValues[],
  extra: Partial<PurchaseReturnFormValues> = {},
): Omit<PurchaseReturnFormValues, 'version'> {
  return {
    supplierId: supplier.id,
    date: '2026-10-15',
    warehouseId: main.id,
    reason: 'damaged',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

async function returned(body: object, as = jamal): Promise<PurchaseReturn> {
  const res = await send('POST', '/purchase-returns', body, as);
  expect(res.statusCode, res.body).toBe(201);
  return purchaseReturnSchema.parse(res.json());
}

// As the Owner reads it: with the values the store keeper does not see
async function returnNow(id: string): Promise<PurchaseReturn> {
  const res = await send('GET', `/purchase-returns/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseReturnSchema.parse(res.json());
}

// A debit note line of a bill line: its quantity in the bill line's unit, a price per that unit
function debitLine(
  billLineId: string,
  unitId: string,
  quantity: string,
  unitPrice: string,
  extra: Partial<DebitNoteLineFormValues> = {},
): DebitNoteLineFormValues {
  return {
    billLineId,
    returnLineId: '',
    taxRateId: '',
    unitId,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    ...extra,
  };
}

function debitForm(
  supplier: Supplier,
  bill: Bill | null,
  lines: DebitNoteLineFormValues[],
  extra: Partial<DebitNoteFormValues> = {},
): Omit<DebitNoteFormValues, 'version'> {
  return {
    supplierId: supplier.id,
    billId: bill?.id ?? '',
    date: '2026-10-17',
    branchId: '',
    pricesIncludeVat: false,
    reason: 'goods_returned',
    supplierCreditNumber: '',
    supplierCreditDate: '',
    note: '',
    lines,
    expenses: [],
    post: true,
    ...extra,
  };
}

async function debited(body: object, as = shirin): Promise<DebitNote> {
  const res = await send('POST', '/debit-notes', body, as);
  expect(res.statusCode, res.body).toBe(201);
  return debitNoteSchema.parse(res.json());
}

async function debitNoteNow(id: string): Promise<DebitNote> {
  const res = await send('GET', `/debit-notes/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return debitNoteSchema.parse(res.json());
}

function refundForm(
  supplier: Supplier,
  amount: string,
  source: { debitNoteId?: string; paymentId?: string },
  extra: Partial<SupplierRefundFormValues> = {},
): SupplierRefundFormValues {
  return {
    supplierId: supplier.id,
    date: '2026-10-18',
    amount,
    accountId: accountId('1121'),
    method: 'bank_transfer',
    reference: '',
    branchId: main.branchId,
    note: '',
    debitNoteId: source.debitNoteId ?? '',
    paymentId: source.paymentId ?? '',
    ...extra,
  };
}

async function refunded(body: object, as = shirin): Promise<SupplierRefund> {
  const res = await send('POST', '/supplier-refunds', body, as);
  expect(res.statusCode, res.body).toBe(201);
  return supplierRefundSchema.parse(res.json());
}

async function paymentNow(id: string): Promise<SupplierPayment> {
  const res = await send('GET', `/supplier-payments/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return supplierPaymentSchema.parse(res.json());
}

// A supplier payment the accountant posts at once (no payment levels): to bills, or an advance
async function paid(
  supplier: Supplier,
  amount: string,
  allocations: { billId: string; amount: string }[],
): Promise<SupplierPayment> {
  const res = await send(
    'POST',
    '/supplier-payments',
    {
      supplierId: supplier.id,
      date: '2026-10-17',
      amount,
      accountId: accountId('1121'),
      method: 'bank_transfer',
      reference: '',
      supplierBankAccountId: '',
      branchId: main.branchId,
      orderId: '',
      note: '',
      allocations,
      submit: true,
    },
    shirin,
  );
  expect(res.statusCode, res.body).toBe(201);
  const payment = supplierPaymentSchema.parse(res.json());
  expect(payment.status).toBe('posted');
  return payment;
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
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

// The stock card's count and value, in every warehouse
async function stockOf(product: Product) {
  const card = stockCardSchema.parse(
    (await send('GET', `/stock/variants/${variantOf(product)}`)).json(),
  );
  return [card.item.onHand, card.item.value];
}

// The bill form's "Add from goods receipts" list for a supplier: [number, bill state]
async function toBill(supplier: Supplier) {
  const page = goodsReceiptPageSchema.parse(
    (await send('GET', `/goods-receipts?bill=to_bill&supplierId=${supplier.id}`)).json(),
  );
  return page.items.map((item) => [item.number, item.billState]);
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
    companyName: 'Padma Apparels Ltd.',
    workspaceSlug: 'padma-apparel',
    fullName: 'Rafiqul Islam',
    email: 'rafiq@padmaapparel.com',
    password: 'Padma-apparel-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  // The bank the supplier pays back into
  const bank = await send('POST', '/accounts', {
    parentId: accountId('1120'),
    code: '1121',
    name: 'Eastern Bank CD A/C 1041',
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

  jamal = await member(
    'jamal@padmaapparel.com',
    'Jamal Uddin',
    'Gate-register-2026',
    await addRole('Gate store', ['purchase.receipt.manage', 'purchase.return.manage']),
  );
  shirin = await member(
    'shirin@padmaapparel.com',
    'Shirin Akter',
    'Ledger-books-2026',
    await addRole('Bills desk', [
      'purchase.bill.manage',
      'purchase.debit_note.manage',
      'purchase.payment.manage',
      'purchase.refund.manage',
    ]),
  );
  rina = await member(
    'rina@padmaapparel.com',
    'Rina Begum',
    'Buying-house-2026',
    await addRole('Buying house', []),
  );

  mill = await addSupplier('Nayapara Weaving Mills', 45);
  trims = await addSupplier('Karim Trims & Accessories');
  packaging = await addSupplier('Meghna Poly Packaging');
  parts = await addSupplier('Juki Parts Centre');
  twill = await addProduct('Cotton twill 3/1, khaki', { baseUnitId: unitId('m') });
  const box = [{ unitId: unitId('box'), factor: '144', barcode: '' }];
  buttons = await addProduct('Polo button 18L', { units: box });
  zippers = await addProduct('Metal zipper 7 inch', { units: box });
  polyBags = await addProduct('Poly bag 12 x 16');
  hangers = await addProduct('Plastic hanger, black');
  motors = await addProduct('Servo motor 550 W', { tracking: 'serial' });
  labels = await addProduct('Care label, woven');

  // From before Omnivo: 100 poly bags at ৳2, 500 hangers at ৳6, one motor at ৳17,000
  await adjusted('in', [
    { product: polyBags, quantity: '100', unitCost: '2' },
    { product: hangers, quantity: '500', unitCost: '6' },
    { product: motors, quantity: '1', unitCost: '17000', serialNumbers: ['JK-40001'] },
  ]);
  orderA = await approvedOrder(
    mill,
    [
      orderLine(twill, '1000', '312.50'),
      orderLine(buttons, '10', '150', { unitId: unitId('box') }),
    ],
    45,
  );
  grn1 = await received(orderA, main, [
    { product: twill, quantity: '600' },
    { product: buttons, quantity: '10', unit: 'box' },
  ]);
  grn2 = await received(orderA, ashulia, [{ product: twill, quantity: '400' }], '2026-10-15');
  const orderM = await approvedOrder(parts, [orderLine(motors, '2', '18000')]);
  grn3 = await received(orderM, main, [
    { product: motors, quantity: '2', serialNumbers: ['JK-55001', 'JK-55002'] },
  ]);
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('purchase returns', () => {
  it('sends goods back before the bill, at what they came in at, and the order expects them again', async () => {
    expect((await orderNow(orderA.id)).status).toBe('received');
    // 50 m of the main store's twill is torn: the store keeper loads it back on the mill's truck
    firstReturn = await returned(
      returnForm(mill, [fromReceipt(grn1, twill, '50')], { note: 'Torn at the fold' }),
    );
    expect(firstReturn).toMatchObject({
      number: 'PRN-2026-27-0001',
      status: 'posted',
      receipts: [{ id: grn1.id, number: 'GRN-2026-27-0001' }],
      debitNotes: [],
    });
    // Not billed yet: nothing to debit. The store keeper does not see what it was worth.
    expect(firstReturn.lines[0]).toMatchObject({
      receiptLineId: receiptLineOf(grn1, twill).id,
      receiptNumber: 'GRN-2026-27-0001',
      billed: false,
      billLineId: null,
      debitedQuantity: '0.0000',
      value: null,
    });
    // 50 m at the receipt's ৳312.50: Dr Goods received not billed / Cr Inventory
    expect((await returnNow(firstReturn.id)).lines[0]?.value).toBe('15625.0000');
    expect(await entryLines(firstReturn.entry?.id)).toEqual([
      ['1154', '0.0000', '15625.0000', 'HO'],
      ['2115', '15625.0000', '0.0000', 'HO'],
    ]);
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${firstReturn.entry?.id ?? ''}`)).json(),
    );
    expect(entry).toMatchObject({
      source: 'purchase_return',
      narration: 'Purchase return PRN-2026-27-0001',
    });

    const receipt = await receiptNow(grn1.id);
    expect(receipt.returnState).toBe('partly_returned');
    expect(receipt.returns).toEqual([{ id: firstReturn.id, number: 'PRN-2026-27-0001' }]);
    expect(receiptLineOf(receipt, twill).returnedQuantity).toBe('50.0000');
    // The order counts the 50 m as not received (decision 3): the mill can send them again
    const order = await orderNow(orderA.id);
    expect(order.status).toBe('approved');
    expect(order.version).toBe(orderA.version + 3);
    expect(order.lines.map((line) => line.receivedQuantity)).toEqual(['950.0000', '1440.0000']);
    expect(await stockOf(twill)).toEqual(['950.0000', '296875.0000']);

    // It does: the order is received again
    const again = await received(orderA, main, [{ product: twill, quantity: '50' }], '2026-10-16');
    expect(again.number).toBe('GRN-2026-27-0004');
    expect((await orderNow(orderA.id)).status).toBe('received');
    expect(await toBill(mill)).toEqual([
      ['GRN-2026-27-0004', 'not_billed'],
      ['GRN-2026-27-0002', 'not_billed'],
      ['GRN-2026-27-0001', 'not_billed'],
    ]);
  });

  it('bills what was kept, and a return after the bill points at its bill line', async () => {
    // The bill bills what the receipt line kept: 550 m, not the 600 m that came in
    const twice = await send(
      'POST',
      '/bills',
      billForm(mill, [receiptBillLine(grn1, twill, '600', '315')], {
        supplierBillNumber: 'NWM/2026/1187',
      }),
      shirin,
    );
    expect(problemOf(twice).fieldErrors).toEqual({
      'lines.0.quantity': ['bill_receipt_line_quantity'],
    });
    bill1 = await billed(
      billForm(
        mill,
        [
          receiptBillLine(grn1, twill, '550', '315'),
          receiptBillLine(grn1, buttons, '10', '150'),
          receiptBillLine(grn2, twill, '400', '312.50'),
        ],
        {
          supplierBillNumber: 'NWM/2026/1187',
          expenses: [expense('5240', 'Truck rent from the mill', '3000')],
        },
      ),
    );
    // ৳1,73,250 + ৳1,500 + ৳1,25,000 + ৳3,000, and 15% VAT
    expect([bill1.number, bill1.status, bill1.net, bill1.vat, bill1.total]).toEqual([
      'BILL-2026-27-0001',
      'posted',
      '302750.0000',
      '45412.5000',
      '348162.5000',
    ]);
    // The receipt's value less what went back: ৳1,71,875 for the 550 m
    expect(bill1.lines[0]?.orderValue).toBe('171875.0000');

    // After the bill: 30 m more is torn, and a box of buttons has the wrong shade
    billedReturn = await returned(
      returnForm(
        mill,
        [
          fromReceipt(grn1, twill, '30'),
          fromReceipt(grn1, buttons, '1', { unitId: unitId('box') }),
        ],
        { date: '2026-10-16', reason: 'wrong_item' },
      ),
    );
    expect(billedReturn.number).toBe('PRN-2026-27-0002');
    expect(
      billedReturn.lines.map((line) => [line.billed, line.billLineId, line.billNumber]),
    ).toEqual([
      [true, billLineOf(bill1, twill, grn1), 'BILL-2026-27-0001'],
      [true, billLineOf(bill1, buttons), 'BILL-2026-27-0001'],
    ]);
    // 30 m at ৳312.50 and 144 buttons of 1,440 that came in at ৳1,500
    expect((await returnNow(billedReturn.id)).lines.map((line) => line.value)).toEqual([
      '9375.0000',
      '150.0000',
    ]);
    expect(await entryLines(billedReturn.entry?.id)).toEqual([
      ['1154', '0.0000', '9525.0000', 'HO'],
      ['2115', '9525.0000', '0.0000', 'HO'],
    ]);
    // Billed already: the order and the receipt's billing stay as they are; a debit note takes the
    // money off
    const order = await orderNow(orderA.id);
    expect([order.status, order.lines.map((line) => line.receivedQuantity)]).toEqual([
      'received',
      ['1000.0000', '1440.0000'],
    ]);
    const receipt = await receiptNow(grn1.id);
    expect([receipt.billState, receipt.returnState]).toEqual(['billed', 'partly_returned']);
    expect(receipt.lines.map((line) => line.returnedQuantity)).toEqual(['80.0000', '144.0000']);
  });

  it('refuses goods that did not come in on that receipt line, each under its own box', async () => {
    // The form's own rules: a receipt line's goods go back in its own batch, and once per return
    const form = await send(
      'POST',
      '/purchase-returns',
      returnForm(mill, [
        fromReceipt(grn1, twill, '1', { batchId: grn1.id }),
        fromReceipt(grn1, twill, '1'),
      ]),
      jamal,
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      'lines.0.batchId': ['purchase_return_batch_not_allowed'],
      'lines.1.receiptLineId': ['purchase_return_line_twice'],
    });
    // The parts centre's receipt line on the mill's return; buttons on the twill's line
    const foreign = await send(
      'POST',
      '/purchase-returns',
      returnForm(mill, [
        fromReceipt(grn3, motors, '1', { serialNumbers: ['JK-55001'] }),
        returnLine(buttons, '1', { receiptLineId: receiptLineOf(grn1, twill).id }),
      ]),
      jamal,
    );
    expect(foreign.statusCode).toBe(409);
    expect(problemOf(foreign).fieldErrors).toEqual({
      'lines.0.receiptLineId': ['purchase_return_receipt_line_invalid'],
      'lines.1.receiptLineId': ['purchase_return_receipt_line_invalid'],
    });
    // More than the line kept (600 − 80 = 520 m); labels never had a cost to leave at
    const more = await send(
      'POST',
      '/purchase-returns',
      returnForm(mill, [fromReceipt(grn1, twill, '521'), returnLine(labels, '1')]),
      jamal,
    );
    expect(problemOf(more).fieldErrors).toEqual({
      'lines.0.quantity': ['purchase_return_over_received'],
      'lines.1.variantId': ['purchase_return_cost_unknown'],
    });
    // JK-40001 is in the store, but it came before Omnivo, not on this receipt line
    const serial = await send(
      'POST',
      '/purchase-returns',
      returnForm(parts, [fromReceipt(grn3, motors, '1', { serialNumbers: ['JK-40001'] })]),
      jamal,
    );
    expect(problemOf(serial).fieldErrors).toEqual({
      'lines.0.serialNumbers': ['purchase_return_serial_invalid'],
    });
    // JK-55002 did: it goes back before the bill
    const motor = await returned(
      returnForm(parts, [fromReceipt(grn3, motors, '1', { serialNumbers: ['JK-55002'] })], {
        reason: 'damaged',
        note: 'Hums and overheats',
      }),
    );
    expect(motor.lines[0]?.serialNumbers).toEqual(['JK-55002']);
    expect(motor.lines[0]?.billed).toBe(false);
    expect((await returnNow(motor.id)).lines[0]?.value).toBe('18000.0000');
  });

  it("gives a receipt line's value back to the paisa, however many goes it takes", async () => {
    // 3 boxes of zippers at ৳1,000: 432 pieces for ৳3,000, ৳6.9444… each. Each go is worth its
    // share to the paisa.
    const order = await approvedOrder(trims, [
      orderLine(zippers, '3', '1000', { unitId: unitId('box') }),
    ]);
    const receipt = await received(order, main, [{ product: zippers, quantity: '3', unit: 'box' }]);
    const values: (string | null | undefined)[] = [];
    for (const quantity of ['100', '100', '232']) {
      const back = await returned(returnForm(trims, [fromReceipt(receipt, zippers, quantity)]));
      values.push((await returnNow(back.id)).lines[0]?.value);
    }
    // Each go is worked out over everything back so far: no paisa is lost or made by rounding
    expect(values).toEqual(['694.4400', '694.4500', '1611.1100']);
    expect(await stockOf(zippers)).toEqual(['0.0000', '0.0000']);
    const after = await receiptNow(receipt.id);
    expect([after.returnState, after.billState]).toEqual(['returned', 'not_billed']);
    // Nothing left on it to bill, and the order expects all of it again
    expect(await toBill(trims)).toEqual([]);
    const now = await orderNow(order.id);
    expect([now.status, now.lines[0]?.receivedQuantity]).toEqual(['approved', '0.0000']);
  });

  it('leaves at what the stock still holds, and books the difference (decision 32)', async () => {
    // 100 bags at ৳2 from before Omnivo and 100 at ৳3 from the receipt: 200 bags worth ৳500.
    // 100 are written off at the average, ৳250. The receipt's 100 go back: they came in at ৳300,
    // but the stock holds ৳250 for its last 100 bags.
    const order = await approvedOrder(packaging, [orderLine(polyBags, '100', '3')]);
    const receipt = await received(order, main, [{ product: polyBags, quantity: '100' }]);
    await adjusted('out', [{ product: polyBags, quantity: '100' }], '2026-10-15');
    expect(await stockOf(polyBags)).toEqual(['100.0000', '250.0000']);
    const back = await returned(
      returnForm(packaging, [fromReceipt(receipt, polyBags, '100')], { date: '2026-10-16' }),
    );
    // Goods received not billed gets the receipt's ৳300 back, so the bill or debit note can clear
    // it; the stock gives its ৳250; the ৳50 is a price difference
    expect((await returnNow(back.id)).lines[0]?.value).toBe('300.0000');
    expect(await entryLines(back.entry?.id)).toEqual([
      ['1154', '0.0000', '250.0000', 'HO'],
      ['2115', '300.0000', '0.0000', 'HO'],
      ['5180', '0.0000', '50.0000', 'HO'],
    ]);
    expect(await stockOf(polyBags)).toEqual(['0.0000', '0.0000']);
  });

  it('sends back goods from before Omnivo at the average cost', async () => {
    ownReturn = await returned(
      returnForm(packaging, [returnLine(hangers, '40')], { reason: 'damaged' }),
    );
    expect(ownReturn.lines[0]).toMatchObject({
      receiptLineId: null,
      receiptNumber: null,
      billed: false,
    });
    expect(ownReturn.receipts).toEqual([]);
    expect((await returnNow(ownReturn.id)).lines[0]?.value).toBe('240.0000');
    expect(await entryLines(ownReturn.entry?.id)).toEqual([
      ['1154', '0.0000', '240.0000', 'HO'],
      ['2115', '240.0000', '0.0000', 'HO'],
    ]);
  });

  it('keeps drafts free, and checks them again when they are posted', async () => {
    // Two drafts for Ashulia's twill, each fine on its own: a draft holds nothing
    const draft = (quantity: string) =>
      returned(
        returnForm(mill, [fromReceipt(grn2, twill, quantity)], {
          warehouseId: ashulia.id,
          post: false,
        }),
      );
    const first = await draft('250');
    const second = await draft('250');
    expect([first.number, first.status, first.entry]).toEqual([null, 'draft', null]);
    const posted = await send(
      'POST',
      `/purchase-returns/${first.id}/post`,
      { version: first.version },
      jamal,
    );
    expect(posted.statusCode, posted.body).toBe(200);
    // Ashulia's goods put their cost back at Ashulia, where the receipt booked it
    const firstNow = purchaseReturnSchema.parse(posted.json());
    ashuliaReturn = firstNow;
    expect(await entryLines(firstNow.entry?.id)).toEqual([
      ['1154', '0.0000', '78125.0000', 'ASH'],
      ['2115', '78125.0000', '0.0000', 'ASH'],
    ]);
    // 150 m are left on the line: the second draft is checked again, and stays a draft
    const late = await send(
      'POST',
      `/purchase-returns/${second.id}/post`,
      { version: second.version },
      jamal,
    );
    expect(late.statusCode).toBe(409);
    expect(problemOf(late).fieldErrors).toEqual({
      'lines.0.quantity': ['purchase_return_over_received'],
    });
    expect((await returnNow(second.id)).status).toBe('draft');
    // A stale version, a posted return changed, and a draft deleted
    const stale = await send(
      'PUT',
      `/purchase-returns/${second.id}`,
      {
        ...returnForm(mill, [fromReceipt(grn2, twill, '100')], { warehouseId: ashulia.id }),
        version: second.version + 1,
      },
      jamal,
    );
    expect(problemOf(stale).code).toBe('version_conflict');
    const changed = await send(
      'PUT',
      `/purchase-returns/${first.id}`,
      { ...returnForm(mill, [fromReceipt(grn2, twill, '1')]), version: firstNow.version },
      jamal,
    );
    expect(problemOf(changed).code).toBe('stock_not_draft');
    const removed = await send(
      'DELETE',
      `/purchase-returns/${second.id}?version=${String(second.version)}`,
      undefined,
      jamal,
    );
    expect(removed.statusCode).toBe(204);
    expect((await send('GET', `/purchase-returns/${second.id}`)).statusCode).toBe(404);
    const drafts = purchaseReturnPageSchema.parse(
      (await send('GET', '/purchase-returns?status=draft')).json(),
    );
    expect(drafts.items).toEqual([]);
    const ashuliaReturns = purchaseReturnPageSchema.parse(
      (await send('GET', `/purchase-returns?warehouseId=${ashulia.id}`)).json(),
    );
    expect(ashuliaReturns.items.map((item) => item.number)).toEqual([firstNow.number]);
  });

  it('leaves a closed order closed', async () => {
    const order = await approvedOrder(trims, [
      orderLine(buttons, '20', '150', { unitId: unitId('box') }),
    ]);
    const receipt = await received(order, main, [{ product: buttons, quantity: '5', unit: 'box' }]);
    const before = await orderNow(order.id);
    const closed = await send('POST', `/purchase-orders/${order.id}/close`, {
      version: before.version,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const closedOrder = purchaseOrderSchema.parse(closed.json());
    await returned(
      returnForm(trims, [fromReceipt(receipt, buttons, '1', { unitId: unitId('box') })]),
    );
    // The line counts what is kept, but nobody reopens a closed order by sending goods back
    const now = await orderNow(order.id);
    expect([now.status, now.version, now.lines[0]?.receivedQuantity]).toEqual([
      'closed',
      closedOrder.version,
      '576.0000',
    ]);
  });
});

describe('debit notes', () => {
  it('takes the money off for goods that went back after the bill', async () => {
    const twillLine = billLineOf(bill1, twill, grn1);
    const buttonLine = billLineOf(bill1, buttons);
    const note = await debited(
      debitForm(
        mill,
        bill1,
        [
          debitLine(twillLine, unitId('m'), '30', '315', {
            returnLineId: returnLineOf(billedReturn, twill),
          }),
          debitLine(buttonLine, unitId('box'), '1', '150', {
            returnLineId: returnLineOf(billedReturn, buttons),
          }),
        ],
        { supplierCreditNumber: 'NWM-CN-0045', supplierCreditDate: '2026-10-17' },
      ),
    );
    // ৳9,450 + ৳150, and 15% VAT. The mill billed the twill at ৳315: ৳75 more than it came in at.
    expect(note).toMatchObject({
      number: 'DN-2026-27-0001',
      status: 'posted',
      bill: { id: bill1.id, number: 'BILL-2026-27-0001', supplierBillNumber: 'NWM/2026/1187' },
      branchId: main.branchId,
      pricesIncludeVat: false,
      supplierCreditNumber: 'NWM-CN-0045',
      supplierCreditDate: '2026-10-17',
      net: '9600.0000',
      vat: '1440.0000',
      total: '11040.0000',
      // The bill owes more than this: all of it comes off the bill
      applied: '11040.0000',
      refunded: '0.0000',
    });
    expect(note.lines.map((line) => line.returnNumber)).toEqual([
      'PRN-2026-27-0002',
      'PRN-2026-27-0002',
    ]);
    expect(note.allocations.map((row) => [row.billId, row.amount])).toEqual([
      [bill1.id, '11040.0000'],
    ]);
    // Dr Accounts payable / Cr Goods received not billed (the goods' receipt cost) / Cr Purchase
    // price difference (what the bill charged above it) / Cr Input VAT. GRNI for them is now zero.
    expect(await entryLines(note.entry?.id)).toEqual([
      ['1170', '0.0000', '1440.0000', 'HO'],
      ['2110', '11040.0000', '0.0000', 'HO'],
      ['2115', '0.0000', '9525.0000', 'HO'],
      ['5180', '0.0000', '75.0000', 'HO'],
    ]);
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${note.entry?.id ?? ''}`)).json(),
    );
    expect(entry.source).toBe('purchase_debit_note');

    const bill = await billNow(bill1.id);
    expect([bill.amountDebited, bill.debitNoteTotal, bill.version]).toEqual([
      '11040.0000',
      '11040.0000',
      bill1.version,
    ]);
    expect([debitStateOf(bill), billPaymentStatusOf(bill)]).toEqual([
      'partly_debited',
      'partly_paid',
    ]);
    expect(bill.debitNotes).toEqual([
      { id: note.id, number: 'DN-2026-27-0001', date: '2026-10-17', total: '11040.0000' },
    ]);
    expect(bill.lines.map((line) => line.debited)).toEqual(['10867.5000', '172.5000', '0.0000']);
    // A posted debit note exists: "Debit whole bill" would take off more than is left
    expect(canDebitWhole(bill)).toBe(false);
    const back = await returnNow(billedReturn.id);
    expect(back.lines.map((line) => line.debitedQuantity)).toEqual(['30.0000', '144.0000']);
    expect(back.debitNotes).toEqual([{ id: note.id, number: 'DN-2026-27-0001' }]);
    const list = debitNotePageSchema.parse(
      (await send('GET', `/debit-notes?billId=${bill1.id}`)).json(),
    );
    expect(list.items.map((item) => item.number)).toEqual(['DN-2026-27-0001']);
  });

  it('refuses what the bill did not bill, each under its own box', async () => {
    const twillLine = billLineOf(bill1, twill, grn1);
    // The form's own rules: a bill line brings its VAT rate; a Mushak date needs its number;
    // something must come off
    const form = await send(
      'POST',
      '/debit-notes',
      debitForm(
        mill,
        bill1,
        [debitLine(twillLine, unitId('m'), '1', '10', { taxRateId: rateId('VAT 15%') })],
        { supplierCreditDate: '2026-10-17' },
      ),
      shirin,
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      'lines.0.taxRateId': ['debit_note_tax_rate_not_allowed'],
      supplierCreditNumber: ['debit_note_supplier_credit_required'],
    });
    const empty = await send('POST', '/debit-notes', debitForm(mill, bill1, []), shirin);
    expect(problemOf(empty).fieldErrors).toEqual({ lines: ['purchase_lines_required'] });
    // Another supplier's bill; a day before the bill
    const supplier = await send(
      'POST',
      '/debit-notes',
      debitForm(trims, bill1, [debitLine(twillLine, unitId('m'), '1', '10')]),
      shirin,
    );
    expect(problemOf(supplier).fieldErrors).toEqual({ billId: ['debit_note_bill_invalid'] });
    const early = await send(
      'POST',
      '/debit-notes',
      debitForm(mill, bill1, [debitLine(twillLine, unitId('m'), '1', '10')], {
        date: '2026-10-15',
      }),
      shirin,
    );
    expect(problemOf(early).fieldErrors).toEqual({ date: ['debit_note_date'] });
    // A bill that is still a draft has nothing to take off yet
    const draftBill = await billed(
      billForm(trims, [], {
        supplierBillNumber: 'KTA-7790',
        expenses: [expense('5240', 'Courier', '500')],
        submit: false,
      }),
    );
    const draft = await send(
      'POST',
      '/debit-notes',
      debitForm(trims, draftBill, [], {
        expenses: [{ billExpenseId: draftBill.expenses[0]?.id ?? '', amount: '100' }],
      }),
      shirin,
    );
    expect(problemOf(draft).fieldErrors).toEqual({ billId: ['debit_note_bill_invalid'] });

    // Line by line: a line of another bill; a return line this bill line did not bill (it went
    // back before the bill); more than the bill line billed, in any unit of the item (1,441
    // buttons of 10 boxes); a unit that is not the item's; more than went back less what was
    // debited already
    const lines = await send(
      'POST',
      '/debit-notes',
      debitForm(mill, bill1, [
        debitLine(draftBill.id, unitId('m'), '1', '10'),
        debitLine(twillLine, unitId('m'), '1', '315', {
          returnLineId: returnLineOf(firstReturn, twill),
        }),
        debitLine(billLineOf(bill1, buttons), unitId('pcs'), '1441', '0.10'),
        debitLine(twillLine, unitId('pcs'), '1', '1'),
        debitLine(twillLine, unitId('m'), '1', '315', {
          returnLineId: returnLineOf(billedReturn, twill),
        }),
      ]),
      shirin,
    );
    expect(lines.statusCode).toBe(409);
    expect(problemOf(lines).fieldErrors).toEqual({
      'lines.0.billLineId': ['debit_note_line_invalid'],
      'lines.1.returnLineId': ['debit_note_return_invalid'],
      'lines.2.quantity': ['debit_note_over_quantity'],
      'lines.3.unitId': ['stock_unit_invalid'],
      'lines.4.quantity': ['debit_note_over_return'],
    });
  });

  it('caps the money on each bill line and expense, under every line that takes from it', async () => {
    const ashuliaLine = billLineOf(bill1, twill, grn2);
    const truck = bill1.expenses[0]?.id ?? '';
    // Ashulia's line charged ৳1,25,000 + ৳18,750 VAT. Two cuts together come to ৳1,44,900.
    const over = await send(
      'POST',
      '/debit-notes',
      debitForm(
        mill,
        bill1,
        [
          debitLine(ashuliaLine, unitId('m'), '400', '300'),
          debitLine(ashuliaLine, unitId('m'), '100', '60'),
        ],
        { reason: 'price_adjustment', expenses: [{ billExpenseId: truck, amount: '3001' }] },
      ),
      shirin,
    );
    expect(over.statusCode).toBe(409);
    expect(problemOf(over).fieldErrors).toEqual({
      'lines.0.unitPrice': ['debit_note_over_line'],
      'lines.1.unitPrice': ['debit_note_over_line'],
    });
    const expenseOver = await send(
      'POST',
      '/debit-notes',
      debitForm(mill, bill1, [], {
        reason: 'price_adjustment',
        expenses: [{ billExpenseId: truck, amount: '3001' }],
      }),
      shirin,
    );
    expect(problemOf(expenseOver).fieldErrors).toEqual({
      'expenses.0.amount': ['debit_note_over_line'],
    });
    const foreign = await send(
      'POST',
      '/debit-notes',
      debitForm(mill, bill1, [], {
        reason: 'price_adjustment',
        expenses: [{ billExpenseId: ashuliaLine, amount: '1' }],
      }),
      shirin,
    );
    expect(problemOf(foreign).fieldErrors).toEqual({
      'expenses.0.billExpenseId': ['debit_note_expense_invalid'],
    });
    // What the mill agreed: ৳2.50 off each of Ashulia's 400 m, and ৳1,000 off the truck rent
    const cut = await debited(
      debitForm(mill, bill1, [debitLine(ashuliaLine, unitId('m'), '400', '2.50')], {
        reason: 'price_adjustment',
        expenses: [{ billExpenseId: truck, amount: '1000' }],
      }),
    );
    expect([cut.net, cut.vat, cut.total]).toEqual(['2000.0000', '300.0000', '2300.0000']);
    expect(cut.expenses[0]).toMatchObject({
      billExpenseId: truck,
      accountId: accountId('5240'),
      description: 'Truck rent from the mill',
      total: '1150.0000',
    });
    // No goods went back: the twill's ৳1,000 is all price difference, at the bill's branch
    expect(await entryLines(cut.entry?.id)).toEqual([
      ['1170', '0.0000', '300.0000', 'HO'],
      ['2110', '2300.0000', '0.0000', 'HO'],
      ['5180', '0.0000', '1000.0000', 'HO'],
      ['5240', '0.0000', '1000.0000', 'HO'],
    ]);
    const bill = await billNow(bill1.id);
    expect(bill.amountDebited).toBe('13340.0000');
    expect(bill.expenses[0]?.debited).toBe('1150.0000');
  });

  it("clears goods received not billed at the receipt's branch, below the receipt's cost too", async () => {
    // Ashulia's 250 m came in at ৳312.50 and the bill charged that, less the ৳2.50 already cut:
    // the mill takes them off at ৳310. ৳625 less than they came in at is a price difference the
    // other way: a debit.
    const note = await debited(
      debitForm(mill, bill1, [
        debitLine(billLineOf(bill1, twill, grn2), unitId('m'), '250', '310', {
          returnLineId: returnLineOf(ashuliaReturn, twill),
        }),
      ]),
    );
    expect([note.net, note.vat, note.total]).toEqual(['77500.0000', '11625.0000', '89125.0000']);
    // The bill's branch for the payable and the VAT; Ashulia's for the goods received not billed
    expect(await entryLines(note.entry?.id)).toEqual([
      ['1170', '0.0000', '11625.0000', 'HO'],
      ['2110', '89125.0000', '0.0000', 'HO'],
      ['2115', '0.0000', '78125.0000', 'ASH'],
      ['5180', '625.0000', '0.0000', 'HO'],
    ]);
  });

  it('debits a whole bill in one click, to the paisa, the way the bill worked it out', async () => {
    // Bought over the counter, prices with VAT: 7 boxes of buttons at ৳173.33 and a courier at
    // ৳575. The supplier sent the wrong buttons and took the whole bill back.
    const counter = await billed(
      billForm(trims, [billLine(buttons, '7', '173.33', { unitId: unitId('box') })], {
        warehouseId: main.id,
        pricesIncludeVat: true,
        supplierBillNumber: 'KTA-7781',
        expenses: [expense('5240', 'Courier from Islampur', '575')],
      }),
    );
    expect(canDebitWhole(counter)).toBe(true);
    const whole = wholeBillDebit(counter);
    const draft = await debited(
      debitForm(trims, counter, whole.lines, {
        expenses: whole.expenses,
        reason: 'billing_error',
        post: false,
      }),
    );
    expect([draft.status, draft.number, draft.total]).toEqual(['draft', null, counter.total]);
    expect(draft.pricesIncludeVat).toBe(true);
    // A draft takes nothing off yet
    expect((await billNow(counter.id)).amountDebited).toBe('0.0000');
    const posted = await send(
      'POST',
      `/debit-notes/${draft.id}/post`,
      { version: draft.version },
      shirin,
    );
    expect(posted.statusCode, posted.body).toBe(200);
    const note = debitNoteSchema.parse(posted.json());
    expect([note.net, note.vat, note.total, note.applied]).toEqual([
      counter.net,
      counter.vat,
      counter.total,
      counter.total,
    ]);
    const bill = await billNow(counter.id);
    expect([debitStateOf(bill), billPaymentStatusOf(bill), bill.amountPaid]).toEqual([
      'debited',
      'paid',
      '0.0000',
    ]);
    // Every line and expense, as billed
    expect(bill.lines.map((line) => line.debited)).toEqual(bill.lines.map((line) => line.total));
    expect(bill.expenses.map((item) => item.debited)).toEqual(
      bill.expenses.map((item) => item.total),
    );
    expect(canDebitWhole(bill)).toBe(false);
    const rows = await entryLines(note.entry?.id);
    expect(rows.map((row) => row[0])).toEqual(['1170', '2110', '5180', '5240']);
    expect(rows[1]).toEqual(['2110', counter.total, '0.0000', 'HO']);
    // A posted debit note is final
    const changed = await send(
      'PUT',
      `/debit-notes/${note.id}`,
      { ...debitForm(trims, counter, whole.lines), version: note.version },
      shirin,
    );
    expect(problemOf(changed).code).toBe('purchase_not_draft');
  });

  it('keeps what a paid bill no longer owes as money the supplier owes, and applies it later', async () => {
    // The parts centre billed the motor it kept, and was paid in full
    const motorBill = await billed(
      billForm(parts, [receiptBillLine(grn3, motors, '1', '18000')], {
        supplierBillNumber: 'JPC-0912',
      }),
    );
    expect(motorBill.lines[0]?.serialNumbers).toEqual(['JK-55001']);
    await paid(parts, motorBill.total, [{ billId: motorBill.id, amount: motorBill.total }]);
    // Then JK-55001 fails too: it goes back, and the debit note finds nothing left to owe
    const back = await returned(
      returnForm(parts, [fromReceipt(grn3, motors, '1', { serialNumbers: ['JK-55001'] })], {
        date: '2026-10-17',
      }),
    );
    motorNote = await debited(
      debitForm(parts, motorBill, [
        debitLine(billLineOf(motorBill, motors), unitId('pcs'), '1', '18000', {
          returnLineId: returnLineOf(back, motors),
        }),
      ]),
    );
    expect([motorNote.total, motorNote.applied, motorNote.allocations]).toEqual([
      '20700.0000',
      '0.0000',
      [],
    ]);
    expect(await entryLines(motorNote.entry?.id)).toEqual([
      ['1170', '0.0000', '2700.0000', 'HO'],
      ['2110', '20700.0000', '0.0000', 'HO'],
      ['2115', '0.0000', '18000.0000', 'HO'],
    ]);
    expect(billPaymentStatusOf(await billNow(motorBill.id))).toBe('paid');

    // The next bill shows the money the supplier owes, like an advance
    serviceBill = await billed(
      billForm(parts, [], {
        supplierBillNumber: 'JPC-0958',
        expenses: [expense('5270', 'Servicing of 12 lockstitch machines', '10000')],
      }),
    );
    expect(serviceBill.openDebitNotes).toEqual([
      {
        debitNoteId: motorNote.id,
        debitNoteNumber: motorNote.number,
        date: '2026-10-17',
        bill: { id: motorBill.id, number: motorBill.number },
        unapplied: '20700.0000',
      },
    ]);
    // Applied to a bill of another supplier, past what the bill owes, past what the note has
    const allocate = (allocations: { billId: string; amount: string }[], version: number) =>
      send('PUT', `/debit-notes/${motorNote.id}/allocations`, { version, allocations }, shirin);
    const foreign = await allocate([{ billId: bill1.id, amount: '100' }], motorNote.version);
    expect(problemOf(foreign).fieldErrors).toEqual({
      'allocations.0.billId': ['debit_note_allocation_invalid'],
    });
    const overBill = await allocate(
      [{ billId: serviceBill.id, amount: '11501' }],
      motorNote.version,
    );
    expect(problemOf(overBill).fieldErrors).toEqual({
      'allocations.0.amount': ['debit_note_over_bill'],
    });
    const overNote = await allocate(
      [
        { billId: serviceBill.id, amount: '11500' },
        { billId: motorBill.id, amount: '9201' },
      ],
      motorNote.version,
    );
    expect(problemOf(overNote).code).toBe('debit_note_over_allocated');
    const applied = await allocate([{ billId: serviceBill.id, amount: '5000' }], motorNote.version);
    expect(applied.statusCode, applied.body).toBe(200);
    motorNote = debitNoteSchema.parse(applied.json());
    expect(motorNote.applied).toBe('5000.0000');
    serviceBill = await billNow(serviceBill.id);
    expect([serviceBill.amountDebited, billPaymentStatusOf(serviceBill)]).toEqual([
      '5000.0000',
      'partly_paid',
    ]);
    // Applied money is not a debit of the bill: it was written for the motor's bill
    expect([serviceBill.debitNoteTotal, debitStateOf(serviceBill)]).toEqual(['0.0000', 'none']);
  });

  it('takes money off goods from before Omnivo, with no bill', async () => {
    // The form's own rules without a bill: a return line, a VAT rate, a branch, no expenses
    const form = await send(
      'POST',
      '/debit-notes',
      debitForm(packaging, null, [debitLine('', unitId('pcs'), '40', '6.50')], {
        expenses: [{ billExpenseId: bill1.expenses[0]?.id ?? '', amount: '1' }],
      }),
      shirin,
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      branchId: ['purchase_branch_invalid'],
      expenses: ['debit_note_expense_invalid'],
      'lines.0.returnLineId': ['debit_note_return_required'],
      'lines.0.taxRateId': ['tax_rate_invalid'],
    });
    // A return line of a receipt is debited on its bill; more than went back
    const lines = await send(
      'POST',
      '/debit-notes',
      debitForm(
        packaging,
        null,
        [
          debitLine('', unitId('m'), '1', '1', {
            returnLineId: returnLineOf(firstReturn, twill),
            taxRateId: rateId('VAT 15%'),
          }),
          debitLine('', unitId('pcs'), '41', '6.50', {
            returnLineId: returnLineOf(ownReturn, hangers),
            taxRateId: rateId('VAT 15%'),
          }),
        ],
        { branchId: main.branchId },
      ),
      shirin,
    );
    expect(problemOf(lines).fieldErrors).toEqual({
      'lines.0.returnLineId': ['debit_note_return_invalid'],
      'lines.1.quantity': ['debit_note_over_return'],
    });
    // The 40 hangers at the supplier's ৳6.50 a piece and 15% VAT
    const note = await debited(
      debitForm(
        packaging,
        null,
        [
          debitLine('', unitId('pcs'), '40', '6.50', {
            returnLineId: returnLineOf(ownReturn, hangers),
            taxRateId: rateId('VAT 15%'),
          }),
        ],
        { branchId: main.branchId },
      ),
    );
    expect(note).toMatchObject({
      bill: null,
      net: '260.0000',
      vat: '39.0000',
      total: '299.0000',
      applied: '0.0000',
    });
    expect(note.lines[0]).toMatchObject({ billLineId: null, returnNumber: ownReturn.number });
    // The ৳240 the return put on goods received not billed comes off; ৳20 above it is a difference
    expect(await entryLines(note.entry?.id)).toEqual([
      ['1170', '0.0000', '39.0000', 'HO'],
      ['2110', '299.0000', '0.0000', 'HO'],
      ['2115', '0.0000', '240.0000', 'HO'],
      ['5180', '0.0000', '20.0000', 'HO'],
    ]);
    expect((await returnNow(ownReturn.id)).debitNotes).toEqual([
      { id: note.id, number: note.number },
    ]);
  });

  it('lets two debit notes of one bill line take turns: the second finds less left', async () => {
    // The buttons line charged ৳1,725 and ৳172.50 came off: ৳1,552.50 is left. Two drafts of
    // ৳1,150 each fit alone, not together.
    const buttonLine = billLineOf(bill1, buttons);
    const draft = () =>
      debited(
        debitForm(mill, bill1, [debitLine(buttonLine, unitId('box'), '1', '1000')], {
          reason: 'price_adjustment',
          post: false,
        }),
      );
    const [a, b] = [await draft(), await draft()];
    const answers = await Promise.all(
      [a, b].map((note) =>
        send('POST', `/debit-notes/${note.id}/post`, { version: note.version }, shirin),
      ),
    );
    expect(answers.map((res) => res.statusCode).toSorted()).toEqual([200, 409]);
    const refused = answers.find((res) => res.statusCode === 409);
    expect(refused && problemOf(refused).fieldErrors).toEqual({
      'lines.0.unitPrice': ['debit_note_over_line'],
    });
    expect((await billNow(bill1.id)).lines[1]?.debited).toBe('1322.5000');
    // The one that lost is still a draft: lowered to ৳200 a box it fits, or it is deleted
    const loser = answers[0]?.statusCode === 409 ? a : b;
    const lowered = await send(
      'PUT',
      `/debit-notes/${loser.id}`,
      {
        ...debitForm(mill, bill1, [debitLine(buttonLine, unitId('box'), '1', '200')], {
          reason: 'price_adjustment',
          post: false,
        }),
        version: loser.version,
      },
      shirin,
    );
    expect(lowered.statusCode, lowered.body).toBe(200);
    const kept = debitNoteSchema.parse(lowered.json());
    expect([kept.status, kept.total, kept.version]).toEqual([
      'draft',
      '230.0000',
      loser.version + 1,
    ]);
    const removed = await send(
      'DELETE',
      `/debit-notes/${kept.id}?version=${String(kept.version)}`,
      undefined,
      shirin,
    );
    expect(removed.statusCode).toBe(204);
    expect((await send('GET', `/debit-notes/${kept.id}`)).statusCode).toBe(404);
  });
});

describe('supplier refunds', () => {
  let refund: SupplierRefund;

  it("records a debit note's money paid back, and gives it back when voided", async () => {
    // The parts centre pays the rest of the motor's money into the bank: ৳20,700 − ৳5,000
    refund = await refunded(
      refundForm(parts, '15700', { debitNoteId: motorNote.id }, { reference: 'EBL-778120' }),
    );
    expect(refund).toMatchObject({
      number: 'SRF-2026-27-0001',
      status: 'posted',
      amount: '15700.0000',
      source: { type: 'debit_note', id: motorNote.id, number: motorNote.number },
    });
    // Dr the bank / Cr Accounts payable: the supplier no longer owes it
    expect(await entryLines(refund.entry.id)).toEqual([
      ['1121', '15700.0000', '0.0000', 'HO'],
      ['2110', '0.0000', '15700.0000', 'HO'],
    ]);
    const note = await debitNoteNow(motorNote.id);
    expect([note.applied, note.refunded]).toEqual(['5000.0000', '15700.0000']);
    // Nothing is left: no second refund, and no more to apply
    const again = await send(
      'POST',
      '/supplier-refunds',
      refundForm(parts, '1', { debitNoteId: motorNote.id }),
      shirin,
    );
    expect(problemOf(again).fieldErrors).toEqual({ amount: ['supplier_refund_over_source'] });
    const allocate = await send(
      'PUT',
      `/debit-notes/${motorNote.id}/allocations`,
      { version: note.version, allocations: [{ billId: serviceBill.id, amount: '5001' }] },
      shirin,
    );
    expect(problemOf(allocate).code).toBe('debit_note_over_allocated');
    expect((await billNow(serviceBill.id)).openDebitNotes).toEqual([]);

    // The bank returns the transfer: voided, on a day not before it
    const early = await send(
      'POST',
      `/supplier-refunds/${refund.id}/void`,
      { version: refund.version, date: '2026-10-17', reason: 'Transfer returned by the bank' },
      shirin,
    );
    expect(problemOf(early).fieldErrors).toEqual({ date: ['payment_void_date'] });
    const voided = await send(
      'POST',
      `/supplier-refunds/${refund.id}/void`,
      { version: refund.version, date: '2026-10-18', reason: 'Transfer returned by the bank' },
      shirin,
    );
    expect(voided.statusCode, voided.body).toBe(200);
    refund = supplierRefundSchema.parse(voided.json());
    expect([refund.status, refund.voidDate, refund.voidReason]).toEqual([
      'voided',
      '2026-10-18',
      'Transfer returned by the bank',
    ]);
    expect(await entryLines(refund.voidEntry?.id)).toEqual([
      ['1121', '0.0000', '15700.0000', 'HO'],
      ['2110', '15700.0000', '0.0000', 'HO'],
    ]);
    expect((await debitNoteNow(motorNote.id)).refunded).toBe('0.0000');
    const twice = await send(
      'POST',
      `/supplier-refunds/${refund.id}/void`,
      { version: refund.version, date: '2026-10-18', reason: 'Again' },
      shirin,
    );
    expect(problemOf(twice).code).toBe('supplier_refund_voided');
  });

  it("pays back a payment's advance, and the payment cannot be voided while it is", async () => {
    // ৳50,000 in advance for the next fabric; the mill sends ৳20,000 of it back
    advance = await paid(mill, '50000', []);
    const back = await refunded(refundForm(mill, '20000', { paymentId: advance.id }));
    expect(back.source).toEqual({
      type: 'supplier_payment',
      id: advance.id,
      number: advance.number,
    });
    const payment = await paymentNow(advance.id);
    expect([payment.applied, payment.refunded]).toEqual(['0.0000', '20000.0000']);
    // Only the ৳30,000 left can be applied
    const allocate = await send(
      'PUT',
      `/supplier-payments/${advance.id}/allocations`,
      { version: payment.version, allocations: [{ billId: bill1.id, amount: '30001' }] },
      shirin,
    );
    expect(problemOf(allocate).code).toBe('payment_over_allocated');
    const voided = await send(
      'POST',
      `/supplier-payments/${advance.id}/void`,
      { version: payment.version, date: '2026-10-18', reason: 'Cheque bounced' },
      shirin,
    );
    expect(problemOf(voided).code).toBe('payment_has_refunds');
    expect((await paymentNow(advance.id)).status).toBe('posted');
  });

  it('pays back only from a posted source of the same supplier', async () => {
    const form = await send(
      'POST',
      '/supplier-refunds',
      refundForm(parts, '1', { debitNoteId: motorNote.id, paymentId: motorNote.id }),
      shirin,
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({ debitNoteId: ['supplier_refund_source'] });
    // The parts centre's debit note on the mill's refund; a draft debit note
    const foreign = await send(
      'POST',
      '/supplier-refunds',
      refundForm(mill, '1', { debitNoteId: motorNote.id }),
      shirin,
    );
    expect(problemOf(foreign).fieldErrors).toEqual({
      debitNoteId: ['supplier_refund_source_invalid'],
    });
    const draft = await debited(
      debitForm(mill, bill1, [debitLine(billLineOf(bill1, buttons), unitId('box'), '1', '1')], {
        reason: 'price_adjustment',
        post: false,
      }),
    );
    const unposted = await send(
      'POST',
      '/supplier-refunds',
      refundForm(mill, '1', { debitNoteId: draft.id }),
      shirin,
    );
    expect(problemOf(unposted).fieldErrors).toEqual({
      debitNoteId: ['supplier_refund_source_invalid'],
    });
    const page = supplierRefundPageSchema.parse(
      (await send('GET', `/supplier-refunds?supplierId=${parts.id}`)).json(),
    );
    expect(page.items.map((item) => [item.number, item.status])).toEqual([
      ['SRF-2026-27-0001', 'voided'],
    ]);
  });

  it('lets two refunds of the last money take turns: the second finds nothing left', async () => {
    // After the void the motor's ৳15,700 is the supplier's to pay back again
    const answers = await Promise.all(
      [1, 2].map(() =>
        send(
          'POST',
          '/supplier-refunds',
          refundForm(parts, '15700', { debitNoteId: motorNote.id }),
          shirin,
        ),
      ),
    );
    expect(answers.map((res) => res.statusCode).toSorted()).toEqual([201, 409]);
    const refused = answers.find((res) => res.statusCode === 409);
    expect(refused && problemOf(refused).fieldErrors).toEqual({
      amount: ['supplier_refund_over_source'],
    });
    expect((await debitNoteNow(motorNote.id)).refunded).toBe('15700.0000');
  });
});

describe('who may do what', () => {
  it('lets anyone read returns, debit notes and refunds, and only the right people write them', async () => {
    for (const url of [
      '/purchase-returns',
      `/purchase-returns/${firstReturn.id}`,
      '/debit-notes',
      `/debit-notes/${motorNote.id}`,
      '/supplier-refunds',
    ]) {
      expect((await send('GET', url, undefined, rina)).statusCode, url).toBe(200);
    }
    const ownLine = returnLine(hangers, '1');
    const writes = [
      send('POST', '/purchase-returns', returnForm(packaging, [ownLine]), rina),
      send(
        'POST',
        '/debit-notes',
        debitForm(mill, bill1, [debitLine(billLineOf(bill1, buttons), unitId('box'), '1', '1')]),
        rina,
      ),
      send(
        'PUT',
        `/debit-notes/${motorNote.id}/allocations`,
        { version: 1, allocations: [] },
        rina,
      ),
      send(
        'POST',
        '/supplier-refunds',
        refundForm(parts, '1', { debitNoteId: motorNote.id }),
        rina,
      ),
    ];
    for (const res of await Promise.all(writes)) {
      expect(res.statusCode).toBe(403);
      expect(problemOf(res).code).toBe('permission_missing');
    }
    // The store keeper sends goods back and moves no money; the accountant the other way round
    const refused = await Promise.all([
      send(
        'POST',
        '/debit-notes',
        debitForm(mill, bill1, [debitLine(billLineOf(bill1, buttons), unitId('box'), '1', '1')]),
        jamal,
      ),
      send(
        'POST',
        '/supplier-refunds',
        refundForm(parts, '1', { debitNoteId: motorNote.id }),
        jamal,
      ),
      send('POST', '/purchase-returns', returnForm(packaging, [ownLine]), shirin),
    ]);
    expect(refused.map((res) => problemOf(res).params?.permissions)).toEqual([
      'purchase.debit_note.manage',
      'purchase.refund.manage',
      'purchase.return.manage',
    ]);
  });
});

describe('what returns, debit notes and refunds hold on to', () => {
  it('keeps a supplier and a money account that they name', async () => {
    const supplier = await send(
      'DELETE',
      `/suppliers/${packaging.id}?version=${String(packaging.version)}`,
    );
    expect(problemOf(supplier).code).toBe('supplier_in_use');
    // The bank the refunds came into
    const bank = accountSchema.parse((await send('GET', `/accounts/${accountId('1121')}`)).json());
    const removed = await send('DELETE', `/accounts/${bank.id}?version=${String(bank.version)}`);
    expect(problemOf(removed).code).toBe('account_in_use');
  });
});

describe('a return and a bill of one receipt line', () => {
  it('lets the second one see what the first did', async () => {
    const order = await approvedOrder(trims, [orderLine(zippers, '200', '7')]);
    const receipt = await received(order, main, [{ product: zippers, quantity: '200' }]);
    // The bill of all 200 first, the return of 20 while the bill is still posting. Holding the
    // receipt line's lock would not set their order: each has already taken a weak lock on the
    // line (the foreign key of its own lines), and Postgres lets a transaction that holds a lock on
    // a row skip the queue for it, so both would wake at once and either could win. So hold the
    // journal's number counter instead: the bill locks the receipt line, then waits to number its
    // entry; the return, sent then, waits for the bill on the receipt line. The bill posts, and the
    // return, which waited for it, finds the line billed and points at the bill line.
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    // A second connection watches who waits: the first one is busy holding the lock
    const watcher = postgres(pg.superuserUrl, { max: 1 });
    // A bill does a lot before it reaches the counter, so a fixed pause is not enough: wait until
    // one request waits on a lock in a query on `table`. The table counts, not any lock: the
    // worker waits on locks of its own (advisory ones).
    const waitingOn = (table: string) =>
      eventually(async () => {
        const [row] = await watcher<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query LIKE ${`%${table}%`}`;
        expect(row?.n).toBe(1);
      });
    let bill: ReturnType<typeof send> | undefined;
    let back: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      // This database holds one workspace, so its journal counter is the only one
      await tx`SELECT last_value FROM number_series_counters
                WHERE document_type = 'accounting.journal' FOR UPDATE`;
      bill = send(
        'POST',
        '/bills',
        billForm(trims, [receiptBillLine(receipt, zippers, '200', '7')], {
          date: '2026-10-17',
          supplierBillNumber: 'KTA-7802',
        }),
        shirin,
      );
      await waitingOn('number_series_counters');
      back = send(
        'POST',
        '/purchase-returns',
        returnForm(trims, [fromReceipt(receipt, zippers, '20')], { date: '2026-10-17' }),
        jamal,
      );
      await waitingOn('goods_receipt_lines');
    });
    await Promise.all([superuser.end(), watcher.end()]);
    const [billedRes, came] = await Promise.all([bill, back]);
    if (!billedRes || !came) throw new Error('the requests were never sent');
    expect(billedRes.statusCode, billedRes.body).toBe(201);
    expect(came.statusCode, came.body).toBe(201);
    const posted = billSchema.parse(billedRes.json());
    expect(purchaseReturnSchema.parse(came.json()).lines[0]).toMatchObject({
      billed: true,
      billLineId: posted.lines[0]?.id,
    });
    // Billed first: the order keeps its 200 received
    expect((await orderNow(order.id)).lines[0]?.receivedQuantity).toBe('200.0000');
  });
});

describe('the books', () => {
  it('add up: goods received not billed is what no bill or debit note has cleared yet', async () => {
    const rows = await superuserSql(
      (sql) => sql<{ code: string; branch: string; balance: string }[]>`
        SELECT a.code, b.code AS branch, sum(l.debit - l.credit)::numeric(19, 4)::text AS balance
          FROM journal_lines l
          JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
          JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
          JOIN branches b ON b.tenant_id = l.tenant_id AND b.id = l.branch_id
         WHERE e.status = 'posted' AND a.code = '2115'
         GROUP BY a.code, b.code
         ORDER BY b.code`,
    );
    // Ashulia: received, billed, sent back, debited: nothing left. The main store: the 50 m that
    // came again and 4 boxes of buttons on the closed order are not billed (৳15,625 + ৳600), and
    // the 20 zippers that went back after their bill wait for a debit note (৳140).
    expect(rows.map((row) => [row.branch === 'ASH' ? 'ASH' : 'HO', row.balance])).toEqual([
      ['ASH', '0.0000'],
      ['HO', '-16085.0000'],
    ]);
    // The parts centre: the motor's bill, paid; its debit note, refunded (voided once); the
    // servicing bill less the ৳5,000 applied. The company owes ৳6,500.
    const [parts1] = await superuserSql(
      (sql) => sql<{ balance: string }[]>`
        SELECT sum(l.debit - l.credit)::numeric(19, 4)::text AS balance
          FROM journal_lines l
          JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
         WHERE e.status = 'posted' AND l.party_id = ${parts.id}`,
    );
    expect(parts1?.balance).toBe('-6500.0000');
    expect(billAmountDueOf(await billNow(serviceBill.id))).toBe('6500.0000');
  });
});

describe('the period lock', () => {
  it('refuses a return, a debit note or a refund on a day the books are closed', async () => {
    const lockedDay = '2026-10-18';
    const draftReturn = await returned(
      returnForm(packaging, [returnLine(hangers, '1')], { date: lockedDay, post: false }),
    );
    const draftNote = await debited(
      debitForm(mill, bill1, [debitLine(billLineOf(bill1, buttons), unitId('box'), '1', '1')], {
        date: lockedDay,
        reason: 'price_adjustment',
        post: false,
      }),
    );
    const lock = await send('PUT', '/period-lock', { lockDate: lockedDay, version: 0 });
    expect(lock.statusCode, lock.body).toBe(200);
    const postReturn = await send(
      'POST',
      `/purchase-returns/${draftReturn.id}/post`,
      { version: draftReturn.version },
      jamal,
    );
    expect(problemOf(postReturn).code).toBe('journal_period_locked');
    expect((await returnNow(draftReturn.id)).status).toBe('draft');
    const postNote = await send(
      'POST',
      `/debit-notes/${draftNote.id}/post`,
      { version: draftNote.version },
      shirin,
    );
    expect(problemOf(postNote).code).toBe('journal_period_locked');
    expect((await debitNoteNow(draftNote.id)).status).toBe('draft');
    const refund = await send(
      'POST',
      '/supplier-refunds',
      refundForm(mill, '1', { paymentId: advance.id }, { date: lockedDay }),
      shirin,
    );
    expect(problemOf(refund).code).toBe('journal_period_locked');
  });
});
