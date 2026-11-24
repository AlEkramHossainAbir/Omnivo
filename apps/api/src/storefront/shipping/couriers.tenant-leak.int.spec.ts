import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type CourierAccount,
  courierAccountSavedSchema,
  courierAccountSchema,
  courierExportSchema,
  courierSetupSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
} from '@omnivo/contracts';
import { type SQL, sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { COURIERS } from '../../infra/tokens.js';
import type { CourierAdapter, CourierAdapters } from '../../shipping/courier.js';
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
} from '../../testing/shop-orders.js';
import { ShopDb } from '../shop-db.js';
import { ShipmentPoll } from './shipment-poll.js';

// Step 28a: a courier account and its parcels are a workspace's own. Two launched shops, Nirvor
// and Acme, each with its own Steadfast account. The fake courier works a parcel's id and code out
// of its invoice, so the first order of each shop (W-000001 in both) has the SAME consignment id
// and invoice in both workspaces: only the account (in the webhook's address) and the workspace
// tell them apart. The ERP must show, change and book with its own accounts only; a webhook must
// move only the parcels of the account it names; the poll must ask each workspace's parcels with
// that workspace's keys; a sealed key must open only where it was sealed; and the shop's and the
// worker's database roles must see no more than 0078 grants them.
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
let courier: CourierAdapter;
let nirvorAccount: CourierAccount;
let nirvorToken: string;
let acmeAccount: CourierAccount;
let acmeToken: string;
// The first order of each shop, packed and booked: W-000001 in both
let nirvorOrder: StorefrontOrder;
let acmeOrder: StorefrontOrder;

const WHOLE = [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }];

function send(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function addSteadfast(who: SignedIn, apiKey: string) {
  const res = await send(who, 'POST', '/storefront/couriers', {
    provider: 'steadfast',
    name: 'Steadfast',
    apiKey,
    secretKey: `${apiKey}-secret`,
  });
  expect(res.statusCode, res.body).toBe(201);
  const saved = courierAccountSavedSchema.parse(res.json());
  return { account: saved.account, token: saved.webhookToken ?? '' };
}

async function getOrder(who: SignedIn, id: string): Promise<StorefrontOrder> {
  const res = await send(who, 'GET', `/storefront/orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// An order of two face washes at this shop, confirmed by shopper n and given its sales order
async function confirmAt(shop: OrderShop, who: SignedIn, n: number): Promise<StorefrontOrder> {
  const headers = shopHeaders(shop.host, clientAddress(n));
  const phone = phoneOf(n);
  const token = await placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, '538'));
  const { code } = await codeFor(mail.apiUrl, phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const [row] = z.array(z.object({ id: z.uuid() })).parse(
    await sql`SELECT id::text FROM storefront_orders
        WHERE tenant_id = ${shop.tenantId} AND phone = ${phone} AND status = 'confirmed'`,
  );
  if (row === undefined) throw new Error(`no confirmed order for ${phone}`);
  return eventually(async () => {
    const order = await getOrder(who, row.id);
    expect(order.salesOrder).not.toBeNull();
    return order;
  });
}

async function packWith(who: SignedIn, order: StorefrontOrder, courierAccountId: string) {
  return send(who, 'POST', `/storefront/orders/${order.id}/pack`, {
    version: order.version,
    lines: WHOLE,
    courierAccountId,
  });
}

async function bookedAt(who: SignedIn, id: string): Promise<StorefrontOrder> {
  return eventually(async () => {
    const order = await getOrder(who, id);
    expect(order.shipments.at(-1)?.status).toBe('booked');
    return order;
  });
}

function webhook(accountId: string, token: string, body: object) {
  return app.inject({
    method: 'POST',
    url: `/public/v1/couriers/steadfast/${accountId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

const parcelRowSchema = z.object({
  tenant_id: z.string(),
  status: z.string(),
  events: z.number(),
});
async function parcelOf(order: StorefrontOrder) {
  const [row] = z.array(parcelRowSchema).parse(
    await sql`SELECT s.tenant_id::text, s.status,
        (SELECT count(*)::int FROM storefront_shipment_events e WHERE e.shipment_id = s.id) AS events
      FROM storefront_shipments s WHERE s.order_id = ${order.id} ORDER BY s.parcel_no DESC LIMIT 1`,
  );
  if (row === undefined) throw new Error(`order ${order.id} has no parcel`);
  return row;
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
  courier = worker.get<CourierAdapters>(COURIERS).steadfast;
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
  ({ account: nirvorAccount, token: nirvorToken } = await addSteadfast(
    nirvorOwner,
    'nirvor-api-key',
  ));
  ({ account: acmeAccount, token: acmeToken } = await addSteadfast(acmeOwner, 'acme-api-key'));
  // Each shop's first order, packed with its own account and booked
  const first = async (shop: OrderShop, who: SignedIn, account: CourierAccount, n: number) => {
    const order = await confirmAt(shop, who, n);
    const res = await packWith(who, order, account.id);
    expect(res.statusCode, res.body).toBe(200);
    return bookedAt(who, order.id);
  };
  nirvorOrder = await first(nirvor, nirvorOwner, nirvorAccount, 1001);
  acmeOrder = await first(acme, acmeOwner, acmeAccount, 1002);
}, 240_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('two shops, one fake courier', () => {
  it('gives both first parcels the same invoice and consignment id', () => {
    expect(nirvorOrder.orderNo).toBe(acmeOrder.orderNo);
    expect(nirvorOrder.shipments[0]?.consignmentId).toBe(acmeOrder.shipments[0]?.consignmentId);
  });
});

describe('Shop couriers', () => {
  it("shows, changes and books with the workspace's own accounts only", async () => {
    const setup = courierSetupSchema.parse(
      (await send(acmeOwner, 'GET', '/storefront/couriers')).json(),
    );
    expect(setup.accounts.map((account) => account.id)).toEqual([acmeAccount.id]);
    const id = nirvorAccount.id;
    const version = { version: nirvorAccount.version };
    for (const [method, url, body] of [
      [
        'PUT',
        `/storefront/couriers/${id}`,
        { provider: 'steadfast', name: 'Taken', apiKey: '', secretKey: '', ...version },
      ],
      ['POST', `/storefront/couriers/${id}/test`, undefined],
      ['POST', `/storefront/couriers/${id}/webhook-token`, version],
      ['POST', `/storefront/couriers/${id}/archive`, version],
      ['POST', `/storefront/couriers/${id}/restore`, version],
      ['PUT', '/storefront/couriers', { accountId: id }],
    ] as const) {
      const res = await send(acmeOwner, method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // Nirvor's account is as it was
    const own = courierSetupSchema.parse(
      (await send(nirvorOwner, 'GET', '/storefront/couriers')).json(),
    ).accounts[0];
    expect(own).toMatchObject({
      name: 'Steadfast',
      version: nirvorAccount.version,
      lastTest: null,
    });

    // Acme's order with Nirvor's account: at Packed, and with Book courier
    const order = await confirmAt(acme, acmeOwner, 1003);
    const packed = await packWith(acmeOwner, order, id);
    expect(packed.statusCode).toBe(422);
    expect(packed.json()).toMatchObject({ code: 'courier_account_not_bookable' });
    const none = storefrontOrderSchema.parse((await packWith(acmeOwner, order, '')).json());
    const booked = await send(acmeOwner, 'POST', `/storefront/orders/${order.id}/shipments`, {
      version: none.version,
      accountId: id,
      trackingCode: '',
    });
    expect(booked.statusCode).toBe(404);
    // The export lists Acme's orders only
    const exported = courierExportSchema.parse(
      (await send(acmeOwner, 'GET', '/storefront/orders/courier-export')).json(),
    );
    expect(exported.rows.map((row) => row.orderId)).toEqual([order.id]);
  });

  it("opens no other workspace's sealed keys", async () => {
    const [own] = z
      .array(z.object({ keys_sealed: z.instanceof(Buffer) }))
      .parse(await sql`SELECT keys_sealed FROM courier_accounts WHERE id = ${acmeAccount.id}`);
    if (own === undefined) throw new Error("no keys on Acme's account");
    // Nirvor's box copied into Acme's row, as someone with database access could do. The key is
    // the same; the workspace is part of what was sealed
    await sql`UPDATE courier_accounts SET keys_sealed =
      (SELECT keys_sealed FROM courier_accounts WHERE id = ${nirvorAccount.id})
      WHERE id = ${acmeAccount.id}`;
    try {
      const tested = await send(acmeOwner, 'POST', `/storefront/couriers/${acmeAccount.id}/test`);
      expect(courierAccountSchema.parse(tested.json()).lastTest?.problem).toBe('rejected');
      const book = vi.spyOn(courier, 'book');
      const order = await confirmAt(acme, acmeOwner, 1004);
      expect((await packWith(acmeOwner, order, acmeAccount.id)).statusCode).toBe(200);
      const failed = await eventually(async () => {
        const now = await getOrder(acmeOwner, order.id);
        expect(now.shipments[0]?.status).toBe('booking_failed');
        return now;
      });
      expect(failed.shipments[0]?.error).toBe('courier_key_missing');
      // Never Nirvor's keys at Acme's courier
      expect(book).not.toHaveBeenCalled();
    } finally {
      await sql`UPDATE courier_accounts SET keys_sealed = ${own.keys_sealed} WHERE id = ${acmeAccount.id}`;
    }
  });
});

describe("the courier's news", () => {
  it("takes no other account's token, and moves only the named account's parcels", async () => {
    const body = {
      notification_type: 'delivery_status',
      consignment_id: Number(nirvorOrder.shipments[0]?.consignmentId),
      invoice: nirvorOrder.orderNo,
      status: 'pending',
      tracking_message: 'Picked up',
    };
    // Acme's address with Nirvor's token, and the other way round
    expect((await webhook(acmeAccount.id, nirvorToken, body)).statusCode).toBe(401);
    expect((await webhook(nirvorAccount.id, acmeToken, body)).statusCode).toBe(401);
    expect(await parcelOf(acmeOrder)).toMatchObject({ status: 'booked', events: 1 });
    expect(await parcelOf(nirvorOrder)).toMatchObject({ status: 'booked', events: 1 });

    // Nirvor's courier tells Nirvor's account: the same id and invoice at Acme stay as they were
    await sql`UPDATE courier_accounts SET last_webhook_at = NULL`;
    const res = await webhook(nirvorAccount.id, nirvorToken, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(await parcelOf(nirvorOrder)).toMatchObject({ status: 'in_transit', events: 2 });
    expect(await parcelOf(acmeOrder)).toMatchObject({ status: 'booked', events: 1 });
    expect((await getOrder(nirvorOwner, nirvorOrder.id)).status).toBe('shipped');
    expect((await getOrder(acmeOwner, acmeOrder.id)).status).toBe('packed');
    const touched = z
      .array(z.object({ tenant_id: z.string() }))
      .parse(
        await sql`SELECT tenant_id::text FROM courier_accounts WHERE last_webhook_at IS NOT NULL`,
      );
    expect(touched.map((row) => row.tenant_id)).toEqual([nirvor.tenantId]);
    // Every event row is its parcel's workspace's
    const [mixed] = await sql`SELECT count(*)::int AS n FROM storefront_shipment_events e
      JOIN storefront_shipments s ON s.id = e.shipment_id WHERE e.tenant_id <> s.tenant_id`;
    expect(mixed?.n).toBe(0);
  });

  it("asks about each workspace's parcels with that workspace's own keys", async () => {
    const consignment = acmeOrder.shipments[0]?.consignmentId;
    const status = vi
      .spyOn(courier, 'status')
      .mockImplementation((keys, consignmentId) =>
        Promise.resolve(
          keys.apiKey === 'acme-api-key' && consignmentId === consignment
            ? { kind: 'status', status: 'in_transit', word: 'pending' }
            : { kind: 'problem', problem: 'unreachable' },
        ),
      );
    await worker.get(ShipmentPoll).run();
    // The one id, asked once in each workspace, each time with its own keys
    expect(
      status.mock.calls
        .filter((call) => call[1] === consignment)
        .map((call) => call[0].apiKey)
        .sort(),
    ).toEqual(['acme-api-key', 'nirvor-api-key']);
    expect(await parcelOf(acmeOrder)).toMatchObject({
      tenant_id: acme.tenantId,
      status: 'in_transit',
    });
    // Nirvor's parcel got no step from Acme's answer
    expect(await parcelOf(nirvorOrder)).toMatchObject({ status: 'in_transit', events: 2 });
  });
});

describe('the order page', () => {
  it("answers 404 for another workspace's order and parcel", async () => {
    const parcel = nirvorOrder.shipments[0]?.id ?? '';
    expect((await send(acmeOwner, 'GET', `/storefront/orders/${nirvorOrder.id}`)).statusCode).toBe(
      404,
    );
    const retry = await send(
      acmeOwner,
      'POST',
      `/storefront/orders/${nirvorOrder.id}/shipments/${parcel}/retry`,
      { version: nirvorOrder.version },
    );
    expect(retry.statusCode).toBe(404);
    // Acme's own packed order (its first one is shipped by now), with Nirvor's parcel id
    const [packed] = z.array(z.object({ id: z.string() })).parse(
      await sql`SELECT id::text FROM storefront_orders
          WHERE tenant_id = ${acme.tenantId} AND status = 'packed' LIMIT 1`,
    );
    const own = await getOrder(acmeOwner, packed?.id ?? '');
    const mixed = await send(
      acmeOwner,
      'POST',
      `/storefront/orders/${own.id}/shipments/${parcel}/retry`,
      { version: own.version },
    );
    expect(mixed.statusCode).toBe(404);
  });
});

describe('the database roles', () => {
  // ShopDb.read and ShopDb.orders in Nirvor's workspace: the shop's two ways in
  function asPublic(query: SQL) {
    return app.get(ShopDb).read(nirvor.host, (tx) => tx.execute(query));
  }
  function asShop(query: SQL) {
    return app.get(ShopDb).orders(nirvor.host, (tx) => tx.execute(query));
  }
  async function deniedAs(as: typeof asShop, query: SQL) {
    return pgErrorOf(await as(query).catch((caught: unknown) => caught));
  }

  it("give the shop's roles no account, no amount and no other workspace's parcel", async () => {
    for (const as of [asPublic, asShop]) {
      expect(await deniedAs(as, drizzleSql`SELECT name FROM courier_accounts`)).toEqual({
        code: '42501',
        message: 'permission denied for table courier_accounts',
      });
      expect(
        await deniedAs(
          as,
          drizzleSql`SELECT * FROM courier_account_for_webhook(${nirvorAccount.id}::uuid, 'steadfast')`,
        ),
      ).toEqual({
        code: '42501',
        message: 'permission denied for function courier_account_for_webhook',
      });
    }
    // omnivo_public reads no parcel at all; omnivo_shop only the tracking page's columns
    expect(await deniedAs(asPublic, drizzleSql`SELECT id FROM storefront_shipments`)).toEqual({
      code: '42501',
      message: 'permission denied for table storefront_shipments',
    });
    for (const column of ['cod_amount', 'consignment_id', 'error_detail']) {
      expect(
        await deniedAs(
          asShop,
          drizzleSql`SELECT ${drizzleSql.identifier(column)} FROM storefront_shipments`,
        ),
      ).toEqual({ code: '42501', message: 'permission denied for table storefront_shipments' });
    }
    expect(await deniedAs(asShop, drizzleSql`SELECT raw FROM storefront_shipment_events`)).toEqual({
      code: '42501',
      message: 'permission denied for table storefront_shipment_events',
    });
    // 0079: when a step arrived, for the tracking page's order. Still only Nirvor's
    const arrived = await asShop(
      drizzleSql`SELECT tenant_id::text, received_at FROM storefront_shipment_events`,
    );
    expect(new Set(Array.from(arrived).map((row) => row.tenant_id))).toEqual(
      new Set([nirvor.tenantId]),
    );
    // Acme's parcel, from Nirvor's shop: not there
    const seen = await asShop(drizzleSql`SELECT tenant_id::text FROM storefront_shipments`);
    expect(Array.from(seen).map((row) => row.tenant_id)).toEqual([nirvor.tenantId]);
    // And never a write
    expect(
      await deniedAs(asShop, drizzleSql`UPDATE storefront_shipments SET status = 'delivered'`),
    ).toEqual({ code: '42501', message: 'permission denied for table storefront_shipments' });
  });

  it('hide a parcel still booking or failed, and a notice nobody could read, even in its own workspace', async () => {
    const order = await confirmAt(nirvor, nirvorOwner, 1005);
    const old = await addSteadfast(nirvorOwner, 'fake_rejected');
    expect((await packWith(nirvorOwner, order, old.account.id)).statusCode).toBe(200);
    await eventually(async () => {
      expect((await getOrder(nirvorOwner, order.id)).shipments[0]?.status).toBe('booking_failed');
    });
    const failed = await asShop(
      drizzleSql`SELECT id FROM storefront_shipments WHERE order_id = ${order.id}::uuid`,
    );
    expect(Array.from(failed)).toEqual([]);
    // A notice Nirvor's adapter cannot read, on Nirvor's booked parcel
    const unread = await webhook(nirvorAccount.id, nirvorToken, {
      notification_type: 'mystery',
      invoice: nirvorOrder.orderNo,
    });
    expect(unread.statusCode).toBe(200);
    const [kept] = await sql`SELECT count(*)::int AS n FROM storefront_shipment_events
      WHERE tenant_id = ${nirvor.tenantId} AND status IS NULL`;
    expect(kept?.n).toBe(1);
    const shown = await asShop(
      drizzleSql`SELECT count(*)::int AS n FROM storefront_shipment_events WHERE status IS NULL`,
    );
    expect(Array.from(shown)).toEqual([{ n: 0 }]);
  });

  it("let the worker's role read only which workspaces have a parcel on its way", async () => {
    const workerSql = postgres(pg.workerUrl, { max: 1 });
    try {
      const open = z
        .array(z.object({ tenant_id: z.string(), status: z.string() }))
        .parse(await workerSql`SELECT tenant_id::text, status FROM storefront_shipments`);
      // Both workspaces' parcels on their way; never a failed one, and never more than two columns
      expect(new Set(open.map((row) => row.tenant_id))).toEqual(
        new Set([nirvor.tenantId, acme.tenantId]),
      );
      expect(open.map((row) => row.status)).not.toContain('booking_failed');
      const error = await workerSql`SELECT tracking_code FROM storefront_shipments`.catch(
        (caught: unknown) => caught,
      );
      expect(pgErrorOf(error)).toEqual({
        code: '42501',
        message: 'permission denied for table storefront_shipments',
      });
    } finally {
      await workerSql.end();
    }
  });
});
