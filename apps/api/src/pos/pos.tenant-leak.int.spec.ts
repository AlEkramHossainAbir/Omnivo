import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  type Customer,
  customerSchema,
  type Device,
  deviceSchema,
  type PosCashReason,
  posCashReasonListSchema,
  posCashReasonSchema,
  type PosRegister,
  posRegisterListSchema,
  posRegisterSalesPageSchema,
  posRegisterSchema,
  posReturnAmounts,
  posReturnPageSchema,
  type PosSale,
  posSalePageSchema,
  posSaleSchema,
  posShiftPageSchema,
  posShiftSchema,
  problemSchema,
  type Product,
  productSchema,
  setupSchema,
  soldShortPageSchema,
  SYNC_PROTOCOL,
  type SyncCommandInput,
  syncPullSchema,
  syncPushSchema,
  type TaxRate,
  taxRateListSchema,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

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

// Step 20a. Two shops: A must never see, change, take or let go of B's registers, nor read B's
// sales or what B sold short; and a sale A's counter pushes takes none of B's registers,
// customers, items, VAT rates or batches. Every answer is 404, or the same refusal as for an id
// that does not exist. Step 20b: the same for B's pay in and pay out reasons and B's shifts.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: the batches and the bell, which no route of this step lists
let sql: postgres.Sql;

// What each workspace has: its owner, its store, its chart, a VAT rate, Napa with a batch, a
// customer, and a counter PC that holds its register
interface Shop {
  who: SignedIn;
  store: Warehouse;
  accounts: Account[];
  vat: TaxRate;
  pcs: string;
  napa: Product;
  batchId: string;
  customer: Customer;
  device: Device;
  register: PosRegister;
}

let a: Shop;
let b: Shop;
// B's sale: Napa it did not have enough of, for its customer
let saleOfB: PosSale;
// B's float reason, and the shift B's counter has open
let reasonOfB: PosCashReason;
let shiftOfB: string;
// Step 20c: A's open shift (from "are not used by A's counter"), and B's return of its sale
let shiftOfA: string;
let returnOfB: string;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type SaleLine = SaleCommand['input']['lines'][number];

function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

function as(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
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

function cashOf(shop: Pick<Shop, 'accounts'>): string {
  const cash = shop.accounts.find((account) => account.code === '1110');
  if (!cash) throw new Error('no cash account');
  return cash.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function accountOf(shop: Pick<Shop, 'accounts'>, code: string): string {
  const account = shop.accounts.find((item) => item.code === code);
  if (!account) throw new Error(`no account ${code}`);
  return account.id;
}

function shiftOpen(shop: Shop, sequence: number, total: string, floatReasonId = '') {
  return {
    id: v7(),
    type: 'pos_shift.open',
    shiftId: v7(),
    input: {
      registerId: shop.register.id,
      sequence,
      date: '2026-10-27',
      openedAt: '2026-10-27T03:00:00.000Z',
      opening: { notes: null, total },
      floatReasonId,
    },
  } satisfies SyncCommandInput;
}

function shiftMove(shiftId: string, reasonId: string) {
  return {
    id: v7(),
    type: 'pos_cash_movement.create',
    movementId: v7(),
    input: {
      shiftId,
      reasonId,
      amount: '100',
      note: '',
      date: '2026-10-27',
      movedAt: '2026-10-27T05:00:00.000Z',
    },
  } satisfies SyncCommandInput;
}

function overShortOf(shop: Pick<Shop, 'accounts'>): string {
  const account = shop.accounts.find((item) => item.code === '5350');
  if (!account) throw new Error('no over/short account');
  return account.id;
}

function registerForm(code: string, warehouseId: string, cash: string, overShort: string) {
  return {
    code,
    name: `Counter ${code}`,
    warehouseId,
    accounts: { cash, card: '', bkash: '', nagad: '' },
    maxDiscountPercent: '',
    paperWidth: '80',
    receiptFooter: '',
    overShortAccountId: overShort,
    varianceAlert: '500',
    lockAfter: '5',
    // Step 20c: no exchanges, and the form's 7 days
    exchangeAccountId: '',
    returnDays: '7',
  };
}

function claim(shop: Pick<Shop, 'who' | 'device'>, register: PosRegister) {
  return as(shop.who, 'POST', `/pos/registers/${register.id}/claim`, {
    deviceId: shop.device.id,
  });
}

async function open(company: string, slug: string, fullName: string, email: string) {
  const who = await signUp(app, {
    companyName: company,
    workspaceSlug: slug,
    fullName,
    email,
    password: 'Counter-shop-2026',
  });
  expect((await as(who, 'POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
  const [store] = warehouseListSchema.parse((await as(who, 'GET', '/warehouses')).json()).items;
  if (!store) throw new Error('no warehouse');
  const accounts = accountListSchema.parse((await as(who, 'GET', '/accounts')).json()).items;
  const [vat] = taxRateListSchema.parse((await as(who, 'GET', '/tax-rates')).json()).items;
  if (!vat) throw new Error('no VAT rate');
  const units = unitListSchema.parse((await as(who, 'GET', '/units')).json()).items;
  const pcs = units.find((unit) => unit.code === 'pcs')?.id ?? '';

  const made = await as(who, 'POST', '/products', {
    code: '',
    name: 'Napa 500 mg strip',
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcs,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'batch',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '30', archived: false },
    ],
    units: [],
    customFields: {},
  });
  expect(made.statusCode, made.body).toBe(201);
  const napa = productSchema.parse(made.json());
  const lotNumber = `${slug.toUpperCase()}-LOT`;
  const stocked = await as(who, 'POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: store.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      {
        variantId: variantOf(napa),
        unitId: pcs,
        quantity: '2',
        batchId: '',
        lotNumber,
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
        unitCost: '20',
      },
    ],
  });
  expect(stocked.statusCode, stocked.body).toBe(201);
  const [lot] = z
    .array(z.object({ id: z.string() }))
    .parse(await sql`SELECT id::text FROM batches WHERE lot_number = ${lotNumber}`);

  const customer = await as(who, 'POST', '/customers', {
    code: '',
    name: `${company} regular`,
    groupId: '',
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
  expect(customer.statusCode, customer.body).toBe(201);
  const device = await as(who, 'POST', '/sync/devices', {
    id: v7(),
    name: 'Front counter PC',
    branchId: store.branchId,
  });
  expect(device.statusCode, device.body).toBe(201);
  const made1 = await as(
    who,
    'POST',
    '/pos/registers',
    registerForm('POS1', store.id, cashOf({ accounts }), overShortOf({ accounts })),
  );
  expect(made1.statusCode, made1.body).toBe(201);
  const shop: Shop = {
    who,
    store,
    accounts,
    vat,
    pcs,
    napa,
    batchId: lot?.id ?? '',
    customer: customerSchema.parse(customer.json()),
    device: deviceSchema.parse(device.json()),
    register: posRegisterSchema.parse(made1.json()),
  };
  const held = await claim(shop, shop.register);
  expect(held.statusCode, held.body).toBe(200);
  return { ...shop, register: posRegisterSchema.parse(held.json()) };
}

// Five strips of Napa from the shop's own batch
function line(shop: Shop, extra: Partial<SaleLine> = {}): SaleLine {
  return {
    variantId: variantOf(shop.napa),
    unitId: shop.pcs,
    quantity: '5',
    description: '',
    unitPrice: '30',
    discountType: 'percent',
    discount: '0',
    taxRateId: shop.vat.id,
    rate: shop.vat.rate,
    startingPrice: '30',
    batchId: shop.batchId,
    serialNumbers: [],
    ...extra,
  };
}

function sale(
  shop: Shop,
  sequence: number,
  lines: SaleLine[],
  extra: Partial<SaleCommand['input']> = {},
): SaleCommand {
  return {
    id: v7(),
    type: 'pos_sale.create',
    saleId: v7(),
    input: {
      registerId: shop.register.id,
      sequence,
      date: '2026-10-27',
      soldAt: '2026-10-27T08:30:00.000Z',
      customerId: '',
      pricesIncludeVat: true,
      lines,
      billDiscountType: 'amount',
      billDiscount: '0',
      payments: [{ method: 'cash', amount: '500', reference: '' }],
      ...extra,
    },
  };
}

async function pushed(shop: Shop, commands: SyncCommandInput[]) {
  const res = await as(shop.who, 'POST', '/sync/push', {
    deviceId: shop.device.id,
    protocol: SYNC_PROTOCOL,
    commands,
  });
  expect(res.statusCode, res.body).toBe(200);
  return syncPushSchema.parse(res.json()).results;
}

async function registerOfBNow(): Promise<PosRegister> {
  return posRegisterSchema.parse(
    (await as(b.who, 'GET', `/pos/registers/${b.register.id}`)).json(),
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
  sql = postgres(pg.superuserUrl, { max: 2 });
  [a, b] = await Promise.all([
    open('Agora Mini Mart', 'agora-mini-mart', 'Nusrat Jahan', 'nusrat@agoramart.com'),
    open('Banani Super Shop', 'banani-super-shop', 'Tareq Aziz', 'tareq@bananisupershop.com'),
  ]);
  // B sells 5 strips with 2 on hand, to its regular customer: a sold-short line and a bell
  const [result] = await pushed(b, [sale(b, 1, [line(b)], { customerId: b.customer.id })]);
  expect(result?.status, JSON.stringify(result)).toBe('accepted');
  const [first] = posSalePageSchema.parse((await as(b.who, 'GET', '/pos/sales')).json()).items;
  if (!first) throw new Error('B has no sale');
  saleOfB = posSaleSchema.parse((await as(b.who, 'GET', `/pos/sales/${first.id}`)).json());
  expect(saleOfB.soldShort).toBe(true);

  // B's counter opens its first shift with ৳2,000 from the owner
  const reason = await as(b.who, 'POST', '/pos/cash-reasons', {
    name: 'Float from the owner',
    direction: 'in',
    accountId: accountOf(b, '3100'),
  });
  expect(reason.statusCode, reason.body).toBe(201);
  reasonOfB = posCashReasonSchema.parse(reason.json());
  const opening = shiftOpen(b, 1, '2000', reasonOfB.id);
  shiftOfB = opening.shiftId;
  const [opened] = await pushed(b, [opening]);
  expect(opened?.status, JSON.stringify(opened)).toBe('accepted');
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe("another workspace's registers", () => {
  it('are not read, changed, archived, restored, taken or let go', async () => {
    const id = b.register.id;
    const version = { version: b.register.version };
    const answers = await Promise.all([
      as(a.who, 'GET', `/pos/registers/${id}`),
      // A valid form of A's own, so the answer is about whose register it is
      as(a.who, 'PUT', `/pos/registers/${id}`, {
        ...registerForm('POS1', a.store.id, cashOf(a), overShortOf(a)),
        ...version,
      }),
      as(a.who, 'POST', `/pos/registers/${id}/archive`, version),
      as(a.who, 'POST', `/pos/registers/${id}/restore`, version),
      as(a.who, 'POST', `/pos/registers/${id}/claim`, { deviceId: a.device.id }),
      as(a.who, 'POST', `/pos/registers/${id}/release`, { deviceId: a.device.id }),
    ]);
    expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
    // Still B's, held by B's counter, with B's one sale and B's open shift
    expect(await registerOfBNow()).toEqual({
      ...b.register,
      lastNumber: 1,
      lastShift: { id: shiftOfB, sequence: 1, status: 'open', cashLeft: null },
    });
    const list = posRegisterListSchema.parse((await as(a.who, 'GET', '/pos/registers')).json());
    expect(list.items.map((item) => item.id)).toEqual([a.register.id]);
    const branch = posRegisterListSchema.parse(
      (await as(a.who, 'GET', `/pos/registers?branchId=${b.store.branchId}`)).json(),
    );
    expect(branch.items).toEqual([]);
  });

  it("are not taken by A's devices, and A's are not taken by B's", async () => {
    // A lets go of its own register, then asks for it with B's counter PC: a device A does not have
    const free = await as(a.who, 'POST', `/pos/registers/${a.register.id}/release`, {
      deviceId: a.device.id,
    });
    expect(free.statusCode, free.body).toBe(200);
    const res = await as(a.who, 'POST', `/pos/registers/${a.register.id}/claim`, {
      deviceId: b.device.id,
    });
    expect(res.statusCode).toBe(404);
    expect(problemOf(res).code).toBe('device_not_found');
    const back = await claim(a, a.register);
    expect(back.statusCode, back.body).toBe(200);
  });

  it("are not made with B's warehouses or accounts", async () => {
    const store = await as(
      a.who,
      'POST',
      '/pos/registers',
      registerForm('POS2', b.store.id, cashOf(a), overShortOf(a)),
    );
    expect(problemOf(store).fieldErrors).toEqual({
      warehouseId: ['pos_register_warehouse_invalid'],
    });
    const cash = await as(
      a.who,
      'POST',
      '/pos/registers',
      registerForm('POS2', a.store.id, cashOf(b), overShortOf(a)),
    );
    expect(problemOf(cash).fieldErrors).toEqual({
      'accounts.cash': ['pos_register_account_invalid'],
    });
  });

  it("are not in A's pull", async () => {
    const query = new URLSearchParams({
      deviceId: a.device.id,
      protocol: String(SYNC_PROTOCOL),
      limit: '1000',
    });
    const res = await as(a.who, 'GET', `/sync/pull?${query.toString()}`);
    expect(res.statusCode, res.body).toBe(200);
    const keys = syncPullSchema
      .parse(res.json())
      .changes.filter((change) => change.entity === 'pos_register')
      .map((change) => change.key);
    expect(keys).toEqual([a.register.id]);
  });
});

describe("another workspace's sales", () => {
  it('are not read or listed, nor what they sold short', async () => {
    expect((await as(a.who, 'GET', `/pos/sales/${saleOfB.id}`)).statusCode).toBe(404);
    for (const query of ['', `?registerId=${b.register.id}`, `?customerId=${b.customer.id}`]) {
      const page = posSalePageSchema.parse((await as(a.who, 'GET', `/pos/sales${query}`)).json());
      expect(page.items).toEqual([]);
    }
    for (const query of ['', `?warehouseId=${b.store.id}`]) {
      const page = soldShortPageSchema.parse(
        (await as(a.who, 'GET', `/pos/sold-short${query}`)).json(),
      );
      expect(page.items).toEqual([]);
    }
    // B's bell reached B's owner only
    await eventually(async () => {
      const bells = z.array(z.object({ email: z.string() })).parse(
        await sql`SELECT u.email FROM notifications n JOIN users u ON u.id = n.user_id
                    WHERE n.type = 'pos.sold_short'`,
      );
      expect(bells.map((bell) => bell.email)).toEqual(['tareq@bananisupershop.com']);
    });
  });

  it("take none of B's registers, customers, items, VAT rates or batches", async () => {
    // Number 9 of B's register: if it leaked, B's last number would jump from 1 to 9
    const onB = sale(a, 9, [line(a)]);
    const results = await pushed(a, [
      { ...onB, input: { ...onB.input, registerId: b.register.id } },
      sale(a, 2, [line(a)], { customerId: b.customer.id }),
      sale(a, 3, [line(a, { variantId: variantOf(b.napa), batchId: '' })]),
      sale(a, 4, [line(a, { taxRateId: b.vat.id })]),
      sale(a, 5, [line(a, { batchId: b.batchId })]),
    ]);
    expect(results.map((result) => (result.status === 'rejected' ? result.error : null))).toEqual([
      { code: 'pos_register_not_held', fieldErrors: { registerId: ['pos_register_not_held'] } },
      { code: 'sales_customer_invalid', fieldErrors: { customerId: ['sales_customer_invalid'] } },
      { code: 'sales_item_invalid', fieldErrors: { 'lines.0.variantId': ['sales_item_invalid'] } },
      { code: 'tax_rate_invalid', fieldErrors: { 'lines.0.taxRateId': ['tax_rate_invalid'] } },
      { code: 'stock_batch_invalid', fieldErrors: { 'lines.0.batchId': ['stock_batch_invalid'] } },
    ]);
    // The refused sales kept their numbers in A's register, never in B's
    expect((await registerOfBNow()).lastNumber).toBe(1);
    const own = posRegisterSchema.parse(
      (await as(a.who, 'GET', `/pos/registers/${a.register.id}`)).json(),
    );
    expect(own.lastNumber).toBe(5);
  });
});

describe("another workspace's reasons and shifts", () => {
  it('are not read, changed, archived, restored or closed', async () => {
    const own = await as(a.who, 'POST', '/pos/cash-reasons', {
      name: 'Float from the owner',
      direction: 'in',
      accountId: accountOf(a, '3100'),
    });
    expect(own.statusCode, own.body).toBe(201);
    const ownReason = posCashReasonSchema.parse(own.json());
    const version = { version: reasonOfB.version };
    const answers = await Promise.all([
      as(a.who, 'PUT', `/pos/cash-reasons/${reasonOfB.id}`, {
        name: 'Taken over',
        accountId: accountOf(a, '3100'),
        ...version,
      }),
      as(a.who, 'POST', `/pos/cash-reasons/${reasonOfB.id}/archive`, version),
      as(a.who, 'POST', `/pos/cash-reasons/${reasonOfB.id}/restore`, version),
      as(a.who, 'GET', `/pos/shifts/${shiftOfB}`),
      as(a.who, 'POST', `/pos/shifts/${shiftOfB}/close-without-count`, { note: '' }),
    ]);
    expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404, 404, 404]);
    for (const status of ['', '?status=archived']) {
      const list = posCashReasonListSchema.parse(
        (await as(a.who, 'GET', `/pos/cash-reasons${status}`)).json(),
      );
      expect(list.items.map((item) => item.id)).toEqual(status === '' ? [ownReason.id] : []);
    }
    for (const query of ['', `?registerId=${b.register.id}`, '?status=open']) {
      const page = posShiftPageSchema.parse((await as(a.who, 'GET', `/pos/shifts${query}`)).json());
      expect(page.items).toEqual([]);
    }
    // Still B's, as it was, and still open
    const reasonNow = posCashReasonListSchema.parse(
      (await as(b.who, 'GET', '/pos/cash-reasons')).json(),
    );
    expect(reasonNow.items).toEqual([reasonOfB]);
    const shift = posShiftSchema.parse((await as(b.who, 'GET', `/pos/shifts/${shiftOfB}`)).json());
    expect(shift).toMatchObject({ status: 'open', movements: [], closedBy: null });
  });

  it("are not made with B's accounts", async () => {
    const reason = await as(a.who, 'POST', '/pos/cash-reasons', {
      name: 'Cash to the bank',
      direction: 'out',
      accountId: accountOf(b, '3100'),
    });
    expect(problemOf(reason).fieldErrors).toEqual({ accountId: ['pos_reason_account_invalid'] });
    const register = await as(
      a.who,
      'POST',
      '/pos/registers',
      registerForm('POS2', a.store.id, cashOf(a), overShortOf(b)),
    );
    expect(problemOf(register).fieldErrors).toEqual({
      overShortAccountId: ['pos_over_short_invalid'],
    });
  });

  it("are not in A's pull", async () => {
    const query = new URLSearchParams({
      deviceId: a.device.id,
      protocol: String(SYNC_PROTOCOL),
      limit: '1000',
    });
    const res = await as(a.who, 'GET', `/sync/pull?${query.toString()}`);
    expect(res.statusCode, res.body).toBe(200);
    const changes = syncPullSchema.parse(res.json()).changes;
    const reasons = changes.filter((change) => change.entity === 'pos_cash_reason');
    expect(reasons.map((change) => change.key)).not.toContain(reasonOfB.id);
    expect(JSON.stringify(changes)).not.toContain(shiftOfB);
  });

  it("are not used by A's counter", async () => {
    // A's first shift with B's float reason: the same refusal as a reason nobody has
    const [float] = await pushed(a, [shiftOpen(a, 1, '1500', reasonOfB.id)]);
    expect(float?.status === 'rejected' ? float.error.code : float?.status).toBe(
      'pos_float_reason_required',
    );
    const opening = shiftOpen(a, 1, '0');
    const [opened] = await pushed(a, [opening]);
    expect(opened?.status, JSON.stringify(opened)).toBe('accepted');
    shiftOfA = opening.shiftId;
    const [ownReason] = posCashReasonListSchema.parse(
      (await as(a.who, 'GET', '/pos/cash-reasons')).json(),
    ).items;
    if (!ownReason) throw new Error('A has no reason');
    const onB = sale(a, 6, [line(a)]);
    const results = await pushed(a, [
      shiftMove(shiftOfB, ownReason.id),
      shiftMove(opening.shiftId, reasonOfB.id),
      { ...onB, input: { ...onB.input, shiftId: shiftOfB } },
      {
        id: v7(),
        type: 'pos_shift.close',
        shiftId: shiftOfB,
        input: {
          date: '2026-10-27',
          closedAt: '2026-10-27T15:00:00.000Z',
          counted: { notes: null, total: '0' },
          deviceExpected: '0',
          heldDropped: 0,
        },
      },
    ]);
    expect(
      results.map((result) => (result.status === 'rejected' ? result.error.code : null)),
    ).toEqual([
      'pos_shift_unknown',
      'pos_reason_required',
      'pos_shift_unknown',
      'pos_shift_unknown',
    ]);
    // B's shift took nothing of it
    const shift = posShiftSchema.parse((await as(b.who, 'GET', `/pos/shifts/${shiftOfB}`)).json());
    expect(shift).toMatchObject({
      status: 'open',
      saleCount: 0,
      movements: [],
      expectedCash: '2000.0000',
    });
  });
});

describe("another workspace's returns", () => {
  it("are not read, listed or found by A, nor is B's receipt", async () => {
    // B takes back one strip of its sale, in cash, in its open shift
    const [sold] = saleOfB.lines;
    if (!sold) throw new Error('B sold no line');
    const amounts = posReturnAmounts(sold, '1');
    returnOfB = v7();
    const [taken] = await pushed(b, [
      {
        id: v7(),
        type: 'pos_return.create',
        returnId: returnOfB,
        input: {
          registerId: b.register.id,
          sequence: 1,
          shiftId: shiftOfB,
          date: '2026-10-27',
          returnedAt: '2026-10-27T09:00:00.000Z',
          saleId: saleOfB.id,
          lines: [
            {
              saleLineId: sold.id,
              quantity: '1',
              net: amounts.net,
              vat: amounts.vat,
              serialNumbers: [],
            },
          ],
          refunds: [{ method: 'cash', amount: amounts.total, reference: '' }],
          note: '',
        },
      },
    ]);
    expect(taken?.status, JSON.stringify(taken)).toBe('accepted');

    const answers = await Promise.all([
      as(a.who, 'GET', `/pos/returns/${returnOfB}`),
      as(a.who, 'GET', `/pos/sales/by-number/${saleOfB.number}`),
      as(a.who, 'GET', `/pos/registers/${b.register.id}/sales`),
    ]);
    expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404]);
    for (const query of [
      '',
      `?registerId=${b.register.id}`,
      `?saleId=${saleOfB.id}`,
      `?shiftId=${shiftOfB}`,
    ]) {
      const page = posReturnPageSchema.parse(
        (await as(a.who, 'GET', `/pos/returns${query}`)).json(),
      );
      expect(page.items).toEqual([]);
    }
    // A's own register lists A's sales only
    const own = posRegisterSalesPageSchema.parse(
      (await as(a.who, 'GET', `/pos/registers/${a.register.id}/sales`)).json(),
    );
    expect(own.items.map((item) => item.id)).not.toContain(saleOfB.id);
  });

  it("are not made of B's sale by A's counter, nor spent on A's sale", async () => {
    const [sold] = saleOfB.lines;
    if (!sold) throw new Error('B sold no line');
    const amounts = posReturnAmounts(sold, '1');
    const onB = sale(a, 7, [line(a)]);
    const results = await pushed(a, [
      // A's counter takes back a strip of B's receipt
      {
        id: v7(),
        type: 'pos_return.create',
        returnId: v7(),
        input: {
          registerId: a.register.id,
          sequence: 1,
          shiftId: shiftOfA,
          date: '2026-10-27',
          returnedAt: '2026-10-27T10:00:00.000Z',
          saleId: saleOfB.id,
          lines: [
            {
              saleLineId: sold.id,
              quantity: '1',
              net: amounts.net,
              vat: amounts.vat,
              serialNumbers: [],
            },
          ],
          refunds: [{ method: 'cash', amount: amounts.total, reference: '' }],
          note: '',
        },
      },
      // A's sale paid with B's return as an exchange
      {
        ...onB,
        input: {
          ...onB.input,
          shiftId: shiftOfA,
          payments: [
            // The ৳150 of five strips (prices with VAT), all of it
            { method: 'exchange', amount: '150', reference: '', returnId: returnOfB },
          ],
        },
      },
    ]);
    expect(results.map((result) => (result.status === 'rejected' ? result.error : null))).toEqual([
      {
        code: 'pos_return_sale_not_found',
        fieldErrors: { saleId: ['pos_return_sale_not_found'] },
      },
      {
        code: 'pos_return_unknown',
        fieldErrors: { 'payments.0.method': ['pos_return_unknown'] },
      },
    ]);
    // B's sale and B's return are as they were
    const saleNow = posSaleSchema.parse(
      (await as(b.who, 'GET', `/pos/sales/${saleOfB.id}`)).json(),
    );
    expect(saleNow.returns.map((item) => item.id)).toEqual([returnOfB]);
    expect(saleNow.lines[0]?.returnedQuantity).toBe('1.0000');
  });

  it("are not in A's pull", async () => {
    const query = new URLSearchParams({
      deviceId: a.device.id,
      protocol: String(SYNC_PROTOCOL),
      limit: '1000',
    });
    const res = await as(a.who, 'GET', `/sync/pull?${query.toString()}`);
    expect(res.statusCode, res.body).toBe(200);
    const changes = syncPullSchema.parse(res.json()).changes;
    const sales = changes.filter((change) => change.entity === 'pos_sale');
    expect(sales.map((change) => change.key)).not.toContain(saleOfB.id);
    expect(JSON.stringify(changes)).not.toContain(returnOfB);
  });
});
