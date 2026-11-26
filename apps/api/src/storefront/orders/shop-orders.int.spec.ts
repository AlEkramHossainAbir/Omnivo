import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  notificationPageSchema,
  problemSchema,
  publicOrderPlacedSchema,
  SHOP_CODE_RESEND_SECONDS,
  SHOP_ORDER_WINDOW_MINUTES,
  SHOP_ORDERS_PER_ADDRESS,
  SHOP_ORDERS_PER_PHONE,
  SHOP_TRACK_TRIES,
  SHOP_TRACK_WINDOW_MINUTES,
  shopCartQuoteSchema,
  shopCheckoutSettingsSchema,
  shopCodeResentSchema,
  shopCodeWaitSchema,
  shopOrderConfirmedSchema,
  shopOrderSchema,
  shopProductPageSchema,
  shopTrackingSchema,
} from '@omnivo/contracts';
import type { Redis } from 'ioredis';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { REDIS } from '../../infra/tokens.js';
import {
  createTestApp,
  createTestWorker,
  eventually,
  lockWaitsOfApi,
  TEST_SHOP_KEY,
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
import { bearer, type SignedIn, signUp } from '../../testing/http.js';
import { lastMailTo } from '../../testing/mailpit.js';
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
  smsAddress,
  trackingTokenFor,
  wrongCode,
} from '../../testing/shop-orders.js';
import { tokenHash } from './order-secrets.js';
import { PendingOrderSweep } from './pending-order-sweep.js';

// Step 27a: the shop's orders against the real stack: Postgres (omnivo_shop, the holds, the
// counter), Redis (the limits, the SMS queue), the worker (the SMS to Mailpit, the bell, the
// sweep). Every test has its own phones (phoneOf) and its own shopper address, because the limits
// count per phone and per address across the whole API, and the SMS inbox is per phone. Times are
// moved by writing the order's own columns as the superuser, never by waiting.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
let shop: OrderShop;

// 2 × ৳229 + ৳80 delivery: over the shop's ৳300 minimum, under its ৳1,000 free delivery
const TWO_NEEM = '538';

// A shopper of this test, with an address of their own
function shopper(n: number): Record<string, string> {
  return shopHeaders(shop.host, clientAddress(n));
}

// One order of two face washes from this phone, that must be placed
function placeTwo(headers: Record<string, string>, phone: string): Promise<string> {
  return placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, TWO_NEEM));
}

const orderRowSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  order_no: z.string().nullable(),
  order_token_hash: z.string(),
  tracking_token_hash: z.string().nullable(),
  code_hash: z.string().nullable(),
  code_sends: z.number().nullable(),
  code_tries_left: z.number().nullable(),
  // to_json: the times as ISO text, so the minutes between them can be compared exactly
  created_at: z.string(),
  code_expires_at: z.string().nullable(),
  confirmed_at: z.string().nullable(),
  total: z.string(),
});

// The orders of this phone in the shop, newest first, read as the superuser (no RLS)
async function ordersOf(phone: string) {
  return z.array(orderRowSchema).parse(
    await sql`
      SELECT id::text, status, order_no, order_token_hash, tracking_token_hash, code_hash,
        code_sends, code_tries_left, to_json(created_at) #>> '{}' AS created_at,
        to_json(code_expires_at) #>> '{}' AS code_expires_at,
        to_json(confirmed_at) #>> '{}' AS confirmed_at, total::text
      FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}
      ORDER BY created_at DESC`,
  );
}

async function onlyOrderOf(phone: string) {
  const [row, ...more] = await ordersOf(phone);
  expect(more).toHaveLength(0);
  if (row === undefined) throw new Error(`no order from ${phone}`);
  return row;
}

const holdRowSchema = z.object({ quantity: z.string(), expires_at: z.string().nullable() });

async function holdsOf(orderId: string) {
  return z.array(holdRowSchema).parse(
    await sql`
      SELECT quantity::text, to_json(expires_at) #>> '{}' AS expires_at
      FROM storefront_stock_holds WHERE order_id = ${orderId}`,
  );
}

// The clock, moved for one order: its placing, its code and its holds, `minutes` earlier. Every
// time column moves by the same amount, so the table's checks (code_expires_at > code_sent_at)
// still hold
async function ageOrder(phone: string, minutes: number): Promise<void> {
  const by = `${String(minutes)} minutes`;
  await sql`
    UPDATE storefront_orders
    SET created_at = created_at - ${by}::interval,
      code_sent_at = code_sent_at - ${by}::interval,
      code_expires_at = code_expires_at - ${by}::interval
    WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}`;
  await sql`
    UPDATE storefront_stock_holds h SET expires_at = h.expires_at - ${by}::interval
    FROM storefront_orders o
    WHERE h.order_id = o.id AND o.tenant_id = ${shop.tenantId} AND o.phone = ${phone}`;
}

// Only the last code's send time moves back: "Resend code" may be pressed again
async function ageCode(phone: string, seconds: number): Promise<void> {
  const by = `${String(seconds)} seconds`;
  await sql`
    UPDATE storefront_orders
    SET code_sent_at = code_sent_at - ${by}::interval
    WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}`;
}

function problemOf(res: { json: () => unknown }) {
  return problemSchema.parse(res.json());
}

async function productInStock(slug: string): Promise<boolean> {
  const res = await app.inject({
    method: 'GET',
    url: `/public/v1/products/${slug}`,
    headers: { 'x-shop-host': shop.host },
  });
  expect(res.statusCode, res.body).toBe(200);
  return shopProductPageSchema.parse(res.json()).product.inStock;
}

// Sends requests "at the same moment" for sure, not by luck: a request's transaction is a few
// milliseconds, so ones sent together could just as well run one after the other. A transaction
// of the test's own locks `table`, so each request runs up to its first write there and waits.
// Only once `waiting` of them wait for a lock (at that table, or at a lock of the API's own that
// the first one holds) does the gate open
async function atOnce<T>(table: string, waiting: number, send: () => Promise<T>): Promise<T> {
  const gate = await sql.begin(async (tx) => {
    await tx`LOCK TABLE ${tx(table)} IN SHARE MODE`;
    const sent = send();
    await eventually(async () => {
      expect(await lockWaitsOfApi(tx)).toBe(waiting);
    });
    // Wrapped: a promise returned alone (or in an array) would be awaited before the gate opens,
    // and the requests behind it would wait for ever
    return { sent };
  });
  return gate.sent;
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
  sql = postgres(pg.superuserUrl, { max: 2 });
  owner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  // Plenty of face washes: the tests that run out of stock use a product of their own
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 1000 });
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe("the shop server's key", () => {
  it('refuses a call with no key, a wrong key or the key twice, before reading the body', async () => {
    const host = { 'x-shop-host': shop.host };
    const calls = [
      host,
      { ...host, 'x-shop-key': 'a-key-that-is-long-enough-but-not-the-one' },
      // Sent twice, the header is a list: no key at all, even when both copies are right
      { ...host, 'x-shop-key': [TEST_SHOP_KEY, TEST_SHOP_KEY] },
    ];
    for (const headers of calls) {
      // An empty body: 401, not 400, shows the key is checked before the body
      const res = await app.inject({
        method: 'POST',
        url: '/public/v1/orders',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(401);
      expect(problemOf(res).code).toBe('storefront_shop_key_invalid');
    }
  });

  it('refuses every order route when the API has no key set', async () => {
    const config = testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url });
    const keyless = await createTestApp({
      ...config,
      storefront: { ...config.storefront, shopKey: null },
    });
    try {
      const res = await keyless.inject({
        method: 'POST',
        url: '/public/v1/track',
        headers: shopper(1),
        payload: { phone: phoneOf(1), orderNo: 'W-000001' },
      });
      expect(res.statusCode).toBe(401);
      expect(problemOf(res).code).toBe('storefront_shop_key_invalid');
      // The public reads do not need the key, with or without one set
      const read = await keyless.inject({
        method: 'GET',
        url: '/public/v1/shop',
        headers: { 'x-shop-host': shop.host },
      });
      expect(read.statusCode, read.body).toBe(200);
    } finally {
      await keyless.close();
    }
  });
});

describe('placing an order', () => {
  it('writes a pending order with no number, only hashes, and a one-hour hold', async () => {
    const phone = phoneOf(101);
    const res = await shopPost(
      app,
      '/orders',
      shopper(101),
      orderRequest(shop.listingId, 2, '+880 1711-000101', TWO_NEEM),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { answer, token } = publicOrderPlacedSchema.parse(res.json());
    expect(answer).toEqual({
      next: 'verify',
      maskedPhone: '+880 17•• ••• 101',
      resendInSeconds: SHOP_CODE_RESEND_SECONDS,
    });

    // The phone as one form (01…), no number yet, the token and the code only as hashes
    const order = await onlyOrderOf(phone);
    expect(order).toMatchObject({
      status: 'pending',
      order_no: null,
      tracking_token_hash: null,
      code_sends: 1,
      code_tries_left: 5,
      total: '538.0000',
    });
    expect(order.order_token_hash).toBe(tokenHash(token));
    const { code } = await codeFor(mail.apiUrl, phone);
    // Only the HMAC: the code itself is in the SMS and nowhere else
    expect(order.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(order.code_expires_at ?? '') - Date.parse(order.created_at)).toBe(
      10 * 60 * 1000,
    );
    const [hold, ...more] = await holdsOf(order.id);
    expect(more).toHaveLength(0);
    expect(hold?.quantity).toBe('2.0000');
    expect(Date.parse(hold?.expires_at ?? '') - Date.parse(order.created_at)).toBe(60 * 60 * 1000);

    // The SMS in the shop's language, the code first
    const sms = await lastMailTo(mail.apiUrl, smsAddress(phone));
    expect(sms.text.trim()).toBe(
      `${code} is your Nirvor order code. It works for 10 minutes. Do not share it.`,
    );
    // The code and the phone never pass through the outbox table (decision 8): the SMS goes on its
    // own queue after the commit
    const outbox = await sql`SELECT payload::text AS payload FROM outbox_events`;
    for (const row of outbox) {
      expect(String(row.payload)).not.toContain(code);
      expect(String(row.payload)).not.toContain(phone);
    }
  });

  it('refuses Mobile Banking until step 27c, and the checkout does not offer it', async () => {
    await sql`
      UPDATE storefront_settings SET payment_methods = '{cod,online}'
      WHERE tenant_id = ${shop.tenantId}`;
    try {
      const settings = await app.inject({
        method: 'GET',
        url: '/public/v1/checkout-settings',
        headers: { 'x-shop-host': shop.host },
      });
      expect(shopCheckoutSettingsSchema.parse(settings.json()).paymentMethods).toEqual(['cod']);
      const res = await shopPost(app, '/orders', shopper(102), {
        ...orderRequest(shop.listingId, 2, phoneOf(102), TWO_NEEM),
        paymentMethod: 'online',
      });
      expect(res.statusCode).toBe(422);
      expect(problemOf(res).code).toBe('shop_payment_unavailable');
    } finally {
      await sql`
        UPDATE storefront_settings SET payment_methods = '{cod}'
        WHERE tenant_id = ${shop.tenantId}`;
    }
  });

  it('refuses an unknown zone, an order under the minimum and a total the shopper did not see', async () => {
    const phone = phoneOf(103);
    const zone = await shopPost(app, '/orders', shopper(103), {
      ...orderRequest(shop.listingId, 2, phone, TWO_NEEM),
      zoneId: 'outside_dhaka',
    });
    expect(zone.statusCode).toBe(422);
    expect(problemOf(zone).code).toBe('shop_zone_unknown');

    // One face wash is ৳229, under the ৳300 minimum
    const small = await shopPost(
      app,
      '/orders',
      shopper(103),
      orderRequest(shop.listingId, 1, phone, '309'),
    );
    expect(small.statusCode).toBe(422);
    expect(problemOf(small)).toMatchObject({ code: 'shop_order_below_minimum' });

    // The price went up since the checkout's quote
    const changed = await shopPost(
      app,
      '/orders',
      shopper(103),
      orderRequest(shop.listingId, 2, phone, '500'),
    );
    expect(changed.statusCode).toBe(409);
    expect(problemOf(changed).code).toBe('shop_order_changed');

    // A listing that is not in the shop (any more) is a change too
    const gone = await shopPost(
      app,
      '/orders',
      shopper(103),
      orderRequest('00000000-0000-4000-8000-000000000000', 2, phone, TWO_NEEM),
    );
    expect(gone.statusCode).toBe(409);
    expect(problemOf(gone).code).toBe('shop_order_changed');

    // Nothing was written, and none of the refusals counted towards the phone's limit: five more
    // orders from this phone are still taken
    expect(await ordersOf(phone)).toHaveLength(0);
    for (let i = 0; i < SHOP_ORDERS_PER_PHONE; i += 1) await placeTwo(shopper(103), phone);
  });
});

describe('the stock an order holds', () => {
  it('holds the last piece while the code is awaited, and frees it after an hour', async () => {
    const gel = await addShopProduct(app, sql, owner, shop, {
      name: 'Aloe Vera Gel',
      slug: 'aloe-vera-gel',
      price: '350',
      stock: 1,
    });
    const phone = phoneOf(201);
    expect(await productInStock('aloe-vera-gel')).toBe(true);
    const token = await placeOrder(app, shopper(201), orderRequest(gel.listingId, 1, phone, '430'));

    // 1 on hand, 1 held: the shop shows it sold out, the quote says so, and a second order fails
    expect(await productInStock('aloe-vera-gel')).toBe(false);
    const quote = await app.inject({
      method: 'POST',
      url: '/public/v1/cart/quote',
      headers: { 'x-shop-host': shop.host },
      payload: { lines: [{ listingId: gel.listingId, quantity: 1 }] },
    });
    expect(shopCartQuoteSchema.parse(quote.json()).lines[0]?.status).toBe('out_of_stock');
    const second = await shopPost(
      app,
      '/orders',
      shopper(202),
      orderRequest(gel.listingId, 1, phoneOf(202), '430'),
    );
    expect(second.statusCode).toBe(409);

    // An hour later the hold has ended, before any sweep: the piece is for sale again, and the
    // order can no longer be confirmed, even with the right code
    const { code } = await codeFor(mail.apiUrl, phone);
    await ageOrder(phone, 61);
    expect(await productInStock('aloe-vera-gel')).toBe(true);
    const late = await shopPost(app, '/orders/verify', shopper(201), { token, code });
    expect(late.statusCode).toBe(404);
    expect(problemOf(late).code).toBe('shop_code_no_order');
    expect((await shopPost(app, '/orders/code-wait', shopper(201), { token })).statusCode).toBe(
      404,
    );
  });

  it('sells the last piece once when five shoppers order it at the same moment', async () => {
    const tea = await addShopProduct(app, sql, owner, shop, {
      name: 'Tulsi Green Tea',
      slug: 'tulsi-green-tea',
      price: '420',
      stock: 1,
    });
    // Each order reads the stock, then waits at its hold's INSERT: one at the table and four at
    // the variant's lock (shop-orders.service.ts). Without that lock all five would wait at the
    // table, each having read one free piece
    const results = await atOnce('storefront_stock_holds', 5, () =>
      Promise.all(
        // 420 + 80
        [211, 212, 213, 214, 215].map((n) =>
          shopPost(app, '/orders', shopper(n), orderRequest(tea.listingId, 1, phoneOf(n), '500')),
        ),
      ),
    );
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
    const held = await sql`
      SELECT coalesce(sum(quantity), 0)::text AS held FROM storefront_stock_holds
      WHERE variant_id = ${tea.variantId}`;
    expect(held[0]?.held).toBe('1.0000');

    // The confirm keeps the hold, now with no end: the piece stays sold until 27b's challan
    const winner = results.findIndex((res) => res.statusCode === 201);
    const phone = phoneOf(211 + winner);
    const token = publicOrderPlacedSchema.parse(results[winner]?.json()).token;
    const { code } = await codeFor(mail.apiUrl, phone);
    const right = await shopPost(app, '/orders/verify', shopper(211 + winner), { token, code });
    expect(right.statusCode, right.body).toBe(200);
    const order = await onlyOrderOf(phone);
    expect(await holdsOf(order.id)).toEqual([{ quantity: '1.0000', expires_at: null }]);
    await ageOrder(phone, 120);
    expect(await productInStock('tulsi-green-tea')).toBe(false);
  });
});

describe('the phone code', () => {
  it('confirms the order with the right code: a number, the tracking SMS and the bell', async () => {
    const phone = phoneOf(301);
    const token = await placeTwo(shopper(301), phone);

    const wait = await shopPost(app, '/orders/code-wait', shopper(301), { token });
    expect(wait.statusCode, wait.body).toBe(200);
    const waiting = shopCodeWaitSchema.parse(wait.json());
    expect(waiting).toMatchObject({
      maskedPhone: '+880 17•• ••• 301',
      listingIds: [shop.listingId],
    });
    expect(waiting.resendInSeconds).toBeGreaterThan(0);
    expect(waiting.resendInSeconds).toBeLessThanOrEqual(SHOP_CODE_RESEND_SECONDS);

    const { code } = await codeFor(mail.apiUrl, phone);
    const right = await shopPost(app, '/orders/verify', shopper(301), { token, code });
    expect(right.statusCode, right.body).toBe(200);
    const { orderNo } = shopOrderConfirmedSchema.parse(right.json());
    expect(orderNo).toMatch(/^W-\d{6}$/);
    expect(right.json()).toEqual({ orderNo, phone });

    // Every code column is gone; the number, the tracking hash and the time are there
    const order = await onlyOrderOf(phone);
    expect(order).toMatchObject({
      status: 'confirmed',
      order_no: orderNo,
      code_hash: null,
      code_sends: null,
      code_tries_left: null,
      code_expires_at: null,
    });
    expect(order.confirmed_at).not.toBeNull();

    // The second SMS: the number and the link, whose token only the SMS has. The link is made from
    // the API's own settings (SHOP_PUBLIC_PORT: 4321 outside production), never from the host the
    // request named
    const link = await trackingTokenFor(mail.apiUrl, phone);
    expect(order.tracking_token_hash).toBe(tokenHash(link));
    const sms = await lastMailTo(mail.apiUrl, smsAddress(phone));
    expect(sms.text.trim()).toBe(
      `Nirvor: order ${orderNo} is confirmed. Track it here: http://nirvor.localhost:4321/t/${link}`,
    );

    // The code is used up: the same code again finds no order
    const again = await shopPost(app, '/orders/verify', shopper(301), { token, code });
    expect(again.statusCode).toBe(404);

    // The bell: the number and the total, never the buyer's name or phone
    await eventually(async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/notifications',
        headers: bearer(owner.accessToken),
      });
      const bell = notificationPageSchema
        .parse(res.json())
        .items.find(
          (item) => item.type === 'storefront.order_confirmed' && item.params.number === orderNo,
        );
      expect(bell?.params).toEqual({ id: order.id, number: orderNo, total: '538.0000' });
    });
  });

  it('counts each wrong code, and drops the order and its hold at the fifth', async () => {
    const phone = phoneOf(302);
    const token = await placeTwo(shopper(302), phone);
    const { code } = await codeFor(mail.apiUrl, phone);
    const { id } = await onlyOrderOf(phone);

    for (let triesLeft = 4; triesLeft >= 1; triesLeft -= 1) {
      const res = await shopPost(app, '/orders/verify', shopper(302), {
        token,
        code: wrongCode(code),
      });
      expect(res.statusCode).toBe(422);
      expect(problemOf(res)).toMatchObject({ code: 'shop_code_wrong', params: { triesLeft } });
      // Written down, not rolled back with the refusal
      expect((await onlyOrderOf(phone)).code_tries_left).toBe(triesLeft);
    }
    const last = await shopPost(app, '/orders/verify', shopper(302), {
      token,
      code: wrongCode(code),
    });
    expect(last.statusCode).toBe(422);
    expect(problemOf(last).code).toBe('shop_code_too_many');
    expect(await ordersOf(phone)).toHaveLength(0);
    expect(await holdsOf(id)).toHaveLength(0);
    // Not even the right code brings it back
    expect((await shopPost(app, '/orders/verify', shopper(302), { token, code })).statusCode).toBe(
      404,
    );
  });

  it('refuses a code past its 10 minutes without spending a try', async () => {
    const phone = phoneOf(303);
    const token = await placeTwo(shopper(303), phone);
    const { code, id } = await codeFor(mail.apiUrl, phone);
    await ageOrder(phone, 11);

    const expired = await shopPost(app, '/orders/verify', shopper(303), { token, code });
    expect(expired.statusCode).toBe(422);
    expect(problemOf(expired).code).toBe('shop_code_expired');
    expect((await onlyOrderOf(phone)).code_tries_left).toBe(5);

    // A new code works: the order still has 49 of its 60 minutes
    const resent = await shopPost(app, '/orders/resend', shopper(303), { token });
    expect(resent.statusCode, resent.body).toBe(200);
    const fresh = await codeFor(mail.apiUrl, phone, id);
    const right = await shopPost(app, '/orders/verify', shopper(303), { token, code: fresh.code });
    expect(right.statusCode, right.body).toBe(200);
  });

  it('resends after 45 seconds, three codes at most, and only the newest one works', async () => {
    const phone = phoneOf(304);
    const token = await placeTwo(shopper(304), phone);
    const first = await codeFor(mail.apiUrl, phone);

    const early = await shopPost(app, '/orders/resend', shopper(304), { token });
    expect(early.statusCode).toBe(429);
    const wait = problemOf(early);
    expect(wait.code).toBe('shop_code_resend_wait');
    expect(wait.params?.seconds).toBeGreaterThan(0);

    await ageCode(phone, SHOP_CODE_RESEND_SECONDS + 1);
    const second = await shopPost(app, '/orders/resend', shopper(304), { token });
    expect(second.statusCode, second.body).toBe(200);
    expect(shopCodeResentSchema.parse(second.json())).toEqual({
      resendInSeconds: SHOP_CODE_RESEND_SECONDS,
    });
    const newer = await codeFor(mail.apiUrl, phone, first.id);
    // The first code stopped working when the second was sent (unless the two happen to match)
    if (first.code !== newer.code) {
      const old = await shopPost(app, '/orders/verify', shopper(304), { token, code: first.code });
      expect(problemOf(old)).toMatchObject({ code: 'shop_code_wrong', params: { triesLeft: 4 } });
    }

    await ageCode(phone, SHOP_CODE_RESEND_SECONDS + 1);
    expect((await shopPost(app, '/orders/resend', shopper(304), { token })).statusCode).toBe(200);
    const third = await codeFor(mail.apiUrl, phone, newer.id);
    expect((await onlyOrderOf(phone)).code_sends).toBe(3);

    // The third was the last: no wait helps any more, so it says so even before the 45 seconds
    const used = await shopPost(app, '/orders/resend', shopper(304), { token });
    expect(used.statusCode).toBe(422);
    expect(problemOf(used).code).toBe('shop_code_sends_used');

    const right = await shopPost(app, '/orders/verify', shopper(304), { token, code: third.code });
    expect(right.statusCode, right.body).toBe(200);
  });

  it('confirms once when the right code arrives twice at the same moment', async () => {
    const phone = phoneOf(305);
    const token = await placeTwo(shopper(305), phone);
    const { code } = await codeFor(mail.apiUrl, phone);
    // One waits at the order counter, the other at the order's row lock (FOR UPDATE). Without
    // that lock both would have checked the code and wait at the counter, and both would confirm
    const [a, b] = await atOnce('storefront_order_counters', 2, () =>
      Promise.all([
        shopPost(app, '/orders/verify', shopper(305), { token, code }),
        shopPost(app, '/orders/verify', shopper(305), { token, code }),
      ]),
    );
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
    expect((await onlyOrderOf(phone)).status).toBe('confirmed');
  });

  it('numbers two orders confirmed at the same moment one after the other', async () => {
    const phones = [phoneOf(306), phoneOf(307)];
    const tokens = await Promise.all(phones.map((phone, i) => placeTwo(shopper(306 + i), phone)));
    const codes = await Promise.all(phones.map((phone) => codeFor(mail.apiUrl, phone)));
    // Both wait at the counter, then take its row one after the other
    const answers = await atOnce('storefront_order_counters', 2, () =>
      Promise.all(
        phones.map((_, i) =>
          shopPost(app, '/orders/verify', shopper(306 + i), {
            token: tokens[i] ?? '',
            code: codes[i]?.code ?? '',
          }),
        ),
      ),
    );
    for (const res of answers) expect(res.statusCode, res.body).toBe(200);
    const numbers = answers
      .map((res) => Number(shopOrderConfirmedSchema.parse(res.json()).orderNo.slice(2)))
      .sort((x, y) => x - y);
    expect(numbers[1]).toBe((numbers[0] ?? 0) + 1);
  });
});

describe('the order and tracking pages', () => {
  it('shows a confirmed order to its token with its number, and to its number with its phone', async () => {
    const phone = phoneOf(401);
    const token = await placeTwo(shopper(401), phone);
    const { code } = await codeFor(mail.apiUrl, phone);
    const right = await shopPost(app, '/orders/verify', shopper(401), { token, code });
    const { orderNo } = shopOrderConfirmedSchema.parse(right.json());

    // The number as a shopper may type it: any case, no dash
    const found = await shopPost(app, '/orders/find', shopper(401), {
      token,
      orderNo: orderNo.replace('W-', 'w'),
    });
    expect(found.statusCode, found.body).toBe(200);
    expect(found.headers['cache-control']).toBe('no-store');
    expect(shopOrderSchema.parse(found.json())).toMatchObject({
      orderNo,
      status: 'confirmed',
      phone,
    });
    // Another order's token with this number: the same 404 as a number that does not exist
    const other = await placeTwo(shopper(401), phoneOf(402));
    const wrong = await shopPost(app, '/orders/find', shopper(401), { token: other, orderNo });
    expect(wrong.statusCode).toBe(404);

    const tracking = await shopPost(app, '/tracking', shopper(401), {
      token: await trackingTokenFor(mail.apiUrl, phone),
    });
    expect(tracking.statusCode, tracking.body).toBe(200);
    expect(shopTrackingSchema.parse(tracking.json())).toMatchObject({
      orderNo,
      itemCount: 2,
      total: '538.0000',
    });
    // A tracking answer names no one: no phone, no address (26e's decision)
    expect(tracking.body).not.toContain(phone.slice(3));
    expect(tracking.body).not.toContain('Mirpur');

    // The /track form, with the phone typed another way
    const track = await shopPost(app, '/track', shopper(401), {
      phone: '+880 1711-000401',
      orderNo,
    });
    expect(track.statusCode, track.body).toBe(200);
  });

  it('never shows a pending order on /track', async () => {
    const phone = phoneOf(403);
    await placeTwo(shopper(403), phone);
    // A pending order has no number; the counter's next one is not its
    const res = await shopPost(app, '/track', shopper(403), { phone, orderNo: 'W-999999' });
    expect(res.statusCode).toBe(404);
    expect(problemOf(res).code).toBe('shop_track_not_found');
  });

  it('stops an address after ten misses on /track, and a hit never counts', async () => {
    const phone = phoneOf(404);
    const token = await placeTwo(shopper(404), phone);
    const { code } = await codeFor(mail.apiUrl, phone);
    const { orderNo } = shopOrderConfirmedSchema.parse(
      (await shopPost(app, '/orders/verify', shopper(404), { token, code })).json(),
    );
    const hit = { phone, orderNo };
    const miss = { phone: phoneOf(405), orderNo };

    for (let i = 0; i < SHOP_TRACK_TRIES + 2; i += 1) {
      expect((await shopPost(app, '/track', shopper(404), hit)).statusCode).toBe(200);
    }
    for (let i = 0; i < SHOP_TRACK_TRIES; i += 1) {
      expect((await shopPost(app, '/track', shopper(404), miss)).statusCode).toBe(404);
    }
    // Over the limit, even the right pair is refused: a guesser learns nothing more
    const stopped = await shopPost(app, '/track', shopper(404), hit);
    expect(stopped.statusCode).toBe(429);
    expect(problemOf(stopped)).toMatchObject({
      code: 'shop_track_too_many',
      params: { minutes: SHOP_TRACK_WINDOW_MINUTES },
    });
    // Another shopper is not stopped
    expect((await shopPost(app, '/track', shopper(406), hit)).statusCode).toBe(200);
  });

  it('counts the shop server itself when the address header is not one address', async () => {
    // A list (a proxy's X-Forwarded-For copied as it is) is not used: the misses count under the
    // caller's own address, which every call without the header shares
    const listed = shopHeaders(shop.host, `${clientAddress(408)}, 10.9.9.9`);
    for (let i = 0; i < SHOP_TRACK_TRIES; i += 1) {
      const res = await shopPost(app, '/track', listed, {
        phone: phoneOf(407),
        orderNo: 'W-999999',
      });
      expect(res.statusCode).toBe(404);
    }
    const bare = { 'x-shop-host': shop.host, 'x-shop-key': TEST_SHOP_KEY };
    const res = await shopPost(app, '/track', bare, { phone: phoneOf(407), orderNo: 'W-999999' });
    expect(res.statusCode).toBe(429);
    // …and not under the first address of the list
    const first = await shopPost(app, '/track', shopper(408), {
      phone: phoneOf(407),
      orderNo: 'W-999999',
    });
    expect(first.statusCode).toBe(404);
  });
});

describe('the order limits', () => {
  it(`takes ${String(SHOP_ORDERS_PER_PHONE)} orders an hour from one phone, from any address`, async () => {
    const phone = phoneOf(501);
    for (let i = 0; i < SHOP_ORDERS_PER_PHONE; i += 1) await placeTwo(shopper(510 + i), phone);
    const sixth = await shopPost(
      app,
      '/orders',
      shopper(519),
      orderRequest(shop.listingId, 2, phone, TWO_NEEM),
    );
    expect(sixth.statusCode).toBe(429);
    expect(problemOf(sixth)).toMatchObject({
      code: 'shop_order_limit',
      params: { minutes: SHOP_ORDER_WINDOW_MINUTES },
    });
    expect(await ordersOf(phone)).toHaveLength(SHOP_ORDERS_PER_PHONE);
  });

  it(`takes ${String(SHOP_ORDERS_PER_ADDRESS)} orders an hour from one address, from any phone`, async () => {
    for (let i = 0; i < SHOP_ORDERS_PER_ADDRESS; i += 1)
      await placeTwo(shopper(520), phoneOf(520 + i));
    const over = await shopPost(
      app,
      '/orders',
      shopper(520),
      orderRequest(shop.listingId, 2, phoneOf(549), TWO_NEEM),
    );
    expect(over.statusCode).toBe(429);
    expect(problemOf(over).code).toBe('shop_order_limit');
    // The same phone from another address is taken
    await placeTwo(shopper(521), phoneOf(549));
  });

  it('keeps no phone number and no address in Redis', async () => {
    const keys = await app.get<Redis>(REDIS).keys('shop-limit:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/^shop-limit:[a-z-]+:[0-9a-f]{32}$/);
    }
  });
});

describe('the SMS', () => {
  it("writes both SMS in the shop's language", async () => {
    await sql`UPDATE storefront_settings SET language = 'bn' WHERE tenant_id = ${shop.tenantId}`;
    try {
      const phone = phoneOf(601);
      const token = await placeTwo(shopper(601), phone);
      const { code } = await codeFor(mail.apiUrl, phone);
      const sms = await lastMailTo(mail.apiUrl, smsAddress(phone));
      expect(sms.text.trim()).toBe(
        `${code} আপনার Nirvor অর্ডারের কোড। ১০ মিনিট কাজ করবে। কাউকে বলবেন না।`,
      );
      const right = await shopPost(app, '/orders/verify', shopper(601), { token, code });
      const { orderNo } = shopOrderConfirmedSchema.parse(right.json());
      const link = await trackingTokenFor(mail.apiUrl, phone);
      const confirmed = await lastMailTo(mail.apiUrl, smsAddress(phone));
      expect(confirmed.text.trim()).toBe(
        `Nirvor: অর্ডার ${orderNo} নিশ্চিত হয়েছে। এখানে দেখুন: http://nirvor.localhost:4321/t/${link}`,
      );
    } finally {
      await sql`UPDATE storefront_settings SET language = 'en' WHERE tenant_id = ${shop.tenantId}`;
    }
  });
});

describe('the sweep', () => {
  it('deletes the orders that waited for their code over an hour, and nothing else', async () => {
    const waiting = phoneOf(701);
    const old = phoneOf(702);
    const done = phoneOf(703);
    await placeTwo(shopper(701), waiting);
    await placeTwo(shopper(702), old);
    const token = await placeTwo(shopper(703), done);
    const { code } = await codeFor(mail.apiUrl, done);
    expect((await shopPost(app, '/orders/verify', shopper(703), { token, code })).statusCode).toBe(
      200,
    );
    // Two orders over their hour: one still pending, one confirmed
    await ageOrder(old, 61);
    await ageOrder(done, 61);

    await worker.get(PendingOrderSweep).run();
    expect(await ordersOf(waiting)).toHaveLength(1);
    expect(await ordersOf(old)).toHaveLength(0);
    expect((await onlyOrderOf(done)).status).toBe('confirmed');
  });
});
