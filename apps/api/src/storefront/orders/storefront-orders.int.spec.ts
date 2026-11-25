import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  customerSchema,
  invoiceSchema,
  memberPageSchema,
  type PermissionKey,
  problemSchema,
  type Product,
  productSchema,
  roleSchema,
  salesOrderSchema,
  type ShopOrderRequestInput,
  type StorefrontOrder,
  storefrontOrderCountsSchema,
  storefrontOrderPageSchema,
  storefrontOrderSchema,
  storefrontPackPlanSchema,
  storefrontSetupSchema,
  type TrackingMode,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runWithTenant } from '../../common/tenant/tenant-context.js';
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
import { lastMailTo } from '../../testing/mailpit.js';
import {
  clientAddress,
  codeFor,
  deliveryServiceUpdate,
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
import { OrderConfirmedHandler } from './order-confirmed.handler.js';

// Step 27b: the shop's orders in the ERP, against the real stack. An order is placed and confirmed
// the way a shopper does it (the code from Mailpit), the worker's handler makes its customer and
// sales order, and the tests move it with the routes of Storefront → Shop orders, as the owner, as a
// packer who may do nothing else, and as someone who may only read. Phones and shopper addresses
// start at 800 (phoneOf, clientAddress): the limits count per phone and per address, so no two tests
// share one. Two requests "at the same moment" are held at a table lock (atOnce), never left to luck.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
// storefront.order.read and .manage, and nothing else: no sales.*, no inventory.*
let packer: SignedIn;
// storefront.order.read only
let reader: SignedIn;
let shop: OrderShop;
// The zone every order is delivered to. launchShop's own id at first; the settings test saves the
// zones again, and the save gives that zone an id of its own (deliveryServiceUpdate)
let zoneId = 'inside_dhaka';
// A batch product (two batches that expire at different times) and a serial one, each listed
let sunscreen: Listed;
let dryer: Listed;

interface Listed {
  product: Product;
  listingId: string;
}

// The order's three ways to fail a move: a step it cannot take from its status, a version the page
// read before someone else moved it, and an order this workspace cannot see
const refusalSchema = problemSchema.pick({ code: true, fieldErrors: true });

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, who = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function getOrder(id: string, who = owner): Promise<StorefrontOrder> {
  const res = await send('GET', `/storefront/orders/${id}`, undefined, who);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// A move that must go through, as `who`
async function move(
  id: string,
  step: 'pack' | 'ship' | 'deliver' | 'cancel' | 'sales-order',
  body: object,
  who = owner,
): Promise<StorefrontOrder> {
  const res = await send('POST', `/storefront/orders/${id}/${step}`, body, who);
  expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// A move that must be refused with this status; the problem's code and field errors
async function refusedMove(
  id: string,
  step: 'pack' | 'ship' | 'deliver' | 'cancel' | 'sales-order',
  body: object,
  status: number,
) {
  const res = await send('POST', `/storefront/orders/${id}/${step}`, body);
  expect(res.statusCode, `${step}: ${res.body}`).toBe(status);
  return refusalSchema.parse(res.json());
}

// The one pick of an untracked line: the whole quantity, no batch
function whole(position: number, quantity: string) {
  return { position, picks: [{ batchId: '', quantity, serialNumbers: [] }] };
}

// Places this request with the code from Mailpit, so the order is confirmed; returns its id. The
// zone is the shop's current one, whatever the request says
async function confirm(n: number, request: ShopOrderRequestInput): Promise<string> {
  const headers = shopHeaders(shop.host, clientAddress(n));
  const token = await placeOrder(app, headers, { ...request, zoneId });
  const { code } = await codeFor(mail.apiUrl, request.phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const [row] = z.array(z.object({ id: z.uuid() })).parse(
    await sql`
        SELECT id::text FROM storefront_orders
        WHERE tenant_id = ${shop.tenantId} AND phone = ${request.phone} AND status = 'confirmed'
        ORDER BY confirmed_at DESC LIMIT 1`,
  );
  if (row === undefined) throw new Error(`no confirmed order from ${request.phone}`);
  return row.id;
}

// Two face washes (৳229 each) plus the ৳80 delivery charge: ৳538
function twoNeem(n: number, name?: string): ShopOrderRequestInput {
  const request = orderRequest(shop.listingId, 2, phoneOf(n), '538');
  return name === undefined ? request : { ...request, name };
}

// The order once the worker's handler has made its sales order (or kept why it could not)
async function made(id: string): Promise<StorefrontOrder> {
  return eventually(async () => {
    const order = await getOrder(id);
    expect(order.salesOrder !== null || order.documentError !== null).toBe(true);
    return order;
  });
}

async function confirmedWithSalesOrder(n: number, request = twoNeem(n)): Promise<StorefrontOrder> {
  const order = await made(await confirm(n, request));
  expect(order.documentError).toBeNull();
  return order;
}

async function salesOrderOf(order: StorefrontOrder) {
  const res = await send('GET', `/sales-orders/${order.salesOrder?.id ?? ''}`);
  expect(res.statusCode, res.body).toBe(200);
  return salesOrderSchema.parse(res.json());
}

const auditRowSchema = z.object({ action: z.string(), actor: z.string().nullable() });

// The order's audit rows in the order they were written, read as the superuser
async function auditOf(entityId: string) {
  return z.array(auditRowSchema).parse(
    await sql`
      SELECT action, actor_user_id::text AS actor FROM audit_logs
      WHERE tenant_id = ${shop.tenantId} AND entity_id = ${entityId}
      ORDER BY created_at, id`,
  );
}

async function userIdOf(email: string): Promise<string> {
  const [row] = z
    .array(z.object({ id: z.uuid() }))
    .parse(await sql`SELECT id::text FROM users WHERE email = ${email}`);
  if (row === undefined) throw new Error(`no user ${email}`);
  return row.id;
}

// A user with a workspace of their own, who then joins this one with a role of these permissions
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

async function addProduct(
  name: string,
  salePrice: string,
  kind: { type?: 'goods' | 'service'; tracking?: TrackingMode; hasExpiry?: boolean } = {},
): Promise<Product> {
  const res = await send('POST', '/products', {
    code: '',
    name,
    type: kind.type ?? 'goods',
    categoryId: '',
    description: '',
    baseUnitId: shop.unitId,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: kind.tracking ?? 'none',
    hasExpiry: kind.hasExpiry ?? false,
    taxRateId: '',
    options: [],
    variants: [{ id: null, sku: '', optionValues: [], barcode: '', salePrice, archived: false }],
    units: [],
    customFields: {},
  });
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

// Stock in, with a cost, through a posted stock adjustment: the challan prices what leaves at the
// average cost, and a batch or a serial number exists only once stock brought it in
function stockLine(product: Product, quantity: string, extra: object = {}) {
  return {
    variantId: product.variants[0]?.id ?? '',
    unitId: shop.unitId,
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost: '150',
    ...extra,
  };
}

async function addCustomer(name: string, phone: string, extra: object = {}) {
  const res = await send('POST', '/customers', {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone,
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 0,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return customerSchema.parse(res.json());
}

// Sends requests "at the same moment" for sure (27a's shop-orders.int.spec.ts has the long
// story): a transaction of the test's own locks `table`, and only once `waiting` requests wait for
// a lock does the gate open. `withWorker`: one of them is a worker job the test runs itself
async function atOnce<T>(
  table: string,
  waiting: number,
  run: () => Promise<T>,
  withWorker = false,
): Promise<T> {
  const gate = await sql.begin(async (tx) => {
    await tx`LOCK TABLE ${tx(table)} IN SHARE MODE`;
    const sent = run();
    await eventually(async () => {
      expect(await lockWaitsOfApi(tx, { withWorker })).toBe(waiting);
    });
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
  sql = postgres(pg.superuserUrl, { max: 3 });
  owner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 0 });
  const sunscreenProduct = await addProduct('Sunscreen SPF 50', '450', {
    tracking: 'batch',
    hasExpiry: true,
  });
  const dryerProduct = await addProduct('Hair dryer 1200 W', '1800', { tracking: 'serial' });
  const neem = productSchema.parse((await send('GET', `/products/${shop.productId}`)).json());
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-11-01',
    warehouseId: shop.warehouseId,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      stockLine(neem, '200'),
      // FEFO takes SS-A first: it expires first, though it came in after SS-B
      stockLine(sunscreenProduct, '10', { lotNumber: 'SS-B', expiresOn: '2027-09-30' }),
      stockLine(sunscreenProduct, '3', { lotNumber: 'SS-A', expiresOn: '2027-03-31' }),
      stockLine(dryerProduct, '3', { serialNumbers: ['HD-1001', 'HD-1002', 'HD-1003'] }),
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);
  for (const [product, slug] of [
    [sunscreenProduct, 'sunscreen-spf-50'],
    [dryerProduct, 'hair-dryer'],
  ] as const) {
    const listingId = await addListing(sql, shop.tenantId, {
      product,
      categoryId: shop.categoryId,
      slug,
      publishedDaysAgo: 1,
    });
    if (product === sunscreenProduct) sunscreen = { product, listingId };
    else dryer = { product, listingId };
  }
  packer = await member('sumi@nirvor.com', 'Sumi Akter', [
    'storefront.order.read',
    'storefront.order.manage',
  ]);
  reader = await member('rafiq@nirvor.com', 'Rafiq Islam', ['storefront.order.read']);
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('an order from confirm to delivered', () => {
  it('is packed, shipped and delivered by a packer with only the storefront.order permissions', async () => {
    const id = await confirm(800, twoNeem(800));
    const order = await made(id);
    expect(order).toMatchObject({ status: 'confirmed', documentError: null, itemCount: 2 });
    const so = await salesOrderOf(order);
    expect(so).toMatchObject({
      status: 'confirmed',
      pricesIncludeVat: true,
      customerReference: order.orderNo,
      total: '538.0000',
    });
    // The face washes at the shop's price, then the delivery charge as a service (decision 4)
    expect(so.lines.map((line) => [line.productType, line.quantity, line.unitPrice])).toEqual([
      ['goods', '2.0000', '229.0000'],
      ['service', '1.0000', '80.0000'],
    ]);

    // The packer may not post a challan or an invoice of their own: the moves below need no
    // sales.* (decision 9). The guard answers before the empty body is looked at
    for (const url of ['/deliveries', '/invoices']) {
      expect((await send('POST', url, {}, packer)).statusCode, url).toBe(403);
    }
    const plan = storefrontPackPlanSchema.parse(
      (await send('GET', `/storefront/orders/${id}/pack-plan`, undefined, packer)).json(),
    );
    expect(plan.warehouse.id).toBe(shop.warehouseId);
    expect(plan.lines).toEqual([
      expect.objectContaining({
        position: 1,
        quantity: '2',
        tracking: 'none',
        batches: [],
        picks: [{ batchId: null, quantity: '2', serialNumbers: [] }],
      }),
    ]);
    const packed = await move(
      id,
      'pack',
      { version: order.version, lines: [whole(1, '2')] },
      packer,
    );
    expect(packed.status).toBe('packed');
    expect(packed.delivery?.number).toMatch(/^DC-/);
    // The stock has really left: the hold is gone, and the challan took the pieces off the shelf
    expect(await sql`SELECT 1 FROM storefront_stock_holds WHERE order_id = ${id}`).toHaveLength(0);
    const [left] = await sql`
      SELECT quantity::text AS q FROM stock_balances
      WHERE tenant_id = ${shop.tenantId} AND variant_id = ${shop.variantId}`;
    expect(left?.q).toBe('198.0000');
    // The sales order is delivered: its only goods line went out (the charge is a service)
    expect((await salesOrderOf(packed)).status).toBe('delivered');

    const shipped = await move(id, 'ship', { version: packed.version }, packer);
    const delivered = await move(id, 'deliver', { version: shipped.version }, packer);
    expect(delivered.status).toBe('delivered');
    const invoice = invoiceSchema.parse(
      (await send('GET', `/invoices/${delivered.invoice?.id ?? ''}`)).json(),
    );
    // Unpaid: the cash the rider brings back is a money receipt (decision 7)
    expect(invoice).toMatchObject({
      status: 'posted',
      total: '538.0000',
      amountPaid: '0.0000',
      customerReference: order.orderNo,
    });
    expect(invoice.lines).toHaveLength(2);
    expect(delivered.history.map((step) => step.status)).toEqual([
      'pending',
      'confirmed',
      'packed',
      'shipped',
      'delivered',
    ]);

    // Who did what: the worker made the sales order with no one behind it; the packer did the rest
    const sumi = await userIdOf('sumi@nirvor.com');
    expect(await auditOf(id)).toEqual([
      { action: 'storefront_order.sales_order_made', actor: null },
      { action: 'storefront_order.packed', actor: sumi },
      { action: 'storefront_order.shipped', actor: sumi },
      { action: 'storefront_order.delivered', actor: sumi },
    ]);

    // The first order with a charge made "Delivery charge" and saved it in the shop's settings
    const setup = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
    const saved = setup.shop?.deliveryVariantId ?? null;
    expect(saved).toBe(so.lines[1]?.variantId);
    expect(setup.deliveryChoices).toEqual([
      expect.objectContaining({ variantId: saved, name: 'Delivery charge' }),
    ]);
  });

  it('lets a reader list and open the orders, and refuses every move and the pack plan', async () => {
    const id = await confirm(801, twoNeem(801));
    const order = await made(id);
    const list = storefrontOrderPageSchema.parse(
      (await send('GET', '/storefront/orders', undefined, reader)).json(),
    );
    expect(list.items.map((item) => item.id)).toContain(id);
    expect((await send('GET', '/storefront/orders/counts', undefined, reader)).statusCode).toBe(
      200,
    );
    expect((await getOrder(id, reader)).orderNo).toBe(order.orderNo);

    for (const [method, step, body] of [
      ['GET', 'pack-plan', undefined],
      ['POST', 'sales-order', { version: order.version }],
      ['POST', 'pack', { version: order.version, lines: [whole(1, '2')] }],
      ['POST', 'ship', { version: order.version }],
      ['POST', 'deliver', { version: order.version }],
      ['POST', 'cancel', { version: order.version, reason: '' }],
    ] as const) {
      const res = await send(method, `/storefront/orders/${id}/${step}`, body, reader);
      expect(res.statusCode, step).toBe(403);
    }
    // Nothing moved
    expect(await getOrder(id)).toMatchObject({ status: 'confirmed', version: order.version });
  });
});

describe('the steps', () => {
  it('refuses a step the order cannot take from where it is, and a version read before a move', async () => {
    const order = await confirmedWithSalesOrder(802);
    const { id } = order;
    const step = { code: 'storefront_order_step_invalid' };
    const at = (version: number) => ({ version });

    expect(await refusedMove(id, 'ship', at(order.version), 409)).toMatchObject(step);
    expect(await refusedMove(id, 'deliver', at(order.version), 409)).toMatchObject(step);
    // It has its sales order already: "Make the sales order" is not offered, and not taken
    expect(await refusedMove(id, 'sales-order', at(order.version), 409)).toMatchObject(step);

    const packed = await move(id, 'pack', { version: order.version, lines: [whole(1, '2')] });
    // The page that still has the confirmed order: it must reload, not pack a second challan
    expect(
      await refusedMove(id, 'pack', { version: order.version, lines: [whole(1, '2')] }, 409),
    ).toMatchObject({ code: 'version_conflict' });
    expect(
      await refusedMove(id, 'pack', { version: packed.version, lines: [whole(1, '2')] }, 409),
    ).toMatchObject(step);
    // Delivered only after Shipped (decision 7)
    expect(await refusedMove(id, 'deliver', at(packed.version), 409)).toMatchObject(step);
    const planned = await send('GET', `/storefront/orders/${id}/pack-plan`);
    expect(refusalSchema.parse(planned.json())).toMatchObject(step);

    const shipped = await move(id, 'ship', at(packed.version));
    // After Shipped a cancel is a return, which is step 28's (decision 8)
    expect(
      await refusedMove(id, 'cancel', { version: shipped.version, reason: '' }, 409),
    ).toMatchObject(step);
    expect(await refusedMove(id, 'ship', at(shipped.version), 409)).toMatchObject(step);
    expect((await getOrder(id)).status).toBe('shipped');
  });

  it('shows no order that waits for its code, and moves none', async () => {
    const phone = phoneOf(803);
    await placeOrder(app, shopHeaders(shop.host, clientAddress(803)), {
      ...orderRequest(shop.listingId, 2, phone, '538'),
      zoneId,
    });
    const [row] = z
      .array(z.object({ id: z.uuid() }))
      .parse(await sql`SELECT id::text FROM storefront_orders WHERE phone = ${phone}`);
    const id = row?.id ?? '';
    expect((await send('GET', `/storefront/orders/${id}`)).statusCode).toBe(404);
    expect((await send('GET', `/storefront/orders/${id}/pack-plan`)).statusCode).toBe(404);
    expect(await refusedMove(id, 'cancel', { version: 1, reason: '' }, 404)).toMatchObject({
      code: 'not_found',
    });
    const all = storefrontOrderPageSchema.parse(
      (await send('GET', '/storefront/orders?view=all&limit=100')).json(),
    );
    expect(all.items.map((item) => item.id)).not.toContain(id);
  });
});

describe('the customer', () => {
  it('is the oldest active one with the phone, typed in any form; an archived one is left out', async () => {
    // phoneOf(804), 01711000804, typed three ways. The first is the oldest, but archived
    const old = await addCustomer('Mirpur Beauty Corner', '+880 1711-000804');
    const archived = await send('POST', `/customers/${old.id}/archive`, { version: old.version });
    expect(archived.statusCode, archived.body).toBe(200);
    const oldest = await addCustomer('Sylhet Pharmacy', '01711 000804');
    await addCustomer('Sylhet Pharmacy (branch)', '01711-000-804');

    const order = await confirmedWithSalesOrder(804);
    expect(order.customer).toEqual({ id: oldest.id, name: 'Sylhet Pharmacy' });
    const [count] = await sql`
      SELECT count(*)::int AS n FROM parties
      WHERE tenant_id = ${shop.tenantId} AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%1711000804'`;
    expect(count?.n).toBe(3);
  });

  it('is new when no one has the phone: no credit limit, the shop language, the address saved', async () => {
    const order = await confirmedWithSalesOrder(805, twoNeem(805, 'Tanvir Hasan'));
    const customer = customerSchema.parse(
      (await send('GET', `/customers/${order.customer?.id ?? ''}`)).json(),
    );
    expect(customer).toMatchObject({
      name: 'Tanvir Hasan',
      phone: phoneOf(805),
      creditLimit: null,
      documentLanguage: 'en',
    });
    expect(customer.addresses).toEqual([
      expect.objectContaining({ kind: 'shipping', address: 'House 12, Road 5, Mirpur 10, Dhaka' }),
    ]);
  });

  it('goes over a credit limit, and the audit log has the override with no one behind it', async () => {
    const limited = await addCustomer('Uttara Cosmetics', phoneOf(806), { creditLimit: '100' });
    const order = await confirmedWithSalesOrder(806);
    expect(order.customer?.id).toBe(limited.id);
    const so = await salesOrderOf(order);
    expect(so.status).toBe('confirmed');
    expect(await auditOf(so.id)).toContainEqual({ action: 'credit_limit.overridden', actor: null });
  });
});

describe('the delivery charge', () => {
  it('is sold as the service picked in the settings, and a free delivery adds no line', async () => {
    const before = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
    if (before.shop === null) throw new Error('no shop');
    // A product that is not a service is refused
    const goods = await send(
      'PUT',
      '/storefront/settings',
      deliveryServiceUpdate(before.shop, shop.variantId),
    );
    expect(refusalSchema.parse(goods.json())).toMatchObject({
      code: 'storefront_delivery_product_invalid',
      fieldErrors: { deliveryVariantId: ['storefront_delivery_product_invalid'] },
    });
    const courier = await addProduct('Courier charge', '', { type: 'service' });
    const courierVariant = courier.variants[0]?.id ?? '';
    const saved = await send(
      'PUT',
      '/storefront/settings',
      deliveryServiceUpdate(before.shop, courierVariant),
    );
    expect(saved.statusCode, saved.body).toBe(200);
    const after = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
    expect(after.shop?.deliveryVariantId).toBe(courierVariant);
    zoneId = after.shop?.deliveryZones[0]?.id ?? '';

    const charged = await salesOrderOf(await confirmedWithSalesOrder(807));
    expect(charged.lines.map((line) => line.variantId)).toEqual([shop.variantId, courierVariant]);
    // 5 × ৳229 = ৳1,145, over the shop's ৳1,000: no delivery charge, so no line of ৳0
    const free = await salesOrderOf(
      await confirmedWithSalesOrder(808, orderRequest(shop.listingId, 5, phoneOf(808), '1145')),
    );
    expect(free.lines.map((line) => line.variantId)).toEqual([shop.variantId]);
    expect(free.total).toBe('1145.0000');
    // Still the one "Delivery charge" the first order made: none was made for these
    const [count] = await sql`
      SELECT count(*)::int AS n FROM products
      WHERE tenant_id = ${shop.tenantId} AND name = 'Delivery charge'`;
    expect(count?.n).toBe(1);
  });
});

describe('packing tracked stock', () => {
  it('suggests the batch that expires first, and names the pick that asks too much of a batch', async () => {
    const order = await confirmedWithSalesOrder(
      809,
      // 5 × ৳450 = ৳2,250: free delivery
      orderRequest(sunscreen.listingId, 5, phoneOf(809), '2250'),
    );
    const plan = storefrontPackPlanSchema.parse(
      (await send('GET', `/storefront/orders/${order.id}/pack-plan`)).json(),
    );
    const [line] = plan.lines;
    expect(line?.tracking).toBe('batch');
    expect(line?.batches.map((batch) => [batch.lotNumber, batch.available])).toEqual([
      ['SS-A', '3.0000'],
      ['SS-B', '10.0000'],
    ]);
    const [a, b] = line?.batches ?? [];
    expect(line?.picks).toEqual([
      // The quantities as the API writes stock (4 decimals); the dialog shows them in the unit's
      { batchId: a?.batchId, quantity: '3.0000', serialNumbers: [] },
      { batchId: b?.batchId, quantity: '2.0000', serialNumbers: [] },
    ]);

    // One from SS-B and four from SS-A, which has three: the error is on the second pick
    const over = await refusedMove(
      order.id,
      'pack',
      {
        version: order.version,
        lines: [
          {
            position: 1,
            picks: [
              { batchId: b?.batchId, quantity: '1', serialNumbers: [] },
              { batchId: a?.batchId, quantity: '4', serialNumbers: [] },
            ],
          },
        ],
      },
      409,
    );
    expect(over).toMatchObject({
      code: 'stock_insufficient',
      fieldErrors: { 'lines.0.picks.1.quantity': ['stock_insufficient'] },
    });
    // Picks that do not add up to the line: the packer's box is short
    const short = await refusedMove(
      order.id,
      'pack',
      {
        version: order.version,
        lines: [
          { position: 1, picks: [{ batchId: a?.batchId, quantity: '3', serialNumbers: [] }] },
        ],
      },
      409,
    );
    expect(short.fieldErrors).toEqual({ 'lines.0.picks': ['storefront_order_pick_total'] });

    const packed = await move(order.id, 'pack', {
      version: order.version,
      lines: [
        {
          position: 1,
          picks: (line?.picks ?? []).map((pick) => ({ ...pick, batchId: pick.batchId ?? '' })),
        },
      ],
    });
    expect(packed.status).toBe('packed');
    const left = await sql`
      SELECT b.lot_number AS lot, s.quantity::text AS q FROM stock_balances s
      JOIN batches b ON b.tenant_id = s.tenant_id AND b.id = s.batch_id
      WHERE s.tenant_id = ${shop.tenantId} AND s.variant_id = ${sunscreen.product.variants[0]?.id ?? ''}
      ORDER BY b.lot_number`;
    expect(
      z
        .array(z.object({ lot: z.string(), q: z.string() }))
        .parse(left)
        .map((row) => [row.lot, row.q]),
    ).toEqual([
      ['SS-A', '0.0000'],
      ['SS-B', '8.0000'],
    ]);
  });

  it('packs a serial product with the numbers the packer types, and a cancel brings them back', async () => {
    // 2 × ৳1,800: free delivery
    const order = await confirmedWithSalesOrder(
      810,
      orderRequest(dryer.listingId, 2, phoneOf(810), '3600'),
    );
    const plan = storefrontPackPlanSchema.parse(
      (await send('GET', `/storefront/orders/${order.id}/pack-plan`)).json(),
    );
    // Only the packer knows which pieces went in the box: no suggestion
    expect(plan.lines[0]).toMatchObject({ tracking: 'serial', batches: [], picks: [] });
    const pack = (serialNumbers: string[]) => ({
      version: order.version,
      lines: [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers }] }],
    });
    expect(await refusedMove(order.id, 'pack', pack(['HD-1001']), 409)).toMatchObject({
      fieldErrors: { 'lines.0.picks.0.serialNumbers': ['stock_serial_count'] },
    });
    expect(await refusedMove(order.id, 'pack', pack(['HD-1001', 'HD-9999']), 409)).toMatchObject({
      code: 'stock_serial_not_here',
    });
    const packed = await move(order.id, 'pack', pack(['HD-1001', 'HD-1003']));
    // The dryer's serial numbers on a shelf (a serial out of stock has no warehouse)
    const serials = async () =>
      z
        .array(z.object({ s: z.string() }))
        .parse(
          await sql`
            SELECT serial_number AS s FROM serials
            WHERE tenant_id = ${shop.tenantId} AND warehouse_id IS NOT NULL
            ORDER BY serial_number`,
        )
        .map((row) => row.s);
    expect(await serials()).toEqual(['HD-1002']);

    const cancelled = await move(order.id, 'cancel', {
      version: packed.version,
      reason: 'Customer did not answer the phone',
    });
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Customer did not answer the phone',
    });
    expect(cancelled.salesReturn?.number).toMatch(/^SR-/);
    expect(await serials()).toEqual(['HD-1001', 'HD-1002', 'HD-1003']);
    expect((await salesOrderOf(cancelled)).status).toBe('cancelled');
    // The shopper hears of it by SMS, without the staff's reason
    await eventually(async () => {
      const sms = await lastMailTo(mail.apiUrl, smsAddress(phoneOf(810)));
      expect(sms.text).toContain(`${order.orderNo} was cancelled`);
      expect(sms.text).not.toContain('did not answer');
    });
  });
});

describe('a cancel before packing', () => {
  it('ends the hold and cancels the sales order', async () => {
    const order = await confirmedWithSalesOrder(811);
    const gone = await move(order.id, 'cancel', { version: order.version, reason: '' });
    expect(gone).toMatchObject({ status: 'cancelled', cancelReason: null, salesReturn: null });
    expect(
      await sql`SELECT 1 FROM storefront_stock_holds WHERE order_id = ${order.id}`,
    ).toHaveLength(0);
    expect((await salesOrderOf(gone)).status).toBe('cancelled');
    expect((await auditOf(order.id)).map((row) => row.action)).toEqual([
      'storefront_order.sales_order_made',
      'storefront_order.cancelled',
    ]);
  });

  it('may not empty the delivery service once an order used it', async () => {
    const setup = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
    if (setup.shop === null) throw new Error('no shop');
    const emptied = await send(
      'PUT',
      '/storefront/settings',
      deliveryServiceUpdate(setup.shop, ''),
    );
    expect(refusalSchema.parse(emptied.json()).code).toBe('storefront_delivery_product_required');
  });
});

describe('a sales order that cannot be made', () => {
  it('keeps the reason, refuses to pack, and is made when the page asks again', async () => {
    // No default VAT rate and none on the product: the sales order is refused
    await sql`UPDATE tax_rates SET is_default = false WHERE tenant_id = ${shop.tenantId}`;
    const id = await confirm(812, twoNeem(812));
    const failed = await made(id);
    expect(failed).toMatchObject({ documentError: 'tax_rate_invalid', needsAttention: true });
    expect(
      await refusedMove(id, 'pack', { version: failed.version, lines: [whole(1, '2')] }, 409),
    ).toMatchObject({ code: 'storefront_order_no_sales_order' });
    // Asked again before the cause is fixed: the same reason, kept, and the version moves on
    expect(await refusedMove(id, 'sales-order', { version: failed.version }, 409)).toMatchObject({
      code: 'tax_rate_invalid',
    });
    const still = await getOrder(id);
    expect(still.documentError).toBe('tax_rate_invalid');

    await sql`
      UPDATE tax_rates SET is_default = true
      WHERE tenant_id = ${shop.tenantId} AND name = 'VAT 15%'`;
    const retried = await move(id, 'sales-order', { version: still.version });
    expect(retried).toMatchObject({ documentError: null, needsAttention: false });
    expect(retried.salesOrder?.number).toMatch(/^SO-/);
  });
});

describe('at the same moment', () => {
  it('lets one of pack and cancel through, and the documents match the status it left', async () => {
    const order = await confirmedWithSalesOrder(813);
    // Both lock the order first; the one that gets it waits at the holds, the other at the order
    const [pack, cancel] = await atOnce('storefront_stock_holds', 2, () =>
      Promise.all([
        send('POST', `/storefront/orders/${order.id}/pack`, {
          version: order.version,
          lines: [whole(1, '2')],
        }),
        send('POST', `/storefront/orders/${order.id}/cancel`, {
          version: order.version,
          reason: '',
        }),
      ]),
    );
    const codes = [pack, cancel].map((res) => res.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    const loser = pack.statusCode === 409 ? pack : cancel;
    expect(refusalSchema.parse(loser.json()).code).toBe('version_conflict');

    const after = await getOrder(order.id);
    const so = await salesOrderOf(after);
    if (after.status === 'packed') {
      expect(after.delivery).not.toBeNull();
      // Every piece of goods went on the challan; the delivery charge is a service, never delivered
      expect(so.status).toBe('delivered');
    } else {
      expect(after.status).toBe('cancelled');
      expect(after.delivery).toBeNull();
      expect(so.status).toBe('cancelled');
    }
    expect(
      await sql`SELECT 1 FROM storefront_stock_holds WHERE order_id = ${order.id}`,
    ).toHaveLength(0);
  });

  it('makes one sales order when the job and the page make it together, and none on a second run', async () => {
    await sql`UPDATE tax_rates SET is_default = false WHERE tenant_id = ${shop.tenantId}`;
    const id = await confirm(814, twoNeem(814));
    const failed = await made(id);
    expect(failed.documentError).toBe('tax_rate_invalid');
    await sql`
      UPDATE tax_rates SET is_default = true
      WHERE tenant_id = ${shop.tenantId} AND name = 'VAT 15%'`;

    // The confirm's own event, run again by the handler as the worker would after a retry
    const [event] = z.array(z.object({ id: z.uuid() })).parse(
      await sql`
          SELECT id::text FROM outbox_events
          WHERE type = 'storefront.order_confirmed' AND payload->>'orderId' = ${id}`,
    );
    const handler = worker.get(OrderConfirmedHandler);
    const runJob = () =>
      runWithTenant(shop.tenantId, () =>
        handler.handle({
          id: event?.id ?? '',
          tenantId: shop.tenantId,
          type: 'storefront.order_confirmed',
          payload: { orderId: id },
          requestId: null,
        }),
      );
    // The one that locks the order first waits at the sales orders; the other at the order
    const [page] = await atOnce(
      'sales_orders',
      2,
      () =>
        Promise.all([
          send('POST', `/storefront/orders/${id}/sales-order`, { version: failed.version }),
          runJob(),
        ]),
      true,
    );
    // The page wins (200) or finds the job made it (the version moved on)
    expect([200, 409]).toContain(page.statusCode);
    await runJob();

    const after = await getOrder(id);
    const rows = await sql`
      SELECT id::text FROM sales_orders
      WHERE tenant_id = ${shop.tenantId} AND customer_reference = ${after.orderNo}`;
    expect(
      z
        .array(z.object({ id: z.uuid() }))
        .parse(rows)
        .map((row) => row.id),
    ).toEqual([after.salesOrder?.id]);
    expect(
      (await auditOf(id)).filter((row) => row.action === 'storefront_order.sales_order_made'),
    ).toHaveLength(1);
    // The bell rang once for the order, however many times the job ran
    const [bells] = await sql`
      SELECT count(*)::int AS n FROM notifications
      WHERE tenant_id = ${shop.tenantId} AND type = 'storefront.order_confirmed'
        AND params->>'id' = ${id} AND user_id = ${await userIdOf('nusrat@nirvor.com')}`;
    expect(bells?.n).toBe(1);
  });
});

describe('the list', () => {
  it('shows each tab its own orders, and the count of new ones', async () => {
    const statusOf = z.array(z.object({ status: z.string(), n: z.number() }));
    const byStatus = new Map(
      statusOf
        .parse(
          await sql`
            SELECT status, count(*)::int AS n FROM storefront_orders
            WHERE tenant_id = ${shop.tenantId} AND status <> 'pending' GROUP BY status`,
        )
        .map((row) => [row.status, row.n]),
    );
    for (const view of ['confirmed', 'packed', 'shipped', 'delivered', 'cancelled'] as const) {
      const page = storefrontOrderPageSchema.parse(
        (await send('GET', `/storefront/orders?view=${view}&limit=100`)).json(),
      );
      expect(
        page.items.every((item) => item.status === view),
        view,
      ).toBe(true);
      expect(page.items, view).toHaveLength(byStatus.get(view) ?? 0);
    }
    const counts = storefrontOrderCountsSchema.parse(
      (await send('GET', '/storefront/orders/counts')).json(),
    );
    expect(counts.confirmed).toBe(byStatus.get('confirmed'));
  });

  it('sorts by total both ways a page at a time, and refuses the cursor of another sort', async () => {
    const all = z.array(z.object({ id: z.uuid(), total: z.string() })).parse(
      await sql`
        SELECT id::text, total::text FROM storefront_orders
        WHERE tenant_id = ${shop.tenantId} AND status <> 'pending'`,
    );
    // Two face-wash orders have one total: the id breaks the tie, the same way both directions
    const byTotal = [...all].sort(
      (a, b) => Number(a.total) - Number(b.total) || a.id.localeCompare(b.id),
    );
    const walk = async (sort: string) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ view: 'all', sort, limit: '3' });
        if (cursor !== null) query.set('cursor', cursor);
        const page = storefrontOrderPageSchema.parse(
          (await send('GET', `/storefront/orders?${query.toString()}`)).json(),
        );
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      return ids;
    };
    expect(await walk('total')).toEqual(byTotal.map((row) => row.id));
    expect(await walk('-total')).toEqual(byTotal.map((row) => row.id).reverse());

    const first = storefrontOrderPageSchema.parse(
      (await send('GET', '/storefront/orders?view=all&sort=-total&limit=2')).json(),
    );
    const other = await send(
      'GET',
      `/storefront/orders?view=all&sort=confirmed&limit=2&cursor=${first.nextCursor ?? ''}`,
    );
    expect(other.statusCode).toBe(400);
    expect(refusalSchema.parse(other.json()).code).toBe('invalid_cursor');
  });

  it('finds an order by part of its number, the name, or the phone typed with spaces', async () => {
    const tanvir = await getOrder(
      z
        .array(z.object({ id: z.uuid() }))
        .parse(await sql`SELECT id::text FROM storefront_orders WHERE phone = ${phoneOf(805)}`)[0]
        ?.id ?? '',
    );
    const found = async (search: string) =>
      storefrontOrderPageSchema
        .parse(
          (
            await send('GET', `/storefront/orders?view=all&search=${encodeURIComponent(search)}`)
          ).json(),
        )
        .items.map((item) => item.id);
    expect(await found('tanvir')).toEqual([tanvir.id]);
    expect(await found('01711 000805')).toEqual([tanvir.id]);
    expect(await found(tanvir.orderNo.toLowerCase())).toEqual([tanvir.id]);
    expect(await found('Nobody by this name')).toEqual([]);
  });
});
