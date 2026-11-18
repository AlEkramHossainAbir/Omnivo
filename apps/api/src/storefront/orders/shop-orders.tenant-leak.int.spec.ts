import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  notificationPageSchema,
  problemSchema,
  SHOP_ORDERS_PER_PHONE,
  shopOrderConfirmedSchema,
} from '@omnivo/contracts';
import { sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Transaction } from '../../common/tenant/with-tenant.js';
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
import { bearer, type SignedIn, signUp } from '../../testing/http.js';
import {
  clientAddress,
  codeFor,
  type OrderShop,
  orderRequest,
  orderShop,
  phoneOf,
  placeOrder,
  shopHeaders,
  shopPost,
  trackingTokenFor,
} from '../../testing/shop-orders.js';
import { ShopDb } from '../shop-db.js';

// Step 27a: an order is a buyer's name, phone and address, reached with no login, by a token and a
// host. Two launched shops, Nirvor and Acme, each with an order: a token, a number or a phone of
// one must open nothing in the other, each shop counts its own numbers, and each workspace's bell
// rings for its own orders only. Then the database's walls: omnivo_shop sees the orders of the
// shop it was given and nothing of the ERP, and omnivo_public sees no order at all.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let nirvorOwner: SignedIn;
let acmeOwner: SignedIn;
let nirvor: OrderShop;
let acme: OrderShop;

// One confirmed order in each shop, made in the first test
interface Placed {
  phone: string;
  token: string;
  orderNo: string;
  trackingToken: string;
}
let nirvorOrder: Placed;
let acmeOrder: Placed;

const TWO = '538';

function problemOf(res: { json: () => unknown }) {
  return problemSchema.parse(res.json());
}

// drizzle wraps the driver's error (DrizzleQueryError); Postgres's own one is on a .cause
function pgErrorOf(error: unknown): { code: string; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') {
      return { code: current.code, message: current.message };
    }
  }
  return null;
}

// Refused for this table, not earlier. 42501 alone could come from the shop's lookup function or
// SET ROLE, and a test that only checked the code would pass with the whole way in broken
function expectDenied(error: unknown, table: string): void {
  expect(pgErrorOf(error)).toEqual({
    code: '42501',
    message: `permission denied for table ${table}`,
  });
}

async function placeAndConfirm(shop: OrderShop, n: number): Promise<Placed> {
  const headers = shopHeaders(shop.host, clientAddress(n));
  const phone = phoneOf(n);
  const token = await placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, TWO));
  const { code } = await codeFor(mail.apiUrl, phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const { orderNo } = shopOrderConfirmedSchema.parse(res.json());
  return { phone, token, orderNo, trackingToken: await trackingTokenFor(mail.apiUrl, phone) };
}

const countSchema = z.array(z.object({ n: z.number() }));

async function ordersIn(tenantId: string): Promise<number> {
  const rows = countSchema.parse(
    await sql`SELECT count(*)::int AS n FROM storefront_orders WHERE tenant_id = ${tenantId}`,
  );
  return rows[0]?.n ?? -1;
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
  nirvorOwner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  acmeOwner = await signUp(app, {
    companyName: 'Acme Distribution',
    workspaceSlug: 'acme',
    fullName: 'Farhan Ahmed',
    email: 'farhan@acme.com.bd',
    password: 'Acme-distribution-2026',
  });
  // The same product, slug and price in both shops, so only the host tells the orders apart
  nirvor = await orderShop(app, sql, nirvorOwner, { slug: 'nirvor', name: 'Nirvor', stock: 100 });
  acme = await orderShop(app, sql, acmeOwner, { slug: 'acme', name: 'Acme', stock: 100 });
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('two shops', () => {
  it('count their order numbers each from W-000001', async () => {
    nirvorOrder = await placeAndConfirm(nirvor, 1);
    acmeOrder = await placeAndConfirm(acme, 2);
    expect(nirvorOrder.orderNo).toBe('W-000001');
    expect(acmeOrder.orderNo).toBe('W-000001');
  });

  it("open nothing with the other shop's tokens, numbers or phones", async () => {
    const atAcme = shopHeaders(acme.host, clientAddress(10));
    // Nirvor's confirmed order, asked for at Acme's address. Acme has a W-000001 too
    const found = await shopPost(app, '/orders/find', atAcme, {
      token: nirvorOrder.token,
      orderNo: nirvorOrder.orderNo,
    });
    expect(found.statusCode).toBe(404);
    const tracking = await shopPost(app, '/tracking', atAcme, {
      token: nirvorOrder.trackingToken,
    });
    expect(tracking.statusCode).toBe(404);
    const track = await shopPost(app, '/track', atAcme, {
      phone: nirvorOrder.phone,
      orderNo: nirvorOrder.orderNo,
    });
    expect(track.statusCode).toBe(404);
    expect(problemOf(track).code).toBe('shop_track_not_found');
    // The same three at Nirvor: the 404s above are the wall, not broken requests
    const atNirvor = shopHeaders(nirvor.host, clientAddress(10));
    expect(
      (
        await shopPost(app, '/orders/find', atNirvor, {
          token: nirvorOrder.token,
          orderNo: nirvorOrder.orderNo,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await shopPost(app, '/tracking', atNirvor, { token: nirvorOrder.trackingToken })).statusCode,
    ).toBe(200);
  });

  it('cannot confirm, resend or read a waiting order through the other shop', async () => {
    const atNirvor = shopHeaders(nirvor.host, clientAddress(20));
    const atAcme = shopHeaders(acme.host, clientAddress(20));
    const phone = phoneOf(20);
    const token = await placeOrder(app, atNirvor, orderRequest(nirvor.listingId, 2, phone, TWO));
    const { code } = await codeFor(mail.apiUrl, phone);

    for (const [url, body] of [
      ['/orders/code-wait', { token }],
      ['/orders/verify', { token, code }],
      ['/orders/resend', { token }],
    ] as const) {
      const res = await shopPost(app, url, atAcme, body);
      expect(res.statusCode, url).toBe(404);
      expect(problemOf(res).code).toBe('shop_code_no_order');
    }
    // Still waiting at Nirvor, with every try left, and its code still works there
    const [row] = z
      .array(z.object({ status: z.string(), code_tries_left: z.number().nullable() }))
      .parse(
        await sql`SELECT status, code_tries_left FROM storefront_orders WHERE phone = ${phone}`,
      );
    expect(row).toEqual({ status: 'pending', code_tries_left: 5 });
    const right = await shopPost(app, '/orders/verify', atNirvor, { token, code });
    expect(right.statusCode, right.body).toBe(200);
    expect(shopOrderConfirmedSchema.parse(right.json()).orderNo).toBe('W-000002');
  });

  it("ring each workspace's bell for its own orders only", async () => {
    const bells = async (who: SignedIn) => {
      const res = await app.inject({
        method: 'GET',
        url: '/notifications',
        headers: bearer(who.accessToken),
      });
      return notificationPageSchema
        .parse(res.json())
        .items.filter((item) => item.type === 'storefront.order_confirmed')
        .map((item) => item.params.id);
    };
    const ids = async (tenantId: string) =>
      z
        .array(z.object({ id: z.string() }))
        .parse(
          await sql`
            SELECT id::text FROM storefront_orders
            WHERE tenant_id = ${tenantId} AND status = 'confirmed'`,
        )
        .map((row) => row.id)
        .sort();
    await eventually(async () => {
      expect((await bells(nirvorOwner)).sort()).toEqual(await ids(nirvor.tenantId));
      expect((await bells(acmeOwner)).sort()).toEqual(await ids(acme.tenantId));
    });
  });

  it('share the order limits: they count a phone on the whole platform, on purpose', async () => {
    // A script that sends one phone a code from every shop is still one phone (shop-limits.ts)
    const phone = phoneOf(30);
    for (let i = 0; i < SHOP_ORDERS_PER_PHONE; i += 1) {
      await placeOrder(
        app,
        shopHeaders(nirvor.host, clientAddress(30 + i)),
        orderRequest(nirvor.listingId, 2, phone, TWO),
      );
    }
    const res = await shopPost(
      app,
      '/orders',
      shopHeaders(acme.host, clientAddress(39)),
      orderRequest(acme.listingId, 2, phone, TWO),
    );
    expect(res.statusCode).toBe(429);
    expect(problemOf(res).code).toBe('shop_order_limit');
  });
});

describe('the omnivo_shop role', () => {
  // ShopDb.orders is the API's own way in: SET LOCAL ROLE omnivo_shop, Nirvor's workspace. The
  // queries below are ones the order routes never write, as a bug might
  function asShop<T>(query: (tx: Transaction) => Promise<T>, host = nirvor.host): Promise<T> {
    return app.get(ShopDb).orders(host, (tx) => query(tx));
  }

  it("sees its own shop's orders, lines and holds, and none of the other shop's", async () => {
    const seen = countSchema.parse(
      await asShop((tx) =>
        tx.execute(drizzleSql`
          SELECT (SELECT count(*) FROM storefront_orders)::int AS n
          UNION ALL SELECT (SELECT count(*) FROM storefront_orders WHERE tenant_id = ${acme.tenantId})::int
          UNION ALL SELECT (SELECT count(*) FROM storefront_order_lines WHERE tenant_id = ${acme.tenantId})::int
          UNION ALL SELECT (SELECT count(*) FROM storefront_stock_holds WHERE tenant_id = ${acme.tenantId})::int`),
      ),
    );
    expect(seen.map((row) => row.n)).toEqual([await ordersIn(nirvor.tenantId), 0, 0, 0]);
    expect(await ordersIn(acme.tenantId)).toBeGreaterThan(0);
  });

  it("cannot read the ERP's tables, nor change an order's money, phone, lines or holds", async () => {
    // Each query with the table it must be refused on
    const forbidden = [
      // Customers and suppliers, their invoices, the books, the ERP's own orders
      [drizzleSql`SELECT count(*) FROM parties`, 'parties'],
      [drizzleSql`SELECT count(*) FROM invoices`, 'invoices'],
      [drizzleSql`SELECT count(*) FROM journal_entries`, 'journal_entries'],
      [drizzleSql`SELECT count(*) FROM sales_orders`, 'sales_orders'],
      // Only the code and confirm columns may change (0071): never what the buyer agreed to pay,
      // where it goes, or what was bought
      [drizzleSql`UPDATE storefront_orders SET total = 1`, 'storefront_orders'],
      [drizzleSql`UPDATE storefront_orders SET phone = '01700000000'`, 'storefront_orders'],
      [drizzleSql`UPDATE storefront_order_lines SET quantity = 9`, 'storefront_order_lines'],
      [drizzleSql`UPDATE storefront_stock_holds SET quantity = 1`, 'storefront_stock_holds'],
      [drizzleSql`DELETE FROM storefront_stock_holds`, 'storefront_stock_holds'],
      [drizzleSql`DELETE FROM storefront_order_lines`, 'storefront_order_lines'],
    ] as const;
    for (const [query, table] of forbidden) {
      expectDenied(
        await asShop((tx) => tx.execute(query)).catch((caught: unknown) => caught),
        table,
      );
    }
  });

  it('sees no order at all as omnivo_public, the role of the public reads', async () => {
    const forbidden = [
      [drizzleSql`SELECT count(*) FROM storefront_orders`, 'storefront_orders'],
      [drizzleSql`SELECT count(*) FROM storefront_order_lines`, 'storefront_order_lines'],
      [drizzleSql`SELECT count(*) FROM storefront_order_counters`, 'storefront_order_counters'],
      // The holds: how much is held where, never by which order
      [drizzleSql`SELECT order_id FROM storefront_stock_holds`, 'storefront_stock_holds'],
    ] as const;
    for (const [query, table] of forbidden) {
      const error = await app
        .get(ShopDb)
        .read(nirvor.host, (tx) => tx.execute(query))
        .catch((caught: unknown) => caught);
      expectDenied(error, table);
    }
  });
});
