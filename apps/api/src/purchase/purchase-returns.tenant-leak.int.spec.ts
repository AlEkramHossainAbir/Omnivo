import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  type Bill,
  billSchema,
  type DebitNote,
  debitNotePageSchema,
  debitNoteSchema,
  type GoodsReceipt,
  goodsReceiptSchema,
  type Product,
  productSchema,
  problemSchema,
  purchaseOrderSchema,
  type PurchaseReturn,
  purchaseReturnPageSchema,
  purchaseReturnSchema,
  setupSchema,
  type Supplier,
  type SupplierPayment,
  supplierPaymentSchema,
  type SupplierRefund,
  supplierRefundPageSchema,
  supplierRefundSchema,
  supplierSchema,
  type TaxRate,
  taxRateListSchema,
  type Unit,
  unitListSchema,
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
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// Step 17d. Two workspaces: A must never see, change, post or delete B's purchase returns and
// debit notes, nor apply B's debit note or void B's supplier refund; nor send back B's goods
// receipt lines, debit B's bills, bill lines, expenses or return lines, or pay back from B's debit
// notes, payments or money. Every answer is 404, or the same "pick one from the list" as for an id
// that does not exist.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let unitsOfA: Unit[];
let ratesOfA: TaxRate[];
let ratesOfB: TaxRate[];
let accountsOfA: Account[];
let accountsOfB: Account[];
let warehouseOfA: Warehouse;
let warehouseOfB: Warehouse;
let productOfA: Product;
let productOfB: Product;
let supplierOfA: Supplier;
let supplierOfB: Supplier;
// 100 cones received and billed
let receiptOfB: GoodsReceipt;
// Posted: bills the receipt line, and a repair
let billOfB: Bill;
// Posted, after the bill: 10 cones back
let returnOfB: PurchaseReturn;
let draftReturnOfB: PurchaseReturn;
// Posted for the 10 cones, applied to the bill; and a draft
let noteOfB: DebitNote;
let draftNoteOfB: DebitNote;
// ৳5,000 in advance, ৳1,000 of it paid back
let advanceOfB: SupplierPayment;
let refundOfB: SupplierRefund;

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

// A return line: from a receipt line, or on its own
function returnLine(variantId: string, unitId: string, extra: object = {}) {
  return {
    variantId,
    unitId,
    quantity: '1',
    batchId: '',
    serialNumbers: [],
    receiptLineId: '',
    ...extra,
  };
}

function returnForm(supplierId: string, warehouse: Warehouse, lines: object[], extra = {}) {
  return {
    supplierId,
    date: '2026-10-17',
    warehouseId: warehouse.id,
    reason: 'damaged',
    note: '',
    lines,
    post: false,
    ...extra,
  };
}

// A debit note line: of a bill line, or of a return line with no bill
function debitLine(unitId: string, extra: object = {}) {
  return {
    billLineId: '',
    returnLineId: '',
    taxRateId: '',
    unitId,
    quantity: '1',
    description: '',
    unitPrice: '100',
    discountType: 'percent',
    discount: '',
    ...extra,
  };
}

function debitForm(supplierId: string, extra = {}) {
  return {
    supplierId,
    billId: '',
    date: '2026-10-17',
    branchId: '',
    pricesIncludeVat: false,
    reason: 'goods_returned',
    supplierCreditNumber: '',
    supplierCreditDate: '',
    note: '',
    lines: [],
    expenses: [],
    post: false,
    ...extra,
  };
}

function refundForm(supplierId: string, warehouse: Warehouse, accounts: Account[], extra = {}) {
  return {
    supplierId,
    date: '2026-10-18',
    amount: '100',
    accountId: codeIn(accounts, '1110'),
    method: 'cash',
    reference: '',
    branchId: warehouse.branchId,
    note: '',
    debitNoteId: '',
    paymentId: '',
    ...extra,
  };
}

async function returnOfBNow(id: string): Promise<PurchaseReturn> {
  return purchaseReturnSchema.parse((await as(tenantB, 'GET', `/purchase-returns/${id}`)).json());
}

async function noteOfBNow(id: string): Promise<DebitNote> {
  return debitNoteSchema.parse((await as(tenantB, 'GET', `/debit-notes/${id}`)).json());
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
  productOfB = await addProduct(tenantB, 'Cotton yarn 30/1', unitsOfB);
  supplierOfA = await addSupplier(tenantA, 'Gazipur Yarn House');
  supplierOfB = await addSupplier(tenantB, 'Tongi Spinning Mills');
  // A has some yarn of its own from before Omnivo, so its own returns are not refused for a cost
  const opening = await as(tenantA, 'POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: warehouseOfA.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      {
        variantId: variantOf(productOfA),
        unitId: pcsOf(unitsOfA),
        quantity: '50',
        batchId: '',
        lotNumber: '',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
        unitCost: '200',
      },
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);

  // B's order of 100 cones at ৳250, approved at once (no order levels), received in full
  const ordered = await as(tenantB, 'POST', '/purchase-orders', {
    supplierId: supplierOfB.id,
    date: '2026-10-12',
    expectedDate: '',
    warehouseId: warehouseOfB.id,
    supplierReference: '',
    paymentTermsDays: 30,
    pricesIncludeVat: false,
    note: '',
    lines: [
      {
        variantId: variantOf(productOfB),
        unitId: pcsOf(unitsOfB),
        quantity: '100',
        description: '',
        unitPrice: '250',
        discountType: 'percent',
        discount: '',
        taxRateId: vatOf(ratesOfB),
        requisitionLineId: '',
      },
    ],
  });
  expect(ordered.statusCode, ordered.body).toBe(201);
  const draftOrder = purchaseOrderSchema.parse(ordered.json());
  const approved = await as(tenantB, 'POST', `/purchase-orders/${draftOrder.id}/submit`, {
    version: draftOrder.version,
  });
  expect(approved.statusCode, approved.body).toBe(200);
  const order = purchaseOrderSchema.parse(approved.json());
  const received = await as(tenantB, 'POST', '/goods-receipts', {
    orderId: order.id,
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
        orderLineId: order.lines[0]?.id ?? '',
        rejectedQuantity: '',
        rejectionReason: '',
      },
    ],
    post: true,
  });
  expect(received.statusCode, received.body).toBe(201);
  receiptOfB = goodsReceiptSchema.parse(received.json());
  const receiptLineId = receiptOfB.lines[0]?.id ?? '';

  // B's Owner bills the cones and a repair: posted at once (no bill levels)
  const billed = await as(tenantB, 'POST', '/bills', {
    supplierId: supplierOfB.id,
    date: '2026-10-16',
    dueDate: '',
    supplierBillNumber: 'TSM-2210',
    mushakNumber: '',
    mushakDate: '',
    branchId: warehouseOfB.branchId,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: [
      {
        variantId: variantOf(productOfB),
        unitId: pcsOf(unitsOfB),
        quantity: '100',
        description: '',
        unitPrice: '250',
        discountType: 'percent',
        discount: '',
        taxRateId: vatOf(ratesOfB),
        receiptLineId,
        orderLineId: '',
        accountId: '',
        lotNumber: '',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
      },
    ],
    expenses: [
      {
        accountId: codeIn(accountsOfB, '5270'),
        description: 'Winding machine repair',
        amount: '1000',
        taxRateId: vatOf(ratesOfB),
      },
    ],
    submit: true,
  });
  expect(billed.statusCode, billed.body).toBe(201);
  billOfB = billSchema.parse(billed.json());
  expect(billOfB.status).toBe('posted');

  // 10 cones go back after the bill, and a draft for 5 more
  const back = await as(
    tenantB,
    'POST',
    '/purchase-returns',
    returnForm(
      supplierOfB.id,
      warehouseOfB,
      [returnLine(variantOf(productOfB), pcsOf(unitsOfB), { quantity: '10', receiptLineId })],
      { post: true },
    ),
  );
  expect(back.statusCode, back.body).toBe(201);
  returnOfB = purchaseReturnSchema.parse(back.json());
  const draftBack = await as(
    tenantB,
    'POST',
    '/purchase-returns',
    returnForm(supplierOfB.id, warehouseOfB, [
      returnLine(variantOf(productOfB), pcsOf(unitsOfB), { quantity: '5', receiptLineId }),
    ]),
  );
  expect(draftBack.statusCode, draftBack.body).toBe(201);
  draftReturnOfB = purchaseReturnSchema.parse(draftBack.json());

  // The debit note for the 10 cones, applied to the bill; and a draft price cut
  const billLineId = billOfB.lines[0]?.id ?? '';
  const note = await as(
    tenantB,
    'POST',
    '/debit-notes',
    debitForm(supplierOfB.id, {
      billId: billOfB.id,
      lines: [
        debitLine(pcsOf(unitsOfB), {
          billLineId,
          returnLineId: returnOfB.lines[0]?.id ?? '',
          quantity: '10',
          unitPrice: '250',
        }),
      ],
      post: true,
    }),
  );
  expect(note.statusCode, note.body).toBe(201);
  noteOfB = debitNoteSchema.parse(note.json());
  expect(noteOfB.applied).toBe('2875.0000');
  const draftNote = await as(
    tenantB,
    'POST',
    '/debit-notes',
    debitForm(supplierOfB.id, {
      billId: billOfB.id,
      reason: 'price_adjustment',
      lines: [debitLine(pcsOf(unitsOfB), { billLineId, quantity: '90', unitPrice: '5' })],
    }),
  );
  expect(draftNote.statusCode, draftNote.body).toBe(201);
  draftNoteOfB = debitNoteSchema.parse(draftNote.json());

  // ৳5,000 in advance; the mill pays ৳1,000 of it back
  const advance = await as(tenantB, 'POST', '/supplier-payments', {
    supplierId: supplierOfB.id,
    date: '2026-10-17',
    amount: '5000',
    accountId: codeIn(accountsOfB, '1110'),
    method: 'cash',
    reference: '',
    supplierBankAccountId: '',
    branchId: warehouseOfB.branchId,
    orderId: '',
    note: '',
    allocations: [],
    submit: true,
  });
  expect(advance.statusCode, advance.body).toBe(201);
  advanceOfB = supplierPaymentSchema.parse(advance.json());
  const refund = await as(
    tenantB,
    'POST',
    '/supplier-refunds',
    refundForm(supplierOfB.id, warehouseOfB, accountsOfB, {
      amount: '1000',
      paymentId: advanceOfB.id,
    }),
  );
  expect(refund.statusCode, refund.body).toBe(201);
  refundOfB = supplierRefundSchema.parse(refund.json());
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe("another workspace's purchase returns", () => {
  it('are not read, changed, posted or deleted', async () => {
    for (const back of [returnOfB, draftReturnOfB]) {
      const answers = await Promise.all([
        as(tenantA, 'GET', `/purchase-returns/${back.id}`),
        as(tenantA, 'PUT', `/purchase-returns/${back.id}`, {
          ...returnForm(supplierOfA.id, warehouseOfA, [
            returnLine(variantOf(productOfA), pcsOf(unitsOfA)),
          ]),
          version: back.version,
        }),
        as(tenantA, 'POST', `/purchase-returns/${back.id}/post`, { version: back.version }),
        as(tenantA, 'DELETE', `/purchase-returns/${back.id}?version=${String(back.version)}`),
      ]);
      expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404, 404]);
      const after = await returnOfBNow(back.id);
      expect([after.status, after.version]).toEqual([back.status, back.version]);
    }
    const page = purchaseReturnPageSchema.parse(
      (await as(tenantA, 'GET', '/purchase-returns')).json(),
    );
    expect(page.items).toEqual([]);
  });

  it("send back none of B's receipt lines, from none of B's stores, to none of B's suppliers", async () => {
    const line = await as(
      tenantA,
      'POST',
      '/purchase-returns',
      returnForm(supplierOfA.id, warehouseOfA, [
        returnLine(variantOf(productOfA), pcsOf(unitsOfA), {
          receiptLineId: receiptOfB.lines[0]?.id ?? '',
        }),
      ]),
    );
    expect(problemOf(line).fieldErrors).toEqual({
      'lines.0.receiptLineId': ['purchase_return_receipt_line_invalid'],
    });
    const store = await as(
      tenantA,
      'POST',
      '/purchase-returns',
      returnForm(supplierOfA.id, warehouseOfB, [
        returnLine(variantOf(productOfA), pcsOf(unitsOfA)),
      ]),
    );
    expect(problemOf(store).fieldErrors).toEqual({ warehouseId: ['stock_warehouse_invalid'] });
    const supplier = await as(
      tenantA,
      'POST',
      '/purchase-returns',
      returnForm(supplierOfB.id, warehouseOfA, [
        returnLine(variantOf(productOfA), pcsOf(unitsOfA)),
      ]),
    );
    expect(problemOf(supplier).fieldErrors).toEqual({ supplierId: ['purchase_supplier_invalid'] });
    // B's goods receipt counts only B's return
    const receipt = goodsReceiptSchema.parse(
      (await as(tenantB, 'GET', `/goods-receipts/${receiptOfB.id}`)).json(),
    );
    expect(receipt.lines[0]?.returnedQuantity).toBe('10.0000');
  });
});

describe("another workspace's debit notes", () => {
  it('are not read, changed, posted, deleted or applied', async () => {
    for (const note of [noteOfB, draftNoteOfB]) {
      const version = { version: note.version };
      const answers = await Promise.all([
        as(tenantA, 'GET', `/debit-notes/${note.id}`),
        as(tenantA, 'PUT', `/debit-notes/${note.id}`, {
          ...debitForm(supplierOfA.id, {
            branchId: warehouseOfA.branchId,
            // A valid form, so the answer is about whose debit note it is
            lines: [
              debitLine(pcsOf(unitsOfA), { returnLineId: note.id, taxRateId: vatOf(ratesOfA) }),
            ],
          }),
          version: note.version,
        }),
        as(tenantA, 'POST', `/debit-notes/${note.id}/post`, version),
        as(tenantA, 'DELETE', `/debit-notes/${note.id}?version=${String(note.version)}`),
        as(tenantA, 'PUT', `/debit-notes/${note.id}/allocations`, { ...version, allocations: [] }),
      ]);
      expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404, 404, 404]);
      const after = await noteOfBNow(note.id);
      expect([after.status, after.version, after.applied]).toEqual([
        note.status,
        note.version,
        note.applied,
      ]);
    }
    const page = debitNotePageSchema.parse((await as(tenantA, 'GET', '/debit-notes')).json());
    expect(page.items).toEqual([]);
    const byBill = debitNotePageSchema.parse(
      (await as(tenantA, 'GET', `/debit-notes?billId=${billOfB.id}`)).json(),
    );
    expect(byBill.items).toEqual([]);
  });

  it("take nothing off B's bills, bill lines, expenses or return lines, nor with B's VAT rates", async () => {
    const bill = await as(
      tenantA,
      'POST',
      '/debit-notes',
      debitForm(supplierOfA.id, {
        billId: billOfB.id,
        lines: [debitLine(pcsOf(unitsOfA), { billLineId: billOfB.lines[0]?.id ?? '' })],
      }),
    );
    expect(problemOf(bill).fieldErrors).toEqual({ billId: ['debit_note_bill_invalid'] });
    // Without a bill: B's return line, at B's VAT rate, at B's branch
    const returnLineOfB = returnOfB.lines[0]?.id ?? '';
    const own = await as(
      tenantA,
      'POST',
      '/debit-notes',
      debitForm(supplierOfA.id, {
        branchId: warehouseOfA.branchId,
        lines: [
          debitLine(pcsOf(unitsOfA), { returnLineId: returnLineOfB, taxRateId: vatOf(ratesOfA) }),
        ],
      }),
    );
    expect(problemOf(own).fieldErrors).toEqual({
      'lines.0.returnLineId': ['debit_note_return_invalid'],
    });
    // A's own return of yarn from before Omnivo, debited at B's rate, or at B's branch
    const ownBack = await as(
      tenantA,
      'POST',
      '/purchase-returns',
      returnForm(
        supplierOfA.id,
        warehouseOfA,
        [returnLine(variantOf(productOfA), pcsOf(unitsOfA), { quantity: '2' })],
        { post: true },
      ),
    );
    expect(ownBack.statusCode, ownBack.body).toBe(201);
    const lineOfA = purchaseReturnSchema.parse(ownBack.json()).lines[0]?.id ?? '';
    const rate = await as(
      tenantA,
      'POST',
      '/debit-notes',
      debitForm(supplierOfA.id, {
        branchId: warehouseOfA.branchId,
        lines: [debitLine(pcsOf(unitsOfA), { returnLineId: lineOfA, taxRateId: vatOf(ratesOfB) })],
      }),
    );
    expect(problemOf(rate).fieldErrors).toEqual({ 'lines.0.taxRateId': ['tax_rate_invalid'] });
    const branch = await as(
      tenantA,
      'POST',
      '/debit-notes',
      debitForm(supplierOfA.id, {
        branchId: warehouseOfB.branchId,
        lines: [debitLine(pcsOf(unitsOfA), { returnLineId: lineOfA, taxRateId: vatOf(ratesOfA) })],
      }),
    );
    expect(problemOf(branch).fieldErrors).toEqual({ branchId: ['purchase_branch_invalid'] });
    // B's bill as where A's debit note's money goes
    const note = await as(
      tenantA,
      'POST',
      '/debit-notes',
      debitForm(supplierOfA.id, {
        branchId: warehouseOfA.branchId,
        lines: [debitLine(pcsOf(unitsOfA), { returnLineId: lineOfA, taxRateId: vatOf(ratesOfA) })],
        post: true,
      }),
    );
    expect(note.statusCode, note.body).toBe(201);
    const noteOfA = debitNoteSchema.parse(note.json());
    const applied = await as(tenantA, 'PUT', `/debit-notes/${noteOfA.id}/allocations`, {
      version: noteOfA.version,
      allocations: [{ billId: billOfB.id, amount: '100' }],
    });
    expect(problemOf(applied).fieldErrors).toEqual({
      'allocations.0.billId': ['debit_note_allocation_invalid'],
    });
    // B's bill and return line count only B's debit note
    const billNow = billSchema.parse((await as(tenantB, 'GET', `/bills/${billOfB.id}`)).json());
    expect([billNow.amountDebited, billNow.lines[0]?.debited]).toEqual(['2875.0000', '2875.0000']);
    expect((await returnOfBNow(returnOfB.id)).lines[0]?.debitedQuantity).toBe('10.0000');
    // Nor B's expense, on a bill of A's own
    const billOfA = await as(tenantA, 'POST', '/bills', {
      supplierId: supplierOfA.id,
      date: '2026-10-16',
      dueDate: '',
      supplierBillNumber: 'GYH-0412',
      mushakNumber: '',
      mushakDate: '',
      branchId: warehouseOfA.branchId,
      warehouseId: '',
      pricesIncludeVat: false,
      note: '',
      lines: [],
      expenses: [
        {
          accountId: codeIn(accountsOfA, '5270'),
          description: 'Linking machine repair',
          amount: '1000',
          taxRateId: vatOf(ratesOfA),
        },
      ],
      submit: true,
    });
    expect(billOfA.statusCode, billOfA.body).toBe(201);
    const expense = await as(
      tenantA,
      'POST',
      '/debit-notes',
      debitForm(supplierOfA.id, {
        billId: billSchema.parse(billOfA.json()).id,
        expenses: [{ billExpenseId: billOfB.expenses[0]?.id ?? '', amount: '100' }],
      }),
    );
    expect(problemOf(expense).fieldErrors).toEqual({
      'expenses.0.billExpenseId': ['debit_note_expense_invalid'],
    });
  });
});

describe("another workspace's supplier refunds", () => {
  it('are not read or voided', async () => {
    const answers = await Promise.all([
      as(tenantA, 'GET', `/supplier-refunds/${refundOfB.id}`),
      as(tenantA, 'POST', `/supplier-refunds/${refundOfB.id}/void`, {
        version: refundOfB.version,
        date: '2026-10-18',
        reason: 'Cheque bounced',
      }),
    ]);
    expect(answers.map((res) => res.statusCode)).toEqual([404, 404]);
    const after = supplierRefundSchema.parse(
      (await as(tenantB, 'GET', `/supplier-refunds/${refundOfB.id}`)).json(),
    );
    expect([after.status, after.version]).toEqual(['posted', refundOfB.version]);
    const page = supplierRefundPageSchema.parse(
      (await as(tenantA, 'GET', '/supplier-refunds')).json(),
    );
    expect(page.items).toEqual([]);
  });

  it("pay back none of B's debit notes or payments, nor into B's money", async () => {
    const note = await as(
      tenantA,
      'POST',
      '/supplier-refunds',
      refundForm(supplierOfA.id, warehouseOfA, accountsOfA, { debitNoteId: noteOfB.id }),
    );
    expect(problemOf(note).fieldErrors).toEqual({
      debitNoteId: ['supplier_refund_source_invalid'],
    });
    const payment = await as(
      tenantA,
      'POST',
      '/supplier-refunds',
      refundForm(supplierOfA.id, warehouseOfA, accountsOfA, { paymentId: advanceOfB.id }),
    );
    expect(problemOf(payment).fieldErrors).toEqual({
      paymentId: ['supplier_refund_source_invalid'],
    });
    // A's own debit note, into B's cash, at B's branch
    const [noteOfA] = debitNotePageSchema.parse(
      (await as(tenantA, 'GET', '/debit-notes?status=posted')).json(),
    ).items;
    const money = await as(
      tenantA,
      'POST',
      '/supplier-refunds',
      refundForm(supplierOfA.id, warehouseOfA, accountsOfB, { debitNoteId: noteOfA?.id ?? '' }),
    );
    expect(problemOf(money).fieldErrors).toEqual({
      accountId: ['supplier_refund_account_invalid'],
    });
    const branch = await as(
      tenantA,
      'POST',
      '/supplier-refunds',
      refundForm(supplierOfA.id, warehouseOfB, accountsOfA, { debitNoteId: noteOfA?.id ?? '' }),
    );
    expect(problemOf(branch).fieldErrors).toEqual({ branchId: ['purchase_branch_invalid'] });
    // B's money is only what B's refund moved
    const advance = supplierPaymentSchema.parse(
      (await as(tenantB, 'GET', `/supplier-payments/${advanceOfB.id}`)).json(),
    );
    expect(advance.refunded).toBe('1000.0000');
    expect((await noteOfBNow(noteOfB.id)).refunded).toBe('0.0000');
  });
});
