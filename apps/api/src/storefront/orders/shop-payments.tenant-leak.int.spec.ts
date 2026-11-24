import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  fakeValId,
  publicOrderPlacedSchema,
  shopCheckoutSettingsSchema,
  shopPaymentSettledSchema,
  type StorefrontPaymentGateway,
  storefrontOrderSchema,
  storefrontPaymentGatewaySchema,
  storefrontPaymentSetupSchema,
} from '@omnivo/contracts';
import { type SQL, sql as drizzleSql } from 'drizzle-orm';
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

// Step 27d: a payment is a workspace's own. Two launched shops, Nirvor and Acme, each with its own
// gateway on the Payment card and Pay online ticked. The ERP must show and change only its own
// card, and take no other workspace's account for it; a shop must settle, show and retry only its
// own orders' payments, whatever tran_id or token it is sent; a sealed password must open only in
// the workspace that sealed it; and the shop's database roles must never read a gateway's row.
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
let nirvorGateway: StorefrontPaymentGateway;
let acmeGateway: StorefrontPaymentGateway;

// Two face washes (৳229 each) and the ৳80 delivery charge
const TWO = '538';

function send(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

// The Payment card saved with the workspace's Cash in hand and its first fee account
async function saveGateway(who: SignedIn, storeId: string): Promise<StorefrontPaymentGateway> {
  const setup = storefrontPaymentSetupSchema.parse(
    (await send(who, 'GET', '/storefront/payment-gateway')).json(),
  );
  const res = await send(who, 'POST', '/storefront/payment-gateway', {
    storeId,
    password: `${storeId}-password`,
    mode: 'sandbox',
    moneyAccountId: setup.moneyAccounts.find((account) => account.code === '1110')?.id ?? '',
    feeAccountId: setup.feeAccounts[0]?.id ?? '',
  });
  expect(res.statusCode, res.body).toBe(201);
  return storefrontPaymentGatewaySchema.parse(res.json());
}

async function cardOf(who: SignedIn): Promise<StorefrontPaymentGateway | null> {
  const res = await send(who, 'GET', '/storefront/payment-gateway');
  expect(res.statusCode, res.body).toBe(200);
  return storefrontPaymentSetupSchema.parse(res.json()).gateway;
}

// An online order of two face washes by shopper n at this shop: its token and its try
async function placeOnline(shop: OrderShop, n: number) {
  const res = await shopPost(app, '/orders', shopHeaders(shop.host, clientAddress(n)), {
    ...orderRequest(shop.listingId, 2, phoneOf(n), TWO),
    paymentMethod: 'online',
  });
  expect(res.statusCode, res.body).toBe(201);
  const { answer, token } = publicOrderPlacedSchema.parse(res.json());
  if (answer.next !== 'pay' || answer.paymentUrl === null) throw new Error('no payment page');
  const url = new URL(answer.paymentUrl);
  return {
    token,
    tranId: url.searchParams.get('tranId') ?? '',
    amount: url.searchParams.get('amount') ?? '',
  };
}

async function tryStatus(tranId: string): Promise<string | undefined> {
  const [row] = z
    .array(z.object({ status: z.string() }))
    .parse(await sql`SELECT status FROM storefront_payments WHERE tran_id = ${tranId}`);
  return row?.status;
}

async function checkoutMethods(shop: OrderShop) {
  const res = await app.inject({
    method: 'GET',
    url: '/public/v1/checkout-settings',
    headers: { 'x-shop-host': shop.host },
  });
  expect(res.statusCode, res.body).toBe(200);
  return shopCheckoutSettingsSchema.parse(res.json()).paymentMethods;
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
  nirvorGateway = await saveGateway(nirvorOwner, 'nirvor67412bc');
  acmeGateway = await saveGateway(acmeOwner, 'acme5521de');
  // Pay online ticked in both. The settings form's own check is the other file's: here only the
  // row matters
  await sql`UPDATE storefront_settings SET payment_methods = '{cod,online}'`;
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('the Payment card', () => {
  it("shows and changes each workspace's own gateway, and takes none of the other's accounts", async () => {
    expect(await cardOf(nirvorOwner)).toMatchObject({ storeId: 'nirvor67412bc', version: 1 });
    expect(await cardOf(acmeOwner)).toMatchObject({ storeId: 'acme5521de', version: 1 });

    // Nirvor's own accounts on Acme's card: not Acme's, so not a choice
    const changed = await send(acmeOwner, 'PUT', '/storefront/payment-gateway', {
      storeId: 'acme5521de',
      password: '',
      mode: 'sandbox',
      moneyAccountId: nirvorGateway.moneyAccountId,
      feeAccountId: nirvorGateway.feeAccountId,
      version: acmeGateway.version,
    });
    expect(changed.statusCode, changed.body).toBe(422);
    // Acme's test and save touch Acme's row only
    const tested = await send(acmeOwner, 'POST', '/storefront/payment-gateway/test');
    expect(tested.statusCode, tested.body).toBe(200);
    expect(await cardOf(nirvorOwner)).toMatchObject({ lastTest: null, version: 1 });
    const audit = z.array(z.object({ action: z.string(), tenant: z.string() })).parse(
      await sql`
          SELECT action, tenant_id::text AS tenant FROM audit_logs
          WHERE entity_type = 'storefront_payment_gateway' ORDER BY created_at, id`,
    );
    expect(audit).toEqual([
      { action: 'storefront_payment_gateway.created', tenant: nirvor.tenantId },
      { action: 'storefront_payment_gateway.created', tenant: acme.tenantId },
      { action: 'storefront_payment_gateway.tested', tenant: acme.tenantId },
    ]);
  });

  it('opens a sealed password only in the workspace that sealed it', async () => {
    const [saved] = z.array(z.object({ sealed: z.instanceof(Buffer) })).parse(
      await sql`
          SELECT password_sealed AS sealed FROM storefront_payment_gateways
          WHERE tenant_id = ${acme.tenantId}`,
    );
    if (saved === undefined) throw new Error("no Acme's gateway");
    // Nirvor's sealed bytes copied into Acme's row: the same key, but the workspace is part of
    // what was sealed (AAD = tenant id), so it does not open there
    await sql`
      UPDATE storefront_payment_gateways SET password_sealed = (
        SELECT password_sealed FROM storefront_payment_gateways WHERE tenant_id = ${nirvor.tenantId})
      WHERE tenant_id = ${acme.tenantId}`;
    try {
      const tested = storefrontPaymentGatewaySchema.parse(
        (await send(acmeOwner, 'POST', '/storefront/payment-gateway/test')).json(),
      );
      expect(tested.lastTest?.problem).toBe('rejected');
      // And the shop can't open a page with it: the order is refused, not paid at Nirvor's store
      const res = await shopPost(app, '/orders', shopHeaders(acme.host, clientAddress(971)), {
        ...orderRequest(acme.listingId, 2, phoneOf(971), TWO),
        paymentMethod: 'online',
      });
      expect(res.statusCode, res.body).toBe(422);
    } finally {
      await sql`
        UPDATE storefront_payment_gateways SET password_sealed = ${saved.sealed}
        WHERE tenant_id = ${acme.tenantId}`;
    }
  });

  it("is ready for each shop on that workspace's own accounts", async () => {
    const acmeFee = acmeGateway.feeAccountId;
    await sql`UPDATE ledger_accounts SET archived_at = now() WHERE id = ${acmeFee}`;
    try {
      expect(await checkoutMethods(acme)).toEqual(['cod']);
      expect(await checkoutMethods(nirvor)).toEqual(['cod', 'online']);
    } finally {
      await sql`UPDATE ledger_accounts SET archived_at = NULL WHERE id = ${acmeFee}`;
    }
    expect(await checkoutMethods(acme)).toEqual(['cod', 'online']);
  });
});

describe("the shops' payment routes", () => {
  it("settle, show and retry only their own orders' payments", async () => {
    const order = await placeOnline(nirvor, 972);
    const atAcme = shopHeaders(acme.host, clientAddress(972));
    const paid = fakeValId(order.tranId, { outcome: 'paid', amount: order.amount });
    // Nirvor's tran_id and token sent through Acme's shop: unknown there
    const calls = [
      shopPost(app, '/payments/settle', atAcme, { tranId: order.tranId, valId: paid }),
      shopPost(app, '/orders/payment', atAcme, { token: order.token }),
      shopPost(app, '/orders/payment/retry', atAcme, { token: order.token }),
      shopPost(app, '/orders/payment/cod', atAcme, { token: order.token }),
    ];
    expect((await Promise.all(calls)).map((res) => res.statusCode)).toEqual([404, 404, 404, 404]);
    expect(await tryStatus(order.tranId)).toBe('started');
    const [tries] = await sql`
      SELECT count(*)::int AS n FROM storefront_payments WHERE tenant_id = ${acme.tenantId}`;
    expect(tries?.n).toBe(0);

    // At its own shop it settles, and the receipt is Nirvor's
    const res = await shopPost(
      app,
      '/payments/settle',
      shopHeaders(nirvor.host, clientAddress(972)),
      {
        tranId: order.tranId,
        valId: paid,
      },
    );
    expect(shopPaymentSettledSchema.parse(res.json()).status).toBe('paid');
    await eventually(async () => {
      const rows = z
        .array(z.object({ tenant: z.string() }))
        .parse(await sql`SELECT tenant_id::text AS tenant FROM receipts`);
      expect(rows).toEqual([{ tenant: nirvor.tenantId }]);
    }, 10_000);
  });

  it("make no receipt from the other workspace's order page", async () => {
    const [row] = z.array(z.object({ order: z.string(), payment: z.string() })).parse(
      await sql`
          SELECT order_id::text AS order, id::text AS payment FROM storefront_payments
          WHERE tenant_id = ${nirvor.tenantId} AND status = 'paid' LIMIT 1`,
    );
    if (row === undefined) throw new Error("no Nirvor's paid try");
    const own = storefrontOrderSchema.parse(
      (await send(nirvorOwner, 'GET', `/storefront/orders/${row.order}`)).json(),
    );
    expect((await send(acmeOwner, 'GET', `/storefront/orders/${row.order}`)).statusCode).toBe(404);
    const made = await send(
      acmeOwner,
      'POST',
      `/storefront/orders/${row.order}/payments/${row.payment}/receipt`,
      { version: own.version },
    );
    expect(made.statusCode, made.body).toBe(404);
  });
});

describe("the shop's database roles", () => {
  // ShopDb.read and ShopDb.orders in Nirvor's workspace: the shop's two ways in
  function asPublic(query: SQL) {
    return app.get(ShopDb).read(nirvor.host, (tx) => tx.execute(query));
  }
  function asShop(query: SQL) {
    return app.get(ShopDb).orders(nirvor.host, (tx) => tx.execute(query));
  }

  it("never read a gateway's row, not even their own workspace's", async () => {
    const query = drizzleSql`SELECT store_id FROM storefront_payment_gateways`;
    for (const as of [asPublic, asShop]) {
      expect(pgErrorOf(await as(query).catch((caught: unknown) => caught))).toEqual({
        code: '42501',
        message: 'permission denied for table storefront_payment_gateways',
      });
    }
  });

  it("reach no other workspace's payment, and change no amount of their own", async () => {
    const order = await placeOnline(acme, 973);
    // Acme's try, from Nirvor's order role: not there to read or to mark paid
    const seen = await asShop(
      drizzleSql`SELECT id FROM storefront_payments WHERE tran_id = ${order.tranId}`,
    );
    expect(Array.from(seen)).toEqual([]);
    const marked = await asShop(drizzleSql`
      UPDATE storefront_payments SET status = 'paid', settled_at = now(), store_amount = 0
      WHERE tran_id = ${order.tranId} RETURNING id`);
    expect(Array.from(marked)).toEqual([]);
    expect(await tryStatus(order.tranId)).toBe('started');
    // The amount is the order's, never the shop role's to write
    const error = await asShop(drizzleSql`UPDATE storefront_payments SET amount = 1`).catch(
      (caught: unknown) => caught,
    );
    expect(pgErrorOf(error)).toEqual({
      code: '42501',
      message: 'permission denied for table storefront_payments',
    });
  });
});
