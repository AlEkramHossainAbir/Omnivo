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
  journalEntrySchema,
  memberPageSchema,
  type Payout,
  payoutMatchSchema,
  payoutPageSchema,
  payoutParcelsSchema,
  payoutSchema,
  payoutSetupSchema,
  type PermissionKey,
  problemSchema,
  receiptSchema,
  roleSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
  type StorefrontShipment,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

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
} from '../../testing/shop-orders.js';
import { joinWithoutRoles } from '../../testing/workspace.js';

// Step 28c: the courier's payout, on the real stack (Postgres, Redis, Mailpit, the API and the
// worker, with the fake courier). A courier pays the riders' cash out to the bank with its charges
// taken off; a payout takes the parcels it paid and posts Dr bank (net) + Dr charges / Cr the COD
// account. The courier's CSV is matched against the account's parcels first. Every test places
// its own orders, with its own phone and shopper address (n), so the shop's limits never stop a
// test, and never counts parcels another test made.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
// storefront.payout.manage only, and every storefront.* permission but that one
let payer: SignedIn;
let clerk: SignedIn;
let shop: OrderShop;
// The COD money account, the courier charges account, and the cash account (1110) a payout goes
// into
let codAccount: Account;
let chargeAccount: Account;
let bankId: string;
// Steadfast by its API with both accounts; Pathao by hand with the COD account only; RedX by hand
// with none
let steadfast: CourierAccount;
let steadfastToken: string;
let pathao: CourierAccount;
let redx: CourierAccount;

// Two face washes (৳229 each) and the ৳80 delivery charge
const TOTAL = '538';
const WHOLE = [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }];
// Each test places a few orders and waits a second between two courier steps of one parcel
const COURIER_CLOCK = 60_000;

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

async function move(id: string, step: string, body: object): Promise<StorefrontOrder> {
  const res = await send('POST', `/storefront/orders/${id}/${step}`, body);
  expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// Placed by shopper n, confirmed with the code from Mailpit, and given its sales order by the
// worker: ready to pack
async function confirm(n: number): Promise<StorefrontOrder> {
  const phone = phoneOf(n);
  const headers = shopHeaders(shop.host, clientAddress(n));
  const token = await placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, TOTAL));
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

// Packed, and booked with Steadfast by the worker
async function booked(n: number): Promise<StorefrontOrder> {
  const order = await confirm(n);
  await move(order.id, 'pack', {
    version: order.version,
    lines: WHOLE,
    courierAccountId: steadfast.id,
  });
  return eventually(async () => {
    const now = await getOrder(order.id);
    expect(now.shipments.at(-1)?.status).toBe('booked');
    return now;
  });
}

// Steadfast's webhook for this order's newest parcel. The fake courier gives no time, so a step's
// time is the moment it reached the API: the wait keeps two steps of one parcel a second apart
async function notice(order: StorefrontOrder, body: object): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const res = await app.inject({
    method: 'POST',
    url: `/public/v1/couriers/steadfast/${steadfast.id}`,
    headers: { authorization: `Bearer ${steadfastToken}` },
    payload: {
      notification_type: 'delivery_status',
      consignment_id: Number(order.shipments.at(-1)?.consignmentId),
      ...body,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

// An order and its newest parcel, as the order page shows them now. The parcel's courier invoice
// is the order number (W-000123): each test's order has one parcel
interface Sent {
  order: StorefrontOrder;
  parcel: StorefrontShipment;
}

async function sentOf(order: StorefrontOrder): Promise<Sent> {
  const now = await getOrder(order.id);
  const parcel = now.shipments.at(-1);
  if (parcel === undefined) throw new Error(`${order.orderNo} has no parcel`);
  return { order: now, parcel };
}

// Delivered by Steadfast: the rider collected cod (its COD receipt is posted) and the courier
// charged charge
async function delivered(n: number, cod = 538, charge = 80): Promise<Sent> {
  const order = await booked(n);
  await notice(order, { status: 'delivered', cod_amount: cod, delivery_charge: charge });
  const sent = await sentOf(order);
  expect(sent.parcel.receipt, `${order.orderNo} has no COD receipt`).not.toBeNull();
  return sent;
}

// Cancelled by Steadfast with its charge, and received back by a member: a charge line
async function returned(n: number, charge = 50): Promise<Sent> {
  const order = await booked(n);
  await notice(order, { status: 'pending' });
  await notice(order, { status: 'cancelled', delivery_charge: charge });
  const now = await getOrder(order.id);
  await move(now.id, 'return', { version: now.version, reason: '' });
  return sentOf(order);
}

// Booked by hand with Pathao, shipped and marked delivered: the COD receipt is the whole ৳538
async function deliveredByHand(n: number): Promise<Sent> {
  const order = await confirm(n);
  const packed = await move(order.id, 'pack', {
    version: order.version,
    lines: WHOLE,
    courierAccountId: '',
  });
  const withParcel = await move(order.id, 'shipments', {
    version: packed.version,
    accountId: pathao.id,
    trackingCode: `PTH-${order.orderNo}`,
  });
  const shipped = await move(order.id, 'ship', { version: withParcel.version });
  await move(order.id, 'deliver', { version: shipped.version, collectedAmount: null });
  return sentOf(order);
}

async function receiptOf(sent: Sent) {
  const res = await send('GET', `/receipts/${sent.parcel.receipt?.id ?? ''}`);
  expect(res.statusCode, res.body).toBe(200);
  return receiptSchema.parse(res.json());
}

// The day of a parcel's COD receipt: today in the workspace's time zone, the day a payout of it
// is dated in these tests
async function today(sent: Sent): Promise<string> {
  return (await receiptOf(sent)).date;
}

function dayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

// A payout of these parcels, each with its charge, into the cash account
function payoutBody(date: string, lines: [Sent, string][], account = steadfast) {
  return {
    accountId: account.id,
    date,
    bankAccountId: bankId,
    reference: 'SFC-23618228',
    note: '',
    lines: lines.map(([sent, charge]) => ({ shipmentId: sent.parcel.id, charge })),
  };
}

async function pay(body: object): Promise<Payout> {
  const res = await send('POST', '/storefront/payouts', body);
  expect(res.statusCode, res.body).toBe(201);
  return payoutSchema.parse(res.json());
}

async function refused(
  method: 'GET' | 'POST',
  url: string,
  body: object | undefined,
  status: number,
) {
  const res = await send(method, url, body);
  expect(res.statusCode, res.body).toBe(status);
  return refusalSchema.parse(res.json());
}

// The new payout page's list of this account
async function payable(account: CourierAccount) {
  const res = await send('GET', `/storefront/couriers/${account.id}/payout-parcels`);
  expect(res.statusCode, res.body).toBe(200);
  return payoutParcelsSchema.parse(res.json());
}

async function match(account: CourierAccount, csv: string, map: object | null = null) {
  const res = await send('POST', `/storefront/couriers/${account.id}/payout-match`, { csv, map });
  expect(res.statusCode, res.body).toBe(200);
  return payoutMatchSchema.parse(res.json());
}

// A courier account as the Shop couriers page shows it now
async function courierAccount(id: string) {
  const setup = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
  const found = setup.accounts.find((account) => account.id === id);
  if (found === undefined) throw new Error(`no courier account ${id}`);
  return found;
}

// What it holds: the page's "৳45,200 · 18 parcels"
async function holdsOf(id: string) {
  return (await courierAccount(id)).holds;
}

// An entry's lines as [account, debit, credit], by the accounts' names in this test
async function entryLines(id: string) {
  const res = await send('GET', `/journal-entries/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  const entry = journalEntrySchema.parse(res.json());
  const name = (accountId: string) =>
    accountId === codAccount.id
      ? 'cod'
      : accountId === chargeAccount.id
        ? 'charges'
        : accountId === bankId
          ? 'bank'
          : accountId;
  return entry.lines
    .map((line) => [name(line.accountId), line.debit, line.credit])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

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
// When the gate opens, they run in the order they were sent
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
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 400 });

  // The COD account sits next to Cash in hand (1110), the charge account under the first expense
  // group, as in 28b's cod.int.spec.ts
  const chart = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const cash = chart.find((account) => account.code === '1110');
  const expenses = chart.find(
    (account) => account.type === 'expense' && account.isGroup && account.parentId !== null,
  );
  if (cash?.parentId == null || expenses === undefined) throw new Error('the seed chart changed');
  bankId = cash.id;
  codAccount = await ledgerAccount(cash.parentId, '1191', 'Cash with couriers', true);
  chargeAccount = await ledgerAccount(expenses.id, '5998', 'Courier charges', false);

  const api = await send('POST', '/storefront/couriers', {
    provider: 'steadfast',
    name: 'Steadfast Dhaka',
    apiKey: 'sf-api-7k2m9q4x',
    secretKey: 'sf-secret-4n8p1x6w',
    codAccountId: codAccount.id,
    chargeAccountId: chargeAccount.id,
  });
  expect(api.statusCode, api.body).toBe(201);
  const made = courierAccountSavedSchema.parse(api.json());
  steadfast = made.account;
  steadfastToken = made.webhookToken ?? '';
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

  payer = await member('shamim@nirvor.com', 'Shamim Ahmed', ['storefront.payout.manage']);
  clerk = await member('rafiq@nirvor.com', 'Rafiq Islam', [
    'storefront.manage',
    'storefront.order.read',
    'storefront.order.manage',
  ]);
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('the parcels a payout can take', () => {
  it(
    'offers the COD parcels and the charge lines, never a parcel on its way or a voided receipt',
    async () => {
      const cod = await delivered(1);
      const charge = await returned(2, 50);
      const onItsWay = await sentOf(await booked(3));
      const voided = await delivered(4);
      const receipt = await receiptOf(voided);
      const res = await send('POST', `/receipts/${receipt.id}/void`, {
        version: receipt.version,
        date: receipt.date,
        reason: 'The rider handed in the wrong parcel',
      });
      expect(res.statusCode, res.body).toBe(200);

      const { account, parcels, csvMap } = await payable(steadfast);
      expect(account).toMatchObject({
        id: steadfast.id,
        codAccount: { id: codAccount.id },
        chargeAccount: { id: chargeAccount.id },
      });
      expect(csvMap).toBeNull();
      const ids = parcels.map((parcel) => parcel.shipmentId);
      expect(ids).not.toContain(onItsWay.parcel.id);
      expect(ids).not.toContain(voided.parcel.id);
      expect(parcels.find((parcel) => parcel.shipmentId === cod.parcel.id)).toMatchObject({
        kind: 'cod',
        order: { id: cod.order.id, number: cod.order.orderNo },
        invoice: cod.order.orderNo,
        collected: '538.0000',
        courierCharge: '80.0000',
        receipt: { id: cod.parcel.receipt?.id },
        receiptDate: receipt.date,
      });
      expect(parcels.find((parcel) => parcel.shipmentId === charge.parcel.id)).toMatchObject({
        kind: 'charge',
        collected: '0.0000',
        courierCharge: '50.0000',
        receipt: null,
        receiptDate: null,
      });
      // The COD parcels by their receipt's day first, then the charge lines
      const kinds = parcels.map((parcel) => parcel.kind);
      expect(kinds.indexOf('charge')).toBeGreaterThan(kinds.lastIndexOf('cod'));
      // Another account's list does not have them
      const byHand = (await payable(pathao)).parcels.map((parcel) => parcel.shipmentId);
      expect(byHand).not.toContain(cod.parcel.id);
    },
    COURIER_CLOCK,
  );

  it('lists every courier account, archived ones last, and the accounts money can go into', async () => {
    const spare = await send('POST', '/storefront/couriers', {
      provider: 'manual',
      name: 'Paperfly spare',
      courier: 'paperfly',
      codAccountId: '',
      chargeAccountId: '',
    });
    expect(spare.statusCode, spare.body).toBe(201);
    const saved = courierAccountSavedSchema.parse(spare.json()).account;
    const archived = await send('POST', `/storefront/couriers/${saved.id}/archive`, {
      version: saved.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const setup = payoutSetupSchema.parse((await send('GET', '/storefront/payout-setup')).json());
    expect(setup.accounts.at(-1)).toMatchObject({ id: saved.id, archived: true });
    expect(setup.accounts.find((account) => account.id === redx.id)).toMatchObject({
      archived: false,
      codAccount: null,
      chargeAccount: null,
    });
    const codes = setup.bankAccounts.map((account) => account.code);
    expect(codes).toEqual(expect.arrayContaining(['1110', '1191']));
    expect(codes).not.toContain('5998');
  });
});

describe('the courier’s file', () => {
  it(
    'accounts for every row with the preset, and names the payout a paid parcel is in',
    async () => {
      const a = await delivered(10);
      const b = await delivered(11);
      const c = await returned(12, 50);
      const d = await booked(13);
      const csv = [
        'Invoice,COD Amount,Delivery Charge',
        `${a.order.orderNo},538,80`,
        `${b.order.orderNo},"1,000",60`,
        `${c.order.orderNo},0,50`,
        `${d.orderNo},538,80`,
        'W-999999,10,1',
        `${a.order.orderNo},538,80`,
        ',1,1',
        `${a.order.orderNo}x,N/A,1`,
        '',
      ].join('\n');
      // With the byte order mark of Excel's "CSV UTF-8", which the browser's FileReader keeps
      const first = await match(steadfast, `\uFEFF${csv}`);
      expect(first).toMatchObject({
        columns: ['Invoice', 'COD Amount', 'Delivery Charge'],
        map: { key: 'invoice', keyColumn: 'Invoice' },
        missing: [],
        // (538 + 1,000 + 0) − (80 + 60 + 50): the rows this payout can take only
        fileNet: '1348.0000',
      });
      expect(first.rows.map((row) => [row.row, row.outcome])).toEqual([
        [2, 'matched'],
        [3, 'different'],
        [4, 'matched'],
        [5, 'not_ready'],
        [6, 'unknown'],
        [7, 'twice'],
        [8, 'invalid'],
        [9, 'invalid'],
      ]);
      expect(first.rows[0]).toMatchObject({ shipmentId: a.parcel.id, fileCollected: '538.0000' });
      expect(first.rows[1]).toMatchObject({ shipmentId: b.parcel.id, fileCollected: '1000.0000' });
      // The preset is not saved: only a map the member gives is
      expect((await payable(steadfast)).csvMap).toBeNull();

      const payout = await pay(payoutBody(await today(a), [[a, '80']]));
      const again = await match(steadfast, csv);
      expect(again.rows[0]).toMatchObject({
        outcome: 'already_paid',
        shipmentId: null,
        payout: { id: payout.id, number: payout.number },
      });
    },
    COURIER_CLOCK,
  );

  it(
    'saves a map the member gave once the file has its columns, and uses it next time',
    async () => {
      const sent = await deliveredByHand(20);
      const csv = `Parcel ID,Collected\n${sent.parcel.trackingCode ?? ''},538\n`;
      // A manual account has no preset: the mapping step, with the file's columns
      expect(await match(pathao, csv)).toEqual({
        columns: ['Parcel ID', 'Collected'],
        map: null,
        missing: [],
        rows: [],
        fileNet: null,
      });
      // A map the file lacks: what is missing, no rows, nothing saved
      const wrong = {
        key: 'tracking_code',
        keyColumn: 'Tracking',
        collectedColumn: 'Collected',
        chargeColumn: '',
      };
      expect(await match(pathao, csv, wrong)).toMatchObject({ missing: ['Tracking'], rows: [] });
      expect((await payable(pathao)).csvMap).toBeNull();
      // One that fits (any case): matched and saved, and the account's version does not move
      const matched = await match(pathao, csv, { ...wrong, keyColumn: 'parcel id' });
      expect(matched.rows[0]).toMatchObject({ outcome: 'matched', shipmentId: sent.parcel.id });
      // Only one of the two amounts is mapped, so the file's net would be a guess
      expect(matched.fileNet).toBeNull();
      const saved = {
        key: 'tracking_code',
        keyColumn: 'parcel id',
        collectedColumn: 'Collected',
        chargeColumn: null,
      };
      expect((await payable(pathao)).csvMap).toEqual(saved);
      expect((await courierAccount(pathao.id)).version).toBe(pathao.version);
      // map null now reads with the saved one
      expect(await match(pathao, csv)).toMatchObject({ map: saved, missing: [] });
    },
    COURIER_CLOCK,
  );

  it('refuses a file it cannot read, one of too many rows and one too long', async () => {
    const url = `/storefront/couriers/${steadfast.id}/payout-match`;
    const broken = await refused(
      'POST',
      url,
      { csv: 'Invoice,"COD Amount\nW-1,538', map: null },
      422,
    );
    expect(broken).toMatchObject({
      code: 'payout_csv_unreadable',
      fieldErrors: { csv: ['payout_csv_unreadable'] },
    });
    const rows = Array.from({ length: 5001 }, (_, i) => `W-${String(i).padStart(6, '0')},1,1`);
    const csv = ['Invoice,COD Amount,Delivery Charge', ...rows].join('\n');
    expect((await refused('POST', url, { csv, map: null }, 422)).code).toBe(
      'payout_csv_too_many_rows',
    );
    const big = await refused('POST', url, { csv: 'x'.repeat(1_000_001), map: null }, 400);
    expect(big.fieldErrors).toEqual({ csv: ['payout_csv_too_big'] });
  });
});

describe('a payout', () => {
  it(
    'posts the bank, the charges and the COD account, and takes its parcels',
    async () => {
      const a = await delivered(30, 538, 80);
      const b = await delivered(31, 538, 60);
      const c = await returned(32, 50);
      const day = await today(a);
      const holds = await holdsOf(steadfast.id);
      const payout = await pay({
        ...payoutBody(day, [
          [a, '80'],
          [b, '60'],
          [c, '50'],
        ]),
        note: 'Steadfast weekly payout',
      });
      const [branch] = z
        .array(z.object({ id: z.string() }))
        .parse(
          await sql`SELECT branch_id::text AS id FROM warehouses WHERE id = ${shop.warehouseId}`,
        );
      expect(payout).toMatchObject({
        date: day,
        account: { id: steadfast.id, name: 'Steadfast Dhaka', courier: 'steadfast' },
        bankAccountId: bankId,
        codAccountId: codAccount.id,
        chargeAccountId: chargeAccount.id,
        branchId: branch?.id,
        reference: 'SFC-23618228',
        note: 'Steadfast weekly payout',
        parcels: 3,
        collected: '1076.0000',
        charges: '190.0000',
        net: '886.0000',
        status: 'posted',
        voidEntry: null,
      });
      expect(payout.number).toMatch(/^CPO-/);
      // By invoice; a charge line names no receipt
      expect(
        payout.lines.map((line) => [line.invoice, line.kind, line.collected, line.charge]),
      ).toEqual([
        [a.order.orderNo, 'cod', '538.0000', '80.0000'],
        [b.order.orderNo, 'cod', '538.0000', '60.0000'],
        [c.order.orderNo, 'charge', '0.0000', '50.0000'],
      ]);
      expect(payout.lines.map((line) => line.receipt?.id ?? null)).toEqual([
        a.parcel.receipt?.id,
        b.parcel.receipt?.id,
        null,
      ]);
      expect(await entryLines(payout.entry.id)).toEqual([
        ['bank', '886.0000', '0.0000'],
        ['charges', '190.0000', '0.0000'],
        ['cod', '0.0000', '1076.0000'],
      ]);
      // The courier holds the paid parcels no more, and each parcel card names the payout
      expect(await holdsOf(steadfast.id)).toEqual({
        amount: (Number(holds.amount) - 1076).toFixed(4),
        parcels: holds.parcels - 2,
      });
      expect((await sentOf(a.order)).parcel.payout).toEqual({
        id: payout.id,
        number: payout.number,
      });
      // Taken: a second payout of the same parcel says which line
      const twice = await refused('POST', '/storefront/payouts', payoutBody(day, [[b, '60']]), 409);
      expect(twice).toMatchObject({
        code: 'payout_parcel_unavailable',
        fieldErrors: { 'lines.0.shipmentId': ['payout_parcel_unavailable'] },
      });
      expect(
        payoutSchema.parse((await send('GET', `/storefront/payouts/${payout.id}`)).json()),
      ).toEqual(payout);
      const [logged] = await sql`SELECT payload->'changes'->'net'->>'to' AS net FROM audit_logs
        WHERE tenant_id = ${shop.tenantId} AND action = 'storefront_payout.created'
          AND entity_id = ${payout.id}`;
      expect(logged?.net).toBe('886.0000');
    },
    COURIER_CLOCK,
  );

  it(
    'posts no bank line when the charges take all of the cash, and no charge line without charges',
    async () => {
      const all = await delivered(40, 538, 80);
      const day = await today(all);
      const zero = await pay(payoutBody(day, [[all, '538']]));
      expect(zero.net).toBe('0.0000');
      expect(await entryLines(zero.entry.id)).toEqual([
        ['charges', '538.0000', '0.0000'],
        ['cod', '0.0000', '538.0000'],
      ]);
      // Pathao has no charges account: a payout with no charge needs none
      const byHand = await deliveredByHand(41);
      const plain = await pay(payoutBody(day, [[byHand, '0']], pathao));
      expect(plain.chargeAccountId).toBeNull();
      expect(await entryLines(plain.entry.id)).toEqual([
        ['bank', '538.0000', '0.0000'],
        ['cod', '0.0000', '538.0000'],
      ]);
    },
    COURIER_CLOCK,
  );

  it(
    'refuses what the books or the parcels cannot take, each under its box',
    async () => {
      const a = await delivered(50, 538, 80);
      const charge = await returned(51, 50);
      const onItsWay = await sentOf(await booked(52));
      const byHand = await deliveredByHand(53);
      const day = await today(a);
      const body = payoutBody(day, [[a, '80']]);
      const line = (sent: Sent, amount: string) => ({ shipmentId: sent.parcel.id, charge: amount });
      const cases: [object, number, string, Record<string, string[]>][] = [
        // The COD account is no bank, and an expense account holds no money
        [
          { bankAccountId: codAccount.id },
          422,
          'payout_bank_account_invalid',
          { bankAccountId: ['payout_bank_account_invalid'] },
        ],
        [
          { bankAccountId: chargeAccount.id },
          422,
          'payout_bank_account_invalid',
          { bankAccountId: ['payout_bank_account_invalid'] },
        ],
        // RedX has no COD account; Pathao no charges account for a charge
        [
          { accountId: redx.id },
          422,
          'payout_account_no_cod',
          { accountId: ['payout_account_no_cod'] },
        ],
        [
          payoutBody(day, [[byHand, '10']], pathao),
          422,
          'payout_account_no_charges',
          { accountId: ['payout_account_no_charges'] },
        ],
        // A charge line of ৳0, the charges over the cash, a charge line alone
        [
          { lines: [line(a, '80'), line(charge, '0')] },
          422,
          'payout_charge_line_zero',
          { 'lines.1.charge': ['payout_charge_line_zero'] },
        ],
        [{ lines: [line(a, '600')] }, 422, 'payout_below_zero', {}],
        [{ lines: [line(charge, '50')] }, 422, 'payout_below_zero', {}],
        // Before its COD receipt
        [
          { date: dayBefore(day) },
          422,
          'payout_date_before_receipt',
          { date: ['payout_date_before_receipt'] },
        ],
        // A parcel on its way, and one of another courier account
        [
          { lines: [line(a, '80'), line(onItsWay, '0')] },
          409,
          'payout_parcel_unavailable',
          { 'lines.1.shipmentId': ['payout_parcel_unavailable'] },
        ],
        [
          { lines: [line(byHand, '0')] },
          409,
          'payout_parcel_unavailable',
          { 'lines.0.shipmentId': ['payout_parcel_unavailable'] },
        ],
      ];
      for (const [wrong, status, code, fieldErrors] of cases) {
        const problem = await refused('POST', '/storefront/payouts', { ...body, ...wrong }, status);
        expect(problem.code, JSON.stringify(wrong)).toBe(code);
        expect(problem.fieldErrors ?? {}, code).toEqual(fieldErrors);
      }
      // The receipt's day, for the message
      const early = await refused(
        'POST',
        '/storefront/payouts',
        { ...body, date: dayBefore(day) },
        422,
      );
      expect(early.params).toEqual({ date: day });
      // The contract's own: the same parcel twice, on the second line
      const same = await refused(
        'POST',
        '/storefront/payouts',
        { ...body, lines: [line(a, '80'), line(a, '0')] },
        400,
      );
      expect(same.fieldErrors).toEqual({ 'lines.1.shipmentId': ['payout_line_twice'] });
      // Nothing was saved, and the parcel can still be paid out
      const [none] = await sql`SELECT count(*)::int AS n FROM storefront_payout_lines
        WHERE tenant_id = ${shop.tenantId} AND shipment_id = ${a.parcel.id}`;
      expect(none?.n).toBe(0);
      await pay(body);
    },
    COURIER_CLOCK,
  );

  it(
    'is refused in a closed period',
    async () => {
      const a = await delivered(60);
      const day = await today(a);
      await sql`INSERT INTO period_locks (tenant_id, lock_date) VALUES (${shop.tenantId}, ${day})
        ON CONFLICT (tenant_id) DO UPDATE SET lock_date = EXCLUDED.lock_date`;
      try {
        const res = await send('POST', '/storefront/payouts', payoutBody(day, [[a, '80']]));
        expect(refusalSchema.parse(res.json()).code, res.body).toBe('journal_period_locked');
      } finally {
        await sql`UPDATE period_locks SET lock_date = NULL WHERE tenant_id = ${shop.tenantId}`;
      }
      await pay(payoutBody(day, [[a, '80']]));
    },
    COURIER_CLOCK,
  );

  it(
    'still pays out an archived courier account’s parcels',
    async () => {
      const a = await deliveredByHand(70);
      const day = await today(a);
      const current = await courierAccount(pathao.id);
      const archived = await send('POST', `/storefront/couriers/${pathao.id}/archive`, {
        version: current.version,
      });
      expect(archived.statusCode, archived.body).toBe(200);
      try {
        const ids = (await payable(pathao)).parcels.map((parcel) => parcel.shipmentId);
        expect(ids).toContain(a.parcel.id);
        await pay(payoutBody(day, [[a, '0']], pathao));
      } finally {
        const now = courierAccountSchema.parse(archived.json());
        const back = await send('POST', `/storefront/couriers/${pathao.id}/restore`, {
          version: now.version,
        });
        expect(back.statusCode, back.body).toBe(200);
      }
    },
    COURIER_CLOCK,
  );
});

describe('voiding a payout', () => {
  it(
    'reverses its entry and frees its parcels, on its own page only',
    async () => {
      const a = await delivered(80, 538, 80);
      const c = await returned(81, 50);
      const day = await today(a);
      const payout = await pay(
        payoutBody(day, [
          [a, '80'],
          [c, '50'],
        ]),
      );
      // The journal does not undo it, and its COD receipt cannot be voided while it is paid out
      const entry = journalEntrySchema.parse(
        (await send('GET', `/journal-entries/${payout.entry.id}`)).json(),
      );
      const reverse = await refused(
        'POST',
        `/journal-entries/${entry.id}/reverse`,
        { version: entry.version, date: day },
        409,
      );
      expect(reverse.code).toBe('journal_is_payout');
      const receipt = await receiptOf(a);
      const voidReceipt = { version: receipt.version, date: day, reason: 'Typed by mistake' };
      expect((await refused('POST', `/receipts/${receipt.id}/void`, voidReceipt, 409)).code).toBe(
        'receipt_paid_out',
      );

      const url = `/storefront/payouts/${payout.id}/void`;
      const reason = 'Steadfast sent it twice';
      const early = await refused(
        'POST',
        url,
        { version: payout.version, date: dayBefore(day), reason },
        409,
      );
      expect(early).toMatchObject({
        code: 'receipt_void_date',
        fieldErrors: { date: ['receipt_void_date'] },
      });
      const stale = await refused(
        'POST',
        url,
        { version: payout.version + 1, date: day, reason },
        409,
      );
      expect(stale.code).toBe('version_conflict');
      const res = await send('POST', url, { version: payout.version, date: day, reason });
      expect(res.statusCode, res.body).toBe(200);
      const voided = payoutSchema.parse(res.json());
      expect(voided).toMatchObject({
        status: 'voided',
        voidDate: day,
        voidReason: reason,
        version: payout.version + 1,
        entry: { id: payout.entry.id },
      });
      // The lines stay, so the page still shows what it paid
      expect(voided.lines).toHaveLength(2);
      expect(await entryLines(voided.voidEntry?.id ?? '')).toEqual([
        ['bank', '0.0000', '408.0000'],
        ['charges', '0.0000', '130.0000'],
        ['cod', '538.0000', '0.0000'],
      ]);
      const again = await refused('POST', url, { version: voided.version, date: day, reason }, 409);
      expect(again.code).toBe('payout_voided');

      // Its parcels can be paid out again, and its COD receipt could be voided now
      expect((await sentOf(a.order)).parcel.payout).toBeNull();
      const ids = (await payable(steadfast)).parcels.map((parcel) => parcel.shipmentId);
      expect(ids).toEqual(expect.arrayContaining([a.parcel.id, c.parcel.id]));
      const next = await pay(
        payoutBody(day, [
          [a, '80'],
          [c, '50'],
        ]),
      );
      expect(next.number).not.toBe(payout.number);
    },
    COURIER_CLOCK,
  );
});

describe('at the same moment', () => {
  it(
    'lets one of two payouts of the same parcel through',
    async () => {
      const a = await delivered(90);
      const body = payoutBody(await today(a), [[a, '80']]);
      // The first holds the parcel's lock and waits at the journal; the second waits for the
      // parcel, then finds it paid out, so it can say which line (without the lock it would get as
      // far as the parcel's UPDATE, find nothing to update, and name no line)
      const [first, second] = await inTurn('journal_entries', [
        () => send('POST', '/storefront/payouts', body),
        () => send('POST', '/storefront/payouts', body),
      ]);
      expect(first?.statusCode, first?.body).toBe(201);
      expect(second?.statusCode, second?.body).toBe(409);
      expect(refusalSchema.parse(second?.json())).toMatchObject({
        code: 'payout_parcel_unavailable',
        fieldErrors: { 'lines.0.shipmentId': ['payout_parcel_unavailable'] },
      });
      const [lines] = await sql`SELECT count(*)::int AS n FROM storefront_payout_lines
        WHERE tenant_id = ${shop.tenantId} AND shipment_id = ${a.parcel.id}`;
      expect(lines?.n).toBe(1);
    },
    COURIER_CLOCK,
  );

  it(
    'takes turns with voiding the COD receipt: the payout first, so the void is refused',
    async () => {
      const a = await delivered(91);
      const receipt = await receiptOf(a);
      // The payout's line reads the receipt FOR SHARE; the void waits for that lock
      const [payout, voidIt] = await inTurn('journal_entries', [
        () => send('POST', '/storefront/payouts', payoutBody(receipt.date, [[a, '80']])),
        () =>
          send('POST', `/receipts/${receipt.id}/void`, {
            version: receipt.version,
            date: receipt.date,
            reason: 'The rider handed in the wrong parcel',
          }),
      ]);
      expect(payout?.statusCode, payout?.body).toBe(201);
      expect(voidIt?.statusCode, voidIt?.body).toBe(409);
      expect(refusalSchema.parse(voidIt?.json()).code).toBe('receipt_paid_out');
    },
    COURIER_CLOCK,
  );

  it(
    'takes turns with voiding the COD receipt: the void first, so the payout is refused',
    async () => {
      const a = await delivered(92);
      const receipt = await receiptOf(a);
      // The void holds the receipt's lock and waits at the journal; the payout's line then waits
      // for the receipt and finds it voided (0083's parcel check)
      const [voidIt, payout] = await inTurn('journal_entries', [
        () =>
          send('POST', `/receipts/${receipt.id}/void`, {
            version: receipt.version,
            date: receipt.date,
            reason: 'The rider handed in the wrong parcel',
          }),
        () => send('POST', '/storefront/payouts', payoutBody(receipt.date, [[a, '80']])),
      ]);
      expect(voidIt?.statusCode, voidIt?.body).toBe(200);
      expect(payout?.statusCode, payout?.body).toBe(409);
      expect(refusalSchema.parse(payout?.json()).code).toBe('payout_parcel_unavailable');
      const [made] = await sql`SELECT count(*)::int AS n FROM storefront_payouts
        WHERE tenant_id = ${shop.tenantId} AND reference = 'SFC-23618228'
          AND id IN (SELECT payout_id FROM storefront_payout_lines WHERE shipment_id = ${a.parcel.id})`;
      expect(made?.n).toBe(0);
    },
    COURIER_CLOCK,
  );
});

describe('the list and who may use it', () => {
  it('filters by status and courier account, and pages newest first', async () => {
    const all = payoutPageSchema.parse((await send('GET', '/storefront/payouts?limit=100')).json());
    expect(all.items.length).toBeGreaterThan(3);
    const voided = payoutPageSchema.parse(
      (await send('GET', '/storefront/payouts?status=voided')).json(),
    );
    expect(voided.items.length).toBeGreaterThan(0);
    expect(voided.items.every((item) => item.status === 'voided')).toBe(true);
    const byHand = payoutPageSchema.parse(
      (await send('GET', `/storefront/payouts?accountId=${pathao.id}`)).json(),
    );
    expect(byHand.items.length).toBeGreaterThan(0);
    expect(byHand.items.every((item) => item.account.id === pathao.id)).toBe(true);
    // Two at a time, never one twice, in the full list's order
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const page = payoutPageSchema.parse(
        (await send('GET', `/storefront/payouts?limit=2${after}`)).json(),
      );
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.items.map((item) => item.id));
  });

  it('needs storefront.payout.manage for every route, and nothing more to read them', async () => {
    const all = payoutPageSchema.parse((await send('GET', '/storefront/payouts')).json());
    const first = all.items[0];
    if (first === undefined) throw new Error('no payout yet');
    const day = first.date;
    const routes: ['GET' | 'POST', string, object?][] = [
      ['GET', '/storefront/payout-setup'],
      ['GET', '/storefront/payouts'],
      ['GET', `/storefront/payouts/${first.id}`],
      ['GET', `/storefront/couriers/${steadfast.id}/payout-parcels`],
      [
        'POST',
        `/storefront/couriers/${steadfast.id}/payout-match`,
        { csv: 'Invoice\nW-1', map: null },
      ],
      [
        'POST',
        '/storefront/payouts',
        { ...payoutBody(day, []), lines: [{ shipmentId: first.id, charge: '0' }] },
      ],
      [
        'POST',
        `/storefront/payouts/${first.id}/void`,
        { version: first.version, date: day, reason: 'x' },
      ],
    ];
    for (const [method, url, body] of routes) {
      const res = await send(method, url, body, clerk);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    for (const [method, url, body] of routes.slice(0, 5)) {
      const res = await send(method, url, body, payer);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(200);
    }
  });
});
