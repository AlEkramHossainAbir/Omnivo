import { createHash } from 'node:crypto';

import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type CourierAccount,
  courierAccountSavedSchema,
  courierAccountSchema,
  courierChoicesSchema,
  courierExportSchema,
  courierSetupSchema,
  invoiceSchema,
  memberPageSchema,
  type PermissionKey,
  roleSchema,
  type ShopShipment,
  shopTrackingSchema,
  type StorefrontOrder,
  storefrontOrderPageSchema,
  storefrontOrderSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Config, ShippingConfig } from '../../config.js';
import { COURIERS, SHIPPING_CONFIG } from '../../infra/tokens.js';
import type { CourierAdapter, CourierAdapters } from '../../shipping/courier.js';
import { FAKE_REFUSED_PHONE, FakeCourier } from '../../shipping/fake-courier.js';
import {
  createTestApp,
  createTestWorker,
  eventually,
  lockWaitsOfApi,
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
} from '../../testing/shop-orders.js';
import { joinWithoutRoles } from '../../testing/workspace.js';
import { openKeys } from './courier-keys.js';
import { ShipmentPoll } from './shipment-poll.js';

// Step 28a: Shop couriers and a shop order's parcels, on the real stack: Postgres, Redis, Mailpit,
// the API and the worker, with the fake courier (COURIER_MODE's default outside production). The
// fake answers like Steadfast from the invoice alone; where a test needs another answer (a lost
// one, a parcel the courier has already, a status for the poll), it spies on the worker's own
// adapter (`courier`), which the booking job and the poll look up on every call.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let config: Config;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
let shop: OrderShop;
let courier: CourierAdapter;
// The accounts most tests use, made by the first tests and kept up to date by them
let steadfast: CourierAccount;
let steadfastToken: string;
let manual: CourierAccount;

const API_KEY = 'sf-api-7k2m9q4x';
const SECRET_KEY = 'sf-secret-4n8p1x6w';
// 28b: a courier account's two money accounts (the COD account and the charge account) have no
// default, so every body sends both. These tests are about the rest of the account: both stay
// empty, and cod.int.spec.ts tests them
const NO_COD = { codAccountId: '', chargeAccountId: '' };

// Two face washes (৳229 each) and the ৳80 delivery charge
const TOTAL = '538';
const WHOLE = [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }];

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, who = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function accountOf(id: string): Promise<CourierAccount> {
  const setup = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
  const found = setup.accounts.find((account) => account.id === id);
  if (found === undefined) throw new Error(`no courier account ${id}`);
  return found;
}

async function addAccount(body: object) {
  const res = await send('POST', '/storefront/couriers', body);
  expect(res.statusCode, res.body).toBe(201);
  return courierAccountSavedSchema.parse(res.json());
}

async function defaultOf(): Promise<string | null> {
  return courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json())
    .defaultAccountId;
}

// The account's row as the database keeps it: the sealed box in hex, so a test can compare it
// before and after a save
const accountRowSchema = z.object({
  sealed: z.string().nullable(),
  key_version: z.number().nullable(),
  webhook_token_hash: z.string().nullable(),
  is_default: z.boolean(),
  last_webhook_at: z.date().nullable(),
});
async function accountRow(id: string) {
  const [row] = z.array(accountRowSchema).parse(
    await sql`
      SELECT encode(keys_sealed, 'hex') AS sealed, key_version, webhook_token_hash, is_default,
        last_webhook_at
      FROM courier_accounts WHERE id = ${id}`,
  );
  if (row === undefined) throw new Error(`no courier account row ${id}`);
  return row;
}

// The two keys as this server opens them, read with the API's own config
async function keysOf(id: string) {
  const [row] = z
    .array(
      z.object({
        tenant_id: z.string(),
        keys_sealed: z.instanceof(Buffer).nullable(),
        key_version: z.number().nullable(),
      }),
    )
    .parse(
      await sql`SELECT tenant_id::text, keys_sealed, key_version FROM courier_accounts WHERE id = ${id}`,
    );
  if (row === undefined) throw new Error(`no courier account row ${id}`);
  return openKeys(app.get<ShippingConfig>(SHIPPING_CONFIG).credentialsKey, {
    tenantId: row.tenant_id,
    keysSealed: row.keys_sealed,
    keyVersion: row.key_version,
  });
}

// Every audit row of courier accounts, its whole payload as text
async function accountAudit() {
  return z.array(z.object({ action: z.string(), text: z.string() })).parse(
    await sql`
      SELECT action, payload::text AS text FROM audit_logs
      WHERE tenant_id = ${shop.tenantId} AND entity_type = 'courier_account'
      ORDER BY created_at, id`,
  );
}

async function getOrder(id: string): Promise<StorefrontOrder> {
  const res = await send('GET', `/storefront/orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

interface Confirmed {
  id: string;
  orderNo: string;
  phone: string;
  // The tracking link's token, from the confirm SMS
  token: string;
  // The shopper's address, for the tracking page's limits
  client: number;
}

// An order placed, confirmed with its phone code, and given its sales order by the worker: ready
// to pack. n picks the phone and the shopper's address, so no two tests share them
async function confirm(n: number, phone = phoneOf(n)): Promise<Confirmed> {
  const headers = shopHeaders(shop.host, clientAddress(n));
  const token = await placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, TOTAL));
  const { code } = await codeFor(mail.apiUrl, phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const tracking = await trackingTokenFor(mail.apiUrl, phone);
  const [row] = z.array(z.object({ id: z.uuid(), order_no: z.string() })).parse(
    await sql`SELECT id::text, order_no FROM storefront_orders
        WHERE tenant_id = ${shop.tenantId} AND phone = ${phone} AND status = 'confirmed'`,
  );
  if (row === undefined) throw new Error(`no confirmed order for ${phone}`);
  await eventually(async () => {
    expect((await getOrder(row.id)).salesOrder).not.toBeNull();
  });
  return { id: row.id, orderNo: row.order_no, phone, token: tracking, client: n };
}

// Packed, with a courier account or none (''). Answers the order as the Packed dialog gets it
async function pack(id: string, courierAccountId: string) {
  const order = await getOrder(id);
  return send('POST', `/storefront/orders/${id}/pack`, {
    version: order.version,
    lines: WHOLE,
    courierAccountId,
  });
}
async function packed(id: string, courierAccountId: string): Promise<StorefrontOrder> {
  const res = await pack(id, courierAccountId);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// Waits until the order's newest parcel is in `status` (the worker books a moment later)
async function parcelIs(id: string, status: string): Promise<StorefrontOrder> {
  return eventually(async () => {
    const order = await getOrder(id);
    expect(order.shipments.at(-1)?.status).toBe(status);
    return order;
  });
}

function lastParcel(order: StorefrontOrder) {
  const parcel = order.shipments.at(-1);
  if (parcel === undefined) throw new Error(`order ${order.id} has no parcel`);
  return parcel;
}

// "Book courier" on the order page
function bookCourier(order: StorefrontOrder, accountId: string, trackingCode = '') {
  return send('POST', `/storefront/orders/${order.id}/shipments`, {
    version: order.version,
    accountId,
    trackingCode,
  });
}

function retry(order: StorefrontOrder, shipmentId: string) {
  return send('POST', `/storefront/orders/${order.id}/shipments/${shipmentId}/retry`, {
    version: order.version,
  });
}

async function move(order: StorefrontOrder, step: 'ship' | 'deliver' | 'cancel') {
  return send(
    'POST',
    `/storefront/orders/${order.id}/${step}`,
    step === 'cancel' ? { version: order.version, reason: '' } : { version: order.version },
  );
}

// The courier's webhook, as Steadfast's panel sends it
function webhook(accountId: string, token: string | null, body: object) {
  return app.inject({
    method: 'POST',
    url: `/public/v1/couriers/steadfast/${accountId}`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: body,
  });
}
async function notice(body: object): Promise<void> {
  const res = await webhook(steadfast.id, steadfastToken, body);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json()).toEqual({ status: 'success', message: 'Received' });
}

// A Steadfast delivery_status body about one parcel. Its time is Steadfast's own form, in Dhaka
function statusNotice(consignmentId: string, status: string, message: string, at: string) {
  return {
    notification_type: 'delivery_status',
    consignment_id: Number(consignmentId),
    status,
    tracking_message: message,
    updated_at: at,
  };
}

// A moment as Steadfast writes it ("2026-11-23 14:05:09", Dhaka time, UTC+6)
function steadfastAt(at: Date): string {
  return new Date(at.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// Steadfast's times have whole seconds, and a step is never before its parcel's booking (the API
// keeps it between the booking and now). Waiting for the next second makes "now" in Steadfast's
// form later than the booking, so the steps keep the times the test gives them
async function nextSecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_010 - (Date.now() % 1_000)));
}

const eventRowSchema = z.object({
  status: z.string().nullable(),
  note: z.string().nullable(),
  source: z.string(),
  raw: z.unknown(),
});
async function eventRows(shipmentId: string) {
  return z.array(eventRowSchema).parse(
    await sql`SELECT status, note, source, raw FROM storefront_shipment_events
      WHERE shipment_id = ${shipmentId} ORDER BY occurred_at, received_at, id`,
  );
}

// The tracking page, as the shop's server asks for it (as omnivo_shop)
async function trackingOf(order: Confirmed): Promise<ShopShipment[]> {
  const res = await shopPost(
    app,
    '/tracking',
    shopHeaders(shop.host, clientAddress(order.client)),
    {
      token: order.token,
    },
  );
  expect(res.statusCode, res.body).toBe(200);
  return shopTrackingSchema.parse(res.json()).shipments;
}

// The SMS to one phone, newest first (Mailpit lists 50 at a time by default; its snippet holds
// a whole SMS)
const mailboxSchema = z.object({
  messages: z.array(
    z.object({ To: z.array(z.object({ Address: z.string() })), Snippet: z.string() }),
  ),
});
async function smsTo(phone: string): Promise<string[]> {
  const res = await fetch(`${mail.apiUrl}/api/v1/messages?limit=1000`);
  const { messages } = mailboxSchema.parse(await res.json());
  return messages
    .filter((message) => message.To.some((to) => to.Address === smsAddress(phone)))
    .map((message) => message.Snippet);
}
const ON_ITS_WAY = 'is on its way with Steadfast';

async function bellsFor(orderId: string) {
  return z.array(z.object({ params: z.record(z.string(), z.unknown()) })).parse(
    await sql`SELECT params FROM notifications
      WHERE type = 'storefront.shipment_failed' AND params->>'id' = ${orderId}`,
  );
}

// A member of Nirvor with exactly these permissions (27b's helper)
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

// Sends requests "at the same moment" for sure, and in a known order (27c's gate): a transaction
// of the test's own locks `table` in SHARE mode, and the next request is sent only once the one
// before it waits
async function inTurn<T>(table: string, sends: (() => Promise<T>)[]): Promise<T[]> {
  const gate = await sql.begin(async (tx) => {
    await tx`LOCK TABLE ${tx(table)} IN SHARE MODE`;
    const sent: Promise<T>[] = [];
    for (const next of sends) {
      sent.push(next());
      await eventually(async () => {
        expect(await lockWaitsOfApi(tx)).toBe(sent.length);
      });
    }
    return { all: Promise.all(sent) };
  });
  return gate.all;
}

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  config = testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url });
  app = await createTestApp(config);
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
    }),
  );
  courier = worker.get<CourierAdapters>(COURIERS).steadfast;
  // Three: the gate's transaction, and the reads a test makes while the gate is shut
  sql = postgres(pg.superuserUrl, { max: 3 });
  owner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 200 });
}, 240_000);

afterEach(() => {
  // Every spy on the worker's courier goes back to the fake's own answers
  vi.restoreAllMocks();
});

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('Shop couriers', () => {
  it('adds an API account with its webhook token once, and keeps its keys sealed', async () => {
    const saved = await addAccount({
      provider: 'steadfast',
      ...NO_COD,
      name: 'Steadfast',
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
    });
    expect(saved.account).toMatchObject({
      provider: 'steadfast',
      courier: 'steadfast',
      status: 'active',
      webhookUrl: `http://localhost:3000/public/v1/couriers/steadfast/${saved.account.id}`,
      hasWebhookToken: true,
      lastWebhookAt: null,
      lastTest: null,
      version: 1,
    });
    expect(saved.webhookToken).toMatch(/^[\w-]{22}$/);
    steadfast = saved.account;
    steadfastToken = saved.webhookToken ?? '';

    // The page never answers a key or the token again
    const page = await send('GET', '/storefront/couriers');
    for (const secret of [API_KEY, SECRET_KEY, steadfastToken])
      expect(page.body).not.toContain(secret);
    // The database keeps one sealed box of both keys, and the token's hash only
    const row = await accountRow(steadfast.id);
    for (const secret of [API_KEY, SECRET_KEY]) {
      expect(row.sealed).not.toContain(Buffer.from(secret).toString('hex'));
    }
    expect(row.webhook_token_hash).toBe(createHash('sha256').update(steadfastToken).digest('hex'));
    expect(row.key_version).toBe(1);
    expect(await keysOf(steadfast.id)).toEqual({ apiKey: API_KEY, secretKey: SECRET_KEY });
    // The audit row says "changed", never a value
    const audit = await accountAudit();
    expect(audit.map((entry) => entry.action)).toEqual(['courier_account.created']);
    expect(audit[0]?.text).toContain('changed');
    for (const secret of [API_KEY, SECRET_KEY, steadfastToken]) {
      expect(audit[0]?.text).not.toContain(secret);
    }

    // A manual account: a name and a courier, no keys, no webhook
    const byHand = await addAccount({
      ...NO_COD,
      provider: 'manual',
      name: 'RedX by hand',
      courier: 'redx',
    });
    expect(byHand.webhookToken).toBeNull();
    expect(byHand.account).toMatchObject({
      provider: 'manual',
      courier: 'redx',
      webhookUrl: null,
      hasWebhookToken: false,
    });
    manual = byHand.account;
    expect((await accountRow(manual.id)).sealed).toBeNull();
  });

  it('keeps a key whose box is left empty, clears the last test with new keys, and keeps the provider', async () => {
    // Test connection: an answer, not a change of the form's version
    const tested = courierAccountSchema.parse(
      (await send('POST', `/storefront/couriers/${steadfast.id}/test`)).json(),
    );
    expect(tested.lastTest?.problem).toBeNull();
    expect(tested.version).toBe(steadfast.version);
    const sealed = (await accountRow(steadfast.id)).sealed;

    // Both boxes empty: the keys stay, so does the last test
    const renamed = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
      provider: 'steadfast',
      ...NO_COD,
      name: 'Steadfast Mirpur',
      apiKey: '',
      secretKey: '',
      version: tested.version,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(courierAccountSchema.parse(renamed.json())).toMatchObject({
      name: 'Steadfast Mirpur',
      version: tested.version + 1,
      lastTest: { problem: null },
    });
    expect((await accountRow(steadfast.id)).sealed).toBe(sealed);

    // A form opened before that save
    const stale = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
      provider: 'steadfast',
      ...NO_COD,
      name: 'Steadfast',
      apiKey: '',
      secretKey: '',
      version: tested.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'version_conflict' });

    // Only the API key: the secret key comes from the saved box, in a new box
    const newKey = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
      provider: 'steadfast',
      ...NO_COD,
      name: 'Steadfast Mirpur',
      apiKey: 'fake_rejected',
      secretKey: '',
      version: tested.version + 1,
    });
    expect(newKey.statusCode, newKey.body).toBe(200);
    expect(courierAccountSchema.parse(newKey.json()).lastTest).toBeNull();
    expect((await accountRow(steadfast.id)).sealed).not.toBe(sealed);
    expect(await keysOf(steadfast.id)).toEqual({ apiKey: 'fake_rejected', secretKey: SECRET_KEY });
    const refused = courierAccountSchema.parse(
      (await send('POST', `/storefront/couriers/${steadfast.id}/test`)).json(),
    );
    expect(refused.lastTest?.problem).toBe('rejected');

    // The same keys typed again are no change: same box, and the last test stays
    const sealedNow = (await accountRow(steadfast.id)).sealed;
    const same = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
      provider: 'steadfast',
      ...NO_COD,
      name: 'Steadfast Mirpur',
      apiKey: 'fake_rejected',
      secretKey: SECRET_KEY,
      version: refused.version,
    });
    expect(courierAccountSchema.parse(same.json()).lastTest?.problem).toBe('rejected');
    expect((await accountRow(steadfast.id)).sealed).toBe(sealedNow);

    // Back to the good keys for the tests after this one
    const back = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
      provider: 'steadfast',
      ...NO_COD,
      name: 'Steadfast',
      apiKey: API_KEY,
      secretKey: '',
      version: refused.version + 1,
    });
    expect(back.statusCode, back.body).toBe(200);
    steadfast = courierAccountSchema.parse(back.json());
    expect(await keysOf(steadfast.id)).toEqual({ apiKey: API_KEY, secretKey: SECRET_KEY });
    // In the audit log, "keys" only where keys were sealed: the account's creation and the two
    // saves with a new key
    const audit = await accountAudit();
    expect(audit.filter((entry) => entry.text.includes('"keys"'))).toHaveLength(3);
    for (const entry of audit) {
      for (const secret of [API_KEY, SECRET_KEY]) expect(entry.text).not.toContain(secret);
    }

    // A manual account stays manual, and has nothing to test
    const fixed = await send('PUT', `/storefront/couriers/${manual.id}`, {
      provider: 'steadfast',
      ...NO_COD,
      name: 'RedX by hand',
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
      version: manual.version,
    });
    expect(fixed.statusCode).toBe(409);
    expect(fixed.json()).toMatchObject({ code: 'courier_provider_fixed' });
    const notTestable = await send('POST', `/storefront/couriers/${manual.id}/test`);
    expect(notTestable.statusCode).toBe(422);
    expect(notTestable.json()).toMatchObject({ code: 'courier_account_not_bookable' });
    const otherCourier = await send('PUT', `/storefront/couriers/${manual.id}`, {
      provider: 'manual',
      ...NO_COD,
      name: 'Paperfly by hand',
      courier: 'paperfly',
      version: manual.version,
    });
    expect(otherCourier.statusCode, otherCourier.body).toBe(200);
    manual = courierAccountSchema.parse(otherCourier.json());
    expect(manual.courier).toBe('paperfly');
  });

  it('keeps one default: an active API account, never a manual or an archived one', async () => {
    expect(await defaultOf()).toBeNull();
    const set = await send('PUT', '/storefront/couriers', { accountId: steadfast.id });
    expect(set.statusCode, set.body).toBe(200);
    expect(courierSetupSchema.parse(set.json()).defaultAccountId).toBe(steadfast.id);
    const byHand = await send('PUT', '/storefront/couriers', { accountId: manual.id });
    expect(byHand.statusCode).toBe(422);
    expect(byHand.json()).toMatchObject({
      code: 'courier_account_not_bookable',
      fieldErrors: { accountId: ['courier_account_not_bookable'] },
    });

    // A second API account takes the flag from the first, in one UPDATE
    const spare = (
      await addAccount({
        provider: 'steadfast',
        ...NO_COD,
        name: 'Steadfast spare',
        apiKey: 'k2',
        secretKey: 's2',
      })
    ).account;
    await send('PUT', '/storefront/couriers', { accountId: spare.id });
    expect(await defaultOf()).toBe(spare.id);
    const [flags] = await sql`SELECT count(*)::int AS n FROM courier_accounts
      WHERE tenant_id = ${shop.tenantId} AND is_default`;
    expect(flags?.n).toBe(1);

    // Archived: no longer the default, and cannot become it
    const archived = await send('POST', `/storefront/couriers/${spare.id}/archive`, {
      version: spare.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(await defaultOf()).toBeNull();
    expect((await send('PUT', '/storefront/couriers', { accountId: spare.id })).statusCode).toBe(
      422,
    );
    // A second archive (another tab) changes nothing
    const again = await send('POST', `/storefront/couriers/${spare.id}/archive`, {
      version: courierAccountSchema.parse(archived.json()).version,
    });
    expect(again.statusCode).toBe(200);
    const restored = courierAccountSchema.parse(
      (
        await send('POST', `/storefront/couriers/${spare.id}/restore`, {
          version: courierAccountSchema.parse(archived.json()).version,
        })
      ).json(),
    );
    expect(restored.status).toBe('active');
    const edit = await send('PUT', `/storefront/couriers/${spare.id}`, {
      provider: 'steadfast',
      ...NO_COD,
      name: 'Steadfast spare',
      apiKey: '',
      secretKey: '',
      version: restored.version,
    });
    expect(edit.statusCode).toBe(200);
    const spareNow = courierAccountSchema.parse(edit.json());

    // "Use as default" and Archive at the same moment, both ways round. The second always sees
    // the first: the default goes with the archive, or the archived account is refused
    const [first, second] = await inTurn('courier_accounts', [
      () => send('PUT', '/storefront/couriers', { accountId: spare.id }),
      () => send('POST', `/storefront/couriers/${spare.id}/archive`, { version: spareNow.version }),
    ]);
    expect([first?.statusCode, second?.statusCode]).toEqual([200, 200]);
    expect(await defaultOf()).toBeNull();
    const archivedAgain = await accountOf(spare.id);
    const back = courierAccountSchema.parse(
      (
        await send('POST', `/storefront/couriers/${spare.id}/restore`, {
          version: archivedAgain.version,
        })
      ).json(),
    );
    const [archive, setDefault] = await inTurn('courier_accounts', [
      () => send('POST', `/storefront/couriers/${spare.id}/archive`, { version: back.version }),
      () => send('PUT', '/storefront/couriers', { accountId: spare.id }),
    ]);
    expect(archive?.statusCode).toBe(200);
    expect(setDefault?.statusCode).toBe(422);
    expect(await defaultOf()).toBeNull();

    // None, then the first account again for the tests after this one
    await send('PUT', '/storefront/couriers', { accountId: steadfast.id });
    const none = await send('PUT', '/storefront/couriers', { accountId: '' });
    expect(courierSetupSchema.parse(none.json()).defaultAccountId).toBeNull();
    await send('PUT', '/storefront/couriers', { accountId: steadfast.id });
    expect(await defaultOf()).toBe(steadfast.id);
  });

  it('renews the webhook token: the old one stops at once', async () => {
    const body = { notification_type: 'delivery_status', invoice: 'W-999999', status: 'pending' };
    expect((await webhook(steadfast.id, steadfastToken, body)).statusCode).toBe(200);
    const res = await send('POST', `/storefront/couriers/${steadfast.id}/webhook-token`, {
      version: steadfast.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const renewed = courierAccountSavedSchema.parse(res.json());
    expect(renewed.webhookToken).toMatch(/^[\w-]{22}$/);
    expect(renewed.account.version).toBe(steadfast.version + 1);
    const old = await webhook(steadfast.id, steadfastToken, body);
    expect(old.statusCode).toBe(401);
    expect(old.json()).toMatchObject({ code: 'courier_webhook_token_invalid' });
    steadfastToken = renewed.webhookToken ?? '';
    steadfast = renewed.account;
    expect((await webhook(steadfast.id, steadfastToken, body)).statusCode).toBe(200);
    // A manual account has no webhook
    const byHand = await send('POST', `/storefront/couriers/${manual.id}/webhook-token`, {
      version: manual.version,
    });
    expect(byHand.statusCode).toBe(422);
  });

  it("needs CREDENTIALS_KEY for an API account's keys, never for a manual one", async () => {
    const keyless = await createTestApp({
      ...config,
      payments: { ...config.payments, credentialsKey: null },
      shipping: { ...config.shipping, credentialsKey: null },
    });
    try {
      const as = (method: 'POST' | 'PUT', url: string, payload: object) =>
        keyless.inject({ method, url, headers: bearer(owner.accessToken), payload });
      const [before] = await sql`SELECT count(*)::int AS n FROM courier_accounts`;
      const added = await as('POST', '/storefront/couriers', {
        provider: 'steadfast',
        ...NO_COD,
        name: 'Steadfast Sylhet',
        apiKey: 'k3',
        secretKey: 's3',
      });
      expect(added.statusCode).toBe(422);
      expect(added.json()).toMatchObject({ code: 'courier_key_missing' });
      const [after] = await sql`SELECT count(*)::int AS n FROM courier_accounts`;
      expect(after?.n).toBe(before?.n);
      const byHand = await as('POST', '/storefront/couriers', {
        provider: 'manual',
        ...NO_COD,
        name: 'eCourier by hand',
        courier: 'ecourier',
      });
      expect(byHand.statusCode, byHand.body).toBe(201);

      // A new key needs it; a name change with both boxes empty does not
      const current = await accountOf(steadfast.id);
      const typed = await as('PUT', `/storefront/couriers/${steadfast.id}`, {
        provider: 'steadfast',
        ...NO_COD,
        name: 'Steadfast',
        apiKey: 'k4',
        secretKey: '',
        version: current.version,
      });
      expect(typed.json()).toMatchObject({ code: 'courier_key_missing' });
      const named = await as('PUT', `/storefront/couriers/${steadfast.id}`, {
        provider: 'steadfast',
        ...NO_COD,
        name: 'Steadfast',
        apiKey: '',
        secretKey: '',
        version: current.version,
      });
      expect(named.statusCode, named.body).toBe(200);
      steadfast = courierAccountSchema.parse(named.json());
      // The keys cannot be opened, so they cannot reach the courier: refused
      const tested = await as('POST', `/storefront/couriers/${steadfast.id}/test`, {});
      expect(courierAccountSchema.parse(tested.json()).lastTest?.problem).toBe('rejected');
      expect(await keysOf(steadfast.id)).toEqual({ apiKey: API_KEY, secretKey: SECRET_KEY });
    } finally {
      await keyless.close();
    }
  });

  it('gives the accounts to storefront.manage only, and their names to the packer', async () => {
    const packer = await member('rafiq@nirvor.com', 'Rafiq Islam', [
      'storefront.order.read',
      'storefront.order.manage',
    ]);
    for (const [method, url, body] of [
      ['GET', '/storefront/couriers', undefined],
      [
        'POST',
        '/storefront/couriers',
        { ...NO_COD, provider: 'manual', name: 'RedX', courier: 'redx' },
      ],
      ['PUT', '/storefront/couriers', { accountId: '' }],
      ['POST', `/storefront/couriers/${steadfast.id}/test`, undefined],
    ] as const) {
      expect((await send(method, url, body, packer)).statusCode).toBe(403);
    }
    // 28a.6: the packer still gets what the Packed dialog and Book courier offer: the active
    // accounts by name and the default, the same as the page's read, never a webhook address
    const page = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
    const choices = await send('GET', '/storefront/orders/courier-choices', undefined, packer);
    expect(choices.statusCode, choices.body).toBe(200);
    const read = courierChoicesSchema.parse(choices.json());
    // By id on both sides: the API sorts by name in the database's collation, which is not JS's
    const byId = <T extends { id: string }>(rows: T[]) =>
      [...rows].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(read.accounts)).toEqual(
      byId(
        page.accounts
          .filter((account) => account.status === 'active')
          .map(({ id, provider, name, courier }) => ({ id, provider, name, courier })),
      ),
    );
    expect(read.accounts.length).toBeGreaterThan(0);
    expect(read.defaultAccountId).toBe(page.defaultAccountId);
    expect(choices.body).not.toContain('webhook');
  });
});

describe('booking a parcel', () => {
  it('books at Packed in the worker, with the order number as its invoice', async () => {
    const book = vi.spyOn(courier, 'book');
    const order = await confirm(900);
    const before = await getOrder(order.id);
    expect(before.codAmount).toBe('538.0000');
    expect(before.shipments).toEqual([]);
    // A manual account cannot book at Packed: nothing would call it
    const byHand = await pack(order.id, manual.id);
    expect(byHand.statusCode).toBe(422);
    expect(byHand.json()).toMatchObject({
      fieldErrors: { courierAccountId: ['courier_account_not_bookable'] },
    });

    const answer = await packed(order.id, steadfast.id);
    expect(answer.shipments).toMatchObject([
      { status: 'booking', codAmount: '538.0000', attempts: 0, events: [] },
    ]);
    const booked = await parcelIs(order.id, 'booked');
    const parcel = lastParcel(booked);
    expect(parcel).toMatchObject({
      account: { id: steadfast.id, name: 'Steadfast', provider: 'steadfast' },
      courier: 'steadfast',
      attempts: 1,
      error: null,
    });
    expect(parcel.trackingCode).toMatch(/^FAKE[0-9A-F]{10}$/);
    expect(parcel.consignmentId).toMatch(/^\d+$/);
    expect(parcel.bookedAt).not.toBeNull();
    expect(parcel.events.map((event) => event.status)).toEqual(['booked']);
    expect((await eventRows(parcel.id)).map((row) => row.source)).toEqual(['booking']);
    // What the courier was told: our number, the zone in the address, two decimals, no product
    expect(book).toHaveBeenCalledTimes(1);
    expect(book.mock.calls[0]?.[1]).toEqual({
      invoice: order.orderNo,
      name: 'Nusrat Jahan',
      phone: order.phone,
      address: 'House 12, Road 5, Mirpur 10, Dhaka, Inside Dhaka',
      codAmount: '538.00',
      note: '2 items',
    });
    const [row] = await sql`SELECT invoice FROM storefront_shipments WHERE id = ${parcel.id}`;
    expect(row?.invoice).toBe(order.orderNo);
    // One parcel on its way at a time
    const second = await bookCourier(booked, steadfast.id);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'storefront_order_has_parcel' });
    // Packed's audit row names the account
    const [audit] = await sql`SELECT payload::text AS text FROM audit_logs
      WHERE entity_id = ${order.id} AND action = 'storefront_order.shipment_booked'`;
    expect(audit?.text).toContain('Steadfast');
  });

  it('waits for a booking before it cancels, then cancels the booked parcel with its order', async () => {
    const fake = new FakeCourier();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(courier, 'book').mockImplementationOnce(async (keys, request) => {
      await held;
      return fake.book(keys, request);
    });
    const order = await confirm(901);
    try {
      await packed(order.id, steadfast.id);
      // The worker has the parcel: its try is counted, and the courier has not answered
      await eventually(async () => {
        const [row] =
          await sql`SELECT attempts FROM storefront_shipments WHERE order_id = ${order.id}`;
        expect(row?.attempts).toBe(1);
      });
      const booking = await getOrder(order.id);
      const refused = await move(booking, 'cancel');
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'storefront_order_parcel_booking' });
      // The tracking page shows no parcel before the courier has it
      expect(await trackingOf(order)).toEqual([]);
    } finally {
      release();
    }
    const booked = await parcelIs(order.id, 'booked');
    const cancelled = await move(booked, 'cancel');
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const after = storefrontOrderSchema.parse(cancelled.json());
    expect(after.status).toBe('cancelled');
    expect(lastParcel(after).status).toBe('cancelled');
    expect(lastParcel(after).events.map((event) => event.status)).toEqual(['booked', 'cancelled']);
    expect((await eventRows(lastParcel(after).id)).map((row) => row.source)).toEqual([
      'booking',
      'member',
    ]);
  });

  it('asks by the invoice after a lost answer, so the courier never gets two parcels', async () => {
    const book = vi.spyOn(courier, 'book').mockResolvedValueOnce({
      kind: 'problem',
      problem: 'unreachable',
    });
    const find = vi.spyOn(courier, 'find').mockResolvedValueOnce({
      kind: 'found',
      parcel: {
        consignmentId: '880001',
        trackingCode: 'SFLOST0001',
        trackingUrl: 'https://steadfast.com.bd/t/SFLOST0001',
        status: 'booked',
      },
    });
    const order = await confirm(902);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    expect(parcel).toMatchObject({
      consignmentId: '880001',
      trackingCode: 'SFLOST0001',
      attempts: 2,
      error: null,
    });
    expect(book).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0]?.[1]).toBe(order.orderNo);
    // The courier's own page, for the tracking page's link
    expect((await trackingOf(order))[0]?.trackingUrl).toBe('https://steadfast.com.bd/t/SFLOST0001');
  });

  it('asks by the invoice when the courier says it has one, and fails a parcel it cannot match', async () => {
    // "taken": an earlier call got through. Found by the invoice, it is the booking
    vi.spyOn(courier, 'book').mockResolvedValueOnce({ kind: 'taken' });
    vi.spyOn(courier, 'find').mockResolvedValueOnce({
      kind: 'found',
      parcel: {
        consignmentId: '880002',
        trackingCode: 'SFTAKEN002',
        trackingUrl: null,
        status: 'booked',
      },
    });
    const taken = await confirm(903);
    await packed(taken.id, steadfast.id);
    expect(lastParcel(await parcelIs(taken.id, 'booked'))).toMatchObject({
      trackingCode: 'SFTAKEN002',
      attempts: 1,
    });

    // "exists": the courier has the invoice, but its answer has no code. Never booked twice
    vi.spyOn(courier, 'book').mockResolvedValueOnce({ kind: 'problem', problem: 'unreachable' });
    vi.spyOn(courier, 'find').mockResolvedValueOnce({ kind: 'exists' });
    const order = await confirm(904);
    await packed(order.id, steadfast.id);
    const failed = await parcelIs(order.id, 'booking_failed');
    expect(lastParcel(failed)).toMatchObject({ error: 'courier_invoice_taken', attempts: 2 });
    expect(failed.needsAttention).toBe(true);
  });

  it('fails a parcel the courier refused at once, with its words, and rings the bell', async () => {
    const book = vi.spyOn(courier, 'book');
    const order = await confirm(905, FAKE_REFUSED_PHONE);
    await packed(order.id, steadfast.id);
    const failed = await parcelIs(order.id, 'booking_failed');
    expect(lastParcel(failed)).toMatchObject({
      error: 'courier_rejected_parcel',
      errorDetail: 'The recipient phone must be a working mobile number.',
      attempts: 1,
      trackingCode: null,
    });
    // Asking again would get the same answer: one call
    expect(book).toHaveBeenCalledTimes(1);
    const bells = await eventually(async () => {
      const found = await bellsFor(order.id);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(bells[0]?.params).toEqual({ id: order.id, number: order.orderNo, courier: 'Steadfast' });
    // The tracking page has no parcel to show
    expect(await trackingOf(order)).toEqual([]);
  });

  it('tries an unreachable courier again, then fails the parcel; Book again books the same row', async () => {
    vi.spyOn(courier, 'book').mockResolvedValue({ kind: 'problem', problem: 'unreachable' });
    const order = await confirm(906);
    await packed(order.id, steadfast.id);
    const failed = await parcelIs(order.id, 'booking_failed');
    const parcel = lastParcel(failed);
    expect(parcel).toMatchObject({ error: 'courier_unreachable', attempts: 2 });
    expect(failed.needsAttention).toBe(true);
    const list = storefrontOrderPageSchema.parse(
      (await send('GET', '/storefront/orders?view=packed')).json(),
    );
    expect(list.items.find((item) => item.id === order.id)?.needsAttention).toBe(true);
    // Everyone who may book again: the owner, and Rafiq, the packer of the permissions test
    await eventually(async () => {
      expect(await bellsFor(order.id)).toHaveLength(2);
    });
    const [people] = await sql`SELECT array_agg(u.email ORDER BY u.email) AS emails
      FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.type = 'storefront.shipment_failed' AND n.params->>'id' = ${order.id}`;
    expect(people?.emails).toEqual(['nusrat@nirvor.com', 'rafiq@nirvor.com']);

    vi.restoreAllMocks();
    const again = await retry(failed, parcel.id);
    expect(again.statusCode, again.body).toBe(200);
    // Booking again, with the last reason still on it for the page
    expect(lastParcel(storefrontOrderSchema.parse(again.json()))).toMatchObject({
      id: parcel.id,
      status: 'booking',
      error: 'courier_unreachable',
    });
    const booked = await parcelIs(order.id, 'booked');
    expect(booked.shipments).toHaveLength(1);
    expect(lastParcel(booked)).toMatchObject({ id: parcel.id, attempts: 3, error: null });
    expect(booked.needsAttention).toBe(false);
    const [row] = await sql`SELECT invoice FROM storefront_shipments WHERE id = ${parcel.id}`;
    expect(row?.invoice).toBe(order.orderNo);
    const notFailed = await retry(booked, parcel.id);
    expect(notFailed.statusCode).toBe(409);
    expect(notFailed.json()).toMatchObject({ code: 'storefront_shipment_not_failed' });
  });

  it("fails a parcel whose keys this server can't open, without calling the courier", async () => {
    const book = vi.spyOn(courier, 'book');
    const sylhet = (
      await addAccount({
        provider: 'steadfast',
        ...NO_COD,
        name: 'Steadfast Sylhet',
        apiKey: 'k5',
        secretKey: 's5',
      })
    ).account;
    // This server's key is version 1
    await sql`UPDATE courier_accounts SET key_version = 2 WHERE id = ${sylhet.id}`;
    try {
      const order = await confirm(907);
      await packed(order.id, sylhet.id);
      const failed = await parcelIs(order.id, 'booking_failed');
      expect(lastParcel(failed)).toMatchObject({ error: 'courier_key_missing', attempts: 1 });
      expect(book).not.toHaveBeenCalled();
    } finally {
      await sql`UPDATE courier_accounts SET key_version = 1 WHERE id = ${sylhet.id}`;
    }
  });

  it('books a second parcel after a failure, and keeps Book again for the last one', async () => {
    const old = (
      await addAccount({
        provider: 'steadfast',
        ...NO_COD,
        name: 'Steadfast old keys',
        apiKey: 'fake_rejected',
        secretKey: 's6',
      })
    ).account;
    const order = await confirm(908);
    await packed(order.id, old.id);
    const failed = await parcelIs(order.id, 'booking_failed');
    const first = lastParcel(failed);
    expect(first).toMatchObject({ error: 'courier_rejected_keys', attempts: 1 });

    // An archived account books nothing, again or new
    await send('POST', `/storefront/couriers/${old.id}/archive`, { version: old.version });
    const archivedRetry = await retry(failed, first.id);
    expect(archivedRetry.statusCode).toBe(409);
    expect(archivedRetry.json()).toMatchObject({ code: 'courier_account_archived' });
    expect((await bookCourier(failed, old.id)).json()).toMatchObject({
      code: 'courier_account_archived',
    });

    // By hand: the code from the courier's panel is required, and kept in capitals
    const noCode = await bookCourier(failed, manual.id);
    expect(noCode.statusCode).toBe(422);
    expect(noCode.json()).toMatchObject({
      fieldErrors: { trackingCode: ['courier_tracking_code_required'] },
    });
    const res = await bookCourier(failed, manual.id, 'pf-2611-0042');
    expect(res.statusCode, res.body).toBe(200);
    const two = storefrontOrderSchema.parse(res.json());
    expect(two.shipments.map((parcel) => parcel.status)).toEqual(['booking_failed', 'booked']);
    const second = lastParcel(two);
    expect(second).toMatchObject({
      courier: 'paperfly',
      trackingCode: 'PF-2611-0042',
      attempts: 0,
    });
    expect(two.needsAttention).toBe(false);
    const [row] = await sql`SELECT invoice FROM storefront_shipments WHERE id = ${second.id}`;
    expect(row?.invoice).toBe(`${order.orderNo}-2`);
    // The first parcel is not the last one any more
    const oldRetry = await retry(two, first.id);
    expect(oldRetry.statusCode).toBe(409);
    expect(oldRetry.json()).toMatchObject({ code: 'storefront_order_has_parcel' });

    // A manual parcel follows the buttons
    const shipped = storefrontOrderSchema.parse((await move(two, 'ship')).json());
    expect(lastParcel(shipped).status).toBe('picked_up');
    const delivered = await move(shipped, 'deliver');
    expect(delivered.statusCode, delivered.body).toBe(200);
    const done = storefrontOrderSchema.parse(delivered.json());
    expect(lastParcel(done).events.map((event) => event.status)).toEqual([
      'booked',
      'picked_up',
      'delivered',
    ]);
    // The tracking page shows the parcel that went, never the one that failed
    const tracking = await trackingOf(order);
    expect(tracking).toHaveLength(1);
    expect(tracking[0]).toMatchObject({ courier: 'paperfly', trackingCode: 'PF-2611-0042' });
  });

  it('keeps an API parcel where its courier put it when a member marks the order shipped', async () => {
    const order = await confirm(909);
    await packed(order.id, steadfast.id);
    const booked = await parcelIs(order.id, 'booked');
    const shipped = storefrontOrderSchema.parse((await move(booked, 'ship')).json());
    expect(shipped.status).toBe('shipped');
    expect(lastParcel(shipped).status).toBe('booked');
    // The courier's news still comes; the order is shipped already, so no second SMS of it
    await notice(
      statusNotice(
        lastParcel(shipped).consignmentId ?? '',
        'pending',
        'Picked up',
        steadfastAt(new Date()),
      ),
    );
    expect(lastParcel(await getOrder(order.id)).status).toBe('in_transit');
    expect((await smsTo(order.phone)).filter((text) => text.includes(ON_ITS_WAY))).toEqual([]);
  });

  it('refuses a parcel for an order that is not packed', async () => {
    const order = await confirm(910);
    const res = await bookCourier(await getOrder(order.id), steadfast.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'storefront_order_not_bookable' });
  });

  it('exports the packed orders with no parcel on its way, with the next parcel’s invoice', async () => {
    const none = await confirm(911);
    const noParcel = await packed(none.id, '');
    expect(noParcel.shipments).toEqual([]);
    const res = await send('GET', '/storefront/orders/courier-export');
    expect(res.statusCode, res.body).toBe(200);
    const exported = courierExportSchema.parse(res.json());
    expect(exported.more).toBe(false);
    expect(exported.rows.find((row) => row.orderId === none.id)).toEqual({
      orderId: none.id,
      invoice: none.orderNo,
      name: 'Nusrat Jahan',
      address: 'House 12, Road 5, Mirpur 10, Dhaka',
      phone: none.phone,
      amount: '538.0000',
      itemCount: 2,
    });
    // The refused parcel's order (905) goes again as its second parcel; a booked one not at all
    const [refused] = await sql`SELECT id::text, order_no FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${FAKE_REFUSED_PHONE}`;
    expect(exported.rows.find((row) => row.orderId === refused?.id)?.invoice).toBe(
      `${String(refused?.order_no)}-2`,
    );
    const [booked] = await sql`SELECT order_id::text AS id FROM storefront_shipments
      WHERE tenant_id = ${shop.tenantId} AND status = 'booked' LIMIT 1`;
    expect(exported.rows.map((row) => row.orderId)).not.toContain(booked?.id);
    // The packer's permission, not a reader's
    const reader = await member('sumi@nirvor.com', 'Sumi Akter', ['storefront.order.read']);
    expect(
      (await send('GET', '/storefront/orders/courier-export', undefined, reader)).statusCode,
    ).toBe(403);
  });
});

describe("the courier's news", () => {
  it('answers 401 for every wrong token or account, and 200 for a parcel it does not know', async () => {
    const body = { notification_type: 'delivery_status', invoice: 'W-999998', status: 'pending' };
    for (const [id, token] of [
      [steadfast.id, null],
      [steadfast.id, 'wrongwrongwrongwrongwr'],
      [steadfast.id, `${steadfastToken} extra`],
      // Another account's id with this one's token, a manual account, and no account at all
      [manual.id, steadfastToken],
      ['0198c0de-0000-7000-8000-000000000000', steadfastToken],
    ] as const) {
      const res = await webhook(id, token, body);
      expect(res.statusCode, `${id} ${String(token)}`).toBe(401);
      expect(res.json()).toMatchObject({ code: 'courier_webhook_token_invalid' });
    }
    const [before] = await sql`SELECT count(*)::int AS n FROM storefront_shipment_events`;
    await sql`UPDATE courier_accounts SET last_webhook_at = NULL WHERE id = ${steadfast.id}`;
    await notice(body);
    const [after] = await sql`SELECT count(*)::int AS n FROM storefront_shipment_events`;
    expect(after?.n).toBe(before?.n);
    // The page shows when the courier last called
    expect((await accountRow(steadfast.id)).last_webhook_at).not.toBeNull();
    expect((await accountOf(steadfast.id)).lastWebhookAt).not.toBeNull();
  });

  it('moves the order to Shipped and Delivered, one step per notice, and sends one SMS', async () => {
    const order = await confirm(920);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    const id = parcel.consignmentId ?? '';
    await nextSecond();
    const now = steadfastAt(new Date());
    const pickedUp = statusNotice(id, 'pending', 'Picked up from Nirvor', now);
    await notice(pickedUp);
    const shipped = await getOrder(order.id);
    expect(shipped.status).toBe('shipped');
    expect(lastParcel(shipped).status).toBe('in_transit');
    await eventually(async () => {
      expect((await smsTo(order.phone)).filter((text) => text.includes(ON_ITS_WAY))).toHaveLength(
        1,
      );
    });
    // The same notice again is the same step
    await notice(pickedUp);
    // Words with no status, by our invoice instead of the courier's id
    await notice({
      notification_type: 'tracking_update',
      invoice: order.orderNo,
      tracking_message: 'Received at Sylhet hub',
      updated_at: now,
    });
    // A status the adapter does not know, and a body far too large: kept, never refused
    await notice({
      notification_type: 'delivery_status',
      consignment_id: Number(id),
      status: 'teleported',
    });
    await notice({
      notification_type: 'delivery_status',
      consignment_id: Number(id),
      status: 'pending',
      tracking_message: 'x'.repeat(9000),
      updated_at: now,
    });
    await notice(statusNotice(id, 'delivered', 'Delivered to Nusrat', now));
    const done = await getOrder(order.id);
    expect(done.status).toBe('delivered');
    const invoice = invoiceSchema.parse(
      (await send('GET', `/invoices/${done.invoice?.id ?? ''}`)).json(),
    );
    expect(invoice.status).toBe('posted');
    // A late notice from before, by the courier's clock: kept, and the parcel stays delivered.
    // Its time is before the booking, so it counts as the booking's moment
    const yesterday = steadfastAt(new Date(Date.now() - 24 * 60 * 60 * 1000));
    await notice(statusNotice(id, 'pending', 'At Mirpur hub', yesterday));
    const last = await getOrder(order.id);
    expect(lastParcel(last).status).toBe('delivered');
    const steps = lastParcel(last).events.map((event) => [event.status, event.note]);
    expect(steps[0]).toEqual(['booked', null]);
    expect(steps.slice(-3)).toEqual([
      ['in_transit', 'Received at Sylhet hub'],
      ['in_transit', 'x'.repeat(300)],
      ['delivered', 'Delivered to Nusrat'],
    ]);
    expect(steps.filter(([, note]) => note === 'Picked up from Nirvor')).toHaveLength(1);
    expect(steps).toContainEqual(['in_transit', 'At Mirpur hub']);
    // The unread one is a row with no status, its body kept
    const unread = (await eventRows(parcel.id)).filter((row) => row.status === null);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.raw).toMatchObject({ status: 'teleported' });
    // Only one SMS for the whole trip
    expect((await smsTo(order.phone)).filter((text) => text.includes(ON_ITS_WAY))).toHaveLength(1);
    // The tracking page has the same steps, and not the unread one
    const tracking = await trackingOf(order);
    expect(tracking[0]?.events.map((event) => event.note)).toEqual(steps.map(([, note]) => note));
  });

  // 28a.6 (0079): two steps of one courier second, inserted in the opposite order to when they
  // arrived, so only the tie-break by received_at puts them right (Postgres would return them in
  // the order they were written). Inserted by hand: the API always writes in arrival order. The id
  // is made here because the app makes the ids, so the column has no default
  it('shows steps of one courier second in the order they arrived, on the tracking page too', async () => {
    const order = await confirm(925);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    const at = new Date(Date.now() + 60_000);
    const step = (note: string, arrived: number) => sql`
      INSERT INTO storefront_shipment_events
        (id, tenant_id, shipment_id, status, note, occurred_at, received_at, source, event_key)
      SELECT gen_random_uuid(), tenant_id, id, 'in_transit', ${note}, ${at}, ${new Date(at.getTime() + arrived)},
             'webhook', encode(sha256(convert_to(${note}, 'UTF8')), 'hex')
        FROM storefront_shipments WHERE id = ${parcel.id}`;
    await step('Left Tejgaon hub', 2_000);
    await step('Reached Tejgaon hub', 1_000);
    const notes = (events: readonly { note: string | null }[]) =>
      events.map((event) => event.note).slice(-2);
    const expected = ['Reached Tejgaon hub', 'Left Tejgaon hub'];
    expect(notes(lastParcel(await getOrder(order.id)).events)).toEqual(expected);
    expect(notes((await trackingOf(order))[0]?.events ?? [])).toEqual(expected);
  });

  it('keeps a body too large for its column as a marker', async () => {
    const order = await confirm(921);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    await notice({
      notification_type: 'mystery',
      consignment_id: Number(parcel.consignmentId),
      extra: 'y'.repeat(9000),
    });
    const unread = (await eventRows(parcel.id)).filter((row) => row.status === null);
    expect(unread.map((row) => row.raw)).toEqual([{ tooLarge: true }]);
    expect(lastParcel(await getOrder(order.id)).status).toBe('booked');
  });

  it('keeps the news when the invoice is refused, and leaves the order Shipped', async () => {
    const order = await confirm(922);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    // The books are closed up to today in Dhaka: no invoice can be posted
    await sql`INSERT INTO period_locks (tenant_id, lock_date)
      VALUES (${shop.tenantId}, (now() AT TIME ZONE 'Asia/Dhaka')::date)
      ON CONFLICT (tenant_id) DO UPDATE SET lock_date = EXCLUDED.lock_date`;
    try {
      await notice(
        statusNotice(parcel.consignmentId ?? '', 'delivered', 'Delivered', steadfastAt(new Date())),
      );
      const shipped = await getOrder(order.id);
      expect(shipped.status).toBe('shipped');
      expect(shipped.invoice).toBeNull();
      expect(lastParcel(shipped).status).toBe('delivered');
      // Mark delivered shows the reason to the member
      const refused = await move(shipped, 'deliver');
      expect(refused.json()).toMatchObject({ code: 'journal_period_locked' });
    } finally {
      await sql`UPDATE period_locks SET lock_date = NULL WHERE tenant_id = ${shop.tenantId}`;
    }
    const delivered = await move(await getOrder(order.id), 'deliver');
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect(storefrontOrderSchema.parse(delivered.json()).invoice).not.toBeNull();
  });

  it('cancels a parcel the courier cancelled before pickup, and brings one back after it', async () => {
    const before = await confirm(923);
    await packed(before.id, steadfast.id);
    const first = lastParcel(await parcelIs(before.id, 'booked'));
    const now = steadfastAt(new Date());
    await notice(
      statusNotice(first.consignmentId ?? '', 'cancelled', 'Cancelled by merchant', now),
    );
    const cancelled = await getOrder(before.id);
    expect(cancelled.status).toBe('packed');
    expect(lastParcel(cancelled).status).toBe('cancelled');
    // Nothing on its way: it can go again, as its second parcel
    const again = await bookCourier(cancelled, steadfast.id);
    expect(again.statusCode, again.body).toBe(200);
    expect((await parcelIs(before.id, 'booked')).shipments).toHaveLength(2);

    const after = await confirm(924);
    await packed(after.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(after.id, 'booked'));
    await notice(statusNotice(parcel.consignmentId ?? '', 'pending', 'Picked up', now));
    await notice(statusNotice(parcel.consignmentId ?? '', 'cancelled', 'Refused at the door', now));
    const back = await getOrder(after.id);
    expect(back.status).toBe('shipped');
    expect(lastParcel(back).status).toBe('returning');
    // Once the courier has it, the order cannot be cancelled
    expect((await move(back, 'cancel')).statusCode).toBe(409);
  });
});

describe('the poll', () => {
  it('asks about each parcel on its way, and writes a step only when the status changed', async () => {
    const order = await confirm(930);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    const status = vi
      .spyOn(courier, 'status')
      .mockImplementation((_keys, consignmentId) =>
        Promise.resolve(
          consignmentId === parcel.consignmentId
            ? { kind: 'status', status: 'in_transit', word: 'pending' }
            : { kind: 'problem', problem: 'unreachable' },
        ),
      );
    const poll = worker.get(ShipmentPoll);
    expect(await poll.run()).toBeGreaterThan(0);
    const shipped = await getOrder(order.id);
    expect(shipped.status).toBe('shipped');
    expect(lastParcel(shipped).events.map((event) => event.status)).toEqual([
      'booked',
      'in_transit',
    ]);
    expect((await eventRows(parcel.id)).map((row) => row.source)).toEqual(['booking', 'poll']);
    await eventually(async () => {
      expect((await smsTo(order.phone)).filter((text) => text.includes(ON_ITS_WAY))).toHaveLength(
        1,
      );
    });
    const synced = lastParcel(shipped).lastSyncedAt ?? '';

    // The same status again is no news: no step, only the time it was asked
    await poll.run();
    const again = lastParcel(await getOrder(order.id));
    expect(again.events).toHaveLength(2);
    expect(Date.parse(again.lastSyncedAt ?? '')).toBeGreaterThan(Date.parse(synced));
    // A word the adapter does not know is no step either
    status.mockImplementation(() =>
      Promise.resolve({ kind: 'status', status: null, word: 'teleported' }),
    );
    await poll.run();
    expect(lastParcel(await getOrder(order.id)).events).toHaveLength(2);
    // Only parcels with the courier's id: never a manual one, never one still booking
    const asked = new Set(status.mock.calls.map((call) => call[1]));
    const [manualIds] = await sql`SELECT count(*)::int AS n FROM storefront_shipments s
      JOIN courier_accounts a ON a.id = s.courier_account_id
      WHERE a.provider = 'manual' AND s.consignment_id = ANY(${[...asked]})`;
    expect(manualIds?.n).toBe(0);
    // Delivered and cancelled parcels are not on their way any more
    const [settled] = await sql`SELECT count(*)::int AS n FROM storefront_shipments
      WHERE status IN ('delivered', 'cancelled', 'booking_failed') AND consignment_id = ANY(${[...asked]})`;
    expect(settled?.n).toBe(0);
  });

  it("skips a parcel whose account's keys this server can't open", async () => {
    const order = await confirm(931);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    const status = vi.spyOn(courier, 'status');
    await sql`UPDATE courier_accounts SET key_version = 2 WHERE id = ${steadfast.id}`;
    try {
      await worker.get(ShipmentPoll).run();
      expect(status.mock.calls.map((call) => call[1])).not.toContain(parcel.consignmentId);
    } finally {
      await sql`UPDATE courier_accounts SET key_version = 1 WHERE id = ${steadfast.id}`;
    }
    await worker.get(ShipmentPoll).run();
    expect(status.mock.calls.map((call) => call[1])).toContain(parcel.consignmentId);
  });
});
