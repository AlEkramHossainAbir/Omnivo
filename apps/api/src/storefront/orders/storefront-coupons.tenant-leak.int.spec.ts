import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  shopCartQuoteSchema,
  type ShopCouponResult,
  type StorefrontCoupon,
  storefrontCouponPageSchema,
  storefrontCouponSchema,
} from '@omnivo/contracts';
import { type SQL, sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createTestApp,
  createTestWorker,
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
  type OrderShop,
  orderRequest,
  orderShop,
  phoneOf,
  shopHeaders,
  shopPost,
} from '../../testing/shop-orders.js';
import { ShopDb } from '../shop-db.js';

// Step 27c: a coupon is a workspace's own. Two launched shops, Nirvor and Acme, each with a coupon
// WELCOME10 (a code is unique per workspace, not across them), and ACME20 at Acme only. The ERP
// must open, change and archive none of the other workspace's coupons; a shop must know only its
// own codes; and a use, or a phone's use, at one shop must never count at the other. Then the
// database's walls: the counting function is SECURITY DEFINER, so it must stay inside the caller's
// workspace on its own, and the shop's roles must reach no other workspace's coupon.
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
let nirvorWelcome: StorefrontCoupon;
let acmeWelcome: StorefrontCoupon;
let acmeTwenty: StorefrontCoupon;

// Two face washes (৳229 each) plus the ৳80 delivery charge, with WELCOME10's 10% off
const TEN_OFF = '492.2';

function send(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function makeCoupon(who: SignedIn, code: string): Promise<StorefrontCoupon> {
  const res = await send(who, 'POST', '/storefront/coupons', {
    code,
    kind: 'percent',
    value: '10',
    upTo: '',
    minimum: '',
    startsOn: '',
    lastDay: '',
    // One use each and once per phone: a use or a phone that crossed over would show at once
    usageLimit: '1',
    onePerPhone: true,
  });
  expect(res.statusCode, res.body).toBe(201);
  return storefrontCouponSchema.parse(res.json());
}

async function usedOf(who: SignedIn, id: string): Promise<number> {
  const res = await send(who, 'GET', `/storefront/coupons/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontCouponSchema.parse(res.json()).used;
}

async function couponAt(shop: OrderShop, couponCode: string): Promise<ShopCouponResult> {
  const res = await shopPost(app, '/cart/quote', shopHeaders(shop.host, clientAddress(960)), {
    lines: [{ listingId: shop.listingId, quantity: 2 }],
    zoneId: 'inside_dhaka',
    couponCode,
  });
  expect(res.statusCode, res.body).toBe(200);
  return shopCartQuoteSchema.parse(res.json()).coupon;
}

const countSchema = z.array(z.object({ n: z.number() }));

// drizzle wraps the driver's error (DrizzleQueryError); Postgres's own one is on a .cause
function pgErrorOf(error: unknown): { code: string; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') {
      return { code: current.code, message: current.message };
    }
  }
  return null;
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
  // One code in two workspaces: both are made
  nirvorWelcome = await makeCoupon(nirvorOwner, 'WELCOME10');
  acmeWelcome = await makeCoupon(acmeOwner, 'WELCOME10');
  acmeTwenty = await makeCoupon(acmeOwner, 'ACME20');
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('the Coupons page', () => {
  it("lists each workspace's own coupons, and opens, changes or archives none of the other's", async () => {
    const codes = async (who: SignedIn) =>
      storefrontCouponPageSchema
        .parse((await send(who, 'GET', '/storefront/coupons')).json())
        .items.map((item) => item.id);
    expect(await codes(nirvorOwner)).toEqual([nirvorWelcome.id]);
    expect((await codes(acmeOwner)).sort()).toEqual([acmeWelcome.id, acmeTwenty.id].sort());

    // Acme's owner with Nirvor's coupon id: as if it did not exist
    const id = nirvorWelcome.id;
    const version = { version: nirvorWelcome.version };
    const calls = [
      send(acmeOwner, 'GET', `/storefront/coupons/${id}`),
      send(acmeOwner, 'PUT', `/storefront/coupons/${id}`, {
        code: 'HACKED',
        kind: 'amount',
        value: '9999',
        upTo: '',
        minimum: '',
        startsOn: '',
        lastDay: '',
        usageLimit: '',
        onePerPhone: false,
        ...version,
      }),
      send(acmeOwner, 'POST', `/storefront/coupons/${id}/archive`, version),
      send(acmeOwner, 'POST', `/storefront/coupons/${id}/restore`, version),
    ];
    expect((await Promise.all(calls)).map((res) => res.statusCode)).toEqual([404, 404, 404, 404]);
    // Nirvor's coupon as it was: no new version, no audit row but its own
    const after = storefrontCouponSchema.parse(
      (await send(nirvorOwner, 'GET', `/storefront/coupons/${id}`)).json(),
    );
    expect(after).toMatchObject({ code: 'WELCOME10', version: 1, status: 'active' });
    const actions = z
      .array(z.object({ action: z.string() }))
      .parse(await sql`SELECT action FROM audit_logs WHERE entity_id = ${id}`);
    expect(actions.map((row) => row.action)).toEqual(['storefront_coupon.created']);
  });
});

describe('the shops', () => {
  it("know only their own codes: Acme's code at Nirvor takes nothing off", async () => {
    expect(await couponAt(acme, 'ACME20')).toMatchObject({ status: 'applied' });
    expect(await couponAt(nirvor, 'ACME20')).toMatchObject({ reason: 'shop_coupon_unknown' });
    // The order goes ahead at the full price, with no coupon on it
    const res = await shopPost(app, '/orders', shopHeaders(nirvor.host, clientAddress(961)), {
      ...orderRequest(nirvor.listingId, 2, phoneOf(961), '538'),
      couponCode: 'ACME20',
    });
    expect(res.statusCode, res.body).toBe(201);
    const rows = z.array(z.object({ coupon_id: z.string().nullable() })).parse(
      await sql`
        SELECT coupon_id::text FROM storefront_orders
        WHERE tenant_id = ${nirvor.tenantId} AND phone = ${phoneOf(961)}`,
    );
    expect(rows).toEqual([{ coupon_id: null }]);
  });

  it("count each workspace's uses apart, and a phone's use too", async () => {
    // One phone takes Acme's only use of WELCOME10
    const phone = phoneOf(962);
    const atAcme = await shopPost(app, '/orders', shopHeaders(acme.host, clientAddress(962)), {
      ...orderRequest(acme.listingId, 2, phone, TEN_OFF),
      couponCode: 'WELCOME10',
    });
    expect(atAcme.statusCode, atAcme.body).toBe(201);
    expect(await usedOf(acmeOwner, acmeWelcome.id)).toBe(1);
    expect(await couponAt(acme, 'WELCOME10')).toMatchObject({ reason: 'shop_coupon_used_up' });

    // Nirvor's WELCOME10 is untouched, and the same phone may still use it there
    expect(await usedOf(nirvorOwner, nirvorWelcome.id)).toBe(0);
    expect(await couponAt(nirvor, 'WELCOME10')).toMatchObject({ status: 'applied' });
    const atNirvor = await shopPost(app, '/orders', shopHeaders(nirvor.host, clientAddress(963)), {
      ...orderRequest(nirvor.listingId, 2, phone, TEN_OFF),
      couponCode: 'WELCOME10',
    });
    expect(atNirvor.statusCode, atNirvor.body).toBe(201);
    expect(await usedOf(nirvorOwner, nirvorWelcome.id)).toBe(1);
    expect(await usedOf(acmeOwner, acmeWelcome.id)).toBe(1);
  });
});

describe("the shop's database roles", () => {
  // ShopDb.read: SET LOCAL ROLE omnivo_public in Nirvor's workspace, the quote's way in
  function asPublic(query: SQL): Promise<unknown> {
    return app.get(ShopDb).read(nirvor.host, (tx) => tx.execute(query));
  }

  it("count no use of the other workspace's coupon, even with its id", async () => {
    // Acme's WELCOME10 has a use (the test before). The function is SECURITY DEFINER, so the
    // workspace's own rows are all it must count, by its own filter
    const uses = countSchema.parse(
      await asPublic(drizzleSql`
        SELECT storefront_coupon_uses(${acmeWelcome.id}::uuid, now() - interval '1 hour') AS n
        UNION ALL
        SELECT storefront_coupon_uses(${nirvorWelcome.id}::uuid, now() - interval '1 hour')`),
    );
    expect(uses.map((row) => row.n)).toEqual([0, 1]);
    expect(await usedOf(acmeOwner, acmeWelcome.id)).toBe(1);

    const seen = countSchema.parse(
      await asPublic(drizzleSql`
        SELECT (SELECT count(*) FROM storefront_coupons)::int AS n
        UNION ALL
        SELECT (SELECT count(*) FROM storefront_coupons WHERE tenant_id = ${acme.tenantId})::int`),
    );
    expect(seen.map((row) => row.n)).toEqual([1, 0]);
  });

  // The quote's role writes nothing whatever its grants: ShopDb.read is a read-only transaction.
  // Placing an order's role is the one that may write, so its walls are the ones to check
  it("change no coupon's discount as the order's role, and reach no other workspace's coupon", async () => {
    // ShopDb.orders: omnivo_shop in Nirvor's workspace. The discount is never the shop's to set
    const discountError = await app
      .get(ShopDb)
      .orders(nirvor.host, (tx) =>
        tx.execute(drizzleSql`UPDATE storefront_coupons SET discount_value = 99`),
      )
      .catch((caught: unknown) => caught);
    expect(pgErrorOf(discountError)).toEqual({
      code: '42501',
      message: 'permission denied for table storefront_coupons',
    });
    // The one column it may write, aimed at Acme's coupon: the row is not there for it
    const reached = await app.get(ShopDb).orders(nirvor.host, (tx) =>
      tx.execute(drizzleSql`
          UPDATE storefront_coupons SET first_ordered_at = now()
          WHERE id = ${acmeWelcome.id}::uuid RETURNING id`),
    );
    expect(Array.from(reached)).toEqual([]);
  });
});
