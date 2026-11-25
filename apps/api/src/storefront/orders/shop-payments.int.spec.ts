import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  accountListSchema,
  accountSchema,
  type CreateStorefrontPaymentGatewayInput,
  fakeValId,
  memberPageSchema,
  type PermissionKey,
  problemSchema,
  publicOrderPlacedSchema,
  roleSchema,
  type ShopPaymentMethod,
  type ShopPaymentWait,
  shopCheckoutSettingsSchema,
  shopCodeWaitSchema,
  shopPaymentRetrySchema,
  shopPaymentSettledSchema,
  shopPaymentWaitSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
  storefrontPackPlanSchema,
  storefrontPaymentGatewaySchema,
  storefrontPaymentSetupSchema,
  storefrontSetupSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Config } from '../../config.js';
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
  deliveryServiceUpdate,
  type OrderShop,
  orderRequest,
  orderShop,
  phoneOf,
  shopHeaders,
  shopPost,
  smsAddress,
  trackingTokenFor,
} from '../../testing/shop-orders.js';
import { joinWithoutRoles } from '../../testing/workspace.js';
import { PendingOrderSweep } from './pending-order-sweep.js';

// Step 27d: paying online against the real stack, on the fake gateway (PAYMENT_GATEWAY's default
// outside production, 27d.3). First the ERP's Payment card and the shop settings' "Pay online";
// then the shop's side as a shopper goes through it: the order placed, the gateway's page, its
// answer posted back (once, or twice at the same moment), /checkout/paid with "Try again" and "Pay
// on delivery", the money receipt with the gateway's fee, the invoice that takes it at Delivered,
// and the sweep that asks the gateway before it deletes an unpaid order. The fake gateway's val_id
// says what happened (fakeValId), so a test decides what the gateway answers. Every test has its
// own phones and shopper addresses: the limits count them across the file.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let config: Config;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
// storefront.order.read only: may read the orders, and nothing of the Payment card
let reader: SignedIn;
let shop: OrderShop;
// The zone the orders name. The shop settings' save gives the launch's zone a new id (27b's
// deliveryServiceUpdate says why), so it is read again after that save
let zoneId = 'inside_dhaka';
// The Payment card's two accounts: Cash in hand, and an expense account of the test's own for the
// gateway's fee
let cash: { id: string; code: string };
let feeAccount: { id: string; code: string };
// What the Payment card is saved with. The space at the end is part of the password: a password
// is never trimmed (27d.1)
const STORE_ID = 'nirvor67412bc';
const PASSWORD = 'Bkash-store-2026 ';

const refusalSchema = problemSchema.pick({ code: true, fieldErrors: true });

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  who = owner,
) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

// A request that must be refused with this status; its problem's code and field errors
async function refused(res: Promise<{ statusCode: number; body: string }>, status: number) {
  const answer = await res;
  expect(answer.statusCode, answer.body).toBe(status);
  return refusalSchema.parse(JSON.parse(answer.body));
}

// The Payment card's form, as the page sends it
function gatewayForm(extra: Partial<CreateStorefrontPaymentGatewayInput> = {}) {
  return {
    storeId: STORE_ID,
    password: PASSWORD,
    mode: 'sandbox',
    moneyAccountId: cash.id,
    feeAccountId: feeAccount.id,
    ...extra,
  } satisfies CreateStorefrontPaymentGatewayInput;
}

async function gateway() {
  const res = await send('GET', '/storefront/payment-gateway');
  expect(res.statusCode, res.body).toBe(200);
  const setup = storefrontPaymentSetupSchema.parse(res.json());
  if (setup.gateway === null) throw new Error('the gateway is not saved');
  return setup.gateway;
}

// The sealed password as the row keeps it, in hex: a test compares it before and after a save
async function sealedPassword(): Promise<string> {
  const [row] = z.array(z.object({ sealed: z.string(), version: z.number() })).parse(
    await sql`
        SELECT encode(password_sealed, 'hex') AS sealed, key_version AS version
        FROM storefront_payment_gateways WHERE tenant_id = ${shop.tenantId}`,
  );
  if (row === undefined) throw new Error('no gateway row');
  return row.sealed;
}

// The Payment card's audit rows, oldest first, as JSON text: a test looks for the password in it
async function gatewayAudit() {
  return z.array(z.object({ action: z.string(), text: z.string() })).parse(
    await sql`
      SELECT action, payload::text AS text FROM audit_logs
      WHERE tenant_id = ${shop.tenantId} AND entity_type = 'storefront_payment_gateway'
      ORDER BY created_at, id`,
  );
}

async function checkoutMethods(): Promise<ShopPaymentMethod[]> {
  const res = await app.inject({
    method: 'GET',
    url: '/public/v1/checkout-settings',
    headers: { 'x-shop-host': shop.host },
  });
  expect(res.statusCode, res.body).toBe(200);
  return shopCheckoutSettingsSchema.parse(res.json()).paymentMethods;
}

// The shop's settings form as it is saved, with these payment methods ticked. The delivery
// charge's service stays as it is: once an order used one, it can't be emptied (27b)
async function saveMethods(methods: ShopPaymentMethod[]) {
  const setup = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
  if (setup.shop === null) throw new Error('the shop is not set up');
  return send('PUT', '/storefront/settings', {
    ...deliveryServiceUpdate(setup.shop, setup.shop.deliveryVariantId ?? ''),
    paymentMethods: methods,
  });
}

async function setArchived(account: { id: string }, archived: boolean): Promise<void> {
  const current = accountSchema.parse((await send('GET', `/accounts/${account.id}`)).json());
  const res = await send('POST', `/accounts/${account.id}/${archived ? 'archive' : 'restore'}`, {
    version: current.version,
  });
  expect(res.statusCode, res.body).toBe(200);
}

// The headers of shopper n, at Nirvor
function shopper(n: number): Record<string, string> {
  return shopHeaders(shop.host, clientAddress(n));
}

// Two face washes (৳229 each) and the ৳80 delivery charge
const TWO = '538';

interface OnlineOrder {
  n: number;
  phone: string;
  token: string;
  // The gateway's page, or null when it did not open
  paymentUrl: string | null;
}

// An online order of two face washes by shopper n, placed as the checkout places it
async function placeOnline(n: number): Promise<OnlineOrder> {
  const res = await shopPost(app, '/orders', shopper(n), {
    ...orderRequest(shop.listingId, 2, phoneOf(n), TWO),
    zoneId,
    paymentMethod: 'online',
  });
  expect(res.statusCode, res.body).toBe(201);
  const { answer, token } = publicOrderPlacedSchema.parse(res.json());
  if (answer.next !== 'pay') throw new Error(`the order answered ${answer.next}`);
  return { n, phone: phoneOf(n), token, paymentUrl: answer.paymentUrl };
}

// The try a payment page is for, read from the fake page's address (27d.3's FakeGateway)
function pageOf(paymentUrl: string | null): { tranId: string; amount: string } {
  if (paymentUrl === null) throw new Error('no payment page');
  const url = new URL(paymentUrl);
  return {
    tranId: url.searchParams.get('tranId') ?? '',
    amount: url.searchParams.get('amount') ?? '',
  };
}

// What the fake page posts back when the shopper pays: the val_id that says paid, this amount
function paidValId(page: { tranId: string; amount: string }): string {
  return fakeValId(page.tranId, { outcome: 'paid', amount: page.amount });
}

// The gateway's post (the browser's return or the IPN), as the shop's server passes it on
function settle(n: number, tranId: string, valId: string | null) {
  return shopPost(app, '/payments/settle', shopper(n), { tranId, valId });
}

async function settled(n: number, tranId: string, valId: string | null): Promise<string> {
  const res = await settle(n, tranId, valId);
  expect(res.statusCode, res.body).toBe(200);
  return shopPaymentSettledSchema.parse(res.json()).status;
}

// /checkout/paid's question
async function waitOf(order: OnlineOrder): Promise<ShopPaymentWait> {
  const res = await shopPost(app, '/orders/payment', shopper(order.n), { token: order.token });
  expect(res.statusCode, res.body).toBe(200);
  return shopPaymentWaitSchema.parse(res.json());
}

function retry(order: OnlineOrder) {
  return shopPost(app, '/orders/payment/retry', shopper(order.n), { token: order.token });
}

function payOnDelivery(order: OnlineOrder) {
  return shopPost(app, '/orders/payment/cod', shopper(order.n), { token: order.token });
}

const orderRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  payment_method: z.string(),
  order_no: z.string().nullable(),
  has_code: z.boolean(),
});

async function orderRowOf(phone: string) {
  const rows = z.array(orderRowSchema).parse(
    await sql`
      SELECT id::text, status, payment_method, order_no, code_hash IS NOT NULL AS has_code
      FROM storefront_orders WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}`,
  );
  return rows;
}

async function onlyOrderOf(phone: string) {
  const [row, ...more] = await orderRowOf(phone);
  if (row === undefined || more.length > 0) throw new Error(`not one order from ${phone}`);
  return row;
}

// The order's tries, oldest first
async function triesOf(phone: string) {
  return z.array(z.object({ try_no: z.number(), status: z.string(), tran_id: z.string() })).parse(
    await sql`
        SELECT p.try_no, p.status, p.tran_id FROM storefront_payments p
        JOIN storefront_orders o ON o.tenant_id = p.tenant_id AND o.id = p.order_id
        WHERE o.tenant_id = ${shop.tenantId} AND o.phone = ${phone}
        ORDER BY p.try_no`,
  );
}

// The order as if placed `minutes` ago
async function ageOrder(phone: string, minutes: number): Promise<void> {
  const by = `${String(minutes)} minutes`;
  await sql`
    UPDATE storefront_orders SET created_at = created_at - ${by}::interval
    WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}`;
}

// The order as the Shop orders page sees it, once `check` holds (the worker makes its sales order
// and its receipts a moment after the confirm)
async function erpOrder(
  phone: string,
  check: (order: StorefrontOrder) => void = () => undefined,
): Promise<StorefrontOrder> {
  const { id } = await onlyOrderOf(phone);
  return eventually(async () => {
    const res = await send('GET', `/storefront/orders/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    const order = storefrontOrderSchema.parse(res.json());
    check(order);
    return order;
  }, 10_000);
}

const mailboxSchema = z.object({
  messages: z.array(z.object({ To: z.array(z.object({ Address: z.string() })) })),
});

// How many SMS went to this phone (Mailpit lists 50 at a time by default)
async function smsCount(phone: string): Promise<number> {
  const res = await fetch(`${mail.apiUrl}/api/v1/messages?limit=1000`);
  const { messages } = mailboxSchema.parse(await res.json());
  return messages.filter((message) => message.To.some((to) => to.Address === smsAddress(phone)))
    .length;
}

// Sends requests "at the same moment" for sure, and in a known order (27c's storefront-coupons
// spec says how): a transaction of the test's own locks `table`, and the next request is sent only
// once the one before it waits
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
  const chart = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const cashInHand = chart.find((account) => account.code === '1110');
  // The fee goes under the expenses' first group that is not cost of goods sold
  const expenses = chart.find(
    (account) => account.type === 'expense' && account.isGroup && account.parentId !== null,
  );
  if (cashInHand === undefined || expenses === undefined) throw new Error('no 1110 or no group');
  cash = cashInHand;
  const made = await send('POST', '/accounts', {
    parentId: expenses.id,
    code: '5999',
    name: 'Online payment charges',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  expect(made.statusCode, made.body).toBe(201);
  feeAccount = accountSchema.parse(made.json());
  reader = await member('rafiq@nirvor.com', 'Rafiq Islam', ['storefront.order.read']);
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('the Payment card', () => {
  it('starts empty, lists the accounts it may use, and Pay online cannot be ticked yet', async () => {
    const setup = storefrontPaymentSetupSchema.parse(
      (await send('GET', '/storefront/payment-gateway')).json(),
    );
    expect(setup.gateway).toBeNull();
    expect(setup.moneyAccounts.map((account) => account.code)).toContain('1110');
    expect(setup.feeAccounts.map((account) => account.code)).toContain('5999');
    // Never a money account as the fee's, and never a group
    expect(setup.feeAccounts.map((account) => account.id)).not.toContain(cash.id);
    const chart = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
    const groups = new Set(chart.filter((account) => account.isGroup).map((account) => account.id));
    expect(setup.feeAccounts.some((account) => groups.has(account.id))).toBe(false);
    expect(setup.moneyAccounts.some((account) => groups.has(account.id))).toBe(false);

    expect((await refused(send('POST', '/storefront/payment-gateway/test'), 409)).code).toBe(
      'storefront_gateway_not_set_up',
    );
    expect(
      (
        await refused(
          send('PUT', '/storefront/payment-gateway', { ...gatewayForm(), version: 1 }),
          409,
        )
      ).code,
    ).toBe('storefront_gateway_not_set_up');
    expect(await refused(saveMethods(['cod', 'online']), 422)).toEqual({
      code: 'storefront_online_not_ready',
      fieldErrors: { paymentMethods: ['storefront_online_not_ready'] },
    });
    expect(await checkoutMethods()).toEqual(['cod']);
  });

  it('refuses an account that does not fit and a store id it cannot send, under their boxes', async () => {
    const path = '/storefront/payment-gateway';
    expect(
      await refused(send('POST', path, gatewayForm({ moneyAccountId: feeAccount.id })), 422),
    ).toEqual({
      code: 'storefront_gateway_money_account_invalid',
      fieldErrors: { moneyAccountId: ['storefront_gateway_money_account_invalid'] },
    });
    expect(await refused(send('POST', path, gatewayForm({ feeAccountId: cash.id })), 422)).toEqual({
      code: 'storefront_gateway_fee_account_invalid',
      fieldErrors: { feeAccountId: ['storefront_gateway_fee_account_invalid'] },
    });
    const bad = await refused(
      send('POST', path, gatewayForm({ storeId: 'nirvor 674', password: '' })),
      400,
    );
    expect(bad.fieldErrors).toEqual({
      storeId: ['storefront_gateway_store_id_format'],
      password: ['storefront_gateway_password_required'],
    });
    // Nothing was saved by any of them
    const [row] = await sql`SELECT count(*)::int AS n FROM storefront_payment_gateways`;
    expect(row?.n).toBe(0);
  });

  it('saves the gateway with its password sealed, never in an answer or the audit log', async () => {
    const res = await send('POST', '/storefront/payment-gateway', gatewayForm());
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body).not.toContain('Bkash-store');
    expect(storefrontPaymentGatewaySchema.parse(res.json())).toMatchObject({
      provider: 'sslcommerz',
      storeId: STORE_ID,
      mode: 'sandbox',
      moneyAccountId: cash.id,
      feeAccountId: feeAccount.id,
      ready: true,
      lastTest: null,
      version: 1,
    });
    // nonce (12) + tag (16) + the password's 17 bytes, and no plain text in it
    const sealed = await sealedPassword();
    expect(sealed).toHaveLength((12 + 16 + PASSWORD.length) * 2);
    expect(sealed).not.toContain(Buffer.from('Bkash').toString('hex'));
    // A second first save (another tab) is refused, and changes nothing
    expect(
      (
        await refused(
          send('POST', '/storefront/payment-gateway', gatewayForm({ storeId: 'other' })),
          409,
        )
      ).code,
    ).toBe('storefront_gateway_set_up_already');
    expect((await gateway()).storeId).toBe(STORE_ID);

    const rows = await gatewayAudit();
    expect(rows.map((row) => row.action)).toEqual(['storefront_payment_gateway.created']);
    expect(rows[0]?.text).toContain('"changed"');
    expect(rows[0]?.text).toContain('1110');
    expect(rows[0]?.text).not.toContain('Bkash-store');
  });

  it('keeps the password when its box is left empty, and a change to where it reaches clears the test', async () => {
    const path = '/storefront/payment-gateway';
    const tested = storefrontPaymentGatewaySchema.parse(
      (await send('POST', `${path}/test`)).json(),
    );
    // A test answers what the gateway said, and moves no version: a form open elsewhere still saves
    expect(tested.lastTest?.problem).toBeNull();
    expect(tested.version).toBe(1);
    const before = await sealedPassword();

    // The password box left empty: the saved one stays, sealed as it was
    const kept = await send('PUT', path, { ...gatewayForm({ password: '' }), version: 1 });
    expect(kept.statusCode, kept.body).toBe(200);
    const keptGateway = storefrontPaymentGatewaySchema.parse(kept.json());
    expect(keptGateway.version).toBe(2);
    // Nothing the test reached changed, so its answer stays
    expect(keptGateway.lastTest).toEqual(tested.lastTest);
    expect(await sealedPassword()).toBe(before);
    // The same password typed again is no change either
    const same = await send('PUT', path, { ...gatewayForm(), version: 2 });
    expect(same.statusCode, same.body).toBe(200);
    expect(await sealedPassword()).toBe(before);
    // A form opened before those saves is refused
    expect((await refused(send('PUT', path, { ...gatewayForm(), version: 1 }), 409)).code).toBe(
      'version_conflict',
    );

    // A store id the gateway refuses: saved, and the test says so; the last test was cleared first
    const rejected = await send('PUT', path, {
      ...gatewayForm({ storeId: 'fake_rejected', password: '' }),
      version: 3,
    });
    expect(storefrontPaymentGatewaySchema.parse(rejected.json()).lastTest).toBeNull();
    const refusedTest = storefrontPaymentGatewaySchema.parse(
      (await send('POST', `${path}/test`)).json(),
    );
    expect(refusedTest.lastTest?.problem).toBe('rejected');
    // A new password: sealed again, with a new nonce
    const back = await send('PUT', path, {
      ...gatewayForm({ password: 'New-store-pass-2026' }),
      version: 4,
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(await sealedPassword()).not.toBe(before);
    const reset = await send('PUT', path, { ...gatewayForm(), version: 5 });
    expect(reset.statusCode, reset.body).toBe(200);

    const rows = await gatewayAudit();
    expect(rows.map((row) => row.action)).toEqual([
      'storefront_payment_gateway.created',
      'storefront_payment_gateway.tested',
      'storefront_payment_gateway.updated',
      'storefront_payment_gateway.updated',
      'storefront_payment_gateway.updated',
      'storefront_payment_gateway.tested',
      'storefront_payment_gateway.updated',
      'storefront_payment_gateway.updated',
    ]);
    // The two saves that kept the password say nothing about it; the two new ones say "changed"
    expect(rows.map((row) => row.text.includes('"password"'))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(
      rows.some((row) => row.text.includes('Bkash-store') || row.text.includes('New-store')),
    ).toBe(false);
    expect(rows[5]?.text).toContain('rejected');
  });

  it('lets Pay online be ticked once the gateway is ready, and keeps it when an account is archived', async () => {
    const saved = await saveMethods(['cod', 'online']);
    expect(saved.statusCode, saved.body).toBe(200);
    zoneId =
      shopCheckoutSettingsSchema.parse(
        (
          await app.inject({
            method: 'GET',
            url: '/public/v1/checkout-settings',
            headers: { 'x-shop-host': shop.host },
          })
        ).json(),
      ).zones[0]?.id ?? '';
    expect(await checkoutMethods()).toEqual(['cod', 'online']);

    // The fee account archived: the gateway is not ready, so the checkout stops offering it
    await setArchived(feeAccount, true);
    try {
      expect((await gateway()).ready).toBe(false);
      expect(await checkoutMethods()).toEqual(['cod']);
      // An order placed now with it is refused
      const res = await shopPost(app, '/orders', shopper(1), {
        ...orderRequest(shop.listingId, 2, phoneOf(1), TWO),
        zoneId,
        paymentMethod: 'online',
      });
      expect((await refused(Promise.resolve(res), 422)).code).toBe('shop_payment_unavailable');
      // Ticked already: a save of the other settings keeps it, and is not refused for it
      const again = await saveMethods(['cod', 'online']);
      expect(again.statusCode, again.body).toBe(200);
      // Unticked, it can't be ticked again while the gateway is not ready
      expect((await saveMethods(['cod'])).statusCode).toBe(200);
      expect((await refused(saveMethods(['cod', 'online']), 422)).code).toBe(
        'storefront_online_not_ready',
      );
    } finally {
      await setArchived(feeAccount, false);
    }
    expect((await saveMethods(['cod', 'online'])).statusCode).toBe(200);
    expect(await checkoutMethods()).toEqual(['cod', 'online']);
  });

  it('keeps an account the gateway uses from being deleted', async () => {
    const current = accountSchema.parse((await send('GET', `/accounts/${feeAccount.id}`)).json());
    const res = await send(
      'DELETE',
      `/accounts/${feeAccount.id}?version=${String(current.version)}`,
    );
    expect((await refused(Promise.resolve(res), 409)).code).toBe('account_used_by_shop');
  });

  it('needs CREDENTIALS_KEY for a new password and for a test, and takes no online order without it', async () => {
    const keyless = await createTestApp({
      ...config,
      payments: { ...config.payments, credentialsKey: null },
    });
    try {
      const path = '/storefront/payment-gateway';
      const version = (await gateway()).version;
      const asKeyless = (method: 'POST' | 'PUT', url: string, payload?: object) =>
        keyless.inject({
          method,
          url,
          headers: bearer(owner.accessToken),
          ...(payload === undefined ? {} : { payload }),
        });
      expect(
        (
          await refused(
            asKeyless('PUT', path, { ...gatewayForm({ password: 'Another-pass-1' }), version }),
            422,
          )
        ).code,
      ).toBe('storefront_gateway_key_missing');
      expect((await refused(asKeyless('POST', `${path}/test`), 422)).code).toBe(
        'storefront_gateway_key_missing',
      );
      // The password box left empty needs no key: the accounts may still change
      const kept = await asKeyless('PUT', path, { ...gatewayForm({ password: '' }), version });
      expect(kept.statusCode, kept.body).toBe(200);
      // The password can't be opened, so the shop's order is refused, not a 500
      const res = await keyless.inject({
        method: 'POST',
        url: '/public/v1/orders',
        headers: shopper(2),
        payload: {
          ...orderRequest(shop.listingId, 2, phoneOf(2), TWO),
          zoneId,
          paymentMethod: 'online',
        },
      });
      expect((await refused(Promise.resolve(res), 422)).code).toBe('shop_payment_unavailable');
      expect(await orderRowOf(phoneOf(2))).toEqual([]);
    } finally {
      await keyless.close();
    }
  });

  it('is for storefront.manage only', async () => {
    const path = '/storefront/payment-gateway';
    const version = (await gateway()).version;
    for (const res of [
      send('GET', path, undefined, reader),
      send('POST', path, gatewayForm(), reader),
      send('PUT', path, { ...gatewayForm(), version }, reader),
      send('POST', `${path}/test`, undefined, reader),
    ]) {
      expect((await res).statusCode).toBe(403);
    }
    expect((await gateway()).version).toBe(version);
  });
});

describe('placing an online order', () => {
  it('opens the fake page on the shop address and sends no phone code', async () => {
    const order = await placeOnline(10);
    const page = pageOf(order.paymentUrl);
    expect(order.paymentUrl).toBe(
      `http://nirvor.localhost:4321/checkout/fake-gateway?tranId=${page.tranId}&amount=538.0000`,
    );
    expect(page.tranId).toMatch(/^[A-Z0-9]{20}$/);
    // Waiting for its payment, not for a code: none of the code columns
    expect(await onlyOrderOf(order.phone)).toMatchObject({
      status: 'pending',
      payment_method: 'online',
      order_no: null,
      has_code: false,
    });
    expect(await triesOf(order.phone)).toEqual([
      { try_no: 1, status: 'started', tran_id: page.tranId },
    ]);
    // The phone code's routes know no such order
    for (const url of ['/orders/verify', '/orders/resend']) {
      const res = await shopPost(app, url, shopper(10), { token: order.token, code: '123456' });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(404);
    }
    // Paid: the only SMS is the confirmation
    expect(await settled(10, page.tranId, paidValId(page))).toBe('paid');
    await trackingTokenFor(mail.apiUrl, order.phone);
    expect(await smsCount(order.phone)).toBe(1);
  });

  it('keeps a try whose page did not open, and says "checking" while the gateway cannot answer', async () => {
    await sql`UPDATE storefront_payment_gateways SET store_id = 'fake_unreachable'`;
    let order: OnlineOrder;
    try {
      order = await placeOnline(11);
      // The order and its hold stay; /checkout/paid says the page did not open
      expect(order.paymentUrl).toBeNull();
      expect(await triesOf(order.phone)).toMatchObject([{ try_no: 1, status: 'not_opened' }]);
      expect(await waitOf(order)).toEqual({
        state: 'unpaid',
        problem: 'not_opened',
        triesLeft: 2,
        payOnDelivery: true,
        total: '538.0000',
      });
    } finally {
      await sql`UPDATE storefront_payment_gateways SET store_id = ${STORE_ID}`;
    }
    // Try again opens one
    const page = pageOf(shopPaymentRetrySchema.parse((await retry(order)).json()).paymentUrl);
    expect(await triesOf(order.phone)).toMatchObject([
      { try_no: 1, status: 'not_opened' },
      { try_no: 2, status: 'started', tran_id: page.tranId },
    ]);
    // The gateway can't be asked now: the page waits and asks again
    await sql`UPDATE storefront_payment_gateways SET store_id = 'fake_unreachable'`;
    try {
      expect(await waitOf(order)).toEqual({ state: 'checking' });
      // The return post cannot be checked either: the try stays started
      expect(await settled(11, page.tranId, paidValId(page))).toBe('started');
    } finally {
      await sql`UPDATE storefront_payment_gateways SET store_id = ${STORE_ID}`;
    }
    expect(await waitOf(order)).toMatchObject({
      state: 'unpaid',
      problem: 'not_finished',
      triesLeft: 1,
    });
  });
});

describe('the gateway coming back', () => {
  it('records a payment once, even when the return and the IPN come at the same moment', async () => {
    const order = await placeOnline(20);
    const page = pageOf(order.paymentUrl);
    // The browser's return first, with the val_id; the IPN a moment later, waiting for the order
    const results = await inTurn('storefront_payments', [
      () => settle(20, page.tranId, paidValId(page)),
      () => settle(20, page.tranId, paidValId(page)),
    ]);
    expect(results.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(results.map((res) => shopPaymentSettledSchema.parse(res.json()).status)).toEqual([
      'paid',
      'paid',
    ]);
    const row = await onlyOrderOf(order.phone);
    expect(row).toMatchObject({ status: 'confirmed', payment_method: 'online' });
    expect(row.order_no).toMatch(/^W-\d{6}$/);
    // One event for the receipt, one receipt, one confirm SMS
    const [events] = await sql`
      SELECT count(*)::int AS n FROM outbox_events
      WHERE tenant_id = ${shop.tenantId} AND type = 'storefront.payment_paid'
        AND payload ->> 'paymentId' = (
          SELECT id::text FROM storefront_payments WHERE tran_id = ${page.tranId})`;
    expect(events?.n).toBe(1);
    const erp = await erpOrder(order.phone, (found) => {
      expect(found.payments[0]?.receipt).not.toBeNull();
    });
    expect(erp.payments).toHaveLength(1);
    await trackingTokenFor(mail.apiUrl, order.phone);
    expect(await smsCount(order.phone)).toBe(1);
    // A later post changes nothing, whatever it says
    expect(await settled(20, page.tranId, fakeValId(page.tranId, { outcome: 'failed' }))).toBe(
      'paid',
    );
    // /checkout/paid shows "Order Confirmed"
    expect(await waitOf(order)).toEqual({
      state: 'paid',
      orderNo: row.order_no,
      phone: order.phone,
      listingIds: [shop.listingId],
    });
  });

  it('believes no payment of another amount or another try, and knows no made-up tran_id', async () => {
    const order = await placeOnline(21);
    const page = pageOf(order.paymentUrl);
    const other = pageOf((await placeOnline(22)).paymentUrl);
    // Another amount, and the other order's payment posted for this try: both stay started
    expect(
      await settled(21, page.tranId, fakeValId(page.tranId, { outcome: 'paid', amount: '1.0000' })),
    ).toBe('started');
    expect(await settled(21, page.tranId, paidValId(other))).toBe('started');
    expect(await onlyOrderOf(order.phone)).toMatchObject({ status: 'pending' });
    // A tran_id nobody made
    const unknown = await settle(21, 'ABCDEFGHIJ0123456789', null);
    expect(unknown.statusCode, unknown.body).toBe(404);
    // A post with no val_id is asked about by the tran_id; the fake gateway knows none
    expect(await settled(21, page.tranId, null)).toBe('started');
    // The real one still pays it
    expect(await settled(21, page.tranId, paidValId(page))).toBe('paid');
  });

  it('confirms an order whose payment came after its hold, because the money came', async () => {
    const order = await placeOnline(23);
    const page = pageOf(order.paymentUrl);
    await ageOrder(order.phone, 61);
    // /checkout/paid no longer offers anything for it
    const res = await shopPost(app, '/orders/payment', shopper(23), { token: order.token });
    expect(res.statusCode, res.body).toBe(404);
    expect(await settled(23, page.tranId, paidValId(page))).toBe('paid');
    expect(await onlyOrderOf(order.phone)).toMatchObject({ status: 'confirmed' });
  });
});

describe('/checkout/paid and its two buttons', () => {
  it('says what went wrong, and Try again opens a new page, three times at most', async () => {
    const order = await placeOnline(30);
    expect(await waitOf(order)).toEqual({
      state: 'unpaid',
      problem: 'not_finished',
      triesLeft: 2,
      payOnDelivery: true,
      total: '538.0000',
    });
    const first = pageOf(order.paymentUrl);
    expect(await settled(30, first.tranId, fakeValId(first.tranId, { outcome: 'failed' }))).toBe(
      'failed',
    );
    expect(await waitOf(order)).toMatchObject({ problem: 'failed', triesLeft: 2 });

    const second = pageOf(shopPaymentRetrySchema.parse((await retry(order)).json()).paymentUrl);
    expect(second.tranId).not.toBe(first.tranId);
    expect(
      await settled(30, second.tranId, fakeValId(second.tranId, { outcome: 'cancelled' })),
    ).toBe('cancelled');
    expect(await waitOf(order)).toMatchObject({ problem: 'cancelled', triesLeft: 1 });

    const third = pageOf(shopPaymentRetrySchema.parse((await retry(order)).json()).paymentUrl);
    expect(await waitOf(order)).toMatchObject({ problem: 'not_finished', triesLeft: 0 });
    expect((await refused(retry(order), 422)).code).toBe('shop_payment_tries_used');
    expect((await triesOf(order.phone)).map((row) => row.status)).toEqual([
      'failed',
      'cancelled',
      'started',
    ]);
    // A failed try is not final: its payment, if it came after all, still counts
    expect(await settled(30, first.tranId, paidValId(first))).toBe('paid');
    expect((await triesOf(order.phone)).map((row) => row.status)).toEqual([
      'paid',
      'cancelled',
      'started',
    ]);
    expect(third.tranId).toMatch(/^[A-Z0-9]{20}$/);
  });

  it('turns the order into cash on delivery once, with one phone code', async () => {
    const order = await placeOnline(31);
    const page = pageOf(order.paymentUrl);
    const first = await payOnDelivery(order);
    expect(first.statusCode, first.body).toBe(200);
    expect(shopCodeWaitSchema.parse(first.json())).toMatchObject({ next: 'verify' });
    const { code } = await codeFor(mail.apiUrl, order.phone);
    // A second press answers the same, and sends no second code
    const second = await payOnDelivery(order);
    expect(second.statusCode, second.body).toBe(200);
    expect(await smsCount(order.phone)).toBe(1);
    // Try again is no longer offered, and /checkout/paid sends the shopper to the code
    expect((await refused(retry(order), 409)).code).toBe('shop_payment_settled');
    expect(
      (await shopPost(app, '/orders/payment', shopper(31), { token: order.token })).statusCode,
    ).toBe(404);

    const verified = await shopPost(app, '/orders/verify', shopper(31), {
      token: order.token,
      code,
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(await onlyOrderOf(order.phone)).toMatchObject({
      status: 'confirmed',
      payment_method: 'cod',
    });
    // The page the shopper left open pays after all: kept as paid, and the order stays cash on
    // delivery, so the order page says the rider collects nothing (27d.6)
    expect(await settled(31, page.tranId, paidValId(page))).toBe('paid');
    expect(await onlyOrderOf(order.phone)).toMatchObject({ payment_method: 'cod' });
  });

  it('confirms as online an order that turned into cash on delivery and was paid before its code', async () => {
    const order = await placeOnline(32);
    const page = pageOf(order.paymentUrl);
    expect((await payOnDelivery(order)).statusCode).toBe(200);
    const { code } = await codeFor(mail.apiUrl, order.phone);
    expect(await settled(32, page.tranId, paidValId(page))).toBe('paid');
    // Back to online, with every code column empty again (storefront_orders_pending_check)
    expect(await onlyOrderOf(order.phone)).toMatchObject({
      status: 'confirmed',
      payment_method: 'online',
    });
    const [codes] = await sql`
      SELECT count(*)::int AS n FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${order.phone} AND code_sends IS NOT NULL`;
    expect(codes?.n).toBe(0);
    // The code is no longer asked for
    const verified = await shopPost(app, '/orders/verify', shopper(32), {
      token: order.token,
      code,
    });
    expect(verified.statusCode, verified.body).toBe(404);
    expect(await waitOf(order)).toMatchObject({ state: 'paid' });
  });

  it('offers neither button on a paid order, nor a way the shop no longer takes', async () => {
    const paid = await placeOnline(33);
    const page = pageOf(paid.paymentUrl);
    expect(await settled(33, page.tranId, paidValId(page))).toBe('paid');
    // Confirmed: no order waits for either button
    expect((await payOnDelivery(paid)).statusCode).toBe(404);
    expect((await retry(paid)).statusCode).toBe(404);

    const order = await placeOnline(34);
    await sql`UPDATE storefront_settings SET payment_methods = '{online}' WHERE tenant_id = ${shop.tenantId}`;
    try {
      expect(await waitOf(order)).toMatchObject({ payOnDelivery: false });
      expect((await refused(payOnDelivery(order), 422)).code).toBe('shop_payment_unavailable');
    } finally {
      await sql`UPDATE storefront_settings SET payment_methods = '{cod,online}' WHERE tenant_id = ${shop.tenantId}`;
    }
    await sql`UPDATE storefront_settings SET payment_methods = '{cod}' WHERE tenant_id = ${shop.tenantId}`;
    try {
      // Pay online unticked: no try is spent on a page that cannot open
      expect((await refused(retry(order), 422)).code).toBe('shop_payment_unavailable');
      expect(await triesOf(order.phone)).toHaveLength(1);
    } finally {
      await sql`UPDATE storefront_settings SET payment_methods = '{cod,online}' WHERE tenant_id = ${shop.tenantId}`;
    }
  });
});

describe('the money receipt', () => {
  // Packs, ships and delivers an order, as the Shop orders page does
  async function deliver(order: StorefrontOrder): Promise<StorefrontOrder> {
    const plan = storefrontPackPlanSchema.parse(
      (await send('GET', `/storefront/orders/${order.id}/pack-plan`)).json(),
    );
    const packed = await send('POST', `/storefront/orders/${order.id}/pack`, {
      version: order.version,
      lines: plan.lines.map((line) => ({
        position: line.position,
        picks: line.picks.map((pick) => ({ ...pick, batchId: pick.batchId ?? '' })),
      })),
    });
    expect(packed.statusCode, packed.body).toBe(200);
    const shipped = await send('POST', `/storefront/orders/${order.id}/ship`, {
      version: storefrontOrderSchema.parse(packed.json()).version,
    });
    expect(shipped.statusCode, shipped.body).toBe(200);
    const delivered = await send('POST', `/storefront/orders/${order.id}/deliver`, {
      version: storefrontOrderSchema.parse(shipped.json()).version,
    });
    expect(delivered.statusCode, delivered.body).toBe(200);
    return storefrontOrderSchema.parse(delivered.json());
  }

  const receiptSchema = z.object({
    number: z.string(),
    amount: z.string(),
    applied: z.string(),
    method: z.string(),
    reference: z.string().nullable(),
    account: z.string(),
  });

  async function receiptOf(id: string) {
    const [row] = z.array(receiptSchema).parse(
      await sql`
        SELECT r.number, r.amount::text, r.applied::text, r.method, r.reference, a.code AS account
        FROM receipts r JOIN ledger_accounts a ON a.tenant_id = r.tenant_id AND a.id = r.account_id
        WHERE r.tenant_id = ${shop.tenantId} AND r.id = ${id}`,
    );
    if (row === undefined) throw new Error(`no receipt ${id}`);
    return row;
  }

  // The receipt's journal lines: account code, debit, credit
  async function entryOf(receiptId: string) {
    return z.array(z.object({ code: z.string(), debit: z.string(), credit: z.string() })).parse(
      await sql`
          SELECT a.code, l.debit::text, l.credit::text FROM journal_lines l
          JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
          JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
          WHERE e.tenant_id = ${shop.tenantId} AND e.source = 'sales_receipt'
            AND e.document_id = ${receiptId}
          ORDER BY l.debit DESC, a.code`,
    );
  }

  async function invoiceOf(order: StorefrontOrder) {
    const id = order.invoice?.id;
    if (id === undefined) throw new Error('no invoice');
    const [row] = z.array(z.object({ total: z.string(), amount_paid: z.string() })).parse(
      await sql`
          SELECT total::text, amount_paid::text FROM invoices
          WHERE tenant_id = ${shop.tenantId} AND id = ${id}`,
    );
    return row;
  }

  it('posts the payment with the gateway fee, and the invoice at Delivered takes it', async () => {
    const order = await placeOnline(40);
    const page = pageOf(order.paymentUrl);
    expect(await settled(40, page.tranId, paidValId(page))).toBe('paid');
    const erp = await erpOrder(order.phone, (found) => {
      expect(found.payments[0]?.receipt).not.toBeNull();
    });
    // The fake gateway keeps 2.5%: ৳13.45 of ৳538
    expect(erp.payments[0]).toMatchObject({
      tranId: page.tranId,
      status: 'paid',
      amount: '538.0000',
      cardType: 'BKASH-BKash',
      storeAmount: '524.5500',
      receiptError: null,
    });
    const receiptId = erp.payments[0]?.receipt?.id ?? '';
    expect(await receiptOf(receiptId)).toEqual({
      number: erp.payments[0]?.receipt?.number,
      amount: '538.0000',
      applied: '0.0000',
      method: 'mobile_wallet',
      reference: `FAKE${page.tranId.slice(0, 12)} · BKASH-BKash`,
      account: '1110',
    });
    // One entry: the payout into the money account, the fee as an expense, the customer's money
    expect(await entryOf(receiptId)).toEqual([
      { code: '1110', debit: '524.5500', credit: '0.0000' },
      { code: '5999', debit: '13.4500', credit: '0.0000' },
      { code: '1140', debit: '0.0000', credit: '538.0000' },
    ]);

    const delivered = await deliver(erp);
    expect(await invoiceOf(delivered)).toEqual({ total: '538.0000', amount_paid: '538.0000' });
    expect((await receiptOf(receiptId)).applied).toBe('538.0000');
  });

  it("keeps the receipt's refusal on its try, and Make the receipt makes it later", async () => {
    const order = await placeOnline(41);
    const page = pageOf(order.paymentUrl);
    // The fee account archived after the page opened: the receipt cannot post its fee line
    await setArchived(feeAccount, true);
    let erp: StorefrontOrder;
    try {
      expect(await settled(41, page.tranId, paidValId(page))).toBe('paid');
      erp = await erpOrder(order.phone, (found) => {
        expect(found.payments[0]?.receiptError).not.toBeNull();
      });
      expect(erp.payments[0]).toMatchObject({
        status: 'paid',
        receipt: null,
        receiptError: 'storefront_gateway_fee_account_invalid',
      });
      const path = `/storefront/orders/${erp.id}/payments/${erp.payments[0]?.id ?? ''}/receipt`;
      // Pressed while the account is still archived: refused again, the error kept
      expect((await refused(send('POST', path, { version: erp.version }), 409)).code).toBe(
        'storefront_gateway_fee_account_invalid',
      );
    } finally {
      await setArchived(feeAccount, false);
    }
    const path = `/storefront/orders/${erp.id}/payments/${erp.payments[0]?.id ?? ''}/receipt`;
    // A page that is not the newest is refused
    expect((await refused(send('POST', path, { version: erp.version - 1 }), 409)).code).toBe(
      'version_conflict',
    );
    // By someone who may read the orders only: 403
    expect((await send('POST', path, { version: erp.version }, reader)).statusCode).toBe(403);
    const made = await send('POST', path, { version: erp.version });
    expect(made.statusCode, made.body).toBe(200);
    const after = storefrontOrderSchema.parse(made.json());
    expect(after.version).toBe(erp.version + 1);
    expect(after.payments[0]?.receipt?.number).toMatch(/^MR-/);
    expect(after.payments[0]?.receiptError).toBeNull();
    // Pressed again (another tab): nothing more to make
    expect((await refused(send('POST', path, { version: after.version }), 409)).code).toBe(
      'storefront_order_step_invalid',
    );
  });

  it('keeps a second payment of the same order as an advance', async () => {
    const order = await placeOnline(42);
    const first = pageOf(order.paymentUrl);
    // The shopper opens a second page (Try again) and pays there, then the first one pays too
    const second = pageOf(shopPaymentRetrySchema.parse((await retry(order)).json()).paymentUrl);
    expect(await settled(42, second.tranId, paidValId(second))).toBe('paid');
    expect(await settled(42, first.tranId, paidValId(first))).toBe('paid');
    const erp = await erpOrder(order.phone, (found) => {
      expect(found.payments.map((payment) => payment.receipt === null)).toEqual([false, false]);
    });
    expect(erp.payments.map((payment) => payment.status)).toEqual(['paid', 'paid']);
    const delivered = await deliver(erp);
    // The invoice takes the oldest try's receipt; the other stays the customer's advance
    expect(await invoiceOf(delivered)).toEqual({ total: '538.0000', amount_paid: '538.0000' });
    const applied = await Promise.all(
      erp.payments.map(async (payment) => (await receiptOf(payment.receipt?.id ?? '')).applied),
    );
    expect(applied).toEqual(['538.0000', '0.0000']);
  });
});

describe('the sweep', () => {
  it('gives an online order an hour more, then deletes it once the gateway knows no payment', async () => {
    const order = await placeOnline(50);
    const cod = phoneOf(51);
    const placed = await shopPost(app, '/orders', shopper(51), {
      ...orderRequest(shop.listingId, 2, cod, TWO),
      zoneId,
    });
    expect(placed.statusCode, placed.body).toBe(201);
    // Both past their hold: the cash on delivery one goes, the online one has its grace hour
    await ageOrder(order.phone, 61);
    await ageOrder(cod, 61);
    await worker.get(PendingOrderSweep).run();
    expect(await orderRowOf(cod)).toEqual([]);
    expect(await triesOf(order.phone)).toHaveLength(1);
    // Past the grace hour: the gateway is asked, knows nothing, and the order goes with its try
    await ageOrder(order.phone, 60);
    await worker.get(PendingOrderSweep).run();
    expect(await orderRowOf(order.phone)).toEqual([]);
    const [tries] = await sql`
      SELECT count(*)::int AS n FROM storefront_payments WHERE tran_id = ${pageOf(order.paymentUrl).tranId}`;
    expect(tries?.n).toBe(0);
    // The gateway's late post for it: unknown now, logged with its tran_id
    const late = await settle(
      50,
      pageOf(order.paymentUrl).tranId,
      paidValId(pageOf(order.paymentUrl)),
    );
    expect(late.statusCode, late.body).toBe(404);
  });

  it('keeps an online order while the gateway cannot be asked', async () => {
    const order = await placeOnline(52);
    await ageOrder(order.phone, 125);
    // A password this server cannot open (another key's version): the gateway can't be asked
    await sql`UPDATE storefront_payment_gateways SET key_version = 2`;
    try {
      await worker.get(PendingOrderSweep).run();
      expect(await orderRowOf(order.phone)).toHaveLength(1);
    } finally {
      await sql`UPDATE storefront_payment_gateways SET key_version = 1`;
    }
    await worker.get(PendingOrderSweep).run();
    expect(await orderRowOf(order.phone)).toEqual([]);
  });

  it('never deletes an order a paid try confirmed', async () => {
    const order = await placeOnline(53);
    const page = pageOf(order.paymentUrl);
    await ageOrder(order.phone, 125);
    expect(await settled(53, page.tranId, paidValId(page))).toBe('paid');
    await worker.get(PendingOrderSweep).run();
    expect(await onlyOrderOf(order.phone)).toMatchObject({ status: 'confirmed' });
    // The database's own wall: a paid try is never deleted, not even with its order
    const error: unknown = await sql`
      DELETE FROM storefront_orders WHERE phone = ${order.phone}`.catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(postgres.PostgresError);
    expect(error instanceof postgres.PostgresError ? error.constraint_name : null).toBe(
      'storefront_payments_paid_kept',
    );
  });
});
