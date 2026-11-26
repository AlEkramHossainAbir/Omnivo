import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  type CourierAccount,
  courierAccountSavedSchema,
  type Payout,
  payoutMatchSchema,
  payoutPageSchema,
  payoutSchema,
  payoutSetupSchema,
  problemSchema,
  receiptSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
  type StorefrontShipment,
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

// Step 28c: a courier payout is a workspace's own. Two launched shops, Nirvor and Acme, each with
// its own Steadfast account, COD account and charges account, and one parcel delivered by the
// courier's news. The fake courier works a parcel's id out of its invoice, so both first parcels
// are W-000001 with the same consignment id: only the workspace tells them apart. Nirvor pays its
// parcel out. Acme must not read, void or list Nirvor's payout, nor use Nirvor's courier account,
// parcel or bank account in its own; its CSV's W-000001 must find its own parcel; and the shop's
// and the worker's database roles must not read a payout at all (0083 grants them nothing).
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;

interface Side {
  owner: SignedIn;
  shop: OrderShop;
  bankId: string;
  codAccount: Account;
  account: CourierAccount;
  token: string;
  parcel: StorefrontShipment;
  day: string;
}
let nirvor: Side;
let acme: Side;
let nirvorPayout: Payout;

const WHOLE = [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }];
const refusalSchema = problemSchema.pick({ code: true, fieldErrors: true });

function send(who: SignedIn, method: 'GET' | 'POST', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function getOrder(who: SignedIn, id: string): Promise<StorefrontOrder> {
  const res = await send(who, 'GET', `/storefront/orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

async function ledgerAccount(
  who: SignedIn,
  parentId: string,
  code: string,
  name: string,
  holdsMoney: boolean,
): Promise<Account> {
  const res = await send(who, 'POST', '/accounts', {
    parentId,
    code,
    name,
    isGroup: false,
    holdsMoney,
    description: '',
  });
  expect(res.statusCode, res.body).toBe(201);
  return accountSchema.parse(res.json());
}

// A workspace with a launched shop, its Steadfast account with both money accounts, and its first
// order (W-000001) delivered by the courier's news, with its COD receipt
async function sideOf(
  owner: SignedIn,
  slug: string,
  name: string,
  apiKey: string,
  n: number,
): Promise<Side> {
  const shop = await orderShop(app, sql, owner, { slug, name, stock: 50 });
  const chart = accountListSchema.parse((await send(owner, 'GET', '/accounts')).json()).items;
  const cash = chart.find((account) => account.code === '1110');
  const expenses = chart.find(
    (account) => account.type === 'expense' && account.isGroup && account.parentId !== null,
  );
  if (cash?.parentId == null || expenses === undefined) throw new Error('the seed chart changed');
  const codAccount = await ledgerAccount(owner, cash.parentId, '1191', 'Cash with Steadfast', true);
  const chargeAccount = await ledgerAccount(owner, expenses.id, '5998', 'Courier charges', false);
  const saved = await send(owner, 'POST', '/storefront/couriers', {
    provider: 'steadfast',
    name: 'Steadfast',
    apiKey,
    secretKey: `${apiKey}-secret`,
    codAccountId: codAccount.id,
    chargeAccountId: chargeAccount.id,
  });
  expect(saved.statusCode, saved.body).toBe(201);
  const { account, webhookToken } = courierAccountSavedSchema.parse(saved.json());
  const token = webhookToken ?? '';

  const headers = shopHeaders(shop.host, clientAddress(n));
  const phone = phoneOf(n);
  const orderToken = await placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, '538'));
  const { code } = await codeFor(mail.apiUrl, phone);
  const verified = await shopPost(app, '/orders/verify', headers, { token: orderToken, code });
  expect(verified.statusCode, verified.body).toBe(200);
  const [row] = z.array(z.object({ id: z.uuid() })).parse(
    await sql`SELECT id::text FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${phone} AND status = 'confirmed'`,
  );
  if (row === undefined) throw new Error(`no confirmed order for ${phone}`);
  const order = await eventually(async () => {
    const now = await getOrder(owner, row.id);
    expect(now.salesOrder).not.toBeNull();
    return now;
  });
  const packed = await send(owner, 'POST', `/storefront/orders/${order.id}/pack`, {
    version: order.version,
    lines: WHOLE,
    courierAccountId: account.id,
  });
  expect(packed.statusCode, packed.body).toBe(200);
  const booked = await eventually(async () => {
    const now = await getOrder(owner, order.id);
    expect(now.shipments.at(-1)?.status).toBe('booked');
    return now;
  });
  // A second after the booking, so the delivered step is the parcel's newest (28a)
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const news = await app.inject({
    method: 'POST',
    url: `/public/v1/couriers/steadfast/${account.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      notification_type: 'delivery_status',
      consignment_id: Number(booked.shipments.at(-1)?.consignmentId),
      status: 'delivered',
      cod_amount: 538,
      delivery_charge: 80,
    },
  });
  expect(news.statusCode, news.body).toBe(200);
  const parcel = (await getOrder(owner, order.id)).shipments.at(-1);
  if (parcel?.receipt == null) throw new Error(`${slug}'s parcel has no COD receipt`);
  const receipt = receiptSchema.parse(
    (await send(owner, 'GET', `/receipts/${parcel.receipt.id}`)).json(),
  );
  return { owner, shop, bankId: cash.id, codAccount, account, token, parcel, day: receipt.date };
}

function payoutBody(side: Side, overrides: object = {}) {
  return {
    accountId: side.account.id,
    date: side.day,
    bankAccountId: side.bankId,
    reference: 'SFC-23618228',
    note: '',
    lines: [{ shipmentId: side.parcel.id, charge: '80' }],
    ...overrides,
  };
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
  const nirvorOwner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  const acmeOwner = await signUp(app, {
    companyName: 'Acme Distribution',
    workspaceSlug: 'acme',
    fullName: 'Farhan Ahmed',
    email: 'farhan@acme.com.bd',
    password: 'Acme-distribution-2026',
  });
  nirvor = await sideOf(nirvorOwner, 'nirvor', 'Nirvor', 'nirvor-api-key', 2001);
  acme = await sideOf(acmeOwner, 'acme', 'Acme', 'acme-api-key', 2002);
  const paid = await send(nirvor.owner, 'POST', '/storefront/payouts', payoutBody(nirvor));
  expect(paid.statusCode, paid.body).toBe(201);
  nirvorPayout = payoutSchema.parse(paid.json());
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('two shops, one fake courier', () => {
  it('gives both first parcels the same invoice and consignment id', () => {
    expect(nirvor.parcel.consignmentId).toBe(acme.parcel.consignmentId);
    expect(nirvor.parcel.id).not.toBe(acme.parcel.id);
  });
});

describe('Shop payouts', () => {
  it("shows the workspace's own courier accounts, bank accounts and payouts only", async () => {
    const setup = payoutSetupSchema.parse(
      (await send(acme.owner, 'GET', '/storefront/payout-setup')).json(),
    );
    expect(setup.accounts.map((account) => account.id)).toEqual([acme.account.id]);
    const banks = setup.bankAccounts.map((account) => account.id);
    expect(banks).toContain(acme.bankId);
    expect(banks).not.toContain(nirvor.bankId);
    expect(banks).not.toContain(nirvor.codAccount.id);
    // Acme's account holds its own parcel, not Nirvor's paid one
    expect(setup.accounts[0]?.holds).toEqual({ amount: '538.0000', parcels: 1 });
    const list = payoutPageSchema.parse(
      (await send(acme.owner, 'GET', '/storefront/payouts')).json(),
    );
    expect(list.items).toEqual([]);
    const filtered = payoutPageSchema.parse(
      (await send(acme.owner, 'GET', `/storefront/payouts?accountId=${nirvor.account.id}`)).json(),
    );
    expect(filtered.items).toEqual([]);
  });

  it("answers 404 for another workspace's payout and courier account", async () => {
    const routes: ['GET' | 'POST', string, object?][] = [
      ['GET', `/storefront/payouts/${nirvorPayout.id}`],
      [
        'POST',
        `/storefront/payouts/${nirvorPayout.id}/void`,
        { version: nirvorPayout.version, date: nirvor.day, reason: 'Not ours' },
      ],
      ['GET', `/storefront/couriers/${nirvor.account.id}/payout-parcels`],
      [
        'POST',
        `/storefront/couriers/${nirvor.account.id}/payout-match`,
        { csv: 'Invoice,COD Amount,Delivery Charge\nW-000001,538,80', map: null },
      ],
    ];
    for (const [method, url, body] of routes) {
      const res = await send(acme.owner, method, url, body);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(404);
    }
    // Nirvor's payout is as it was
    const own = payoutSchema.parse(
      (await send(nirvor.owner, 'GET', `/storefront/payouts/${nirvorPayout.id}`)).json(),
    );
    expect(own).toMatchObject({ status: 'posted', version: nirvorPayout.version });
  });

  it('finds its own W-000001 in the file, not the paid one of the other workspace', async () => {
    const res = await send(
      acme.owner,
      'POST',
      `/storefront/couriers/${acme.account.id}/payout-match`,
      {
        csv: 'Invoice,COD Amount,Delivery Charge\nW-000001,538,80',
        map: null,
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(payoutMatchSchema.parse(res.json()).rows).toEqual([
      expect.objectContaining({ outcome: 'matched', shipmentId: acme.parcel.id, payout: null }),
    ]);
  });

  it('pays out with its own courier account, parcels and bank account only', async () => {
    const cases: [object, number, string, Record<string, string[]>][] = [
      [
        { accountId: nirvor.account.id },
        422,
        'payout_pick_account',
        { accountId: ['payout_pick_account'] },
      ],
      [
        { lines: [{ shipmentId: nirvor.parcel.id, charge: '80' }] },
        409,
        'payout_parcel_unavailable',
        { 'lines.0.shipmentId': ['payout_parcel_unavailable'] },
      ],
      [
        { bankAccountId: nirvor.bankId },
        422,
        'payout_bank_account_invalid',
        { bankAccountId: ['payout_bank_account_invalid'] },
      ],
    ];
    for (const [wrong, status, code, fieldErrors] of cases) {
      const res = await send(acme.owner, 'POST', '/storefront/payouts', payoutBody(acme, wrong));
      expect(res.statusCode, res.body).toBe(status);
      expect(refusalSchema.parse(res.json())).toEqual({ code, fieldErrors });
    }
    // Its own goes through, with its own number series
    const res = await send(acme.owner, 'POST', '/storefront/payouts', payoutBody(acme));
    expect(res.statusCode, res.body).toBe(201);
    const payout = payoutSchema.parse(res.json());
    expect(payout.number).toBe(nirvorPayout.number);
    expect(payout.lines.map((line) => line.shipmentId)).toEqual([acme.parcel.id]);
    // And Nirvor's parcel still names Nirvor's payout
    const [row] = await sql`SELECT payout_id::text AS id FROM storefront_shipments
      WHERE id = ${nirvor.parcel.id}`;
    expect(row?.id).toBe(nirvorPayout.id);
  });
});

describe('the database roles', () => {
  // ShopDb.read and ShopDb.orders in Nirvor's workspace: the shop's two ways in
  function asPublic(query: SQL) {
    return app.get(ShopDb).read(nirvor.shop.host, (tx) => tx.execute(query));
  }
  function asShop(query: SQL) {
    return app.get(ShopDb).orders(nirvor.shop.host, (tx) => tx.execute(query));
  }
  async function deniedAs(as: typeof asShop, query: SQL) {
    return pgErrorOf(await as(query).catch((caught: unknown) => caught));
  }

  it("give the shop's roles and the worker's role no payout and no parcel's payout", async () => {
    for (const as of [asPublic, asShop]) {
      for (const table of ['storefront_payouts', 'storefront_payout_lines']) {
        expect(
          await deniedAs(as, drizzleSql`SELECT count(*) FROM ${drizzleSql.identifier(table)}`),
        ).toEqual({ code: '42501', message: `permission denied for table ${table}` });
      }
    }
    expect(await deniedAs(asShop, drizzleSql`SELECT payout_id FROM storefront_shipments`)).toEqual({
      code: '42501',
      message: 'permission denied for table storefront_shipments',
    });
    const workerSql = postgres(pg.workerUrl, { max: 1 });
    try {
      for (const table of ['storefront_payouts', 'storefront_payout_lines']) {
        const error = await workerSql`SELECT count(*) FROM ${workerSql(table)}`.catch(
          (caught: unknown) => caught,
        );
        expect(pgErrorOf(error)).toEqual({
          code: '42501',
          message: `permission denied for table ${table}`,
        });
      }
    } finally {
      await workerSql.end();
    }
  });
});
