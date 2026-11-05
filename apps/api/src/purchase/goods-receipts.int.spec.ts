import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  branchSchema,
  type GoodsReceipt,
  type GoodsReceiptFormValues,
  type GoodsReceiptLineFormValues,
  goodsReceiptPageSchema,
  goodsReceiptSchema,
  journalEntrySchema,
  memberPageSchema,
  openRequisitionLinePageSchema,
  type PermissionKey,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  type PurchaseOrder,
  type PurchaseOrderFormValues,
  type PurchaseOrderLineFormValues,
  purchaseOrderPageSchema,
  purchaseOrderSchema,
  type Requisition,
  requisitionSchema,
  roleSchema,
  settingsSchema,
  setupSchema,
  stockAccountsSchema,
  stockCardSchema,
  stockMovementPageSchema,
  stockPageSchema,
  type Supplier,
  supplierSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  valuationSummarySchema,
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

// Step 17b: a knit and woven garments factory takes in fabric, dye, sewing machines and buttons
// against its purchase orders. There are no approval levels, so an order the Owner submits is
// approved at once and every test starts from approved orders. Each test builds on the ones
// before it: read the first failure first.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// Rafiq, the Owner: writes the orders and sees every value
let owner: SignedIn;
// Jamal, the store keeper: receives at the gate. purchase.receipt.manage only, so no stock values.
let jamal: SignedIn;
let units: Unit[];
let rates: TaxRate[];
let accounts: Account[];
let main: Warehouse;
// A second branch's store: a truck may unload there instead
let ashulia: Warehouse;
let mill: Supplier;
let trims: Supplier;
// Cotton twill by the metre (2 decimals)
let twill: Product;
// Reactive dye by the kg, kept by lot with an expiry date
let dye: Product;
// Sewing machines, one serial number each
let machine: Product;
// Buttons by the piece, bought by the box of 144
let buttons: Product;
// A service on the order: carriage is billed, never received
let carriage: Product;
// Twill, dye, machines and carriage from the mill, before VAT
let orderA: PurchaseOrder;
// Buttons from the trims supplier, priced with VAT, for a store requisition
let orderB: PurchaseOrder;
let requisition: Requisition;
// The first receipt against order A
let first: GoodsReceipt;

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

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

// The id of an order's line for this product
function lineOf(order: PurchaseOrder, product: Product): string {
  const found = order.lines.find((line) => line.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} on ${order.number ?? 'the order'}`);
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

async function addSupplier(name: string): Promise<Supplier> {
  const res = await send('POST', '/suppliers', {
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
    bankAccounts: [],
    notes: '',
  });
  expect(res.statusCode, res.body).toBe(201);
  return supplierSchema.parse(res.json());
}

// A user who signs up for a workspace of their own, then joins this one with a role of their own
async function member(
  email: string,
  fullName: string,
  password: string,
  permissions: PermissionKey[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Trading`,
    workspaceSlug: email.split('@')[0] ?? 'trading',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'tarabo-knit' });
  const made = await send('POST', '/roles', { name: `${fullName}'s role`, description: '' });
  expect(made.statusCode, made.body).toBe(201);
  const role = roleSchema.parse(made.json());
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = memberPageSchema.parse((await send('GET', '/members?limit=50')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'tarabo-knit', email, password, keepSignedIn: false });
}

// An order line as the form sends it: in the product's base unit, 15% VAT, no discount
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

// Written and submitted by the Owner: with no approval levels, approved at once
async function approvedOrder(
  supplier: Supplier,
  lines: PurchaseOrderLineFormValues[],
  extra: Partial<PurchaseOrderFormValues> = {},
): Promise<PurchaseOrder> {
  const draft = await draftOrder(supplier, lines, extra);
  const res = await send('POST', `/purchase-orders/${draft.id}/submit`, {
    version: draft.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  const order = purchaseOrderSchema.parse(res.json());
  expect(order.status).toBe('approved');
  return order;
}

async function draftOrder(
  supplier: Supplier,
  lines: PurchaseOrderLineFormValues[],
  extra: Partial<PurchaseOrderFormValues> = {},
): Promise<PurchaseOrder> {
  const res = await send('POST', '/purchase-orders', {
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
  expect(res.statusCode, res.body).toBe(201);
  return purchaseOrderSchema.parse(res.json());
}

async function orderNow(id: string): Promise<PurchaseOrder> {
  const res = await send('GET', `/purchase-orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseOrderSchema.parse(res.json());
}

// An order action that takes the version: reopen, close, cancel
function act(action: 'reopen' | 'close' | 'cancel', order: PurchaseOrder, as = owner) {
  return send('POST', `/purchase-orders/${order.id}/${action}`, { version: order.version }, as);
}

// A receipt line as the store keeper types it: in the base unit, nothing turned back
function receiptLine(
  order: PurchaseOrder,
  product: Product,
  quantity: string,
  extra: Partial<GoodsReceiptLineFormValues> = {},
): GoodsReceiptLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: product.baseUnitId,
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    orderLineId: lineOf(order, product),
    rejectedQuantity: '',
    rejectionReason: '',
    ...extra,
  };
}

function receiptForm(
  order: PurchaseOrder,
  lines: GoodsReceiptLineFormValues[],
  extra: Partial<GoodsReceiptFormValues> = {},
): GoodsReceiptFormValues {
  return {
    orderId: order.id,
    date: '2026-10-14',
    warehouseId: main.id,
    supplierChallan: '',
    vehicle: '',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

async function received(body: GoodsReceiptFormValues, as = jamal): Promise<GoodsReceipt> {
  const res = await send('POST', '/goods-receipts', body, as);
  expect(res.statusCode, res.body).toBe(201);
  return goodsReceiptSchema.parse(res.json());
}

async function receiptNow(id: string, as = owner): Promise<GoodsReceipt> {
  const res = await send('GET', `/goods-receipts/${id}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return goodsReceiptSchema.parse(res.json());
}

function postDraft(draft: GoodsReceipt, as = jamal) {
  return send('POST', `/goods-receipts/${draft.id}/post`, { version: draft.version }, as);
}

// A journal entry as [account code, debit, credit, branch] rows
async function entryLines(id: string) {
  const entry = journalEntrySchema.parse((await send('GET', `/journal-entries/${id}`)).json());
  return entry.lines.map((item) => [
    codeOf(item.accountId),
    item.debit,
    item.credit,
    item.branchId,
  ]);
}

// What /stock shows for a warehouse: on hand and still coming, per product name. Only goods.
async function stockIn(warehouse: Warehouse) {
  const page = stockPageSchema.parse(
    (await send('GET', `/stock?warehouseId=${warehouse.id}&limit=50`)).json(),
  );
  return Object.fromEntries(
    page.items.map((item) => [item.productName, [item.onHand, item.incoming]]),
  );
}

async function cardOf(product: Product) {
  return stockCardSchema.parse((await send('GET', `/stock/variants/${variantOf(product)}`)).json());
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
    companyName: 'Tarabo Knit & Woven Ltd.',
    workspaceSlug: 'tarabo-knit',
    fullName: 'Rafiq Islam',
    email: 'rafiq@taraboknit.com',
    password: 'Tarabo-factory-2026',
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

  jamal = await member('jamal@taraboknit.com', 'Jamal Uddin', 'Gate-register-2026', [
    'purchase.receipt.manage',
  ]);
  mill = await addSupplier('Nayapara Weaving Mills');
  trims = await addSupplier('Karim Trims & Accessories');
  twill = await addProduct('Cotton twill 3/1, khaki', { baseUnitId: unitId('m') });
  dye = await addProduct('Reactive dye, black', {
    baseUnitId: unitId('kg'),
    tracking: 'batch',
    hasExpiry: true,
  });
  machine = await addProduct('Juki DDL-8700 sewing machine', { tracking: 'serial' });
  buttons = await addProduct('Polo button 18L', {
    units: [{ unitId: unitId('box'), factor: '144', barcode: '' }],
  });
  carriage = await addProduct('Carriage inward', { type: 'service' });

  // 1,000 m at ৳312.50 is ৳3,12,500; 50 kg at ৳900 less 10% is ৳40,500; 3 machines at ৳85,000
  // are ৳2,55,000; and ৳5,000 for the truck. All before VAT.
  orderA = await approvedOrder(mill, [
    orderLine(twill, '1000', '312.50'),
    orderLine(dye, '50', '900', { discount: '10' }),
    orderLine(machine, '3', '85000'),
    orderLine(carriage, '1', '5000'),
  ]);

  // The store asks for 10 boxes of buttons; the order buys them at ৳172.50 a box with VAT, which
  // is ৳150 a box before it
  const asked = await send('POST', '/requisitions', {
    date: '2026-10-10',
    warehouseId: main.id,
    neededBy: '',
    note: '',
    lines: [
      {
        variantId: variantOf(buttons),
        unitId: unitId('box'),
        quantity: '10',
        description: '',
        estimatedCost: '150',
      },
    ],
  });
  expect(asked.statusCode, asked.body).toBe(201);
  const draft = requisitionSchema.parse(asked.json());
  const submitted = await send('POST', `/requisitions/${draft.id}/submit`, {
    version: draft.version,
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  requisition = requisitionSchema.parse(submitted.json());
  const [askedLine] = requisition.lines;
  if (!askedLine) throw new Error('the requisition has no line');
  orderB = await approvedOrder(
    trims,
    [
      orderLine(buttons, '10', '172.50', {
        unitId: unitId('box'),
        requisitionLineId: askedLine.id,
      }),
    ],
    { pricesIncludeVat: true },
  );
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('goods receipts', () => {
  it('are written only against an approved order, which the form offers', async () => {
    expect([orderA.number, orderB.number]).toEqual(['PO-2026-27-0001', 'PO-2026-27-0002']);
    const draft = await draftOrder(mill, [orderLine(twill, '100', '300')]);
    const early = await send(
      'POST',
      '/goods-receipts',
      receiptForm(draft, [receiptLine(draft, twill, '100')]),
      jamal,
    );
    expect(early.statusCode).toBe(409);
    expect(problemOf(early).fieldErrors).toEqual({ orderId: ['purchase_not_approved'] });
    const unknown = await send(
      'POST',
      '/goods-receipts',
      { ...receiptForm(orderA, [receiptLine(orderA, twill, '1')]), orderId: requisition.id },
      jamal,
    );
    expect(unknown.statusCode).toBe(409);
    expect(problemOf(unknown).fieldErrors).toEqual({ orderId: ['grn_order_invalid'] });
    const removed = await send(
      'DELETE',
      `/purchase-orders/${draft.id}?version=${String(draft.version)}`,
    );
    expect(removed.statusCode).toBe(204);

    // The store keeper reads the orders that still have goods to come, oldest last
    const offered = purchaseOrderPageSchema.parse(
      (await send('GET', '/purchase-orders?receipt=to_receive', undefined, jamal)).json(),
    );
    expect(offered.items.map((item) => [item.number, item.partlyReceived])).toEqual([
      ['PO-2026-27-0002', false],
      ['PO-2026-27-0001', false],
    ]);
    // ...but writes none
    const notHis = await send(
      'POST',
      '/purchase-orders',
      { supplierId: mill.id, lines: [] },
      jamal,
    );
    expect(notHis.statusCode).toBe(403);
  });

  it("brings in what was accepted at the order's price, and books it as received but not billed", async () => {
    first = await received(
      receiptForm(
        orderA,
        [
          receiptLine(orderA, twill, '600'),
          receiptLine(orderA, dye, '30', {
            lotNumber: 'RD-2610',
            expiresOn: '2028-03-31',
            rejectedQuantity: '2',
            rejectionReason: 'Two bags damp and lumpy',
          }),
          receiptLine(orderA, machine, '2', { serialNumbers: ['JK87-10021', 'JK87-10022'] }),
        ],
        { supplierChallan: 'NWM-5521', vehicle: 'Dhaka Metro-Ta 14-2231' },
      ),
    );
    expect(first).toMatchObject({
      number: 'GRN-2026-27-0001',
      status: 'posted',
      supplier: { id: mill.id, name: 'Nayapara Weaving Mills' },
      order: { id: orderA.id, number: 'PO-2026-27-0001' },
      supplierChallan: 'NWM-5521',
      lineCount: 3,
    });
    // Jamal may not see what the books say the goods are worth
    expect(first.lines.map((line) => line.value)).toEqual([null, null, null]);

    // At the order's price, before VAT and after the discount: 600 of 1,000 m of ৳3,12,500 is
    // ৳1,87,500; 30 of 50 kg of ৳40,500 is ৳24,300; 2 of 3 machines of ৳2,55,000 is ৳1,70,000
    const asOwner = await receiptNow(first.id);
    expect(
      asOwner.lines.map((line) => [
        line.baseQuantity,
        line.rejectedBaseQuantity,
        line.rejectionReason,
        line.value,
      ]),
    ).toEqual([
      ['600.0000', '0.0000', null, '187500.0000'],
      ['30.0000', '2.0000', 'Two bags damp and lumpy', '24300.0000'],
      ['2.0000', '0.0000', null, '170000.0000'],
    ]);
    if (!asOwner.entry) throw new Error('expected an entry');
    expect(await entryLines(asOwner.entry.id)).toEqual([
      ['1154', '381800.0000', '0.0000', main.branchId],
      ['2115', '0.0000', '381800.0000', main.branchId],
    ]);
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${asOwner.entry.id}`)).json(),
    );
    expect(entry).toMatchObject({
      source: 'purchase_receipt',
      document: { id: first.id, number: 'GRN-2026-27-0001' },
      narration: 'Goods receipt GRN-2026-27-0001',
    });

    // The order counts what was accepted, and what was turned back apart from it
    const order = await orderNow(orderA.id);
    expect(order).toMatchObject({ status: 'approved', partlyReceived: true });
    expect(order.lines.map((line) => [line.receivedQuantity, line.rejectedQuantity])).toEqual([
      ['600.0000', '0.0000'],
      ['30.0000', '2.0000'],
      ['2.0000', '0.0000'],
      ['0.0000', '0.0000'],
    ]);
    expect(order.receipts).toEqual([
      { id: first.id, number: 'GRN-2026-27-0001', date: '2026-10-14', status: 'posted' },
    ]);

    // On hand, and still to come from approved orders. The 2 kg turned back are still owed.
    expect(await stockIn(main)).toMatchObject({
      'Cotton twill 3/1, khaki': ['600.0000', '400.0000'],
      'Reactive dye, black': ['30.0000', '20.0000'],
      'Juki DDL-8700 sewing machine': ['2.0000', '1.0000'],
      'Polo button 18L': ['0.0000', '1440.0000'],
    });
    const dyeCard = await cardOf(dye);
    expect(dyeCard.item.unitCost).toBe('810.0000');
    expect(dyeCard.batches).toMatchObject([
      { lotNumber: 'RD-2610', expiresOn: '2028-03-31', warehouseId: main.id, quantity: '30.0000' },
    ]);
    expect((await cardOf(machine)).serials).toEqual([
      { serialNumber: 'JK87-10021', warehouseId: main.id },
      { serialNumber: 'JK87-10022', warehouseId: main.id },
    ]);
    const history = stockMovementPageSchema.parse(
      (await send('GET', `/stock/variants/${variantOf(twill)}/movements`)).json(),
    );
    expect(history.items.at(-1)).toMatchObject({
      kind: 'purchase_receipt',
      documentNumber: 'GRN-2026-27-0001',
      quantity: '600.0000',
    });
  });

  it('check every line against its product and its order line, each under its own field', async () => {
    const items = await send(
      'POST',
      '/goods-receipts',
      receiptForm(
        orderA,
        [
          // A lot is needed for what comes in, and one serial number per machine
          receiptLine(orderA, dye, '5'),
          receiptLine(orderA, machine, '1'),
          // Carriage is a service: it never comes through the gate
          receiptLine(orderA, carriage, '1'),
          receiptLine(orderA, twill, '10', { unitId: unitId('pcs') }),
        ],
        { post: false },
      ),
      jamal,
    );
    expect(items.statusCode).toBe(409);
    expect(problemOf(items).fieldErrors).toEqual({
      'lines.0.lotNumber': ['stock_lot_required'],
      'lines.1.serialNumbers': ['stock_serial_count'],
      'lines.2.variantId': ['stock_variant_invalid'],
      'lines.3.unitId': ['stock_unit_invalid'],
    });
    // Twill against the dye line, and buttons against order B's line
    const lines = await send(
      'POST',
      '/goods-receipts',
      receiptForm(
        orderA,
        [
          receiptLine(orderA, twill, '10', { orderLineId: lineOf(orderA, dye) }),
          receiptLine(orderB, buttons, '10'),
        ],
        { post: false },
      ),
      jamal,
    );
    expect(problemOf(lines).fieldErrors).toEqual({
      'lines.0.orderLineId': ['grn_order_line_invalid'],
      'lines.1.orderLineId': ['grn_order_line_invalid'],
    });
    // The form's own rules: a rejection says why, and a line with nothing on it is a mistake
    const rules = await send(
      'POST',
      '/goods-receipts',
      receiptForm(
        orderA,
        [
          receiptLine(orderA, twill, '10', { rejectedQuantity: '2' }),
          receiptLine(orderA, twill, '0'),
        ],
        { post: false },
      ),
      jamal,
    );
    expect(rules.statusCode).toBe(400);
    expect(problemOf(rules).fieldErrors).toEqual({
      'lines.0.rejectionReason': ['grn_rejection_reason'],
      'lines.1.quantity': ['grn_line_empty'],
    });
  });

  it('never bring in more than the order line still takes, unless the workspace allows a little more', async () => {
    const twillLine = lineOf(orderA, twill);
    // 400 m are left of the 1,000
    const over = await send(
      'POST',
      '/goods-receipts',
      receiptForm(orderA, [receiptLine(orderA, twill, '428')]),
      jamal,
    );
    expect(over.statusCode).toBe(409);
    expect(problemOf(over).fieldErrors).toEqual({ 'lines.0.quantity': ['grn_over_order'] });
    // Two lots of one order line count together, and both are marked
    const split = await send(
      'POST',
      '/goods-receipts',
      receiptForm(orderA, [
        receiptLine(orderA, twill, '200', { orderLineId: twillLine }),
        receiptLine(orderA, twill, '228', { orderLineId: twillLine }),
      ]),
      jamal,
    );
    expect(problemOf(split).fieldErrors).toEqual({
      'lines.0.quantity': ['grn_over_order'],
      'lines.1.quantity': ['grn_over_order'],
    });

    // The mills seldom cut to the metre: the factory allows 3% over the order
    const settings = settingsSchema.parse((await send('GET', '/settings')).json());
    const saved = await send('PUT', '/settings', {
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
      pricesIncludeVat: settings.pricesIncludeVat,
      overReceiptPercent: '3',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    // 3% of 3 machines is not a fourth one
    const fourth = await send(
      'POST',
      '/goods-receipts',
      receiptForm(orderA, [
        receiptLine(orderA, machine, '2', { serialNumbers: ['JK87-10023', 'JK87-10024'] }),
      ]),
      jamal,
    );
    expect(problemOf(fourth).fieldErrors).toEqual({ 'lines.0.quantity': ['grn_over_order'] });

    // Drafts hold nothing: two of them may each take the 428 m still allowed (1,030 − 600). Posted
    // at the same moment, the order is locked by the first, and the second then sees it full.
    const draft = () =>
      received(receiptForm(orderA, [receiptLine(orderA, twill, '428')], { post: false }));
    const one = await draft();
    const two = await draft();
    const results = await Promise.all([postDraft(one), postDraft(two)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const loser = results.find((res) => res.statusCode === 409);
    expect(loser && problemOf(loser).fieldErrors).toEqual({
      'lines.0.quantity': ['grn_over_order'],
    });
    const winner = goodsReceiptSchema.parse(results.find((res) => res.statusCode === 200)?.json());
    expect(winner.number).toBe('GRN-2026-27-0002');
    // What came over the order is worth the order's price per metre: 428 m of ৳312.50
    expect((await receiptNow(winner.id)).lines[0]?.value).toBe('133750.0000');
    // The loser moved nothing and used no number; the store keeper deletes it
    const still = await receiptNow(winner.id === one.id ? two.id : one.id);
    expect(still).toMatchObject({ status: 'draft', number: null });
    const removed = await send(
      'DELETE',
      `/goods-receipts/${still.id}?version=${String(still.version)}`,
      undefined,
      jamal,
    );
    expect(removed.statusCode).toBe(204);

    // 1,028 m came in against 1,000: nothing more is coming, and never less than nothing
    const order = await orderNow(orderA.id);
    expect(order.lines[0]?.receivedQuantity).toBe('1028.0000');
    expect((await stockIn(main))['Cotton twill 3/1, khaki']).toEqual(['1028.0000', '0.0000']);
  });

  it('turn a whole line back, and bring nothing in for it', async () => {
    // Nothing accepted: no lot to give, no stock, no value, no entry
    const back = await received(
      receiptForm(orderA, [
        receiptLine(orderA, dye, '0', {
          rejectedQuantity: '5',
          rejectionReason: 'Wrong shade: navy, not black',
        }),
      ]),
    );
    expect(back).toMatchObject({ number: 'GRN-2026-27-0003', status: 'posted', entry: null });
    const asOwner = await receiptNow(back.id);
    expect(asOwner.lines.map((line) => [line.baseQuantity, line.lotNumber, line.value])).toEqual([
      ['0.0000', null, '0.0000'],
    ]);
    const order = await orderNow(orderA.id);
    expect([order.lines[1]?.receivedQuantity, order.lines[1]?.rejectedQuantity]).toEqual([
      '30.0000',
      '7.0000',
    ]);
    expect((await stockIn(main))['Reactive dye, black']).toEqual(['30.0000', '20.0000']);
  });

  it('complete the order with the last receipt, wherever the truck unloads; the service does not hold it open', async () => {
    const last = await received(
      receiptForm(
        orderA,
        [
          receiptLine(orderA, dye, '20', { lotNumber: 'RD-2611', expiresOn: '2028-06-30' }),
          receiptLine(orderA, machine, '1', { serialNumbers: ['JK87-10023'] }),
        ],
        { warehouseId: ashulia.id, date: '2026-10-16' },
      ),
    );
    expect(last.number).toBe('GRN-2026-27-0004');
    // The goods are in Ashulia, so the entry is the Ashulia branch's: 20 of 50 kg of ৳40,500 is
    // ৳16,200, and the third machine ৳85,000
    const entry = (await receiptNow(last.id)).entry;
    if (!entry) throw new Error('expected an entry');
    expect(await entryLines(entry.id)).toEqual([
      ['1154', '101200.0000', '0.0000', ashulia.branchId],
      ['2115', '0.0000', '101200.0000', ashulia.branchId],
    ]);
    const order = await orderNow(orderA.id);
    expect(order).toMatchObject({ status: 'received', partlyReceived: false });
    expect(order.lines[3]?.receivedQuantity).toBe('0.0000');
    expect(await stockIn(ashulia)).toMatchObject({
      'Reactive dye, black': ['20.0000', '0.0000'],
      'Juki DDL-8700 sewing machine': ['1.0000', '0.0000'],
    });
    // A received order is no longer coming anywhere
    expect(await stockIn(main)).toMatchObject({
      'Reactive dye, black': ['30.0000', '0.0000'],
      'Juki DDL-8700 sewing machine': ['2.0000', '0.0000'],
    });

    // It is done: no receipt, no reopen, no close, no cancel
    const more = await send(
      'POST',
      '/goods-receipts',
      receiptForm(order, [receiptLine(order, twill, '1')]),
      jamal,
    );
    expect(problemOf(more).fieldErrors).toEqual({ orderId: ['purchase_not_approved'] });
    for (const [action, code] of [
      ['reopen', 'purchase_cannot_reopen'],
      ['close', 'purchase_not_approved'],
      ['cancel', 'purchase_cannot_cancel'],
    ] as const) {
      const res = await act(action, order);
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).code).toBe(code);
    }
    const offered = purchaseOrderPageSchema.parse(
      (await send('GET', '/purchase-orders?receipt=to_receive')).json(),
    );
    expect(offered.items.map((item) => item.number)).toEqual(['PO-2026-27-0002']);
    const list = goodsReceiptPageSchema.parse(
      (await send('GET', `/goods-receipts?orderId=${orderA.id}`, undefined, jamal)).json(),
    );
    expect(list.items.map((item) => item.number)).toEqual([
      'GRN-2026-27-0004',
      'GRN-2026-27-0003',
      'GRN-2026-27-0002',
      'GRN-2026-27-0001',
    ]);
  });

  it('close a partly received order; the rest goes back to the requisition', async () => {
    const part = await received(
      receiptForm(orderB, [receiptLine(orderB, buttons, '6', { unitId: unitId('box') })]),
    );
    // 864 of 1,440 pieces of a line worth ৳1,500 before VAT
    expect((await receiptNow(part.id)).lines[0]).toMatchObject({
      baseQuantity: '864.0000',
      value: '900.0000',
    });
    const draft = await received(
      receiptForm(orderB, [receiptLine(orderB, buttons, '2', { unitId: unitId('box') })], {
        post: false,
      }),
    );
    let order = await orderNow(orderB.id);
    // Goods came in: closed, not reopened or cancelled
    for (const action of ['reopen', 'cancel'] as const) {
      const res = await act(action, order);
      expect(problemOf(res).code).toBe('purchase_close_instead');
    }
    // Only the buyer closes it
    expect((await act('close', order, jamal)).statusCode).toBe(403);
    const closed = await act('close', order);
    expect(closed.statusCode, closed.body).toBe(200);
    order = purchaseOrderSchema.parse(closed.json());
    expect(order.status).toBe('closed');

    // The draft written before can no longer post, nor be saved; it can be deleted
    const late = await postDraft(draft);
    expect(late.statusCode).toBe(409);
    expect(problemOf(late).fieldErrors).toEqual({ orderId: ['purchase_not_approved'] });
    const removed = await send(
      'DELETE',
      `/goods-receipts/${draft.id}?version=${String(draft.version)}`,
      undefined,
      jamal,
    );
    expect(removed.statusCode).toBe(204);
    expect((await stockIn(main))['Polo button 18L']).toEqual(['864.0000', '0.0000']);

    // A closed order bought only what came: the other 4 boxes are wanted again
    const asked = requisitionSchema.parse(
      (await send('GET', `/requisitions/${requisition.id}`)).json(),
    );
    expect(asked).toMatchObject({ status: 'approved', orderState: 'partly_ordered' });
    expect(asked.lines[0]?.orderedQuantity).toBe('864.0000');
    const open = openRequisitionLinePageSchema.parse(
      (await send('GET', `/requisition-lines?warehouseId=${main.id}`)).json(),
    );
    expect(open.items.map((line) => [line.requisition.id, line.remainingQuantity])).toEqual([
      [requisition.id, '576.0000'],
    ]);
  });

  it('keep an order with a draft receipt from being reopened or cancelled', async () => {
    let order = await approvedOrder(mill, [orderLine(twill, '500', '300')]);
    const draft = await received(
      receiptForm(order, [receiptLine(order, twill, '100')], { post: false }),
    );
    for (const [action, code] of [
      ['reopen', 'purchase_receipt_draft'],
      ['cancel', 'purchase_receipt_draft'],
      // Nothing came in yet: it is cancelled, not closed
      ['close', 'purchase_cancel_instead'],
    ] as const) {
      const res = await act(action, order);
      expect(problemOf(res).code).toBe(code);
    }
    const removed = await send(
      'DELETE',
      `/goods-receipts/${draft.id}?version=${String(draft.version)}`,
      undefined,
      jamal,
    );
    expect(removed.statusCode).toBe(204);
    const cancelled = await act('cancel', order);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    order = purchaseOrderSchema.parse(cancelled.json());
    expect(order.status).toBe('cancelled');
    // A cancelled order brings nothing
    expect((await stockIn(main))['Cotton twill 3/1, khaki']).toEqual(['1028.0000', '0.0000']);
  });

  it('let a reopen and a receipt at the same moment take turns: the second one sees the first', async () => {
    const order = await approvedOrder(mill, [orderLine(twill, '100', '300')]);
    const [reopened, receipt] = await Promise.all([
      act('reopen', order),
      send('POST', '/goods-receipts', receiptForm(order, [receiptLine(order, twill, '60')]), jamal),
    ]);
    const after = await orderNow(order.id);
    if (reopened.statusCode === 200) {
      // The reopen locked the order first: the receipt then found a draft
      expect(receipt.statusCode).toBe(409);
      expect(problemOf(receipt).fieldErrors).toEqual({ orderId: ['purchase_not_approved'] });
      expect([after.status, after.receipts]).toEqual(['draft', []]);
    } else {
      // The receipt came first: posting it gave the order a new version, so the reopen is a
      // page that is out of date. Read again, it is refused: goods came in.
      expect(problemOf(reopened).code).toBe('version_conflict');
      expect(receipt.statusCode, receipt.body).toBe(201);
      expect(after).toMatchObject({ status: 'approved', partlyReceived: true });
      const again = await act('reopen', after);
      expect(problemOf(again).code).toBe('purchase_close_instead');
    }
  });

  it("stay as posted, outside the journal's Reverse and its manual entries", async () => {
    // The edit form sends everything but the order
    const changed = await send(
      'PUT',
      `/goods-receipts/${first.id}`,
      {
        date: first.date,
        warehouseId: main.id,
        supplierChallan: '',
        vehicle: '',
        note: '',
        lines: [receiptLine(orderA, twill, '1')],
        post: false,
        version: first.version,
      },
      jamal,
    );
    expect(problemOf(changed).code).toBe('stock_not_draft');
    const removed = await send(
      'DELETE',
      `/goods-receipts/${first.id}?version=${String(first.version)}`,
      undefined,
      jamal,
    );
    expect(problemOf(removed).code).toBe('stock_not_draft');
    expect(problemOf(await postDraft(first)).code).toBe('stock_not_draft');

    // The entry is the receipt's: a purchase return (17d) takes goods back, not Reverse
    const entryId = first.entry?.id ?? '';
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${entryId}`)).json(),
    );
    const reversed = await send('POST', `/journal-entries/${entryId}/reverse`, {
      version: entry.version,
      date: '2026-10-16',
    });
    expect(problemOf(reversed).code).toBe('journal_is_stock');
    // Goods received not billed holds only what receipts brought in: no manual line, no opening
    // balance
    const manual = await send('POST', '/journal-entries', {
      date: '2026-10-16',
      narration: '',
      lines: [
        { accountId: accountId('2115'), branchId: '', description: '', debit: '100', credit: '' },
        { accountId: accountId('1110'), branchId: '', description: '', debit: '', credit: '100' },
      ],
      post: false,
    });
    expect(manual.statusCode).toBe(409);
    expect(problemOf(manual).fieldErrors).toEqual({
      'lines.0.accountId': ['journal_account_stock'],
    });
    const opening = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [{ accountId: accountId('2115'), debit: '', credit: '5000' }],
    });
    expect(problemOf(opening).fieldErrors).toEqual({
      'lines.0.accountId': ['journal_account_stock'],
    });
    // Settings → Inventory shows the account the receipts use
    const chosen = stockAccountsSchema.parse((await send('GET', '/stock-accounts')).json());
    expect(chosen.received_not_billed).toBe(accountId('2115'));
  });

  it('keep the books equal to the stock, and the account equal to what receipts brought in', async () => {
    const summary = valuationSummarySchema.parse(
      (await send('GET', '/stock/valuation/summary')).json(),
    );
    expect(summary.difference).toBe('0.0000');
    const [row] = await superuserSql(
      (sql) => sql<{ owed: string; received: string }[]>`
        SELECT
          (SELECT sum(l.credit - l.debit)::text FROM journal_lines l
             JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
            WHERE a.code = '2115' AND a.tenant_id = (SELECT tenant_id FROM warehouses WHERE id = ${main.id})) AS owed,
          (SELECT sum(gl.value)::text FROM goods_receipt_lines gl
             JOIN goods_receipts g ON g.tenant_id = gl.tenant_id AND g.id = gl.receipt_id
            WHERE g.status = 'posted' AND g.warehouse_id IN (${main.id}, ${ashulia.id})) AS received`,
    );
    // ৳3,81,800 + ৳1,33,750 + ৳0 + ৳1,01,200 + ৳900, and the race test's ৳18,000 if it posted
    expect(row?.owed).toBe(row?.received);
  });
});
