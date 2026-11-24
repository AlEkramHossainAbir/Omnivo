import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  DEFAULT_SETTINGS,
  invoiceSchema,
  memberPageSchema,
  type PermissionKey,
  problemSchema,
  type Product,
  productSchema,
  roleSchema,
  salesOrderSchema,
  type ShopCartQuote,
  shopCartQuoteSchema,
  type ShopOrderRequestInput,
  type StorefrontCoupon,
  type StorefrontCouponFormValues,
  storefrontCouponPageSchema,
  storefrontCouponSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
  storefrontPackPlanSchema,
  todayIn,
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
} from '../../testing/app.js';
import {
  startMail,
  startPostgres,
  startRedis,
  type TestMail,
  type TestPostgres,
  type TestRedis,
} from '../../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../../testing/http.js';
import {
  addShopProduct,
  clientAddress,
  codeFor,
  type OrderShop,
  orderRequest,
  orderShop,
  phoneOf,
  placeOrder,
  shopHeaders,
  shopPost,
} from '../../testing/shop-orders.js';
import { addListing } from '../../testing/storefront.js';
import { joinWithoutRoles } from '../../testing/workspace.js';

// Step 27c: the shop's coupons against the real stack. The Coupons page's six routes as the owner,
// as a member with storefront.manage and as one who may only read the orders; then the shop's side:
// the quote's reasons, a use counted from the order placed, once per phone, the last use and a code
// change when two requests come at the same moment, and the discount spread to the paisa from the
// order through the sales order, a challan of two batches and the invoice. Phones and shopper
// addresses start at 900 (phoneOf, clientAddress): the limits count per phone and per address, so
// no two tests share one.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
// storefront.manage only: the Coupons page, and nothing of the orders
let manager: SignedIn;
// storefront.order.read only: the orders, and no coupon
let reader: SignedIn;
let shop: OrderShop;
// A batch product with two batches (SS-A 3 pieces, SS-B 10), so one line leaves in two challan lines
let sunscreen: { product: Product; listingId: string };
// A second product with stock of its own, for the race: two orders of one product would meet at
// the variant's lock and never at the coupon's
let tea: { listingId: string };

const refusalSchema = problemSchema.pick({ code: true, fieldErrors: true });
const idSchema = z.array(z.object({ id: z.uuid() }));
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, who = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

// The coupon form as the page sends it: every box a string, '' for "none". 10% off with no cap,
// no minimum, no days and no limit, once per phone off, unless a test says otherwise
function form(code: string, extra: Partial<StorefrontCouponFormValues> = {}) {
  return {
    code,
    kind: 'percent',
    value: '10',
    upTo: '',
    minimum: '',
    startsOn: '',
    lastDay: '',
    usageLimit: '',
    onePerPhone: false,
    ...extra,
  } satisfies StorefrontCouponFormValues;
}

async function makeCoupon(
  code: string,
  extra: Partial<StorefrontCouponFormValues> = {},
  who = owner,
): Promise<StorefrontCoupon> {
  const res = await send('POST', '/storefront/coupons', form(code, extra), who);
  expect(res.statusCode, res.body).toBe(201);
  return storefrontCouponSchema.parse(res.json());
}

async function getCoupon(id: string): Promise<StorefrontCoupon> {
  const res = await send('GET', `/storefront/coupons/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontCouponSchema.parse(res.json());
}

// A request that must be refused with this status; its problem's code and field errors
async function refused(res: Promise<{ statusCode: number; body: string }>, status: number) {
  const answer = await res;
  expect(answer.statusCode, answer.body).toBe(status);
  return refusalSchema.parse(JSON.parse(answer.body));
}

// Two face washes (৳229 each) plus the ৳80 delivery charge: ৳538, or ৳492.20 with 10% off
const TWO = '538';
const TWO_TEN_OFF = '492.2';

function twoNeem(n: number, couponCode?: string): ShopOrderRequestInput {
  const total = couponCode === undefined ? TWO : TWO_TEN_OFF;
  const request = orderRequest(shop.listingId, 2, phoneOf(n), total);
  return couponCode === undefined ? request : { ...request, couponCode };
}

// The checkout's quote of two face washes with this code. The quote has no phone, so its address
// is the same in every test; the quote route has no limit
async function quote(
  couponCode: string,
  lines = [{ listingId: shop.listingId, quantity: 2 }],
): Promise<ShopCartQuote> {
  const res = await shopPost(app, '/cart/quote', shopHeaders(shop.host, clientAddress(900)), {
    lines,
    zoneId: 'inside_dhaka',
    couponCode,
  });
  expect(res.statusCode, res.body).toBe(200);
  return shopCartQuoteSchema.parse(res.json());
}

// Places an order as shopper n; the answer as it is, for a test that expects a refusal
function place(n: number, request: ShopOrderRequestInput) {
  return shopPost(app, '/orders', shopHeaders(shop.host, clientAddress(n)), request);
}

async function orderIdOf(phone: string): Promise<string> {
  const [row] = idSchema.parse(
    await sql`
      SELECT id::text FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}
      ORDER BY created_at DESC LIMIT 1`,
  );
  if (row === undefined) throw new Error(`no order from ${phone}`);
  return row.id;
}

// Placed and confirmed with the code from Mailpit, as a shopper does it; the order once the
// worker's handler has made its sales order
async function confirmed(n: number, request: ShopOrderRequestInput): Promise<StorefrontOrder> {
  const headers = shopHeaders(shop.host, clientAddress(n));
  const token = await placeOrder(app, headers, request);
  const { code } = await codeFor(mail.apiUrl, request.phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const id = await orderIdOf(request.phone);
  return eventually(async () => {
    const order = storefrontOrderSchema.parse(
      (await send('GET', `/storefront/orders/${id}`)).json(),
    );
    expect(order.salesOrder).not.toBeNull();
    return order;
  });
}

async function cancel(order: StorefrontOrder): Promise<void> {
  const res = await send('POST', `/storefront/orders/${order.id}/cancel`, {
    version: order.version,
    reason: 'Customer did not answer the phone',
  });
  expect(res.statusCode, res.body).toBe(200);
}

// The order as if placed `minutes` ago: a pending one past its hold (60 minutes) can no longer be
// confirmed, so its use is free again before any sweep deletes it
async function ageOrder(phone: string, minutes: number): Promise<void> {
  const by = `${String(minutes)} minutes`;
  await sql`
    UPDATE storefront_orders SET created_at = created_at - ${by}::interval
    WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}`;
}

// Sends requests "at the same moment" for sure, and in a known order (27a's shop-orders.int.spec.ts
// has the long story of atOnce). A transaction of the test's own locks `table`; the first request
// is sent, and the next one only once the first waits for a lock (at that table, or at a lock the
// one before it holds). Once all of them wait, the gate opens. The first one sent is the first to
// reach the lock that matters, so the test knows which one wins
async function inTurn<T>(table: string, sends: (() => Promise<T>)[]): Promise<T[]> {
  const gate = await sql.begin(async (tx) => {
    await tx`LOCK TABLE ${tx(table)} IN SHARE MODE`;
    const sent: Promise<T>[] = [];
    for (const next of sends) {
      sent.push(next());
      await eventually(async () => {
        const [row] = await tx`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
        expect(row?.n).toBe(sent.length);
      });
    }
    // Wrapped: a promise returned alone (or in an array) would be awaited before the gate opens,
    // and the requests behind it would wait for ever
    return { all: Promise.all(sent) };
  });
  return gate.all;
}

// A day `days` after an ISO date, by the calendar (no time zone: the date has none)
function dayAfter(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const auditRowSchema = z.object({ action: z.string(), changes: z.unknown() });

async function auditOf(entityId: string) {
  return z.array(auditRowSchema).parse(
    await sql`
      SELECT action, payload -> 'changes' AS changes FROM audit_logs
      WHERE tenant_id = ${shop.tenantId} AND entity_id = ${entityId}
      ORDER BY created_at, id`,
  );
}

// A user with a workspace of their own, who then joins Nirvor with a role of these permissions
async function member(email: string, fullName: string, permissions: PermissionKey[]) {
  const password = 'Mirpur-depot-2026';
  await signUp(app, {
    companyName: `${fullName} Store`,
    workspaceSlug: email.split('@')[0] ?? 'store',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'nirvor' });
  const made = await send('POST', '/roles', { name: `${fullName}'s role`, description: '' });
  expect(made.statusCode, made.body).toBe(201);
  const role = roleSchema.parse(made.json());
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'nirvor', email, password, keepSignedIn: false });
}

// Stock in with a cost, through a posted stock adjustment: the challan prices what leaves at the
// average cost, and a batch exists only once stock brought it in
function stockLine(product: Product, quantity: string, extra: object = {}) {
  return {
    variantId: product.variants[0]?.id ?? '',
    unitId: shop.unitId,
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost: '150',
    ...extra,
  };
}

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
    }),
  );
  // Three: the gate's transaction, and the reads a test makes while the gate is shut
  sql = postgres(pg.superuserUrl, { max: 3 });
  owner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 0 });
  // No free delivery: every order here has a delivery line, which a coupon must never touch
  await sql`
    UPDATE storefront_settings SET free_delivery_from = NULL WHERE tenant_id = ${shop.tenantId}`;
  const made = await send('POST', '/products', {
    code: '',
    name: 'Sunscreen SPF 50',
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: shop.unitId,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'batch',
    hasExpiry: true,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '450', archived: false },
    ],
    units: [],
    customFields: {},
  });
  expect(made.statusCode, made.body).toBe(201);
  const sunscreenProduct = productSchema.parse(made.json());
  const neem = productSchema.parse((await send('GET', `/products/${shop.productId}`)).json());
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-11-01',
    warehouseId: shop.warehouseId,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      stockLine(neem, '200'),
      // FEFO takes SS-A first: it expires first
      stockLine(sunscreenProduct, '3', { lotNumber: 'SS-A', expiresOn: '2027-03-31' }),
      stockLine(sunscreenProduct, '10', { lotNumber: 'SS-B', expiresOn: '2027-09-30' }),
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);
  sunscreen = {
    product: sunscreenProduct,
    listingId: await addListing(sql, shop.tenantId, {
      product: sunscreenProduct,
      categoryId: shop.categoryId,
      slug: 'sunscreen-spf-50',
      publishedDaysAgo: 1,
    }),
  };
  tea = await addShopProduct(app, sql, owner, shop, {
    name: 'Tulsi Green Tea',
    slug: 'tulsi-green-tea',
    price: '420',
    stock: 50,
  });
  manager = await member('sumi@nirvor.com', 'Sumi Akter', ['storefront.manage']);
  reader = await member('rafiq@nirvor.com', 'Rafiq Islam', ['storefront.order.read']);
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('the Coupons page', () => {
  it('makes, changes, archives and restores a coupon, and the audit log has each step', async () => {
    const coupon = await makeCoupon('welcome10', { upTo: '50', usageLimit: '100' });
    // The code upper-cased, the money to 4 decimals as the column keeps it, the percent a number
    expect(coupon).toMatchObject({
      code: 'WELCOME10',
      discount: { kind: 'percent', value: 10 },
      upTo: '50.0000',
      minimum: null,
      startsOn: null,
      lastDay: null,
      usageLimit: 100,
      onePerPhone: false,
      used: 0,
      codeLocked: false,
      status: 'active',
      version: 1,
    });
    expect(await getCoupon(coupon.id)).toEqual(coupon);

    // A start day after today is "scheduled"; the version moves on every save
    const today = todayIn(DEFAULT_SETTINGS.timezone);
    const changed = await send('PUT', `/storefront/coupons/${coupon.id}`, {
      ...form('WELCOME10', { upTo: '50', usageLimit: '100' }),
      startsOn: dayAfter(today, 1),
      lastDay: dayAfter(today, 30),
      version: coupon.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(storefrontCouponSchema.parse(changed.json())).toMatchObject({
      status: 'scheduled',
      version: 2,
    });
    // A form opened before that save: reload first
    const stale = await refused(
      send('PUT', `/storefront/coupons/${coupon.id}`, { ...form('WELCOME10'), version: 1 }),
      409,
    );
    expect(stale.code).toBe('version_conflict');

    const archived = await send('POST', `/storefront/coupons/${coupon.id}/archive`, { version: 2 });
    expect(storefrontCouponSchema.parse(archived.json())).toMatchObject({
      status: 'archived',
      version: 3,
    });
    // A second click changes nothing: no new version, no audit row
    const again = await send('POST', `/storefront/coupons/${coupon.id}/archive`, { version: 3 });
    expect(storefrontCouponSchema.parse(again.json()).version).toBe(3);
    const ids = async (view: string) =>
      storefrontCouponPageSchema
        .parse((await send('GET', `/storefront/coupons?view=${view}&search=WELCOME`)).json())
        .items.map((item) => item.id);
    expect(await ids('archived')).toEqual([coupon.id]);
    expect(await ids('current')).toEqual([]);
    const restored = await send('POST', `/storefront/coupons/${coupon.id}/restore`, { version: 3 });
    expect(storefrontCouponSchema.parse(restored.json())).toMatchObject({
      status: 'scheduled',
      version: 4,
    });

    const rows = await auditOf(coupon.id);
    expect(rows.map((row) => row.action)).toEqual([
      'storefront_coupon.created',
      'storefront_coupon.updated',
      'storefront_coupon.archived',
      'storefront_coupon.restored',
    ]);
    // The change lists only the two boxes that changed; the discount as one short value
    expect(rows[0]?.changes).toMatchObject({ discount: { from: null, to: 'percent 10' } });
    expect(rows[1]?.changes).toEqual({
      startsOn: { from: null, to: dayAfter(today, 1) },
      lastDay: { from: null, to: dayAfter(today, 30) },
    });

    // A coupon this workspace does not have
    expect((await send('GET', `/storefront/coupons/${UNKNOWN}`)).statusCode).toBe(404);
    const missing = await send('PUT', `/storefront/coupons/${UNKNOWN}`, {
      ...form('NOBODY'),
      version: 1,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses a code another coupon has, an archived one's too, and the boxes the form checks", async () => {
    const flat = await makeCoupon('FLAT50', { kind: 'amount', value: '50' });
    await send('POST', `/storefront/coupons/${flat.id}/archive`, { version: flat.version });
    // Archived, it still has its code: an order may point at it, and a restore must not clash
    const taken = await refused(send('POST', '/storefront/coupons', form('flat50')), 409);
    expect(taken).toEqual({
      code: 'storefront_coupon_code_taken',
      fieldErrors: { code: ['storefront_coupon_code_taken'] },
    });
    const other = await makeCoupon('EID25');
    const renamed = await refused(
      send('PUT', `/storefront/coupons/${other.id}`, { ...form('FLAT50'), version: other.version }),
      409,
    );
    expect(renamed.code).toBe('storefront_coupon_code_taken');

    // The rules between boxes: a whole percent from 1 to 99, a cap only on a percent, the last
    // day not before the first
    const rules = await refused(
      send('POST', '/storefront/coupons', form('RULES', { value: '100' })),
      400,
    );
    expect(rules.fieldErrors).toEqual({ value: ['storefront_sale_percent'] });
    const amount = await refused(
      send(
        'POST',
        '/storefront/coupons',
        form('RULES', {
          kind: 'amount',
          value: '0',
          upTo: '50',
          startsOn: '2026-12-10',
          lastDay: '2026-12-01',
        }),
      ),
      400,
    );
    expect(amount.fieldErrors).toEqual({
      value: ['storefront_sale_zero'],
      upTo: ['storefront_coupon_up_to'],
      lastDay: ['storefront_coupon_dates'],
    });
    // Each box on its own
    const boxes = await refused(
      send(
        'POST',
        '/storefront/coupons',
        form('WEL COME', { minimum: '300.505', usageLimit: '0', upTo: '0' }),
      ),
      400,
    );
    expect(boxes.fieldErrors).toEqual({
      code: ['shop_coupon_format'],
      minimum: ['money_format'],
      usageLimit: ['storefront_coupon_limit_format'],
      upTo: ['storefront_sale_zero'],
    });
  });

  it('lists the newest first a page at a time, and finds a code by any part of it', async () => {
    const made: StorefrontCoupon[] = [];
    for (const code of ['PUJA-5', 'PUJA-10', 'PUJA-15']) made.push(await makeCoupon(code));
    const page = async (query: string) =>
      storefrontCouponPageSchema.parse((await send('GET', `/storefront/coupons?${query}`)).json());
    const first = await page('search=puja&limit=2');
    const second = await page(`search=puja&limit=2&cursor=${first.nextCursor ?? ''}`);
    expect([...first.items, ...second.items].map((item) => item.code)).toEqual([
      'PUJA-15',
      'PUJA-10',
      'PUJA-5',
    ]);
    expect(second.nextCursor).toBeNull();
    // Any part, in any case. LIKE's own signs, % and _, are matched as typed: no code has one
    expect((await page('search=ja-1')).items.map((item) => item.code)).toEqual([
      'PUJA-15',
      'PUJA-10',
    ]);
    expect((await page('search=%25')).items).toEqual([]);
    expect((await page('search=PUJA_5')).items).toEqual([]);
  });

  it('is for storefront.manage only, and works before the shop is set up', async () => {
    const coupon = await makeCoupon('STAFF5', {}, manager);
    expect((await send('GET', '/storefront/coupons', undefined, manager)).statusCode).toBe(200);
    const calls = [
      send('GET', '/storefront/coupons', undefined, reader),
      send('GET', `/storefront/coupons/${coupon.id}`, undefined, reader),
      send('POST', '/storefront/coupons', form('READER'), reader),
      send('PUT', `/storefront/coupons/${coupon.id}`, { ...form('STAFF5'), version: 1 }, reader),
      send('POST', `/storefront/coupons/${coupon.id}/archive`, { version: 1 }, reader),
      send('POST', `/storefront/coupons/${coupon.id}/restore`, { version: 1 }, reader),
    ];
    expect((await Promise.all(calls)).map((res) => res.statusCode)).toEqual([
      403, 403, 403, 403, 403, 403,
    ]);
    // A workspace with no shop yet may get WELCOME10 ready for its first day
    const depot = await signUp(app, {
      companyName: 'Mirpur Depot',
      workspaceSlug: 'mirpur',
      fullName: 'Tanvir Hasan',
      email: 'tanvir@mirpur.com',
      password: 'Mirpur-depot-2026',
    });
    expect((await makeCoupon('WELCOME10', {}, depot)).status).toBe('active');
  });
});

describe("the shop's quote", () => {
  it('says why a code takes nothing off, and an order with such a code has no coupon', async () => {
    const today = todayIn(DEFAULT_SETTINGS.timezone);
    await makeCoupon('LATER', { startsOn: dayAfter(today, 1) });
    await makeCoupon('GONE', { lastDay: dayAfter(today, -1) });
    await makeCoupon('BIGCART', { minimum: '1000' });
    const archived = await makeCoupon('OLD10');
    await send('POST', `/storefront/coupons/${archived.id}/archive`, { version: 1 });
    // The first and the last day are both days of the coupon
    await makeCoupon('TODAY', { kind: 'amount', value: '50', startsOn: today, lastDay: today });

    const reason = async (code: string) => (await quote(code)).coupon;
    // A coupon that has not started looks like no coupon at all: the shop does not tell what
    // is coming. An archived one does not exist for the shop (0074's policy)
    expect(await reason('NOPE')).toMatchObject({ reason: 'shop_coupon_unknown' });
    expect(await reason('LATER')).toMatchObject({ reason: 'shop_coupon_unknown' });
    expect(await reason('OLD10')).toMatchObject({ reason: 'shop_coupon_unknown' });
    expect(await reason('GONE')).toMatchObject({ reason: 'shop_coupon_expired' });
    expect(await reason('BIGCART')).toEqual({
      status: 'refused',
      code: 'BIGCART',
      reason: 'shop_coupon_minimum',
      minimum: '1000.0000',
    });
    // ৳458 − ৳50 + ৳80; typed in small letters, as a shopper may
    expect(await quote('today')).toMatchObject({
      coupon: { status: 'applied', code: 'TODAY', upTo: null },
      discount: '50.0000',
      total: '488.0000',
    });

    // The promo box said why; the order goes ahead at the full price, with no coupon on it
    const res = await place(901, { ...twoNeem(901), couponCode: 'GONE' });
    expect(res.statusCode, res.body).toBe(201);
    const [order] = z
      .array(z.object({ coupon_id: z.string().nullable(), discount: z.string() }))
      .parse(
        await sql`
          SELECT coupon_id::text, discount::text FROM storefront_orders
          WHERE tenant_id = ${shop.tenantId} AND phone = ${phoneOf(901)}`,
      );
    expect(order).toEqual({ coupon_id: null, discount: '0.0000' });
  });
});

describe('a use', () => {
  it('counts from the order placed: a pending one inside its hold only, and a cancel gives it back', async () => {
    const coupon = await makeCoupon('HOLD1', { usageLimit: '1' });
    // Placed, not confirmed yet: the order holds the use while it may still be confirmed
    expect((await place(911, twoNeem(911, 'HOLD1'))).statusCode).toBe(201);
    expect((await quote('HOLD1')).coupon).toMatchObject({ reason: 'shop_coupon_used_up' });
    expect(await getCoupon(coupon.id)).toMatchObject({
      used: 1,
      status: 'ended',
      codeLocked: true,
    });

    // An hour later it can no longer be confirmed: the use is free again, before any sweep. The
    // code stays frozen: an order had it
    await ageOrder(phoneOf(911), 61);
    expect((await quote('HOLD1')).coupon.status).toBe('applied');
    expect(await getCoupon(coupon.id)).toMatchObject({
      used: 0,
      status: 'active',
      codeLocked: true,
    });

    const order = await confirmed(912, twoNeem(912, 'HOLD1'));
    expect(order).toMatchObject({ couponCode: 'HOLD1', discount: '45.8000', total: '492.2000' });
    expect((await getCoupon(coupon.id)).used).toBe(1);
    await cancel(order);
    expect((await getCoupon(coupon.id)).used).toBe(0);
    expect((await quote('HOLD1')).coupon.status).toBe('applied');
    // An order is not an edit: no audit row and no new version for the coupon
    expect((await auditOf(coupon.id)).map((row) => row.action)).toEqual([
      'storefront_coupon.created',
    ]);
    expect((await getCoupon(coupon.id)).version).toBe(1);
  });

  it('is once per mobile number when the coupon says so, and again after that order was cancelled', async () => {
    await makeCoupon('ONCE', { onePerPhone: true });
    const first = await confirmed(921, twoNeem(921, 'ONCE'));
    // The same phone from another address: the phone is what counts
    const again = await refused(place(924, twoNeem(921, 'ONCE')), 422);
    expect(again.code).toBe('shop_coupon_used_by_phone');
    // The quote has no phone, so it still says "applied"; another phone may use it
    expect((await quote('ONCE')).coupon.status).toBe('applied');
    expect((await place(922, twoNeem(922, 'ONCE'))).statusCode).toBe(201);
    await cancel(first);
    expect((await place(925, twoNeem(921, 'ONCE'))).statusCode).toBe(201);

    // Without the box, one phone may use it twice
    await makeCoupon('TWICE');
    expect((await place(926, twoNeem(923, 'TWICE'))).statusCode).toBe(201);
    expect((await place(927, twoNeem(923, 'TWICE'))).statusCode).toBe(201);
  });
});

describe('at the same moment', () => {
  it('gives the last use to one of two shoppers', async () => {
    const coupon = await makeCoupon('LAST1', { usageLimit: '1' });
    // Two products, so the orders pass their variants' locks and meet at the coupon's row. The
    // first one waits at its holds' INSERT with the row locked; the second waits for that lock.
    // Counted in the locking statement, the second would still see no use and take one too
    const [first, second] = await inTurn('storefront_stock_holds', [
      () => place(931, twoNeem(931, 'LAST1')),
      // ৳420 + ৳80 − ৳42
      () =>
        place(932, { ...orderRequest(tea.listingId, 1, phoneOf(932), '458'), couponCode: 'LAST1' }),
    ]);
    expect(first?.statusCode, first?.body).toBe(201);
    // The total without the coupon is not the one the shopper saw; the checkout quotes again
    expect(second?.statusCode, second?.body).toBe(409);
    expect(refusalSchema.parse(second?.json()).code).toBe('shop_order_changed');
    expect((await getCoupon(coupon.id)).used).toBe(1);
    expect(
      (await quote('LAST1', [{ listingId: tea.listingId, quantity: 1 }])).coupon,
    ).toMatchObject({ reason: 'shop_coupon_used_up' });
  });

  it('never gives an order a code that changed while it was placed, and keeps a code an order took', async () => {
    const eid = await makeCoupon('EIDSALE');
    // The page saves first: it holds the coupon's row and waits at the table for its UPDATE. The
    // order waits for that row; once the save is in, the row no longer has the code it asked for
    const [saved, order] = await inTurn('storefront_coupons', [
      () =>
        send('PUT', `/storefront/coupons/${eid.id}`, { ...form('EID-SALE'), version: eid.version }),
      () => place(941, twoNeem(941, 'EIDSALE')),
    ]);
    expect(saved?.statusCode, saved?.body).toBe(200);
    expect(order?.statusCode, order?.body).toBe(409);
    expect(await getCoupon(eid.id)).toMatchObject({ code: 'EID-SALE', used: 0, codeLocked: false });
    expect((await quote('EIDSALE')).coupon).toMatchObject({ reason: 'shop_coupon_unknown' });

    // The order first: it holds the row while it waits at its holds; the save waits for the row
    // and then sees the order's first_ordered_at
    const puja = await makeCoupon('PUJA25');
    const [placed, renamed] = await inTurn('storefront_stock_holds', [
      () => place(942, twoNeem(942, 'PUJA25')),
      () =>
        send('PUT', `/storefront/coupons/${puja.id}`, {
          ...form('PUJA-25'),
          version: puja.version,
        }),
    ]);
    expect(placed?.statusCode, placed?.body).toBe(201);
    expect(renamed?.statusCode, renamed?.body).toBe(409);
    expect(refusalSchema.parse(renamed?.json())).toEqual({
      code: 'storefront_coupon_code_locked',
      fieldErrors: { code: ['storefront_coupon_code_locked'] },
    });
    // Everything but the code may still change: a later last day, a bigger limit
    const later = await send('PUT', `/storefront/coupons/${puja.id}`, {
      ...form('PUJA25', { usageLimit: '500' }),
      version: puja.version,
    });
    expect(later.statusCode, later.body).toBe(200);
  });
});

describe('the database', () => {
  it('keeps a code an order had, and the time of the first order, even past the page', async () => {
    const coupon = await makeCoupon('GUARD');
    expect((await place(945, twoNeem(945, 'GUARD'))).statusCode).toBe(201);
    // As the superuser, which skips the row rules but not the trigger (0074): a bug or a hand fix
    const caught = async (query: Promise<unknown>) => {
      const error = await query.then(
        () => null,
        (caughtError: unknown) => caughtError,
      );
      return z.object({ code: z.string(), constraint_name: z.string() }).parse(error);
    };
    expect(
      await caught(sql`UPDATE storefront_coupons SET code = 'GUARD-2' WHERE id = ${coupon.id}`),
    ).toMatchObject({ code: '23514', constraint_name: 'storefront_coupons_code_locked' });
    expect(
      await caught(
        sql`UPDATE storefront_coupons SET first_ordered_at = NULL WHERE id = ${coupon.id}`,
      ),
    ).toMatchObject({ code: '23514', constraint_name: 'storefront_coupons_first_ordered_kept' });
  });
});

describe('the documents', () => {
  it('spread the discount to the paisa over the sales order, a challan of two batches and the invoice', async () => {
    await makeCoupon('FLAT100', { kind: 'amount', value: '100' });
    // One face wash (৳229) and four sunscreens (৳1,800): ৳2,029 + ৳80 − ৳100 = ৳2,009
    const request: ShopOrderRequestInput = {
      ...orderRequest(shop.listingId, 1, phoneOf(951), '2009'),
      lines: [
        { listingId: shop.listingId, quantity: 1 },
        { listingId: sunscreen.listingId, quantity: 4 },
      ],
      couponCode: 'FLAT100',
    };
    const order = await confirmed(951, request);
    const so = salesOrderSchema.parse(
      (await send('GET', `/sales-orders/${order.salesOrder?.id ?? ''}`)).json(),
    );
    // ৳100 by the lines' shares: 11.2863… and 88.7136…; the paisa left over goes to the larger
    // remainder (the face wash). The delivery line gets nothing
    expect(so.lines.map((line) => line.discount)).toEqual(['11.2900', '88.7100', '0.0000']);
    expect(so.total).toBe('2009.0000');

    const plan = storefrontPackPlanSchema.parse(
      (await send('GET', `/storefront/orders/${order.id}/pack-plan`)).json(),
    );
    const picks = plan.lines[1]?.picks ?? [];
    expect(picks.map((pick) => pick.quantity)).toEqual(['3.0000', '1.0000']);
    const packed = await send('POST', `/storefront/orders/${order.id}/pack`, {
      version: order.version,
      lines: [
        { position: 1, picks: [{ batchId: '', quantity: '1', serialNumbers: [] }] },
        {
          position: 2,
          picks: picks.map((pick) => ({ ...pick, batchId: pick.batchId ?? '' })),
        },
      ],
    });
    expect(packed.statusCode, packed.body).toBe(200);
    const shipped = await send('POST', `/storefront/orders/${order.id}/ship`, {
      version: storefrontOrderSchema.parse(packed.json()).version,
    });
    const delivered = await send('POST', `/storefront/orders/${order.id}/deliver`, {
      version: storefrontOrderSchema.parse(shipped.json()).version,
    });
    expect(delivered.statusCode, delivered.body).toBe(200);
    const invoiceId = storefrontOrderSchema.parse(delivered.json()).invoice?.id ?? '';
    const invoice = invoiceSchema.parse((await send('GET', `/invoices/${invoiceId}`)).json());
    // The sunscreen line's ৳88.71 over SS-A's 3 and SS-B's 1 (66.5325 and 22.1775): the paisa to
    // the larger remainder, SS-B's. The invoice bills what the shopper pays, to the paisa
    expect(invoice.lines.map((line) => line.discount)).toEqual([
      '11.2900',
      '66.5300',
      '22.1800',
      '0.0000',
    ]);
    expect(invoice.total).toBe('2009.0000');
  });
});
