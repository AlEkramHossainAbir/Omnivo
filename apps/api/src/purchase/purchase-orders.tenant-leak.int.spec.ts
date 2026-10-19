import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  costLookupSchema,
  type GoodsReceipt,
  goodsReceiptPageSchema,
  goodsReceiptSchema,
  memberPageSchema,
  openRequisitionLinePageSchema,
  type PermissionKey,
  type Product,
  productSchema,
  problemSchema,
  type PurchaseOrder,
  purchaseOrderPageSchema,
  purchaseOrderSchema,
  type Requisition,
  requisitionSchema,
  roleSchema,
  setupSchema,
  stockPageSchema,
  type Supplier,
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

// Step 17b. Two workspaces: A must never see, change, approve, send or receive against B's
// purchase orders and goods receipts, use B's suppliers, items, rates, requisition lines or order
// lines on its own documents, or count B's orders in its stock and prices. Every answer is 404, or
// the same "pick one from the list" as for an id that does not exist.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
// B's merchandiser: B's orders above B's level wait for B's purchase manager
let buyerOfB: SignedIn;
let unitsOfA: Unit[];
let unitsOfB: Unit[];
let ratesOfA: TaxRate[];
let ratesOfB: TaxRate[];
let warehouseOfA: Warehouse;
let warehouseOfB: Warehouse;
let productOfA: Product;
let productOfB: Product;
let supplierOfA: Supplier;
let supplierOfB: Supplier;
let requisitionOfB: Requisition;
// Approved and partly received
let orderOfB: PurchaseOrder;
// Waiting for B's purchase manager
let pendingOfB: PurchaseOrder;
// A draft receipt against orderOfB
let draftReceiptOfB: GoodsReceipt;
let orderOfA: PurchaseOrder;

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

async function addProduct(who: SignedIn, name: string, units: Unit[]): Promise<Product> {
  const res = await as(who, 'POST', '/products', {
    code: '',
    name,
    type: 'goods',
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
    bankAccounts: [],
    notes: '',
  });
  expect(res.statusCode, res.body).toBe(201);
  return supplierSchema.parse(res.json());
}

// A user of B with these permissions: signs up for a workspace of their own, then joins B
async function memberOfB(
  email: string,
  fullName: string,
  password: string,
  permissions: PermissionKey[],
): Promise<{ who: SignedIn; roleId: string }> {
  await signUp(app, {
    companyName: `${fullName} Trading`,
    workspaceSlug: email.split('@')[0] ?? 'trading',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'banani-denim' });
  const made = await as(tenantB, 'POST', '/roles', { name: `${fullName}'s role`, description: '' });
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
  const who = await logIn(app, { workspace: 'banani-denim', email, password, keepSignedIn: false });
  return { who, roleId: role.id };
}

// An order of one line by the piece at 15% VAT
function orderForm(
  supplier: Supplier,
  warehouse: Warehouse,
  product: Product,
  units: Unit[],
  rates: TaxRate[],
  extra: { quantity?: string; unitPrice?: string; requisitionLineId?: string } = {},
) {
  return {
    supplierId: supplier.id,
    date: '2026-10-12',
    expectedDate: '',
    warehouseId: warehouse.id,
    supplierReference: '',
    paymentTermsDays: 30,
    pricesIncludeVat: false,
    note: '',
    lines: [
      {
        variantId: variantOf(product),
        unitId: pcsOf(units),
        quantity: extra.quantity ?? '100',
        description: '',
        unitPrice: extra.unitPrice ?? '250',
        discountType: 'percent',
        discount: '',
        taxRateId: vatOf(rates),
        requisitionLineId: extra.requisitionLineId ?? '',
      },
    ],
  };
}

async function created(who: SignedIn, body: object): Promise<PurchaseOrder> {
  const res = await as(who, 'POST', '/purchase-orders', body);
  expect(res.statusCode, res.body).toBe(201);
  return purchaseOrderSchema.parse(res.json());
}

async function submitted(who: SignedIn, order: PurchaseOrder): Promise<PurchaseOrder> {
  const res = await as(who, 'POST', `/purchase-orders/${order.id}/submit`, {
    version: order.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  return purchaseOrderSchema.parse(res.json());
}

function receiptForm(order: PurchaseOrder, warehouse: Warehouse, units: Unit[], post: boolean) {
  const [line] = order.lines;
  if (!line) throw new Error('the order has no line');
  return {
    orderId: order.id,
    date: '2026-10-14',
    warehouseId: warehouse.id,
    supplierChallan: '',
    vehicle: '',
    note: '',
    lines: [
      {
        variantId: line.variantId,
        unitId: pcsOf(units),
        quantity: '40',
        batchId: '',
        lotNumber: '',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
        orderLineId: line.id,
        rejectedQuantity: '',
        rejectionReason: '',
      },
    ],
    post,
  };
}

async function orderOfBNow(): Promise<PurchaseOrder> {
  return purchaseOrderSchema.parse(
    (await as(tenantB, 'GET', `/purchase-orders/${orderOfB.id}`)).json(),
  );
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
      companyName: 'Ashulia Knit Ltd.',
      workspaceSlug: 'ashulia-knit',
      fullName: 'Arif Chowdhury',
      email: 'arif@ashuliaknit.com',
      password: 'Ashulia-knit-2026',
    }),
    signUp(app, {
      companyName: 'Banani Denim Ltd.',
      workspaceSlug: 'banani-denim',
      fullName: 'Bilkis Rahman',
      email: 'bilkis@bananidenim.com',
      password: 'Banani-denim-2026',
    }),
  ]);
  await Promise.all([setUp(tenantA), setUp(tenantB)]);
  unitsOfA = unitListSchema.parse((await as(tenantA, 'GET', '/units')).json()).items;
  unitsOfB = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;
  ratesOfA = taxRateListSchema.parse((await as(tenantA, 'GET', '/tax-rates')).json()).items;
  ratesOfB = taxRateListSchema.parse((await as(tenantB, 'GET', '/tax-rates')).json()).items;
  warehouseOfA = await firstWarehouse(tenantA);
  warehouseOfB = await firstWarehouse(tenantB);
  productOfA = await addProduct(tenantA, 'Single jersey, black', unitsOfA);
  productOfB = await addProduct(tenantB, 'Denim 12 oz, indigo', unitsOfB);
  supplierOfA = await addSupplier(tenantA, 'Ashulia Yarn House');
  supplierOfB = await addSupplier(tenantB, 'Banani Denim Mills');

  // B's requisition, approved at once (B has no requisition levels), bought for by B's order
  const asked = await as(tenantB, 'POST', '/requisitions', {
    date: '2026-10-10',
    warehouseId: warehouseOfB.id,
    neededBy: '',
    note: '',
    lines: [
      {
        variantId: variantOf(productOfB),
        unitId: pcsOf(unitsOfB),
        quantity: '100',
        description: '',
        estimatedCost: '250',
      },
    ],
  });
  const draft = requisitionSchema.parse(asked.json());
  const approved = await as(tenantB, 'POST', `/requisitions/${draft.id}/submit`, {
    version: draft.version,
  });
  requisitionOfB = requisitionSchema.parse(approved.json());
  const [askedLine] = requisitionOfB.lines;
  if (!askedLine) throw new Error('the requisition has no line');
  orderOfB = await submitted(
    tenantB,
    await created(
      tenantB,
      orderForm(supplierOfB, warehouseOfB, productOfB, unitsOfB, ratesOfB, {
        requisitionLineId: askedLine.id,
      }),
    ),
  );
  expect(orderOfB.status).toBe('approved');
  const posted = await as(tenantB, 'POST', '/goods-receipts', {
    ...receiptForm(orderOfB, warehouseOfB, unitsOfB, true),
  });
  expect(posted.statusCode, posted.body).toBe(201);
  const draftReceipt = await as(
    tenantB,
    'POST',
    '/goods-receipts',
    receiptForm(orderOfB, warehouseOfB, unitsOfB, false),
  );
  expect(draftReceipt.statusCode, draftReceipt.body).toBe(201);
  draftReceiptOfB = goodsReceiptSchema.parse(draftReceipt.json());
  orderOfB = await orderOfBNow();

  // From ৳1,00,000 B's purchase manager approves; B's merchandiser writes one of ৳2,87,500
  const manager = await memberOfB('rakib@bananidenim.com', 'Rakib Hasan', 'Banani-buy-2026', [
    'purchase.order.manage',
  ]);
  const levels = await as(tenantB, 'PUT', '/approval-rules/purchase_order', {
    levels: [{ minAmount: '100000', roleId: manager.roleId }],
    version: 0,
  });
  expect(levels.statusCode, levels.body).toBe(200);
  buyerOfB = (
    await memberOfB('babul@bananidenim.com', 'Babul Mia', 'Banani-merch-2026', [
      'purchase.order.manage',
    ])
  ).who;
  pendingOfB = await submitted(
    buyerOfB,
    await created(
      buyerOfB,
      orderForm(supplierOfB, warehouseOfB, productOfB, unitsOfB, ratesOfB, { quantity: '1000' }),
    ),
  );
  expect(pendingOfB.status).toBe('pending');

  orderOfA = await created(
    tenantA,
    orderForm(supplierOfA, warehouseOfA, productOfA, unitsOfA, ratesOfA),
  );
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe("another workspace's purchase orders", () => {
  it('are never shown, changed or moved', async () => {
    const before = await orderOfBNow();
    const version = { version: before.version };
    const tries = [
      as(tenantA, 'GET', `/purchase-orders/${orderOfB.id}`),
      as(tenantA, 'PUT', `/purchase-orders/${orderOfB.id}`, {
        ...orderForm(supplierOfA, warehouseOfA, productOfA, unitsOfA, ratesOfA),
        ...version,
      }),
      as(tenantA, 'DELETE', `/purchase-orders/${orderOfB.id}?version=${String(before.version)}`),
      ...(['submit', 'reopen', 'close', 'cancel'] as const).map((action) =>
        as(tenantA, 'POST', `/purchase-orders/${orderOfB.id}/${action}`, version),
      ),
    ];
    for (const res of await Promise.all(tries)) expect(res.statusCode).toBe(404);
    const after = await orderOfBNow();
    expect([after.status, after.version]).toEqual([before.status, before.version]);

    // A's lists have only A's, whatever the filter names
    for (const query of ['', `?supplierId=${supplierOfB.id}`, '?receipt=to_receive']) {
      const page = purchaseOrderPageSchema.parse(
        (await as(tenantA, 'GET', `/purchase-orders${query}`)).json(),
      );
      expect(page.items.every((item) => item.id === orderOfA.id)).toBe(true);
    }
  });

  it("are never approved from A, and never in A's waiting list", async () => {
    const [round] = pendingOfB.approval.rounds;
    const res = await as(tenantA, 'POST', `/approvals/purchase_order/${pendingOfB.id}/approve`, {
      roundId: round?.id ?? '',
      comment: '',
    });
    expect(res.statusCode).toBe(404);
    const waiting = waitingApprovalPageSchema.parse(
      (await as(tenantA, 'GET', '/approvals/waiting')).json(),
    );
    expect(waiting.items).toEqual([]);
    // B's Owner sees it, still waiting
    const ofB = waitingApprovalPageSchema.parse(
      (await as(tenantB, 'GET', '/approvals/waiting')).json(),
    );
    expect(ofB.items.map((item) => item.id)).toEqual([pendingOfB.id]);
  });

  it('never go out from A: no PDF, email or share link', async () => {
    const path = `/documents/purchase_order/${orderOfB.id}`;
    const tries = [
      as(tenantA, 'POST', `${path}/files`, { language: 'en' }),
      as(tenantA, 'GET', `${path}/email-draft?language=en`),
      as(tenantA, 'POST', `${path}/shares`, { language: 'en' }),
    ];
    for (const res of await Promise.all(tries)) expect(res.statusCode).toBe(404);
  });

  it("lend A nothing: B's supplier, store, item, VAT rate or requisition line", async () => {
    const [lineOfB] = requisitionOfB.lines;
    const tries: [object, Record<string, string[]>][] = [
      [
        orderForm(supplierOfB, warehouseOfA, productOfA, unitsOfA, ratesOfA),
        { supplierId: ['purchase_supplier_invalid'] },
      ],
      [
        orderForm(supplierOfA, warehouseOfB, productOfA, unitsOfA, ratesOfA),
        { warehouseId: ['purchase_warehouse_invalid'] },
      ],
      [
        orderForm(supplierOfA, warehouseOfA, productOfB, unitsOfA, ratesOfA),
        { 'lines.0.variantId': ['purchase_item_invalid'] },
      ],
      [
        orderForm(supplierOfA, warehouseOfA, productOfA, unitsOfA, ratesOfB),
        { 'lines.0.taxRateId': ['tax_rate_invalid'] },
      ],
      [
        orderForm(supplierOfA, warehouseOfA, productOfA, unitsOfA, ratesOfA, {
          requisitionLineId: lineOfB?.id ?? '',
        }),
        { 'lines.0.requisitionLineId': ['purchase_requisition_line_invalid'] },
      ],
    ];
    for (const [body, fieldErrors] of tries) {
      const res = await as(tenantA, 'POST', '/purchase-orders', body);
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).fieldErrors).toEqual(fieldErrors);
    }
    // B's requisition still counts only B's order
    const asked = requisitionSchema.parse(
      (await as(tenantB, 'GET', `/requisitions/${requisitionOfB.id}`)).json(),
    );
    expect(asked.orders.map((item) => item.id)).toEqual([orderOfB.id]);
    // ...and A's order form never offers its lines, even when asked for B's store
    for (const warehouse of [warehouseOfA, warehouseOfB]) {
      const open = openRequisitionLinePageSchema.parse(
        (await as(tenantA, 'GET', `/requisition-lines?warehouseId=${warehouse.id}`)).json(),
      );
      expect(open.items).toEqual([]);
    }
  });
});

describe("another workspace's goods receipts", () => {
  it('are never shown, changed, posted or deleted', async () => {
    const tries = [
      as(tenantA, 'GET', `/goods-receipts/${draftReceiptOfB.id}`),
      as(tenantA, 'PUT', `/goods-receipts/${draftReceiptOfB.id}`, {
        date: '2026-10-15',
        warehouseId: warehouseOfA.id,
        supplierChallan: '',
        vehicle: '',
        note: '',
        lines: receiptForm(orderOfB, warehouseOfA, unitsOfA, false).lines,
        post: false,
        version: draftReceiptOfB.version,
      }),
      as(tenantA, 'POST', `/goods-receipts/${draftReceiptOfB.id}/post`, {
        version: draftReceiptOfB.version,
      }),
      as(
        tenantA,
        'DELETE',
        `/goods-receipts/${draftReceiptOfB.id}?version=${String(draftReceiptOfB.version)}`,
      ),
    ];
    for (const res of await Promise.all(tries)) expect(res.statusCode).toBe(404);
    const still = goodsReceiptSchema.parse(
      (await as(tenantB, 'GET', `/goods-receipts/${draftReceiptOfB.id}`)).json(),
    );
    expect([still.status, still.version]).toEqual(['draft', draftReceiptOfB.version]);
    const page = goodsReceiptPageSchema.parse(
      (await as(tenantA, 'GET', `/goods-receipts?orderId=${orderOfB.id}`)).json(),
    );
    expect(page.items).toEqual([]);
  });

  it("never take goods against B's order or B's order lines", async () => {
    const res = await as(
      tenantA,
      'POST',
      '/goods-receipts',
      receiptForm(orderOfB, warehouseOfA, unitsOfA, true),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ orderId: ['grn_order_invalid'] });

    // A's own approved order, with B's order line and then B's store
    const approved = await submitted(tenantA, orderOfA);
    const [lineOfB] = orderOfB.lines;
    const form = receiptForm(approved, warehouseOfA, unitsOfA, true);
    const stolenLine = await as(tenantA, 'POST', '/goods-receipts', {
      ...form,
      lines: form.lines.map((line) => ({ ...line, orderLineId: lineOfB?.id ?? '' })),
    });
    expect(problemOf(stolenLine).fieldErrors).toEqual({
      'lines.0.orderLineId': ['grn_order_line_invalid'],
    });
    const elsewhere = await as(tenantA, 'POST', '/goods-receipts', {
      ...form,
      warehouseId: warehouseOfB.id,
    });
    expect(problemOf(elsewhere).fieldErrors).toEqual({ warehouseId: ['stock_warehouse_invalid'] });
    // B's order took in only what B's own receipt brought
    expect((await orderOfBNow()).lines[0]?.receivedQuantity).toBe('40.0000');
  });
});

describe("another workspace's stock and prices", () => {
  it("never count in A's incoming goods or A's last price", async () => {
    const stock = stockPageSchema.parse((await as(tenantA, 'GET', '/stock')).json());
    expect(stock.items.map((item) => [item.productName, item.incoming])).toEqual([
      ['Single jersey, black', '100.0000'],
    ]);
    const res = await as(tenantA, 'POST', '/purchase/cost-lookup', {
      supplierId: supplierOfB.id,
      items: [
        { variantId: variantOf(productOfB), unitId: pcsOf(unitsOfA) },
        { variantId: variantOf(productOfA), unitId: pcsOf(unitsOfA) },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    // B's item is left out; A's comes from A's own order, never from B's supplier
    expect(
      costLookupSchema
        .parse(res.json())
        .items.map((item) => [item.variantId, item.cost, item.source]),
    ).toEqual([[variantOf(productOfA), '250.0000', 'last_price']]);
  });
});
