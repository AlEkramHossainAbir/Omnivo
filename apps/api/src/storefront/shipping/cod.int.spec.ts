import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  type CourierAccount,
  courierAccountSavedSchema,
  courierAccountSchema,
  courierSetupSchema,
  invoiceSchema,
  memberPageSchema,
  type PermissionKey,
  problemSchema,
  type Product,
  productSchema,
  receiptSchema,
  roleSchema,
  type ShopOrderRequestInput,
  storefrontOrderPageSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
  storefrontReturnPlanSchema,
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
import { lastMailTo } from '../../testing/mailpit.js';
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
} from '../../testing/shop-orders.js';
import { addListing } from '../../testing/storefront.js';
import { joinWithoutRoles } from '../../testing/workspace.js';

// Step 28b: a shop order's cash on delivery, on the real stack (Postgres, Redis, Mailpit, the API
// and the worker, with the fake courier). A courier account names the ledger account its COD money
// goes into; at Delivered (the courier's "delivered", or the member's button) the rider's money is
// written on the parcel and a posted money receipt by `courier` takes it into that account and pays
// the invoice. A parcel the shopper kept only part of is recorded by a member (partly delivered),
// and one that came back whole is received by a member (Returned). A receipt the books refuse
// stays on the parcel as an error, rings the bell, and is made again with "Make the receipt".
// Every test places its own orders, with its own phone and shopper address (n), so the shop's
// limits never stop a test.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
// storefront.order.read only: sees the parcel money, moves nothing
let reader: SignedIn;
let shop: OrderShop;
// The two ledger accounts of the courier accounts: a money account the riders' cash goes into,
// and an expense account for the courier's charge
let codAccount: Account;
let chargeAccount: Account;
// Steadfast by its API, with both accounts; Pathao by hand, with the COD account; RedX by hand,
// with none (the cash is a receipt typed by hand, as before 28b)
let steadfast: CourierAccount;
let steadfastToken: string;
let pathao: CourierAccount;
let redx: CourierAccount;
// A serial product (three hair dryers, HD-1001 to HD-1003), listed in the shop
let dryer: { product: Product; listingId: string };

// Two face washes (৳229 each) and the ৳80 delivery charge
const TOTAL = '538';
const WHOLE = [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }];
const API_KEY = 'sf-api-7k2m9q4x';
const SECRET_KEY = 'sf-secret-4n8p1x6w';

const refusalSchema = problemSchema.pick({ code: true, fieldErrors: true, params: true });

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, who = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function getOrder(id: string): Promise<StorefrontOrder> {
  const res = await send('GET', `/storefront/orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// A move that must go through
async function move(id: string, step: string, body: object): Promise<StorefrontOrder> {
  const res = await send('POST', `/storefront/orders/${id}/${step}`, body);
  expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// A move that must be refused with this status: the problem's code, field errors and params
async function refused(id: string, step: string, body: object, status: number) {
  const res = await send('POST', `/storefront/orders/${id}/${step}`, body);
  expect(res.statusCode, `${step}: ${res.body}`).toBe(status);
  return refusalSchema.parse(res.json());
}

// Placed by shopper n, confirmed with the code from Mailpit, and given its sales order by the
// worker: ready to pack
async function confirm(n: number, request?: ShopOrderRequestInput): Promise<StorefrontOrder> {
  const phone = phoneOf(n);
  const headers = shopHeaders(shop.host, clientAddress(n));
  const token = await placeOrder(
    app,
    headers,
    request ?? orderRequest(shop.listingId, 2, phone, TOTAL),
  );
  const { code } = await codeFor(mail.apiUrl, phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const [row] = z.array(z.object({ id: z.uuid() })).parse(
    await sql`SELECT id::text FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${phone} AND status = 'confirmed'`,
  );
  if (row === undefined) throw new Error(`no confirmed order for ${phone}`);
  return eventually(async () => {
    const order = await getOrder(row.id);
    expect(order.salesOrder).not.toBeNull();
    return order;
  });
}

// Packed, and booked with this API account by the worker
async function bookedWith(
  order: StorefrontOrder,
  account: CourierAccount,
  lines: object[] = WHOLE,
) {
  await move(order.id, 'pack', { version: order.version, lines, courierAccountId: account.id });
  return eventually(async () => {
    const now = await getOrder(order.id);
    expect(now.shipments.at(-1)?.status).toBe('booked');
    return now;
  });
}

// Packed, booked by hand with this manual account, and marked shipped: the rider has it
async function shippedBy(order: StorefrontOrder, account: CourierAccount, lines: object[] = WHOLE) {
  const packed = await move(order.id, 'pack', {
    version: order.version,
    lines,
    courierAccountId: '',
  });
  const booked = await move(order.id, 'shipments', {
    version: packed.version,
    accountId: account.id,
    trackingCode: `PTH-${order.orderNo}`,
  });
  return move(order.id, 'ship', { version: booked.version });
}

// Steadfast's webhook for this order's newest parcel, as the courier sends it
function webhook(order: StorefrontOrder, body: object) {
  return app.inject({
    method: 'POST',
    url: `/public/v1/couriers/steadfast/${steadfast.id}`,
    headers: { authorization: `Bearer ${steadfastToken}` },
    payload: {
      notification_type: 'delivery_status',
      consignment_id: Number(order.shipments.at(-1)?.consignmentId),
      ...body,
    },
  });
}

// A webhook the API must take
async function notice(order: StorefrontOrder, body: object) {
  const res = await webhook(order, body);
  expect(res.statusCode, res.body).toBe(200);
}

// The fake courier gives no time, so a step's time is the moment it reached the API, and the
// parcel's newest step wins by it (28a). A test waits a second between two steps of one parcel,
// so no two are at the same second. A test that does this more than once needs more than vitest's
// 5 seconds (COURIER_CLOCK)
function later(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1100));
}
const COURIER_CLOCK = 20_000;

async function invoiceOf(order: StorefrontOrder) {
  const res = await send('GET', `/invoices/${order.invoice?.id ?? ''}`);
  expect(res.statusCode, res.body).toBe(200);
  return invoiceSchema.parse(res.json());
}

// What a courier account holds now: the page's "Holds ৳538 · 1 parcel"
async function holdsOf(id: string) {
  const setup = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
  const found = setup.accounts.find((account) => account.id === id);
  if (found === undefined) throw new Error(`no courier account ${id}`);
  return found.holds;
}

// The workspace's COD receipts, as the database keeps them
async function codReceipts() {
  return z
    .array(z.object({ id: z.string(), amount: z.string(), account: z.string(), ref: z.string() }))
    .parse(
      await sql`SELECT id::text, amount::text, account_id::text AS account, reference AS ref
        FROM receipts WHERE tenant_id = ${shop.tenantId} AND method = 'courier'
        ORDER BY created_at, id`,
    );
}

async function stockOf(variantId: string): Promise<number> {
  const [row] = z.array(z.object({ q: z.string() })).parse(
    await sql`SELECT coalesce(sum(quantity), 0)::text AS q FROM stock_balances
      WHERE tenant_id = ${shop.tenantId} AND variant_id = ${variantId}`,
  );
  return Number(row?.q);
}

async function salesOrderStatus(order: StorefrontOrder): Promise<string | undefined> {
  const [row] = z
    .array(z.object({ status: z.string() }))
    .parse(await sql`SELECT status FROM sales_orders WHERE id = ${order.salesOrder?.id ?? ''}`);
  return row?.status;
}

// A ledger account of the test's own, under the group of an account the seed chart has
async function ledgerAccount(
  parentId: string,
  code: string,
  name: string,
  holdsMoney: boolean,
): Promise<Account> {
  const res = await send('POST', '/accounts', {
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

async function setArchived(id: string, archived: boolean): Promise<void> {
  const current = accountSchema.parse((await send('GET', `/accounts/${id}`)).json());
  const res = await send('POST', `/accounts/${id}/${archived ? 'archive' : 'restore'}`, {
    version: current.version,
  });
  expect(res.statusCode, res.body).toBe(200);
}

// A member of Nirvor with a role of exactly these permissions
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
  if (found === undefined) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'nirvor', email, password, keepSignedIn: false });
}

// Sends requests "at the same moment" for sure (28a's couriers.int.spec.ts): a transaction of the
// test's own locks `table`, and each request is sent only once the ones before it wait for a lock.
// The first one sent holds the order's row lock and waits at `table`; the next waits for the
// order's row. When the gate opens, they run in the order they were sent
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
    return { all: Promise.all(sent) };
  });
  return gate.all;
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
  sql = postgres(pg.superuserUrl, { max: 3 });
  owner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 200 });

  // The COD account sits next to Cash in hand (1110); 1160 is the seed chart's own already. The
  // charge account under the first expense group
  const chart = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const cash = chart.find((account) => account.code === '1110');
  const expenses = chart.find(
    (account) => account.type === 'expense' && account.isGroup && account.parentId !== null,
  );
  if (cash?.parentId == null || expenses === undefined) throw new Error('the seed chart changed');
  codAccount = await ledgerAccount(cash.parentId, '1191', 'Cash with couriers', true);
  chargeAccount = await ledgerAccount(expenses.id, '5998', 'Courier charges', false);

  // The dryers come in by a posted stock adjustment: a serial number exists only once stock
  // brought it in
  const made = await send('POST', '/products', {
    code: '',
    name: 'Hair dryer 1200 W',
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: shop.unitId,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'serial',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '1800', archived: false },
    ],
    units: [],
    customFields: {},
  });
  expect(made.statusCode, made.body).toBe(201);
  const product = productSchema.parse(made.json());
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-11-01',
    warehouseId: shop.warehouseId,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      {
        variantId: product.variants[0]?.id ?? '',
        unitId: shop.unitId,
        quantity: '3',
        batchId: '',
        lotNumber: '',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: ['HD-1001', 'HD-1002', 'HD-1003'],
        unitCost: '1200',
      },
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);
  dryer = {
    product,
    listingId: await addListing(sql, shop.tenantId, {
      product,
      categoryId: shop.categoryId,
      slug: 'hair-dryer',
      publishedDaysAgo: 1,
    }),
  };
  reader = await member('rafiq@nirvor.com', 'Rafiq Islam', ['storefront.order.read']);
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('the money accounts', () => {
  it('saves a COD account and a charge account, and refuses ones that cannot hold them', async () => {
    // The choices: money accounts for the COD money, expense accounts for the charge
    const setup = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
    const cod = setup.codAccounts.map((account) => account.code);
    const charge = setup.chargeAccounts.map((account) => account.code);
    expect(cod).toEqual(expect.arrayContaining(['1110', '1191']));
    expect(cod).not.toContain('5998');
    expect(charge).toContain('5998');
    expect(charge).not.toContain('1191');

    const body = {
      provider: 'steadfast',
      name: 'Steadfast Dhaka',
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
      codAccountId: codAccount.id,
      chargeAccountId: chargeAccount.id,
    };
    // Each one under its own box, and nothing saved
    for (const [wrong, field, code] of [
      [{ codAccountId: chargeAccount.id }, 'codAccountId', 'courier_cod_account_invalid'],
      [{ chargeAccountId: codAccount.id }, 'chargeAccountId', 'courier_charge_account_invalid'],
      [
        { codAccountId: '00000000-0000-4000-8000-000000000000' },
        'codAccountId',
        'courier_cod_account_invalid',
      ],
    ] as const) {
      const res = await send('POST', '/storefront/couriers', { ...body, ...wrong });
      expect(res.statusCode, res.body).toBe(422);
      expect(refusalSchema.parse(res.json())).toMatchObject({
        code,
        fieldErrors: { [field]: [code] },
      });
    }
    const [none] = await sql`SELECT count(*)::int AS n FROM courier_accounts`;
    expect(none?.n).toBe(0);

    const saved = await send('POST', '/storefront/couriers', body);
    expect(saved.statusCode, saved.body).toBe(201);
    const made = courierAccountSavedSchema.parse(saved.json());
    steadfast = made.account;
    steadfastToken = made.webhookToken ?? '';
    expect(steadfast).toMatchObject({
      codAccountId: codAccount.id,
      chargeAccountId: chargeAccount.id,
      holds: { amount: '0.0000', parcels: 0 },
    });
    // The audit row names the two accounts by their codes, which a reader of the log knows
    const [audit] = z.array(z.object({ text: z.string() })).parse(
      await sql`SELECT payload::text AS text FROM audit_logs
        WHERE entity_type = 'courier_account' AND entity_id = ${steadfast.id}`,
    );
    expect(audit?.text).toContain('1191');
    expect(audit?.text).toContain('5998');

    const byHand = await send('POST', '/storefront/couriers', {
      provider: 'manual',
      name: 'Pathao by hand',
      courier: 'pathao',
      codAccountId: codAccount.id,
      chargeAccountId: '',
    });
    expect(byHand.statusCode, byHand.body).toBe(201);
    pathao = courierAccountSavedSchema.parse(byHand.json()).account;
    const plain = await send('POST', '/storefront/couriers', {
      provider: 'manual',
      name: 'RedX by hand',
      courier: 'redx',
      codAccountId: '',
      chargeAccountId: '',
    });
    expect(plain.statusCode, plain.body).toBe(201);
    redx = courierAccountSavedSchema.parse(plain.json()).account;
    expect(redx).toMatchObject({ codAccountId: null, chargeAccountId: null });
  });

  it('checks the accounts again on every save: an archived one is refused', async () => {
    const cash = accountListSchema
      .parse((await send('GET', '/accounts')).json())
      .items.find((account) => account.code === '1110');
    if (cash?.parentId == null) throw new Error('no Cash in hand');
    const spare = await ledgerAccount(cash.parentId, '1192', 'Cash with RedX', true);
    await setArchived(spare.id, true);
    const setup = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
    expect(setup.codAccounts.map((account) => account.id)).not.toContain(spare.id);
    const res = await send('PUT', `/storefront/couriers/${redx.id}`, {
      provider: 'manual',
      name: 'RedX by hand',
      courier: 'redx',
      codAccountId: spare.id,
      chargeAccountId: '',
      version: redx.version,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(refusalSchema.parse(res.json()).code).toBe('courier_cod_account_invalid');
    // Restored, it is a COD account again; RedX stays without one for the tests after this
    await setArchived(spare.id, false);
    const fine = await send('PUT', `/storefront/couriers/${redx.id}`, {
      provider: 'manual',
      name: 'RedX by hand',
      courier: 'redx',
      codAccountId: spare.id,
      chargeAccountId: '',
      version: redx.version,
    });
    expect(fine.statusCode, fine.body).toBe(200);
    const back = await send('PUT', `/storefront/couriers/${redx.id}`, {
      provider: 'manual',
      name: 'RedX by hand',
      courier: 'redx',
      codAccountId: '',
      chargeAccountId: '',
      version: courierAccountSchema.parse(fine.json()).version,
    });
    expect(back.statusCode, back.body).toBe(200);
    redx = courierAccountSchema.parse(back.json());
  });
});

describe("the courier's delivered", () => {
  it(
    'keeps what the rider collected, cut to the COD amount, and pays the invoice with it',
    async () => {
      const order = await bookedWith(await confirm(1), steadfast);
      const parcel = order.shipments.at(-1);
      await later();
      // Steadfast says the rider took ৳900: more than the ৳538 it was told to collect
      await notice(order, { status: 'delivered', cod_amount: 900, delivery_charge: 80 });
      const delivered = await getOrder(order.id);
      expect(delivered.status).toBe('delivered');
      expect(delivered.needsAttention).toBe(false);
      expect(delivered.shipments.at(-1)).toMatchObject({
        status: 'delivered',
        collectedAmount: '538.0000',
        courierCharge: '80.0000',
        receiptError: null,
      });
      // The courier's own figure stays in the event's body, for whoever checks the payout
      const [event] = z.array(z.object({ raw: z.string() })).parse(
        await sql`SELECT raw::text AS raw FROM storefront_shipment_events
        WHERE shipment_id = ${parcel?.id ?? ''} AND status = 'delivered'`,
      );
      expect(event?.raw).toContain('900');
      // One receipt: by courier, into the COD account, with the courier's tracking code
      const receipts = await codReceipts();
      expect(receipts).toEqual([
        {
          id: delivered.shipments.at(-1)?.receipt?.id,
          amount: '538.0000',
          account: codAccount.id,
          ref: parcel?.trackingCode,
        },
      ]);
      const invoice = await invoiceOf(delivered);
      expect(invoice).toMatchObject({ total: '538.0000', amountPaid: '538.0000' });
      expect(await holdsOf(steadfast.id)).toEqual({ amount: '538.0000', parcels: 1 });
      const list = storefrontOrderPageSchema.parse(
        (await send('GET', '/storefront/orders?view=delivered')).json(),
      );
      expect(list.items.find((item) => item.id === order.id)?.parcelStatus).toBe('delivered');

      // Steadfast says delivered again, with another figure: the parcel keeps its receipt and its
      // amount (0081's receipt_kept would refuse a change), and nothing is refused
      await later();
      await notice(order, { status: 'delivered', cod_amount: 100, delivery_charge: 90 });
      const again = await getOrder(order.id);
      expect(again.shipments.at(-1)).toMatchObject({
        collectedAmount: '538.0000',
        courierCharge: '90.0000',
      });
      expect(await codReceipts()).toHaveLength(1);
    },
    COURIER_CLOCK,
  );

  // A shipped order the courier is about to deliver, and the member's page of it
  async function atTheDoor(n: number): Promise<StorefrontOrder> {
    const order = await bookedWith(await confirm(n), steadfast);
    await later();
    await notice(order, { status: 'pending' });
    const shipped = await getOrder(order.id);
    expect(shipped.status).toBe('shipped');
    await later();
    return shipped;
  }

  it(
    'takes turns with Mark delivered: the courier first, and the button is refused',
    async () => {
      const order = await atTheDoor(2);
      const before = (await codReceipts()).length;
      // Both lock the order first. The courier's news holds it and waits at the invoice; the button
      // waits for the order, then finds it moved on (version_conflict), and makes nothing
      const [news, button] = await inTurn('invoices', [
        () => webhook(order, { status: 'delivered', cod_amount: 538 }),
        () =>
          send('POST', `/storefront/orders/${order.id}/deliver`, {
            version: order.version,
            collectedAmount: '500',
          }),
      ]);
      expect(news?.statusCode, news?.body).toBe(200);
      expect(button?.statusCode, button?.body).toBe(409);
      const after = await getOrder(order.id);
      expect(after.shipments.at(-1)?.collectedAmount).toBe('538.0000');
      expect(await codReceipts()).toHaveLength(before + 1);
    },
    COURIER_CLOCK,
  );

  it(
    "takes turns with Mark delivered: the button first, and the courier's figure is too late",
    async () => {
      const order = await atTheDoor(3);
      const before = (await codReceipts()).length;
      // The courier's delivered then finds the order delivered and the parcel with its receipt: it
      // keeps the member's ৳500 (0081's receipt_kept), and is still taken (200), as every notice is
      const [button, news] = await inTurn('invoices', [
        () =>
          send('POST', `/storefront/orders/${order.id}/deliver`, {
            version: order.version,
            collectedAmount: '500',
          }),
        () => webhook(order, { status: 'delivered', cod_amount: 538 }),
      ]);
      expect(button?.statusCode, button?.body).toBe(200);
      expect(news?.statusCode, news?.body).toBe(200);
      const after = await getOrder(order.id);
      expect(after.shipments.at(-1)?.collectedAmount).toBe('500.0000');
      expect((await invoiceOf(after)).amountPaid).toBe('500.0000');
      expect(await codReceipts()).toHaveLength(before + 1);
      const [invoices] = await sql`SELECT count(*)::int AS n FROM invoices
      WHERE tenant_id = ${shop.tenantId} AND customer_reference = ${order.orderNo}`;
      expect(invoices?.n).toBe(1);
    },
    COURIER_CLOCK,
  );
});

describe('Mark delivered by hand', () => {
  it(
    'takes what the member typed, up to the COD amount, and the whole amount when the box is empty',
    async () => {
      const shipped = await shippedBy(await confirm(4), pathao);
      const over = await refused(
        shipped.id,
        'deliver',
        { version: shipped.version, collectedAmount: '600' },
        422,
      );
      expect(over).toMatchObject({
        code: 'storefront_order_collected_over',
        fieldErrors: { collectedAmount: ['storefront_order_collected_over'] },
        params: { amount: '538.0000' },
      });
      // The button moves the manual parcel too, with a member's step
      const holds = await holdsOf(pathao.id);
      const delivered = await move(shipped.id, 'deliver', {
        version: shipped.version,
        collectedAmount: null,
      });
      const parcel = delivered.shipments.at(-1);
      expect(parcel).toMatchObject({ status: 'delivered', collectedAmount: '538.0000' });
      expect(parcel?.events.at(-1)).toMatchObject({ status: 'delivered' });
      expect((await invoiceOf(delivered)).amountPaid).toBe('538.0000');
      expect(await holdsOf(pathao.id)).toEqual({
        amount: (Number(holds.amount) + 538).toFixed(4),
        parcels: holds.parcels + 1,
      });

      // Nothing collected (the shopper paid nothing at the door): no receipt, the invoice stays due
      const none = await shippedBy(await confirm(5), pathao);
      const kept = await move(none.id, 'deliver', { version: none.version, collectedAmount: '0' });
      expect(kept.shipments.at(-1)).toMatchObject({ collectedAmount: '0.0000', receipt: null });
      expect((await invoiceOf(kept)).amountPaid).toBe('0.0000');
      expect(kept.needsAttention).toBe(false);
    },
    COURIER_CLOCK,
  );

  // Two orders and seven moves: more than vitest's 5 seconds on a busy machine (28b.8)
  it(
    'makes no receipt for a courier account without a COD account, nor for an order with no parcel',
    async () => {
      const before = (await codReceipts()).length;
      const shipped = await shippedBy(await confirm(6), redx);
      const delivered = await move(shipped.id, 'deliver', {
        version: shipped.version,
        collectedAmount: null,
      });
      // The amount is still kept on the parcel (the page shows it); the cash is a receipt by hand
      expect(delivered.shipments.at(-1)).toMatchObject({
        status: 'delivered',
        collectedAmount: '538.0000',
        receipt: null,
        receiptError: null,
      });
      expect((await invoiceOf(delivered)).amountPaid).toBe('0.0000');

      // The shop's own rider: no parcel to keep money on, so a typed amount says nothing
      const order = await confirm(7);
      const packed = await move(order.id, 'pack', {
        version: order.version,
        lines: WHOLE,
        courierAccountId: '',
      });
      const shippedOwn = await move(order.id, 'ship', { version: packed.version });
      const own = await move(order.id, 'deliver', {
        version: shippedOwn.version,
        collectedAmount: '538',
      });
      expect(own.status).toBe('delivered');
      expect(own.shipments).toEqual([]);
      expect(await codReceipts()).toHaveLength(before);
    },
    COURIER_CLOCK,
  );
});

describe('Record what came back', () => {
  it(
    "returns part of a parcel, bills what was kept and takes the courier's figure",
    async () => {
      const before = await stockOf(shop.variantId);
      let order = await bookedWith(await confirm(8), steadfast);
      // Not before the rider has it
      expect((await send('GET', `/storefront/orders/${order.id}/return-plan`)).statusCode).toBe(
        409,
      );
      await later();
      await notice(order, { status: 'pending' });
      await later();
      await notice(order, { status: 'partial_delivered', cod_amount: 309, delivery_charge: 80 });
      // The courier's word moves the parcel only: what came back is the member's to record
      order = await getOrder(order.id);
      expect(order.status).toBe('shipped');
      expect(order.shipments.at(-1)).toMatchObject({
        status: 'partly_delivered',
        collectedAmount: '309.0000',
        receipt: null,
      });
      const plan = storefrontReturnPlanSchema.parse(
        (await send('GET', `/storefront/orders/${order.id}/return-plan`)).json(),
      );
      const line = plan.lines[0];
      expect(plan.lines).toHaveLength(1);
      expect(line).toMatchObject({ quantity: '2.0000', tracking: 'none', serialNumbers: [] });
      const body = (lines: object[]) => ({
        version: order.version,
        lines,
        collectedAmount: null,
        reason: 'Wrong size',
      });

      // A line of another challan, nothing, and everything are each refused
      expect(
        await refused(
          order.id,
          'partly-deliver',
          body([
            {
              deliveryLineId: '00000000-0000-4000-8000-000000000000',
              quantity: '1',
              serialNumbers: [],
            },
          ]),
          409,
        ),
      ).toMatchObject({
        code: 'storefront_order_line_missing',
        fieldErrors: { 'lines.0.deliveryLineId': ['storefront_order_line_missing'] },
      });
      expect((await refused(order.id, 'partly-deliver', body([]), 400)).fieldErrors).toMatchObject({
        lines: ['storefront_order_return_nothing'],
      });
      expect(
        (
          await refused(
            order.id,
            'partly-deliver',
            body([{ deliveryLineId: line?.deliveryLineId, quantity: '2', serialNumbers: [] }]),
            409,
          )
        ).code,
      ).toBe('storefront_order_return_everything');

      const done = await move(
        order.id,
        'partly-deliver',
        body([{ deliveryLineId: line?.deliveryLineId, quantity: '1', serialNumbers: [] }]),
      );
      expect(done.status).toBe('delivered');
      expect(done.salesReturn?.number).toMatch(/^SR-/);
      expect(done.shipments.at(-1)).toMatchObject({
        status: 'partly_delivered',
        collectedAmount: '309.0000',
      });
      // One face wash and the delivery charge, paid by the rider's ৳309
      const invoice = await invoiceOf(done);
      expect(invoice).toMatchObject({ total: '309.0000', amountPaid: '309.0000' });
      expect(await salesOrderStatus(done)).toBe('closed');
      // Two went out, one came back
      expect(await stockOf(shop.variantId)).toBe(before - 1);
      const [audit] = await sql`SELECT payload::text AS text FROM audit_logs
      WHERE entity_id = ${order.id} AND action = 'storefront_order.partly_delivered'`;
      expect(audit?.text).toContain('Wrong size');
    },
    COURIER_CLOCK,
  );

  it("needs the amount when the courier gave none, and cuts a coupon's discount with the goods", async () => {
    const coupon = await send('POST', '/storefront/coupons', {
      code: 'WELCOME10',
      kind: 'percent',
      value: '10',
      upTo: '',
      minimum: '',
      startsOn: '',
      lastDay: '',
      usageLimit: '',
      onePerPhone: false,
    });
    expect(coupon.statusCode, coupon.body).toBe(201);
    // Two face washes with 10% off (৳45.80) and the ৳80 delivery charge
    const request = {
      ...orderRequest(shop.listingId, 2, phoneOf(9), '492.2'),
      couponCode: 'WELCOME10',
    };
    const order = await shippedBy(await confirm(9, request), pathao);
    expect(order.shipments.at(-1)?.codAmount).toBe('492.2000');
    const plan = storefrontReturnPlanSchema.parse(
      (await send('GET', `/storefront/orders/${order.id}/return-plan`)).json(),
    );
    const lines = [
      { deliveryLineId: plan.lines[0]?.deliveryLineId, quantity: '1', serialNumbers: [] },
    ];
    // A manual parcel has no courier's figure, and the COD amount is for the whole parcel
    expect(
      await refused(
        order.id,
        'partly-deliver',
        { version: order.version, lines, collectedAmount: null, reason: '' },
        422,
      ),
    ).toMatchObject({
      code: 'storefront_order_collected_required',
      fieldErrors: { collectedAmount: ['storefront_order_collected_required'] },
    });
    // Nothing of it was written: the return and the invoice rolled back with the refusal
    const still = await getOrder(order.id);
    expect(still).toMatchObject({ status: 'shipped', salesReturn: null, invoice: null });

    const done = await move(order.id, 'partly-deliver', {
      version: order.version,
      lines,
      collectedAmount: '286.1',
      reason: '',
    });
    // One face wash keeps half the discount: ৳229 − ৳22.90 + ৳80
    const invoice = await invoiceOf(done);
    expect(invoice).toMatchObject({ total: '286.1000', amountPaid: '286.1000' });
    expect(done.shipments.at(-1)?.receipt?.number).toMatch(/^MR-/);
  });

  it('takes back the serial numbers of the pieces that came back', async () => {
    // Two dryers (৳3,600): free delivery
    const order = await confirm(10, orderRequest(dryer.listingId, 2, phoneOf(10), '3600'));
    const shipped = await shippedBy(order, redx, [
      {
        position: 1,
        picks: [{ batchId: '', quantity: '2', serialNumbers: ['HD-1001', 'HD-1003'] }],
      },
    ]);
    const plan = storefrontReturnPlanSchema.parse(
      (await send('GET', `/storefront/orders/${shipped.id}/return-plan`)).json(),
    );
    expect(plan.lines[0]).toMatchObject({
      tracking: 'serial',
      serialNumbers: ['HD-1001', 'HD-1003'],
    });
    const back = (serialNumbers: string[]) => ({
      version: shipped.version,
      lines: [{ deliveryLineId: plan.lines[0]?.deliveryLineId, quantity: '1', serialNumbers }],
      collectedAmount: '1800',
      reason: '',
    });
    // HD-1002 never left the shelf: it cannot come back with this parcel
    expect(
      (await refused(shipped.id, 'partly-deliver', back(['HD-1002']), 409)).fieldErrors,
    ).toMatchObject({ 'lines.0.serialNumbers': ['return_serial_invalid'] });
    const done = await move(shipped.id, 'partly-deliver', back(['HD-1003']));
    expect((await invoiceOf(done)).total).toBe('1800.0000');
    const shelf = z
      .array(z.object({ s: z.string() }))
      .parse(
        await sql`SELECT serial_number AS s FROM serials
          WHERE tenant_id = ${shop.tenantId} AND warehouse_id IS NOT NULL ORDER BY serial_number`,
      )
      .map((row) => row.s);
    expect(shelf).toEqual(['HD-1002', 'HD-1003']);
  });
});

describe('Receive the return', () => {
  it(
    'puts a parcel the courier brought back on the shelf, with no invoice',
    async () => {
      const before = await stockOf(shop.variantId);
      let order = await bookedWith(await confirm(11), steadfast);
      // Packed, not shipped: there is nothing to receive yet
      expect(
        (await refused(order.id, 'return', { version: order.version, reason: '' }, 409)).code,
      ).toBe('storefront_order_step_invalid');
      await later();
      await notice(order, { status: 'pending' });
      await later();
      await notice(order, { status: 'cancelled' });
      order = await getOrder(order.id);
      expect(order).toMatchObject({ status: 'shipped', parcelStatus: 'returning' });
      expect(order.shipments.at(-1)?.status).toBe('returning');

      const returned = await move(order.id, 'return', {
        version: order.version,
        reason: 'Customer refused the parcel',
      });
      expect(returned).toMatchObject({ status: 'returned', invoice: null });
      expect(returned.salesReturn?.number).toMatch(/^SR-/);
      expect(returned.shipments.at(-1)?.status).toBe('returned');
      expect(await stockOf(shop.variantId)).toBe(before);
      // The sales order delivered nothing in the end: the sales rules call that cancelled
      expect(await salesOrderStatus(returned)).toBe('cancelled');
      const tab = storefrontOrderPageSchema.parse(
        (await send('GET', '/storefront/orders?view=returned')).json(),
      );
      expect(tab.items.map((item) => item.id)).toContain(order.id);
      // The shopper hears of it by SMS, without the staff's reason
      await eventually(async () => {
        const sms = await lastMailTo(mail.apiUrl, smsAddress(phoneOf(11)));
        expect(sms.text).toContain('came back to us');
        expect(sms.text).not.toContain('refused');
      });
    },
    COURIER_CLOCK,
  );

  it('takes a manual parcel back from the rider, with a member step', async () => {
    const shipped = await shippedBy(await confirm(12), pathao);
    const returned = await move(shipped.id, 'return', { version: shipped.version, reason: '' });
    const parcel = returned.shipments.at(-1);
    expect(parcel).toMatchObject({ status: 'returned', collectedAmount: null, receipt: null });
    expect(parcel?.events.at(-1)?.status).toBe('returned');
  });
});

describe('Make the receipt', () => {
  it(
    'keeps a refused COD receipt on the parcel, rings once, and makes it again',
    async () => {
      const order = await bookedWith(await confirm(13), steadfast);
      const parcelId = order.shipments.at(-1)?.id ?? '';
      // The COD account archived since the account was saved: the receipt's own check refuses it
      await setArchived(codAccount.id, true);
      try {
        await later();
        await notice(order, { status: 'delivered', cod_amount: 538 });
        // The Delivered and the invoice stand: only the receipt failed
        const delivered = await getOrder(order.id);
        expect(delivered).toMatchObject({ status: 'delivered', needsAttention: true });
        expect(delivered.shipments.at(-1)).toMatchObject({
          collectedAmount: '538.0000',
          receipt: null,
          receiptError: 'receipt_account_invalid',
        });
        expect((await invoiceOf(delivered)).amountPaid).toBe('0.0000');
        const bells = await sql`SELECT user_id FROM notifications
        WHERE type = 'storefront.cod_receipt_failed' AND params->>'id' = ${order.id}`;
        expect(bells).toHaveLength(1);
        const list = storefrontOrderPageSchema.parse(
          (await send('GET', '/storefront/orders?view=delivered')).json(),
        );
        expect(list.items.find((item) => item.id === order.id)?.needsAttention).toBe(true);

        // Pressed while it is still archived: refused again, the error kept, no second bell
        const again = await send(
          'POST',
          `/storefront/orders/${order.id}/shipments/${parcelId}/receipt`,
          { version: delivered.version },
        );
        expect(again.statusCode, again.body).toBe(409);
        expect((await getOrder(order.id)).shipments.at(-1)?.receiptError).toBe(
          'receipt_account_invalid',
        );
        const rang = await sql`SELECT 1 FROM notifications
        WHERE type = 'storefront.cod_receipt_failed' AND params->>'id' = ${order.id}`;
        expect(rang).toHaveLength(1);
      } finally {
        await setArchived(codAccount.id, false);
      }

      const current = await getOrder(order.id);
      const made = await move(order.id, `shipments/${parcelId}/receipt`, {
        version: current.version,
      });
      expect(made.needsAttention).toBe(false);
      expect(made.version).toBe(current.version + 1);
      expect(made.shipments.at(-1)).toMatchObject({ receiptError: null });
      expect(made.shipments.at(-1)?.receipt?.number).toMatch(/^MR-/);
      expect((await invoiceOf(made)).amountPaid).toBe('538.0000');
      const [audit] = await sql`SELECT 1 FROM audit_logs
      WHERE entity_id = ${order.id} AND action = 'storefront_order.cod_receipt_made'`;
      expect(audit).toBeDefined();
      // Twice is refused: the parcel has its receipt
      expect(
        (await refused(order.id, `shipments/${parcelId}/receipt`, { version: made.version }, 409))
          .code,
      ).toBe('storefront_cod_receipt_not_failed');
    },
    COURIER_CLOCK,
  );

  it(
    'stops counting a voided COD receipt in what the courier holds, and keeps it linked',
    async () => {
      const order = await bookedWith(await confirm(14), steadfast);
      await later();
      await notice(order, { status: 'delivered', cod_amount: 538 });
      const delivered = await getOrder(order.id);
      const receiptId = delivered.shipments.at(-1)?.receipt?.id ?? '';
      const holds = await holdsOf(steadfast.id);
      const receipt = receiptSchema.parse((await send('GET', `/receipts/${receiptId}`)).json());
      const voided = await send('POST', `/receipts/${receiptId}/void`, {
        version: receipt.version,
        date: receipt.date,
        reason: 'The rider handed in the wrong parcel',
      });
      expect(voided.statusCode, voided.body).toBe(200);
      expect(await holdsOf(steadfast.id)).toEqual({
        amount: (Number(holds.amount) - 538).toFixed(4),
        parcels: holds.parcels - 1,
      });
      // The parcel still names its receipt (now voided), so there is nothing to make again: a new
      // receipt for the money is typed by hand (a known limit of 28b)
      const after = await getOrder(order.id);
      expect(after.shipments.at(-1)?.receipt?.id).toBe(receiptId);
      expect(
        (
          await refused(
            order.id,
            `shipments/${after.shipments.at(-1)?.id ?? ''}/receipt`,
            { version: after.version },
            409,
          )
        ).code,
      ).toBe('storefront_cod_receipt_not_failed');
    },
    COURIER_CLOCK,
  );
});

describe('permissions', () => {
  it('lets storefront.order.read see the parcel money and move nothing', async () => {
    const order = await shippedBy(await confirm(15), pathao);
    const seen = await send('GET', `/storefront/orders/${order.id}`, undefined, reader);
    expect(seen.statusCode, seen.body).toBe(200);
    expect(storefrontOrderSchema.parse(seen.json()).shipments.at(-1)?.codAmount).toBe('538.0000');
    const parcelId = order.shipments.at(-1)?.id ?? '';
    for (const [method, url, body] of [
      ['POST', 'deliver', { version: order.version, collectedAmount: null }],
      [
        'POST',
        'partly-deliver',
        { version: order.version, lines: [], collectedAmount: null, reason: '' },
      ],
      ['POST', 'return', { version: order.version, reason: '' }],
      ['GET', 'return-plan', undefined],
      ['POST', `shipments/${parcelId}/receipt`, { version: order.version }],
    ] as const) {
      const res = await send(method, `/storefront/orders/${order.id}/${url}`, body, reader);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await getOrder(order.id)).status).toBe('shipped');
  });
});
