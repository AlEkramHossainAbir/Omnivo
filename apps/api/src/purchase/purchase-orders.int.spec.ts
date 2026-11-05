import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  approvalRuleListSchema,
  auditPageSchema,
  costLookupSchema,
  createdShareSchema,
  type Customer,
  customerSchema,
  type DocumentFile,
  documentEmailDraftSchema,
  documentEmailSchema,
  documentFileSchema,
  type LanguageCode,
  memberPageSchema,
  notificationPageSchema,
  openRequisitionLinePageSchema,
  type PermissionKey,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  publicDocumentSchema,
  type PurchaseOrder,
  type PurchaseOrderFormValues,
  type PurchaseOrderLineFormValues,
  purchaseOrderPageSchema,
  purchaseOrderSchema,
  type Requisition,
  requisitionPageSchema,
  requisitionSchema,
  type Role,
  roleSchema,
  setupSchema,
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

import { type DocumentModel, documentModelSchema } from '../documents/model.js';
import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startMail,
  startPostgres,
  startRedis,
  startStorage,
  type TestMail,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { attachmentOf, lastMailTo } from '../testing/mailpit.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// Step 17b: a knit composite factory orders yarn-dyed fabric, buttons and dyeing from its
// suppliers. The orders' own approval levels, the requisitions they buy for, the price a new line
// starts with, and the order going out as a PDF, by email and by a WhatsApp link. A real MinIO
// for the files and a real Mailpit for the emails. One workspace, one story: each test builds on
// the ones before it, so read the first failure first.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// Habib, the Owner
let owner: SignedIn;
// Mitu, a merchandiser: writes requisitions and purchase orders
let mitu: SignedIn;
// Kamal, the purchase manager: approves orders from ৳1,00,000
let kamal: SignedIn;
// Jamal, the store keeper: asks for goods and receives them, never orders or sends them
let jamal: SignedIn;
let purchaseManager: Role;
let units: Unit[];
let rates: TaxRate[];
let main: Warehouse;
// A second store of the same branch
let konabari: Warehouse;
let meghna: Supplier;
let karim: Supplier;
// A customer, which is not a supplier
let buyer: Customer;
// Single jersey by the kg, bought by the roll of 25 kg; 500 kg in stock at ৳420 a kg
let jersey: Product;
let buttons: Product;
// A service: dyeing is bought, never received
let dyeing: Product;
// In stock, never bought, with its own VAT rate
let rib: Product;
// The first order: jersey and buttons from Meghna
let order: PurchaseOrder;
// Buttons from Karim, small enough to need no approval
let small: PurchaseOrder;
// Cancelled after a round of approval
let dropped: PurchaseOrder;
let requisition: Requisition;
// A draft that buys 20 rolls for the requisition
let firstPart: PurchaseOrder;
// The Konabari store's requisition, which nothing is ordered for
let konabariAsk: Requisition;
let firstFile: DocumentFile;

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as: SignedIn | null = owner,
) {
  return app.inject({
    method,
    url,
    ...(as && { headers: bearer(as.accessToken) }),
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

function defaultRateId(): string {
  const found = rates.find((rate) => rate.isDefault);
  if (!found) throw new Error('no default VAT rate');
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function requisitionLineOf(doc: Requisition, product: Product): string {
  const found = doc.lines.find((line) => line.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} on ${doc.number}`);
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

async function addSupplier(name: string, extra: object = {}): Promise<Supplier> {
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
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return supplierSchema.parse(res.json());
}

async function supplierNow(id: string): Promise<Supplier> {
  return supplierSchema.parse((await send('GET', `/suppliers/${id}`)).json());
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

// A user who signs up for a workspace of their own, then joins this one with this role
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
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'padma-knit' });
  const { items } = memberPageSchema.parse((await send('GET', '/members?limit=50')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'padma-knit', email, password, keepSignedIn: false });
}

// A line as the form sends it: in the product's base unit, 15% VAT, no discount, its own name
function line(
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

function orderForm(
  lines: PurchaseOrderLineFormValues[],
  extra: Partial<PurchaseOrderFormValues> = {},
): Omit<PurchaseOrderFormValues, 'version'> {
  return {
    supplierId: meghna.id,
    date: '2026-10-12',
    expectedDate: '',
    warehouseId: main.id,
    supplierReference: '',
    paymentTermsDays: 30,
    pricesIncludeVat: false,
    note: '',
    lines,
    ...extra,
  };
}

// The edit form: what the order has, with these changes
function formOf(
  doc: PurchaseOrder,
  extra: Partial<PurchaseOrderFormValues> = {},
): PurchaseOrderFormValues {
  return {
    supplierId: doc.supplier.id,
    date: doc.date,
    expectedDate: doc.expectedDate ?? '',
    warehouseId: doc.warehouseId,
    supplierReference: doc.supplierReference ?? '',
    paymentTermsDays: doc.paymentTermsDays,
    pricesIncludeVat: doc.pricesIncludeVat,
    note: doc.note ?? '',
    lines: doc.lines.map((item) => ({
      variantId: item.variantId,
      unitId: item.unitId,
      quantity: item.quantity,
      description: item.description,
      unitPrice: item.unitPrice,
      discountType: item.discountType,
      // The API's "2.0000"; the box takes 2 decimals, as the app's edit page fills it
      discount: item.discount.replace(/(\.\d{2})\d*$/, '$1'),
      taxRateId: item.taxRate.id,
      requisitionLineId: item.requisitionLine?.id ?? '',
    })),
    version: doc.version,
    ...extra,
  };
}

async function ordered(
  lines: PurchaseOrderLineFormValues[],
  extra: Partial<PurchaseOrderFormValues> = {},
  as = mitu,
): Promise<PurchaseOrder> {
  const res = await send('POST', '/purchase-orders', orderForm(lines, extra), as);
  expect(res.statusCode, res.body).toBe(201);
  return purchaseOrderSchema.parse(res.json());
}

async function orderNow(id: string): Promise<PurchaseOrder> {
  const res = await send('GET', `/purchase-orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseOrderSchema.parse(res.json());
}

async function updated(
  doc: PurchaseOrder,
  extra: Partial<PurchaseOrderFormValues>,
): Promise<PurchaseOrder> {
  const res = await send('PUT', `/purchase-orders/${doc.id}`, formOf(doc, extra), mitu);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseOrderSchema.parse(res.json());
}

// An order's button that takes the version
function act(
  action: 'submit' | 'reopen' | 'close' | 'cancel',
  doc: PurchaseOrder,
  as: SignedIn = mitu,
) {
  return send('POST', `/purchase-orders/${doc.id}/${action}`, { version: doc.version }, as);
}

async function acted(
  action: 'submit' | 'reopen' | 'close' | 'cancel',
  doc: PurchaseOrder,
  as: SignedIn = mitu,
): Promise<PurchaseOrder> {
  const res = await act(action, doc, as);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseOrderSchema.parse(res.json());
}

// Kamal approves the step that waits, on the round the page showed
async function approvedBy(doc: PurchaseOrder, as: SignedIn): Promise<PurchaseOrder> {
  const [round] = doc.approval.rounds;
  if (!round) throw new Error(`${doc.number ?? 'the order'} has no round`);
  const res = await send(
    'POST',
    `/approvals/purchase_order/${doc.id}/approve`,
    { roundId: round.id, comment: '' },
    as,
  );
  expect(res.statusCode, res.body).toBe(204);
  return orderNow(doc.id);
}

async function requisitionNow(id: string): Promise<Requisition> {
  return requisitionSchema.parse((await send('GET', `/requisitions/${id}`)).json());
}

// What a purchase order form may still buy for, as [requisition number, product, remaining]
async function openLines(warehouse: Warehouse) {
  const page = openRequisitionLinePageSchema.parse(
    (await send('GET', `/requisition-lines?warehouseId=${warehouse.id}`, undefined, mitu)).json(),
  );
  return page.items.map((item) => [
    item.requisition.number,
    item.productName,
    item.remainingQuantity,
  ]);
}

// The approval notifications a person has, as [type, number]
async function bell(who: SignedIn): Promise<[string, string | number | undefined][]> {
  const page = notificationPageSchema.parse(
    (await send('GET', '/notifications?limit=50', undefined, who)).json(),
  );
  return page.items
    .filter((item) => item.type.startsWith('approval.'))
    .map((item) => [item.type, item.params.number]);
}

function lookup(supplierId: string | null, items: { product: Product; unit: string }[], as = mitu) {
  return send(
    'POST',
    '/purchase/cost-lookup',
    {
      supplierId,
      items: items.map((item) => ({
        variantId: variantOf(item.product),
        unitId: unitId(item.unit),
      })),
    },
    as,
  );
}

async function costs(
  supplierId: string | null,
  items: { product: Product; unit: string }[],
  as = mitu,
) {
  const res = await lookup(supplierId, items, as);
  expect(res.statusCode, res.body).toBe(200);
  return costLookupSchema.parse(res.json()).items.map((item) => [item.cost, item.source]);
}

function documentPath(id: string): string {
  return `/documents/purchase_order/${id}`;
}

async function fileOf(id: string, language: LanguageCode): Promise<DocumentFile> {
  const res = await send('POST', `${documentPath(id)}/files`, { language }, mitu);
  expect(res.statusCode, res.body).toBe(200);
  return documentFileSchema.parse(res.json());
}

async function finished(id: string, fileId: string): Promise<DocumentFile> {
  return eventually(async () => {
    const res = await send('GET', `${documentPath(id)}/files/${fileId}`);
    const file = documentFileSchema.parse(res.json());
    expect(file.status).not.toBe('pending');
    return file;
  }, 8_000);
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// The page as the API wrote it on the row: what the worker draws
async function modelOf(fileId: string): Promise<DocumentModel> {
  const [row] = await superuserSql(
    (sql) => sql<{ model: unknown }[]>`SELECT model FROM document_files WHERE id = ${fileId}`,
  );
  return documentModelSchema.parse(row?.model);
}

beforeAll(async () => {
  [pg, redis, storage, mail] = await Promise.all([
    startPostgres(),
    startRedis(),
    startStorage(),
    startMail(),
  ]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
      storageUrl: storage.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Padma Knit Composite Ltd.',
    workspaceSlug: 'padma-knit',
    fullName: 'Habibur Rahman',
    email: 'habib@padmaknit.com',
    password: 'Konabari-knit-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const [firstWarehouse] = warehouseListSchema.parse(
    (await send('GET', '/warehouses')).json(),
  ).items;
  if (!firstWarehouse) throw new Error('sign-up made no warehouse');
  // Where the trucks go: the PDF says it
  const moved = await send('PUT', `/warehouses/${firstWarehouse.id}`, {
    branchId: firstWarehouse.branchId,
    code: firstWarehouse.code,
    name: firstWarehouse.name,
    address: 'Plot 22, BSCIC Industrial Area\nKonabari, Gazipur',
    version: firstWarehouse.version,
  });
  expect(moved.statusCode, moved.body).toBe(200);
  main = warehouseSchema.parse(moved.json());
  const store = await send('POST', '/warehouses', {
    branchId: main.branchId,
    code: 'KNB',
    name: 'Konabari yarn store',
    address: '',
  });
  expect(store.statusCode, store.body).toBe(201);
  konabari = warehouseSchema.parse(store.json());

  const merchandising = await addRole('Merchandising', [
    'purchase.requisition.manage',
    'purchase.order.manage',
  ]);
  purchaseManager = await addRole('Purchase manager', ['purchase.order.manage']);
  const storeRole = await addRole('Store', [
    'purchase.requisition.manage',
    'purchase.receipt.manage',
  ]);
  mitu = await member('mitu@padmaknit.com', 'Mitu Akter', 'Buyer-order-2026', merchandising);
  kamal = await member(
    'kamal@padmaknit.com',
    'Kamal Hossain',
    'Purchase-desk-2026',
    purchaseManager,
  );
  jamal = await member('jamal@padmaknit.com', 'Jamal Uddin', 'Gate-register-2026', storeRole);

  meghna = await addSupplier('Meghna Spinning Mills Ltd.', {
    phone: '01711-223344',
    email: 'sales@meghnaspinning.com',
    address: 'Plot 14, Nayapara\nNarsingdi',
  });
  karim = await addSupplier('Karim Trims & Accessories');
  const customer = await send('POST', '/customers', {
    code: '',
    name: 'Nordic Fashion AB',
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
  });
  expect(customer.statusCode, customer.body).toBe(201);
  buyer = customerSchema.parse(customer.json());

  jersey = await addProduct('Single jersey 160 GSM, white', {
    baseUnitId: unitId('kg'),
    units: [{ unitId: unitId('roll'), factor: '25', barcode: '' }],
  });
  buttons = await addProduct('Polo button 18L');
  dyeing = await addProduct('Dyeing charge', { type: 'service', baseUnitId: unitId('kg') });
  rib = await addProduct('Rib 1x1, white', {
    baseUnitId: unitId('kg'),
    taxRateId: rateId('Exempt'),
  });
  // Opening stock: 500 kg of jersey at ৳420 a kg, 80 kg of rib at ৳380
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      [jersey, '500', '420'],
      [rib, '80', '380'],
    ].map(([product, quantity, unitCost]) => ({
      variantId: variantOf(product as Product),
      unitId: unitId('kg'),
      quantity,
      batchId: '',
      lotNumber: '',
      expiresOn: '',
      manufacturedOn: '',
      serialNumbers: [],
      unitCost,
    })),
  });
  expect(opening.statusCode, opening.body).toBe(201);
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([
    pg.container.stop(),
    redis.container.stop(),
    storage.container.stop(),
    mail.container.stop(),
  ]);
});

describe('purchase orders', () => {
  it('are written for a supplier and priced like a sales line; a draft has no number', async () => {
    order = await ordered(
      [
        // 20 rolls of 25 kg at ৳10,500 a roll, less 2%: ৳2,05,800 before VAT
        line(jersey, '20', '10500', { unitId: unitId('roll'), discount: '2' }),
        // 5,000 buttons at ৳1.20, less ৳200: ৳5,800
        line(buttons, '5000', '1.20', {
          discountType: 'amount',
          discount: '200',
          description: 'Polo button 18L, white, 4-hole',
        }),
        // Dyeing 500 kg at ৳80: ৳40,000
        line(dyeing, '500', '80'),
      ],
      {
        expectedDate: '2026-10-25',
        supplierReference: 'PI-2210',
        paymentTermsDays: 45,
      },
    );
    expect(order).toMatchObject({
      number: null,
      status: 'draft',
      supplier: { id: meghna.id, name: 'Meghna Spinning Mills Ltd.' },
      warehouseId: main.id,
      supplierReference: 'PI-2210',
      paymentTermsDays: 45,
      pricesIncludeVat: false,
      partlyReceived: false,
      net: '251600.0000',
      vat: '37740.0000',
      total: '289340.0000',
      lineCount: 3,
      requisitions: [],
      receipts: [],
      approval: { rounds: [], canDecide: false },
    });
    expect(
      order.lines.map((item) => [
        item.description,
        item.baseQuantity,
        item.net,
        item.vat,
        item.total,
        item.receivedQuantity,
      ]),
    ).toEqual([
      [
        'Single jersey 160 GSM, white',
        '500.0000',
        '205800.0000',
        '30870.0000',
        '236670.0000',
        '0.0000',
      ],
      [
        'Polo button 18L, white, 4-hole',
        '5000.0000',
        '5800.0000',
        '870.0000',
        '6670.0000',
        '0.0000',
      ],
      ['Dyeing charge', '500.0000', '40000.0000', '6000.0000', '46000.0000', '0.0000'],
    ]);
    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=purchase_order&entityId=${order.id}`)).json(),
    );
    expect(log.items[0]).toMatchObject({
      action: 'purchase_order.created',
      changes: {
        supplier: { from: null, to: meghna.code },
        total: { from: null, to: '289340.0000' },
        lines: { from: null, to: 3 },
      },
    });

    // The order's own "prices include VAT": ৳1.38 a button with VAT is ৳1.20 before it
    const withVat = await ordered([line(buttons, '1000', '1.38')], { pricesIncludeVat: true });
    expect([withVat.net, withVat.vat, withVat.total]).toEqual([
      '1200.0000',
      '180.0000',
      '1380.0000',
    ]);
    // Never submitted: deleted, and gone
    const removed = await send(
      'DELETE',
      `/purchase-orders/${withVat.id}?version=${String(withVat.version)}`,
      undefined,
      mitu,
    );
    expect(removed.statusCode).toBe(204);
    expect((await send('GET', `/purchase-orders/${withVat.id}`)).statusCode).toBe(404);
  });

  it('refuse a supplier, warehouse, item or rate they cannot use, each under its own field', async () => {
    // A customer is not a supplier, and an archived supplier takes no new orders
    const oldDyes = await addSupplier('Old Dhaka Dye House');
    const archived = await send('POST', `/suppliers/${oldDyes.id}/archive`, {
      version: oldDyes.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    for (const supplierId of [buyer.id, oldDyes.id]) {
      const res = await send(
        'POST',
        '/purchase-orders',
        orderForm([line(buttons, '1', '1')], { supplierId }),
        mitu,
      );
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).fieldErrors).toEqual({ supplierId: ['purchase_supplier_invalid'] });
    }
    const nowhere = await send(
      'POST',
      '/purchase-orders',
      orderForm([line(buttons, '1', '1')], { warehouseId: buyer.id }),
      mitu,
    );
    expect(problemOf(nowhere).fieldErrors).toEqual({ warehouseId: ['purchase_warehouse_invalid'] });

    // Every line's problem at once: the items and the rates together
    const oldTrim = await addProduct('Satin label, old logo');
    const gone = await send('POST', `/products/${oldTrim.id}/archive`, {
      version: oldTrim.version,
    });
    expect(gone.statusCode, gone.body).toBe(200);
    const lines = await send(
      'POST',
      '/purchase-orders',
      orderForm([
        line(oldTrim, '100', '2'),
        line(jersey, '10', '420', { unitId: unitId('pcs') }),
        line(buttons, '1.5', '1'),
        line(buttons, '10', '1', { taxRateId: buyer.id }),
      ]),
      mitu,
    );
    expect(lines.statusCode).toBe(409);
    expect(problemOf(lines).fieldErrors).toEqual({
      'lines.0.variantId': ['purchase_item_invalid'],
      'lines.1.unitId': ['stock_unit_invalid'],
      'lines.2.quantity': ['stock_quantity_decimals'],
      'lines.3.taxRateId': ['tax_rate_invalid'],
    });
    // The form's own rules come back before the API looks at anything
    const form = await send(
      'POST',
      '/purchase-orders',
      orderForm([line(buttons, '10', '1', { discount: '120' })], { expectedDate: '2026-10-01' }),
      mitu,
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      expectedDate: ['purchase_expected_date'],
      'lines.0.discount': ['sales_discount_too_large'],
    });
    const empty = await send('POST', '/purchase-orders', orderForm([]), mitu);
    expect(problemOf(empty).fieldErrors).toEqual({ lines: ['purchase_lines_required'] });
  });

  it('change freely as drafts, and only for the people who buy', async () => {
    // The dyeing goes on its own order to the dye house; Meghna gets 60 days
    const changed = await updated(order, {
      paymentTermsDays: 60,
      lines: formOf(order).lines.slice(0, 2),
    });
    expect(changed).toMatchObject({
      paymentTermsDays: 60,
      lineCount: 2,
      total: '243340.0000',
      version: order.version + 1,
    });
    const stale = await send('PUT', `/purchase-orders/${order.id}`, formOf(order), mitu);
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');
    order = changed;

    // Jamal reads every order, and writes none
    const list = purchaseOrderPageSchema.parse(
      (await send('GET', '/purchase-orders?status=draft', undefined, jamal)).json(),
    );
    expect(list.items.map((item) => [item.id, item.lineCount])).toEqual([[order.id, 2]]);
    const refused = [
      await send('POST', '/purchase-orders', orderForm([line(buttons, '1', '1')]), jamal),
      await send('PUT', `/purchase-orders/${order.id}`, formOf(order), jamal),
      await act('submit', order, jamal),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(403);
      expect(problemOf(res).params).toEqual({ permissions: 'purchase.order.manage' });
    }
  });
});

describe('approval', () => {
  it("has its own levels, apart from the requisition's, and numbers the order when submitted", async () => {
    // From ৳1,00,000 (VAT included) the purchase manager approves; requisitions need nobody
    const res = await send('PUT', '/approval-rules/purchase_order', {
      levels: [{ minAmount: '100000', roleId: purchaseManager.id }],
      version: 0,
    });
    expect(res.statusCode, res.body).toBe(200);
    const { items } = approvalRuleListSchema.parse((await send('GET', '/approval-rules')).json());
    expect(items.map((item) => [item.document, item.levels.length])).toEqual([
      ['requisition', 0],
      ['purchase_order', 1],
      // Step 17c: the bill and the supplier payment have levels of their own
      ['bill', 0],
      ['supplier_payment', 0],
    ]);

    order = await acted('submit', order);
    expect(order).toMatchObject({ number: 'PO-2026-27-0001', status: 'pending' });
    expect(order.approval.rounds[0]).toMatchObject({
      status: 'pending',
      amount: '243340.0000',
      submittedBy: { name: 'Mitu Akter' },
      steps: [{ position: 1, role: { name: 'Purchase manager' }, decision: null }],
    });
    // A submitted order is not changed, and not deleted
    const late = await send('PUT', `/purchase-orders/${order.id}`, formOf(order), mitu);
    expect(problemOf(late).code).toBe('purchase_not_draft');

    // Kamal is told, and sees who it is from
    expect(await bell(kamal)).toContainEqual(['approval.requested', 'PO-2026-27-0001']);
    const waiting = waitingApprovalPageSchema.parse(
      (await send('GET', '/approvals/waiting', undefined, kamal)).json(),
    );
    expect(waiting.items).toMatchObject([
      {
        document: 'purchase_order',
        id: order.id,
        number: 'PO-2026-27-0001',
        subject: 'Meghna Spinning Mills Ltd.',
        amount: '243340.0000',
        position: 1,
        stepCount: 1,
      },
    ]);
    order = await approvedBy(order, kamal);
    expect(order.status).toBe('approved');
    expect(await bell(mitu)).toContainEqual(['approval.approved', 'PO-2026-27-0001']);

    // Below the level: approved at once, numbered all the same
    small = await ordered([line(buttons, '5000', '1.20')], {
      supplierId: karim.id,
      date: '2026-10-13',
    });
    small = await acted('submit', small);
    expect(small).toMatchObject({
      number: 'PO-2026-27-0002',
      status: 'approved',
      total: '6900.0000',
    });
  });

  it('go back to draft to change, keeping the number and the supplier, then start from level 1', async () => {
    order = await acted('reopen', order);
    expect(order).toMatchObject({ number: 'PO-2026-27-0001', status: 'draft' });
    // The approved round stays approved: it was
    expect(order.approval.rounds.map((round) => round.status)).toEqual(['approved']);

    // The number went to Meghna: the order cannot move to another supplier
    const other = await send(
      'PUT',
      `/purchase-orders/${order.id}`,
      formOf(order, { supplierId: karim.id }),
      mitu,
    );
    expect(other.statusCode).toBe(409);
    expect(problemOf(other).fieldErrors).toEqual({ supplierId: ['purchase_supplier_invalid'] });
    const removed = await send(
      'DELETE',
      `/purchase-orders/${order.id}?version=${String(order.version)}`,
      undefined,
      mitu,
    );
    expect(problemOf(removed).code).toBe('purchase_was_submitted');

    // 1,000 more buttons: ৳7,000 before VAT, so ৳2,44,720 in all
    const [jerseyLine, buttonLine] = formOf(order).lines;
    if (!jerseyLine || !buttonLine) throw new Error('the order lost a line');
    order = await updated(order, { lines: [jerseyLine, { ...buttonLine, quantity: '6000' }] });
    expect(order.total).toBe('244720.0000');
    order = await acted('submit', order);
    expect(order.approval.rounds.map((round) => [round.status, round.amount])).toEqual([
      ['pending', '244720.0000'],
      ['approved', '243340.0000'],
    ]);
    order = await approvedBy(order, kamal);
    expect(order.status).toBe('approved');
  });

  it('are cancelled, never deleted, once numbered; a pending one is reopened first', async () => {
    dropped = await ordered([line(buttons, '100000', '1.05')], { date: '2026-10-14' });
    // Never submitted: it is deleted, not cancelled
    expect(problemOf(await act('cancel', dropped)).code).toBe('purchase_delete_instead');
    dropped = await acted('submit', dropped);
    expect(dropped.status).toBe('pending');
    expect(problemOf(await act('cancel', dropped)).code).toBe('purchase_cannot_cancel');
    dropped = await acted('reopen', dropped);
    // The pending round ends as reopened: nobody is asked any more
    expect(dropped.approval.rounds[0]?.status).toBe('reopened');
    const waiting = waitingApprovalPageSchema.parse(
      (await send('GET', '/approvals/waiting', undefined, kamal)).json(),
    );
    expect(waiting.items).toEqual([]);
    dropped = await acted('cancel', dropped);
    expect(dropped).toMatchObject({ number: 'PO-2026-27-0003', status: 'cancelled' });
    expect(problemOf(await act('reopen', dropped)).code).toBe('purchase_cannot_reopen');
    expect(problemOf(await act('submit', dropped)).code).toBe('purchase_not_draft');

    // Closing is for an order that was partly received: one with nothing in is cancelled
    expect(problemOf(await act('close', small)).code).toBe('purchase_cancel_instead');
    const draft = await ordered([line(buttons, '1', '1')]);
    expect(problemOf(await act('close', draft)).code).toBe('purchase_not_approved');
    await send('DELETE', `/purchase-orders/${draft.id}?version=${String(draft.version)}`);
  });

  it('check the supplier again when submitted', async () => {
    // A draft keeps a supplier archived after it was written, so it can be finished; it is not
    // sent to a supplier the company stopped buying from
    let draft = await ordered([line(buttons, '100', '1.10')], { supplierId: karim.id });
    karim = await supplierNow(karim.id);
    const archived = await send('POST', `/suppliers/${karim.id}/archive`, {
      version: karim.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    draft = await updated(draft, { note: 'Pack in 100s' });
    const res = await act('submit', draft);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ supplierId: ['purchase_supplier_invalid'] });
    karim = await supplierNow(karim.id);
    const restored = await send('POST', `/suppliers/${karim.id}/restore`, {
      version: karim.version,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    await send('DELETE', `/purchase-orders/${draft.id}?version=${String(draft.version)}`);
  });
});

describe('requisitions to orders', () => {
  it('offer the lines still to order, and count each order line against its requisition line', async () => {
    // The store asks for 30 rolls of jersey and 3,000 buttons; with no levels, approved at once
    const asked = await send(
      'POST',
      '/requisitions',
      {
        date: '2026-10-11',
        warehouseId: main.id,
        neededBy: '2026-10-28',
        note: '',
        lines: [
          {
            variantId: variantOf(jersey),
            unitId: unitId('roll'),
            quantity: '30',
            description: '',
            estimatedCost: '10500',
          },
          {
            variantId: variantOf(buttons),
            unitId: unitId('pcs'),
            quantity: '3000',
            description: '',
            estimatedCost: '1.20',
          },
        ],
      },
      jamal,
    );
    expect(asked.statusCode, asked.body).toBe(201);
    const draft = requisitionSchema.parse(asked.json());
    const submitted = await send(
      'POST',
      `/requisitions/${draft.id}/submit`,
      { version: draft.version },
      jamal,
    );
    requisition = requisitionSchema.parse(submitted.json());
    expect(requisition).toMatchObject({ status: 'approved', orderState: 'not_ordered' });
    expect(await openLines(main)).toEqual([
      [requisition.number, 'Single jersey 160 GSM, white', '750.0000'],
      [requisition.number, 'Polo button 18L', '3000.0000'],
    ]);

    // 20 rolls now, from Meghna: even a draft order holds them, so nobody orders them twice
    firstPart = await ordered([
      line(jersey, '20', '10290', {
        unitId: unitId('roll'),
        requisitionLineId: requisitionLineOf(requisition, jersey),
      }),
    ]);
    expect(firstPart.requisitions).toEqual([{ id: requisition.id, number: requisition.number }]);
    expect(firstPart.lines[0]?.requisitionLine).toEqual({
      id: requisitionLineOf(requisition, jersey),
      requisitionId: requisition.id,
      number: requisition.number,
    });
    requisition = await requisitionNow(requisition.id);
    expect(requisition).toMatchObject({
      orderState: 'partly_ordered',
      orders: [{ id: firstPart.id, number: null }],
    });
    expect(requisition.lines.map((item) => item.orderedQuantity)).toEqual(['500.0000', '0.0000']);
    expect(await openLines(main)).toEqual([
      [requisition.number, 'Single jersey 160 GSM, white', '250.0000'],
      [requisition.number, 'Polo button 18L', '3000.0000'],
    ]);

    // The rest on a second order to Meghna, the buttons with it. Ordered in full: the
    // requisition leaves the buyer's list.
    const rest = await ordered([
      line(jersey, '10', '10290', {
        unitId: unitId('roll'),
        requisitionLineId: requisitionLineOf(requisition, jersey),
      }),
      line(buttons, '3000', '1.15', { requisitionLineId: requisitionLineOf(requisition, buttons) }),
    ]);
    expect((await requisitionNow(requisition.id)).orderState).toBe('ordered');
    expect(await openLines(main)).toEqual([]);
    const toOrder = requisitionPageSchema.parse(
      (await send('GET', '/requisitions?order=to_order', undefined, mitu)).json(),
    );
    expect(toOrder.items).toEqual([]);

    // Deleted, the second order gives its quantities back
    const removed = await send(
      'DELETE',
      `/purchase-orders/${rest.id}?version=${String(rest.version)}`,
      undefined,
      mitu,
    );
    expect(removed.statusCode).toBe(204);
    requisition = await requisitionNow(requisition.id);
    expect(requisition.orderState).toBe('partly_ordered');
  });

  it('refuse a line of another store, another item, an unapproved requisition, or one line twice', async () => {
    const forKonabari = await send(
      'POST',
      '/requisitions',
      {
        date: '2026-10-11',
        warehouseId: konabari.id,
        neededBy: '',
        note: '',
        lines: [
          {
            variantId: variantOf(buttons),
            unitId: unitId('pcs'),
            quantity: '500',
            description: '',
            estimatedCost: '1.20',
          },
        ],
      },
      jamal,
    );
    const asked = requisitionSchema.parse(forKonabari.json());
    const submitted = await send(
      'POST',
      `/requisitions/${asked.id}/submit`,
      { version: asked.version },
      jamal,
    );
    konabariAsk = requisitionSchema.parse(submitted.json());
    // Each store's form offers its own requisitions
    expect(await openLines(konabari)).toEqual([
      [konabariAsk.number, 'Polo button 18L', '500.0000'],
    ]);
    const draftAsk = await send(
      'POST',
      '/requisitions',
      {
        date: '2026-10-11',
        warehouseId: main.id,
        neededBy: '',
        note: '',
        lines: [
          {
            variantId: variantOf(buttons),
            unitId: unitId('pcs'),
            quantity: '200',
            description: '',
            estimatedCost: '1.20',
          },
        ],
      },
      jamal,
    );
    const notYet = requisitionSchema.parse(draftAsk.json());
    const res = await send(
      'POST',
      '/purchase-orders',
      orderForm([
        // A requisition for Konabari on an order for the main store
        line(buttons, '500', '1.20', {
          requisitionLineId: requisitionLineOf(konabariAsk, buttons),
        }),
        // Buttons on the jersey line
        line(buttons, '10', '1.20', {
          requisitionLineId: requisitionLineOf(requisition, jersey),
        }),
        // A draft requisition: its lines may still change
        line(buttons, '200', '1.20', { requisitionLineId: requisitionLineOf(notYet, buttons) }),
      ]),
      mitu,
    );
    expect(res.statusCode).toBe(409);
    // One code for every reason: the form only offers lines that fit
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.0.requisitionLineId': ['purchase_requisition_line_invalid'],
      'lines.1.requisitionLineId': ['purchase_requisition_line_invalid'],
      'lines.2.requisitionLineId': ['purchase_requisition_line_invalid'],
    });
    const twice = await send(
      'POST',
      '/purchase-orders',
      orderForm([
        line(buttons, '100', '1.20', {
          requisitionLineId: requisitionLineOf(requisition, buttons),
        }),
        line(buttons, '100', '1.20', {
          requisitionLineId: requisitionLineOf(requisition, buttons),
        }),
      ]),
      mitu,
    );
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({
      'lines.1.requisitionLineId': ['purchase_requisition_line_twice'],
    });
  });

  it('keep a requisition an order buys for from being reopened or cancelled; it is closed instead', async () => {
    for (const action of ['reopen', 'cancel'] as const) {
      const res = await send(
        'POST',
        `/requisitions/${requisition.id}/${action}`,
        { version: requisition.version },
        jamal,
      );
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).code).toBe('purchase_close_instead');
    }
    // The other 10 rolls will not be bought: closed, it leaves the list
    const closed = await send(
      'POST',
      `/requisitions/${requisition.id}/close`,
      { version: requisition.version },
      jamal,
    );
    expect(closed.statusCode, closed.body).toBe(200);
    requisition = requisitionSchema.parse(closed.json());
    expect(requisition).toMatchObject({ status: 'closed', orderState: 'partly_ordered' });
    expect(await openLines(main)).toEqual([]);
    // A new order cannot buy for it; the draft that already does still saves
    const late = await send(
      'POST',
      '/purchase-orders',
      orderForm([
        line(buttons, '100', '1.20', {
          requisitionLineId: requisitionLineOf(requisition, buttons),
        }),
      ]),
      mitu,
    );
    expect(problemOf(late).fieldErrors).toEqual({
      'lines.0.requisitionLineId': ['purchase_requisition_line_invalid'],
    });
    const kept = await updated(await orderNow(firstPart.id), { note: 'Roll width 72 inches' });
    expect(kept.lines[0]?.requisitionLine?.id).toBe(requisitionLineOf(requisition, jersey));
    // Deleted, the draft lets the closed requisition count nothing ordered
    await send('DELETE', `/purchase-orders/${kept.id}?version=${String(kept.version)}`);
    expect((await requisitionNow(requisition.id)).orderState).toBe('not_ordered');

    // A requisition nothing was ordered for is cancelled, not closed
    const nothing = await send(
      'POST',
      `/requisitions/${konabariAsk.id}/close`,
      { version: konabariAsk.version },
      jamal,
    );
    expect(problemOf(nothing).code).toBe('purchase_cancel_instead');
  });
});

describe('the price a line starts with', () => {
  it("is this supplier's last price, else anyone's, else the average cost", async () => {
    // PO-0001 bought jersey from Meghna at ৳10,500 a roll less 2% (৳411.60 a kg) and buttons at
    // ৳1.20 less ৳200 on 6,000 (৳1.1667); PO-0002 bought buttons from Karim at ৳1.20, a day later.
    // The cancelled PO-0003 and every draft are no price anybody agreed.
    expect(
      await costs(meghna.id, [
        { product: jersey, unit: 'roll' },
        { product: jersey, unit: 'kg' },
        { product: buttons, unit: 'pcs' },
      ]),
    ).toEqual([
      ['10290.0000', 'supplier_price'],
      ['411.6000', 'supplier_price'],
      ['1.1667', 'supplier_price'],
    ]);
    // Karim never sold jersey: Meghna's price is the last one anybody paid
    expect(
      await costs(karim.id, [
        { product: jersey, unit: 'roll' },
        { product: buttons, unit: 'pcs' },
      ]),
    ).toEqual([
      ['10290.0000', 'last_price'],
      ['1.2000', 'supplier_price'],
    ]);
    // No supplier chosen yet: the newest order's price
    expect(await costs(null, [{ product: buttons, unit: 'pcs' }])).toEqual([
      ['1.2000', 'last_price'],
    ]);
    // Never bought: the average cost, for someone who may see it; dyeing was never ordered
    expect(
      await costs(
        null,
        [
          { product: rib, unit: 'kg' },
          { product: dyeing, unit: 'kg' },
        ],
        owner,
      ),
    ).toEqual([
      ['380.0000', 'average_cost'],
      [null, null],
    ]);
    expect(await costs(null, [{ product: rib, unit: 'kg' }])).toEqual([[null, null]]);
  });

  it("starts the VAT rate at the product's own, else the workspace default", async () => {
    const res = await lookup(meghna.id, [
      { product: rib, unit: 'kg' },
      { product: jersey, unit: 'kg' },
    ]);
    expect(costLookupSchema.parse(res.json()).items.map((item) => item.taxRateId)).toEqual([
      rateId('Exempt'),
      defaultRateId(),
    ]);
  });
});

describe('the purchase order goes out', () => {
  it('only once approved: not a draft, a pending order or a cancelled one', async () => {
    const draft = await ordered([line(buttons, '1', '1')]);
    const pending = await acted('submit', await ordered([line(jersey, '400', '420')]));
    expect(pending.status).toBe('pending');
    for (const id of [draft.id, pending.id, dropped.id]) {
      const res = await send('POST', `${documentPath(id)}/files`, { language: 'en' }, mitu);
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).code).toBe('document_not_issued');
    }
    await send('DELETE', `/purchase-orders/${draft.id}?version=${String(draft.version)}`);
    await acted('cancel', await acted('reopen', pending));
  });

  it('as a PDF with the supplier, where to deliver, the terms and the amount in words', async () => {
    firstFile = await fileOf(order.id, 'en');
    const ready = await finished(order.id, firstFile.id);
    expect(ready).toMatchObject({ status: 'ready', fileName: 'PO-2026-27-0001.pdf' });
    const model = await modelOf(firstFile.id);
    expect(model).toMatchObject({
      language: 'en',
      title: 'Purchase order',
      number: 'PO-2026-27-0001',
      party: {
        label: 'Supplier',
        name: 'Meghna Spinning Mills Ltd.',
        code: meghna.code,
        lines: ['Plot 14, Nayapara', 'Narsingdi'],
      },
      facts: [
        {
          label: 'Deliver to',
          value: 'Main store, Plot 22, BSCIC Industrial Area, Konabari, Gazipur',
        },
      ],
      words: 'In words: Two lakh forty-four thousand seven hundred twenty taka only',
      signatures: ['Prepared by', 'Authorised signature'],
    });
    expect(model.meta).toEqual([
      { label: 'No.', value: 'PO-2026-27-0001' },
      { label: 'Date', value: '12 Oct 2026' },
      { label: 'Deliver by', value: '25 Oct 2026' },
      { label: 'Your reference', value: 'PI-2210' },
      { label: 'Payment terms', value: '60 days' },
    ]);
    expect(model.table?.rows.map((row) => row.cells)).toEqual([
      [
        '1',
        'Single jersey 160 GSM, white',
        '20 roll',
        '৳10,500.00',
        // A percent discount as the sales documents print it (step 16)
        '2.00%',
        'VAT 15%',
        '৳2,05,800.00',
      ],
      [
        '2',
        'Polo button 18L, white, 4-hole',
        '6,000 pcs',
        '৳1.20',
        '৳200.00',
        'VAT 15%',
        '৳7,000.00',
      ],
    ]);
    // 2% of ৳2,10,000 and ৳200 off the buttons
    expect(model.totals?.rows).toEqual([
      { label: 'Line discounts', value: '−৳4,400.00', strong: false },
      { label: 'Before VAT', value: '৳2,12,800.00', strong: false },
      { label: 'VAT', value: '৳31,920.00', strong: false },
      { label: 'Total', value: '৳2,44,720.00', strong: true },
    ]);
    const bangla = await modelOf((await fileOf(order.id, 'bn')).id);
    expect(bangla).toMatchObject({ title: 'পারচেজ অর্ডার', party: { label: 'সরবরাহকারী' } });
    expect(bangla.meta.at(-1)).toEqual({ label: 'পেমেন্টের মেয়াদ', value: '৬০ দিন' });
  });

  it('by email to the supplier, with the PDF attached', async () => {
    const draft = documentEmailDraftSchema.parse(
      (
        await send('GET', `${documentPath(order.id)}/email-draft?language=en`, undefined, mitu)
      ).json(),
    );
    expect(draft).toEqual({
      to: 'sales@meghnaspinning.com',
      subject: 'Purchase order PO-2026-27-0001 from Padma Knit Composite Ltd.',
      message:
        'Dear Meghna Spinning Mills Ltd.,\n\n' +
        'Please find attached our purchase order PO-2026-27-0001 for ৳2,44,720.00. ' +
        'Please deliver by 25 Oct 2026.\n\n' +
        'Regards,\nMitu Akter\nPadma Knit Composite Ltd.',
    });
    const res = await send(
      'POST',
      `${documentPath(order.id)}/emails`,
      { ...draft, cc: '', language: 'en' },
      mitu,
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(documentEmailSchema.parse(res.json()).to).toEqual(['sales@meghnaspinning.com']);
    const sent = await eventually(() => lastMailTo(mail.apiUrl, 'sales@meghnaspinning.com'), 8_000);
    expect(sent.subject).toBe('Purchase order PO-2026-27-0001 from Padma Knit Composite Ltd.');
    const [attachment] = sent.attachments;
    expect(attachment).toMatchObject({
      fileName: 'PO-2026-27-0001.pdf',
      contentType: 'application/pdf',
    });
    const bytes = await attachmentOf(mail.apiUrl, sent, attachment?.partId ?? '');
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  }, 20_000);

  it("by a WhatsApp link to the supplier's number, whose page names the supplier", async () => {
    const res = await send('POST', `${documentPath(order.id)}/shares`, { language: 'en' }, mitu);
    expect(res.statusCode, res.body).toBe(201);
    const made = createdShareSchema.parse(res.json());
    expect(made.whatsAppUrl).toMatch(/^https:\/\/wa\.me\/8801711223344\?text=/);
    const token = /\/d\/([\w-]{22})$/.exec(made.url)?.[1] ?? '';
    const opened = await send('GET', `/public/documents/${token}`, undefined, null);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(publicDocumentSchema.parse(opened.json())).toMatchObject({
      kind: 'purchase_order',
      number: 'PO-2026-27-0001',
      recipient: 'Meghna Spinning Mills Ltd.',
      company: 'Padma Knit Composite Ltd.',
      total: '244720.0000',
      dueDate: null,
    });
  });

  it('only by someone who buys; anyone signed in downloads it', async () => {
    for (const res of [
      await send('POST', `${documentPath(order.id)}/shares`, { language: 'en' }, jamal),
      await send('GET', `${documentPath(order.id)}/email-draft?language=en`, undefined, jamal),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(problemOf(res).params).toEqual({ permissions: 'purchase.order.manage' });
    }
    const asked = await send('POST', `${documentPath(order.id)}/files`, { language: 'en' }, jamal);
    expect(documentFileSchema.parse(asked.json()).id).toBe(firstFile.id);
  });
});

describe('in use', () => {
  it('keeps a supplier and a product an order names', async () => {
    karim = await supplierNow(karim.id);
    const supplier = await send(
      'DELETE',
      `/suppliers/${karim.id}?version=${String(karim.version)}`,
    );
    expect(supplier.statusCode).toBe(409);
    expect(problemOf(supplier).code).toBe('supplier_in_use');
    // A party that also buys from the company: the order still holds its supplier side, which
    // no foreign key can say (the party row stays)
    const both = await send('POST', `/suppliers/${meghna.id}/make-customer`, {
      version: (await supplierNow(meghna.id)).version,
    });
    expect(both.statusCode, both.body).toBe(200);
    meghna = await supplierNow(meghna.id);
    const side = await send('DELETE', `/suppliers/${meghna.id}?version=${String(meghna.version)}`);
    expect(problemOf(side).code).toBe('supplier_in_use');
    // An order line keeps its product, on a cancelled order too
    const product = await send(
      'DELETE',
      `/products/${buttons.id}?version=${String(buttons.version)}`,
    );
    expect(problemOf(product).code).toBe('product_in_use');
  });
});
