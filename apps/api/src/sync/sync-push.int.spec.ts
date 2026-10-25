import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  branchSchema,
  type Customer,
  type CustomerFormValues,
  customerSchema,
  type Device,
  deviceSchema,
  memberPageSchema,
  type NewAddressInput,
  problemSchema,
  type Product,
  productSchema,
  roleSchema,
  salesOrderSchema,
  setupSchema,
  type SyncChange,
  type SyncCommandInput,
  type SyncResult,
  syncPushSchema,
  taxRateListSchema,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
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
} from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';
import { SyncLogCleanup } from './sync-log-cleanup.js';

// A distributor in Narsingdi whose sales officers write customers and orders on a laptop and a
// tablet without a connection, and push them later. Every test makes its own shop, so a test can
// run on its own; the order of the tests matters only for the roles (Rafiq's role comes and goes).
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: what the API cannot do yet (revoke a device: 18c) or never does (age an answer)
let sql: postgres.Sql;
let owner: SignedIn;
let rafiq: SignedIn;
let laptop: Device;
let tablet: Device;
let rafiqLaptop: Device;
let depot: Warehouse;
let ctgDepot: Warehouse;
let oldStore: Warehouse;
let taxRateId: string;
let pcs: string;
let juice: Product;
let karim: Customer;

type CreateCommand = Extract<SyncCommandInput, { type: 'customer.create' }>;
type UpdateCommand = Extract<SyncCommandInput, { type: 'customer.update' }>;
type OrderCommand = Extract<SyncCommandInput, { type: 'sales_order.create_draft' }>;

// A UUIDv7 as a device makes it. Only the version digit matters to the server's checks.
function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({ method, url, headers: bearer(as.accessToken), ...(payload && { payload }) });
}

async function created<T>(schema: z.ZodType<T>, url: string, payload: object): Promise<T> {
  const res = await send('POST', url, payload);
  expect(res.statusCode, res.body).toBe(201);
  return schema.parse(res.json());
}

function pushRequest(
  commands: (SyncCommandInput | Record<string, unknown>)[],
  {
    as = owner,
    device = laptop,
    protocol = 1,
  }: { as?: SignedIn; device?: Device; protocol?: number } = {},
) {
  return send('POST', '/sync/push', { deviceId: device.id, protocol, commands }, as);
}

async function push(
  commands: (SyncCommandInput | Record<string, unknown>)[],
  options: { as?: SignedIn; device?: Device } = {},
): Promise<SyncResult[]> {
  const res = await pushRequest(commands, options);
  expect(res.statusCode, res.body).toBe(200);
  const { results } = syncPushSchema.parse(res.json());
  // One answer per command, in the order sent
  expect(results.map((result) => result.id)).toEqual(
    commands.map((command) => (typeof command.id === 'string' ? command.id : '')),
  );
  return results;
}

function accepted(result: SyncResult | undefined) {
  if (result?.status !== 'accepted') throw new Error(`not accepted: ${JSON.stringify(result)}`);
  return result;
}

function refusal(result: SyncResult | undefined) {
  if (result?.status !== 'rejected') throw new Error(`not refused: ${JSON.stringify(result)}`);
  return result.error;
}

// What each answer was: "accepted", or the refusal's code
function outcomes(results: SyncResult[]): string[] {
  return results.map((result) =>
    result.status === 'rejected' ? result.error.code : result.status,
  );
}

// The customer row an answer sends the device to write at once
function customerIn(changes: SyncChange[]) {
  expect(changes).toHaveLength(1);
  const [change] = changes;
  if (change?.op !== 'upsert' || change.entity !== 'customer') {
    throw new Error(`not a customer row: ${JSON.stringify(change)}`);
  }
  return change.data;
}

function customerForm(name: string, extra: Partial<CustomerFormValues> = {}): CustomerFormValues {
  return {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'bn',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  };
}

// The form as the customer page fills it from a customer
function formOf(customer: Customer): CustomerFormValues {
  return {
    code: customer.code,
    name: customer.name,
    groupId: customer.groupId ?? '',
    contactPerson: customer.contactPerson ?? '',
    phone: customer.phone ?? '',
    email: customer.email ?? '',
    documentLanguage: customer.documentLanguage,
    bin: customer.bin ?? '',
    paymentTermsDays: customer.paymentTermsDays,
    creditLimit: customer.creditLimit ?? '',
    priceListId: customer.priceListId ?? '',
    notes: customer.notes ?? '',
    addresses: customer.addresses.map((address) => ({
      id: address.id,
      kind: address.kind === 'billing' ? 'billing' : 'shipping',
      label: address.label ?? '',
      address: address.address,
      phone: address.phone ?? '',
    })),
  };
}

// A shop saved online, through the form's route
async function shop(name: string, extra: Partial<CustomerFormValues> = {}): Promise<Customer> {
  return created(customerSchema, '/customers', customerForm(name, extra));
}

// A change saved online by the head office, from the customer as it is now
async function editOnline(
  customer: Customer,
  edit: (form: CustomerFormValues) => CustomerFormValues,
): Promise<Customer> {
  const now = await customerNow(customer.id);
  const res = await send('PUT', `/customers/${customer.id}`, {
    ...edit(formOf(now)),
    version: now.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  return customerSchema.parse(res.json());
}

async function customerNow(id: string): Promise<Customer> {
  const res = await send('GET', `/customers/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return customerSchema.parse(res.json());
}

function address(kind: 'billing' | 'shipping', text: string): NewAddressInput {
  return { id: v7(), kind, label: '', address: text, phone: '' };
}

function newCustomer(name: string, extra: Partial<CreateCommand['input']> = {}): CreateCommand {
  return {
    id: v7(),
    type: 'customer.create',
    customerId: v7(),
    input: { ...customerForm(name), addresses: [], ...extra },
  };
}

// A change made on a device from the customer as the device read it
function changeOf(
  customer: Customer,
  changes: UpdateCommand['changes'],
  addresses: Partial<UpdateCommand['addresses']> = {},
): UpdateCommand {
  return {
    id: v7(),
    type: 'customer.update',
    customerId: customer.id,
    baseVersion: customer.version,
    changes,
    addresses: { add: [], remove: [], change: [], ...addresses },
  };
}

// Two dozen mango juice at ৳25, 15% VAT: net ৳600, total ৳690
function newOrder(customerId: string, extra: Partial<OrderCommand['input']> = {}): OrderCommand {
  return {
    id: v7(),
    type: 'sales_order.create_draft',
    orderId: v7(),
    input: {
      customerId,
      date: '2026-10-21',
      deliveryDate: '',
      customerReference: '',
      warehouseId: depot.id,
      shippingAddressId: '',
      note: '',
      lines: [
        {
          variantId: juice.variants[0]?.id ?? '',
          unitId: pcs,
          quantity: '24',
          description: '',
          unitPrice: '25',
          discountType: 'percent',
          discount: '0',
          taxRateId,
        },
      ],
      ...extra,
    },
  };
}

// The answer the server kept for a command, straight from the table
const answerRowSchema = z.object({
  device_id: z.uuid(),
  type: z.string(),
  entity_id: z.uuid(),
  status: z.string(),
  notices: z.unknown(),
  error: z.unknown(),
});

async function answerRow(id: string) {
  const rows = z.array(answerRowSchema).parse(
    await sql`SELECT device_id, type, entity_id, status, notices, error
                FROM sync_commands WHERE id = ${id}`,
  );
  return rows[0] ?? null;
}

async function auditOf(entityType: string, entityId: string) {
  const res = await send('GET', `/audit-logs?entityType=${entityType}&entityId=${entityId}`);
  expect(res.statusCode, res.body).toBe(200);
  return auditPageSchema.parse(res.json()).items;
}

async function registerDevice(as: SignedIn, name: string): Promise<Device> {
  const res = await send('POST', '/sync/devices', { id: v7(), name, branchId: depot.branchId }, as);
  expect(res.statusCode, res.body).toBe(201);
  return deviceSchema.parse(res.json());
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  sql = postgres(pg.superuserUrl, { max: 2 });
  owner = await signUp(app, {
    companyName: 'Meghna Distributors',
    workspaceSlug: 'meghna-distributors',
    fullName: 'Shafiq Ahmed',
    email: 'shafiq@meghnadistributors.com',
    password: 'Narsingdi-depot-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  // Rafiq is a member with no role yet: syncing needs no permission, each command does
  await signUp(app, {
    companyName: 'Rafiq Traders',
    workspaceSlug: 'rafiq-traders',
    fullName: 'Rafiq Islam',
    email: 'rafiq@meghnadistributors.com',
    password: 'Bhairab-route-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'rafiq@meghnadistributors.com',
    workspace: 'meghna-distributors',
  });
  rafiq = await logIn(app, {
    workspace: 'meghna-distributors',
    email: 'rafiq@meghnadistributors.com',
    password: 'Bhairab-route-2026',
    keepSignedIn: false,
  });

  // Narsingdi's MAIN store and an old store that is archived; Chattogram has its own depot
  const [main] = warehouseListSchema
    .parse((await send('GET', '/warehouses')).json())
    .items.filter((warehouse) => warehouse.code === 'MAIN');
  if (!main) throw new Error('no MAIN warehouse');
  depot = main;
  const store = await created(warehouseSchema, '/warehouses', {
    branchId: depot.branchId,
    code: 'NRS2',
    name: 'Old store',
    address: '',
  });
  const archived = await send('POST', `/warehouses/${store.id}/archive`, {
    version: store.version,
  });
  expect(archived.statusCode, archived.body).toBe(200);
  oldStore = warehouseSchema.parse(archived.json());
  const chattogram = await created(branchSchema, '/branches', {
    code: 'CTG',
    name: 'Chattogram depot',
    phone: '',
    address: 'Agrabad, Chattogram',
  });
  ctgDepot = await created(warehouseSchema, '/warehouses', {
    branchId: chattogram.id,
    code: 'CTG1',
    name: 'Chattogram depot',
    address: '',
  });

  // The two devices of the sales officer (the owner here), and Rafiq's laptop, all in Narsingdi
  laptop = await registerDevice(owner, 'Laptop');
  tablet = await registerDevice(owner, 'Tablet');
  rafiqLaptop = await registerDevice(rafiq, 'Rafiq laptop');

  taxRateId = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items[0]?.id ?? '';
  pcs =
    unitListSchema.parse((await send('GET', '/units')).json()).items.find((u) => u.code === 'pcs')
      ?.id ?? '';
  juice = await created(productSchema, '/products', {
    code: '',
    name: 'Mango juice 250 ml',
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcs,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '25', archived: false },
    ],
    units: [],
    customFields: {},
  });
  karim = await shop('Karim Store', {
    phone: '01711-000000',
    addresses: [
      { id: null, kind: 'billing', label: '', address: 'Bazar Road, Narsingdi', phone: '' },
    ],
  });
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('the request', () => {
  it('checks the protocol first, then the device', async () => {
    const stranger = { ...laptop, id: v7() };
    // An old app is told to reload, whatever else is wrong
    const old = await pushRequest([newCustomer('Old App Store')], {
      device: stranger,
      protocol: 2,
    });
    expect(old.statusCode).toBe(409);
    expect(problemSchema.parse(old.json()).code).toBe('sync_protocol_mismatch');

    const unknown = await pushRequest([newCustomer('Unknown Store')], { device: stranger });
    expect(unknown.statusCode).toBe(404);
    expect(problemSchema.parse(unknown.json()).code).toBe('device_not_found');
    // A device is one person's: Rafiq may not push with the owner's laptop
    const other = await pushRequest([newCustomer('Borrowed Store')], { as: rafiq, device: laptop });
    expect(other.statusCode).toBe(404);
    expect(problemSchema.parse(other.json()).code).toBe('device_not_found');
  });

  it('refuses a revoked device, and runs none of its commands', async () => {
    const lost = await registerDevice(owner, 'Lost phone');
    // revoked_by: migration 0048 refuses a revoke that names nobody
    await sql`UPDATE devices SET revoked_at = now(), revoked_by = user_id WHERE id = ${lost.id}`;
    const command = newCustomer('Lost Phone Store');
    const res = await pushRequest([command], { device: lost });
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json()).code).toBe('device_revoked');
    expect(await answerRow(command.id)).toBeNull();
  });

  it('takes 1 to 50 commands', async () => {
    expect((await pushRequest([])).statusCode).toBe(400);
    const many = Array.from({ length: 51 }, () => newCustomer('Too Many Store'));
    expect((await pushRequest(many)).statusCode).toBe(400);
  });
});

describe('a new customer', () => {
  it('gets the next C- number, keeps the ids the device made, and names the device', async () => {
    const billing = address('billing', 'Station Road, Chattogram');
    const command = newCustomer('Rahman Pharmacy', { addresses: [billing] });
    const result = accepted((await push([command]))[0]);
    expect(result.notices).toEqual([]);
    // The row the device writes at once: the pull's shape, with no balance
    const row = customerIn(result.changes);
    expect(row).toMatchObject({ id: command.customerId, name: 'Rahman Pharmacy' });
    expect(row.code).toMatch(/^C-\d{5}$/);
    expect(row.addresses.map((a) => a.id)).toEqual([billing.id]);
    expect(row).not.toHaveProperty('balance');

    expect(await answerRow(command.id)).toEqual({
      device_id: laptop.id,
      type: 'customer.create',
      entity_id: command.customerId,
      status: 'accepted',
      notices: [],
      error: null,
    });
    const [entry] = await auditOf('customer', command.customerId);
    expect(entry).toMatchObject({
      action: 'customer.created',
      device: { id: laptop.id, name: 'Laptop' },
    });
  });

  it('keeps a typed code, and refuses one another customer has', async () => {
    const first = accepted((await push([newCustomer('Bhai Bhai Store', { code: 'BB-01' })]))[0]);
    expect(customerIn(first.changes).code).toBe('BB-01');
    const second = refusal((await push([newCustomer('Bhai Bhai Traders', { code: 'BB-01' })]))[0]);
    expect(second).toEqual({
      code: 'customer_code_taken',
      fieldErrors: { code: ['customer_code_taken'] },
    });
  });

  it('refuses an id that is taken, and keeps nothing of the command', async () => {
    const billing = address('billing', 'College Road, Bhairab');
    const made = newCustomer('Nayeem Store', { addresses: [billing] });
    accepted((await push([made]))[0]);

    // The customer's id again, under a new command id: the same customer cannot be made twice
    const again = { ...made, id: v7() };
    expect(refusal((await push([again]))[0])).toEqual({ code: 'sync_id_taken' });
    // A new customer with an address id that is taken: the customer is rolled back with it
    const reused = newCustomer('Nayeem Traders', { addresses: [billing] });
    expect(refusal((await push([reused]))[0])).toEqual({ code: 'sync_id_taken' });
    expect((await send('GET', `/customers/${reused.customerId}`)).statusCode).toBe(404);
    expect(await answerRow(reused.id)).toMatchObject({ status: 'rejected' });
  });

  it("refuses what the form refuses, under the form's own fields", async () => {
    const results = await push([
      newCustomer('R'),
      newCustomer('Sumon Store', { addresses: [address('shipping', 'Bus')] }),
      { ...newCustomer('Sumon Store'), customerId: randomUUID() },
      { ...newCustomer('Sumon Store'), id: randomUUID() },
    ]);
    expect(outcomes(results)).toEqual(Array(4).fill('invalid_input'));
    expect(results.map((result) => Object.keys(refusal(result).fieldErrors ?? {}))).toEqual([
      ['name'],
      ['addresses.0.address'],
      ['customerId'],
      ['id'],
    ]);
    expect(refusal(results[0]).fieldErrors).toEqual({ name: ['customer_name_required'] });
    // A command the server cannot read keeps no answer: sent again, it gets the same refusal
    for (const result of results) expect(await answerRow(result.id)).toBeNull();
  });

  it('refuses a command of a type it does not know, alone', async () => {
    const unknown = { id: v7(), type: 'sale.refund', amount: '500' };
    const results = await push([unknown, newCustomer('Kamal Store')]);
    expect(outcomes(results)).toEqual(['sync_command_invalid', 'accepted']);
    expect(await answerRow(unknown.id)).toBeNull();
  });
});

describe('an order written on a device', () => {
  it('is a draft for the customer made just before it, in the same push', async () => {
    const shipping = address('shipping', 'Godown 4, Ghat Road, Narsingdi');
    const customer = newCustomer('Sonar Bangla Store', { addresses: [shipping] });
    const order = newOrder(customer.customerId, { shippingAddressId: shipping.id });
    const [made, written] = await push([customer, order]);
    accepted(made);
    // Orders are not on the device: nothing to write
    expect(accepted(written).changes).toEqual([]);

    const saved = salesOrderSchema.parse(
      (await send('GET', `/sales-orders/${order.orderId}`)).json(),
    );
    expect(saved).toMatchObject({
      status: 'draft',
      number: null,
      customer: { id: customer.customerId },
      shippingAddressId: shipping.id,
      net: '600.0000',
      total: '690.0000',
    });
    const [entry] = await auditOf('sales_order', order.orderId);
    expect(entry?.device).toEqual({ id: laptop.id, name: 'Laptop' });
    expect(await answerRow(order.id)).toMatchObject({
      type: 'sales_order.create_draft',
      entity_id: order.orderId,
      status: 'accepted',
    });

    // Online, someone confirms it: it gets its number then
    const confirmed = await send('POST', `/sales-orders/${order.orderId}/confirm`, {
      version: saved.version,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(salesOrderSchema.parse(confirmed.json()).number).toMatch(/^SO-/);
  });

  it("may use a warehouse of another branch than the device's", async () => {
    const order = newOrder(karim.id, { warehouseId: ctgDepot.id });
    accepted((await push([order]))[0]);
    const saved = salesOrderSchema.parse(
      (await send('GET', `/sales-orders/${order.orderId}`)).json(),
    );
    expect(saved.warehouseId).toBe(ctgDepot.id);
  });

  it('is refused for what an online draft is refused for', async () => {
    const closed = await shop('Closed Shop');
    const archived = await send('POST', `/customers/${closed.id}/archive`, {
      version: closed.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const [billing] = karim.addresses;
    const taken = newOrder(karim.id);
    accepted((await push([taken]))[0]);

    const results = await push([
      newOrder(karim.id, { warehouseId: oldStore.id }),
      newOrder(closed.id),
      newOrder(v7()),
      newOrder((await shop('Other Shop')).id, { shippingAddressId: billing?.id ?? '' }),
      { ...newOrder(karim.id), orderId: taken.orderId },
    ]);
    expect(outcomes(results)).toEqual([
      'stock_warehouse_invalid',
      'sales_customer_invalid',
      'sales_customer_invalid',
      'sales_address_invalid',
      'sync_id_taken',
    ]);
    expect(refusal(results[0]).fieldErrors).toEqual({ warehouseId: ['stock_warehouse_invalid'] });
    expect(refusal(results[1]).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });
  });

  it('puts a bad line under its place in the lines', async () => {
    const order = newOrder(karim.id);
    const [line] = order.input.lines;
    if (!line) throw new Error('no line');
    const result = refusal(
      (
        await push([{ ...order, input: { ...order.input, lines: [{ ...line, quantity: '0' }] } }])
      )[0],
    );
    expect(result.code).toBe('invalid_input');
    expect(Object.keys(result.fieldErrors ?? {})).toEqual(['lines.0.quantity']);
  });

  it('is refused when its customer was refused before it', async () => {
    // A device should not send it (decision 13), but the server must stay right if one does
    const customer = newCustomer('S');
    const results = await push([customer, newOrder(customer.customerId)]);
    expect(outcomes(results)).toEqual(['invalid_input', 'sales_customer_invalid']);
  });
});

describe('a customer changed on a device', () => {
  it('keeps both changes when two devices changed different fields', async () => {
    const read = await shop('Nadia Cosmetics', { phone: '01712-345678' });
    const fromLaptop = changeOf(read, { phone: { from: read.phone, to: '01812-345678' } });
    const fromTablet = changeOf(read, {
      email: { from: read.email, to: 'nadia@nadiacosmetics.com' },
    });
    expect(accepted((await push([fromLaptop]))[0]).notices).toEqual([]);
    const second = accepted((await push([fromTablet], { device: tablet }))[0]);
    expect(second.notices).toEqual([]);
    // The answer of the second already has both: the device writes the customer as it is now
    expect(customerIn(second.changes)).toMatchObject({
      phone: '01812-345678',
      email: 'nadia@nadiacosmetics.com',
      version: read.version + 2,
    });
  });

  it('takes the later arrival when two devices changed the same field', async () => {
    const read = await shop('Hasan Medical Hall', { contactPerson: 'Hasan Ali' });
    await push([changeOf(read, { contactPerson: { from: 'Hasan Ali', to: 'Rubel Hasan' } })]);
    await push([changeOf(read, { contactPerson: { from: 'Hasan Ali', to: 'Mita Hasan' } })], {
      device: tablet,
    });
    expect((await customerNow(read.id)).contactPerson).toBe('Mita Hasan');
  });

  it('keeps a head-office field the server changed, says so, and takes the rest', async () => {
    const read = await shop('Tasnim Store', { creditLimit: '50000', paymentTermsDays: 30 });
    await editOnline(read, (form) => ({ ...form, creditLimit: '80000' }));
    const command = changeOf(read, {
      creditLimit: { from: read.creditLimit, to: '60000' },
      paymentTermsDays: { from: 30, to: 45 },
      phone: { from: read.phone, to: '01811-111111' },
    });
    const result = accepted((await push([command]))[0]);
    expect(result.notices).toEqual([{ code: 'kept_server_value', fields: ['creditLimit'] }]);
    // The terms were not changed on the server, so the device's 45 days are taken
    expect(customerIn(result.changes)).toMatchObject({
      creditLimit: '80000.0000',
      paymentTermsDays: 45,
      phone: '01811-111111',
    });
    // The notice is kept with the answer: sent again, the device is told the same
    expect(accepted((await push([command]))[0]).notices).toEqual(result.notices);
  });

  it('takes a head-office field the server changed back to what the device read', async () => {
    const read = await shop('Mollah Traders', { creditLimit: '50000' });
    const raised = await editOnline(read, (form) => ({ ...form, creditLimit: '90000' }));
    await editOnline(raised, (form) => ({ ...form, creditLimit: '50000' }));
    const result = accepted(
      (await push([changeOf(read, { creditLimit: { from: read.creditLimit, to: '' } })]))[0],
    );
    expect(result.notices).toEqual([]);
    expect(customerIn(result.changes).creditLimit).toBeNull();
  });

  it('merges the addresses one by one, and an order may use one added in the same push', async () => {
    const read = await shop('Al-Amin Store', {
      addresses: [
        { id: null, kind: 'billing', label: '', address: 'Bazar Road, Bhairab', phone: '' },
        { id: null, kind: 'shipping', label: 'Depot', address: 'Station Road, Bhairab', phone: '' },
      ],
    });
    const [billing, shipping] = read.addresses;
    if (!billing || !shipping) throw new Error('no addresses');
    // Meanwhile the head office adds a godown
    await editOnline(read, (form) => ({
      ...form,
      addresses: [
        ...form.addresses,
        { id: null, kind: 'shipping', label: 'Godown', address: 'Ghat Road, Bhairab', phone: '' },
      ],
    }));
    const shop2 = address('shipping', 'Shop 12, New Market, Bhairab');
    const command = changeOf(
      read,
      {},
      { add: [shop2], change: [{ id: billing.id, phone: '01911-222222' }], remove: [shipping.id] },
    );
    const results = await push([command, newOrder(read.id, { shippingAddressId: shop2.id })]);
    expect(outcomes(results)).toEqual(['accepted', 'accepted']);
    const now = await customerNow(read.id);
    expect(now.addresses.map((a) => [a.label ?? a.address, a.phone])).toEqual([
      ['Bazar Road, Bhairab', '01911-222222'],
      ['Godown', null],
      ['Shop 12, New Market, Bhairab', null],
    ]);
    expect(now.addresses[2]?.id).toBe(shop2.id);
  });

  it('drops the change of an address the server removed, and keeps the rest', async () => {
    const read = await shop('Shapla Store', {
      addresses: [
        { id: null, kind: 'shipping', label: 'Depot', address: 'Station Road, Bhairab', phone: '' },
      ],
    });
    const [depotAddress] = read.addresses;
    if (!depotAddress) throw new Error('no address');
    await editOnline(read, (form) => ({ ...form, addresses: [] }));
    const result = accepted(
      (
        await push([
          changeOf(
            read,
            { name: { from: read.name, to: 'Shapla General Store' } },
            { change: [{ id: depotAddress.id, label: 'Old depot' }] },
          ),
        ])
      )[0],
    );
    expect(customerIn(result.changes)).toMatchObject({
      name: 'Shapla General Store',
      addresses: [],
    });
  });

  it('refuses a second billing address that only the merge makes', async () => {
    // Each change alone is fine: the head office and the device both add the billing address
    const read = await shop('Joy Telecom');
    await editOnline(read, (form) => ({
      ...form,
      addresses: [
        { id: null, kind: 'billing', label: '', address: 'Court Road, Narsingdi', phone: '' },
      ],
    }));
    const billing = address('billing', 'College Road, Narsingdi');
    const command = changeOf(read, {}, { add: [billing] });
    expect(refusal((await push([command]))[0])).toEqual({
      code: 'customer_billing_twice',
      fieldErrors: { [`addresses.${billing.id}.kind`]: ['customer_billing_twice'] },
    });
    expect((await customerNow(read.id)).addresses).toHaveLength(1);
  });

  it('refuses a code another customer has, and a field the form refuses', async () => {
    const read = await shop('Bismillah Store');
    const addressId = v7();
    const results = await push([
      changeOf(read, { code: { from: read.code, to: karim.code } }),
      changeOf(read, { name: { from: read.name, to: 'B' } }),
      changeOf(read, {}, { change: [{ id: addressId, label: 'L'.repeat(61) }] }),
    ]);
    expect(refusal(results[0])).toEqual({
      code: 'customer_code_taken',
      fieldErrors: { code: ['customer_code_taken'] },
    });
    expect(refusal(results[1]).fieldErrors).toEqual({ name: ['customer_name_required'] });
    // An address by its id, not by its place in the command
    expect(Object.keys(refusal(results[2]).fieldErrors ?? {})).toEqual([
      `addresses.${addressId}.label`,
    ]);
  });

  it('changes an archived customer, and tells the device to drop it', async () => {
    const read = await shop('Sabbir Store');
    const res = await send('POST', `/customers/${read.id}/archive`, { version: read.version });
    expect(res.statusCode, res.body).toBe(200);
    const result = accepted(
      (await push([changeOf(read, { phone: { from: read.phone, to: '01733-333333' } })]))[0],
    );
    expect(result.changes).toEqual([{ op: 'delete', entity: 'customer', key: read.id }]);
    expect((await customerNow(read.id)).phone).toBe('01733-333333');
  });

  it('refuses a change of a customer the server no longer has', async () => {
    const read = await shop('Gone Store');
    const deleted = await send('DELETE', `/customers/${read.id}?version=${String(read.version)}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    const results = await push([
      changeOf(read, { phone: { from: read.phone, to: '01744-444444' } }),
      changeOf({ ...read, id: randomUUID() }, { phone: { from: null, to: '01744-444444' } }),
    ]);
    expect(outcomes(results)).toEqual(['sync_customer_gone', 'sync_customer_gone']);
  });

  it('names the device on the audit entry, and no device for a change saved online', async () => {
    const read = await shop('Audit Store');
    await push([changeOf(read, { notes: { from: null, to: 'Pays on Thursdays' } })], {
      device: tablet,
    });
    await editOnline(read, (form) => ({ ...form, notes: 'Pays on Fridays' }));
    const entries = await auditOf('customer', read.id);
    expect(entries.map((entry) => [entry.action, entry.device?.name ?? null])).toEqual([
      ['customer.updated', null],
      ['customer.updated', 'Tablet'],
      ['customer.created', null],
    ]);
  });
});

describe('a command sent again', () => {
  it('is answered from what was kept, with the rows as they are now', async () => {
    const command = newCustomer('Jamuna Store');
    accepted((await push([command]))[0]);
    // The head office renames it before the device hears the first answer
    const made = await customerNow(command.customerId);
    await editOnline(made, (form) => ({ ...form, name: 'Jamuna General Store' }));

    const again = accepted((await push([command]))[0]);
    expect(customerIn(again.changes).name).toBe('Jamuna General Store');
    const entries = await auditOf('customer', command.customerId);
    expect(entries.map((entry) => entry.action)).toEqual(['customer.updated', 'customer.created']);

    // Archived meanwhile: the answer tells the device to drop it
    const now = await customerNow(command.customerId);
    const res = await send('POST', `/customers/${now.id}/archive`, { version: now.version });
    expect(res.statusCode, res.body).toBe(200);
    expect(accepted((await push([command]))[0]).changes).toEqual([
      { op: 'delete', entity: 'customer', key: command.customerId },
    ]);
  });

  it('runs once when it is twice in the same push', async () => {
    const command = newCustomer('Twice In One Store');
    expect(outcomes(await push([command, command]))).toEqual(['accepted', 'accepted']);
    const list = await send('GET', '/customers?search=Twice%20In%20One');
    expect(z.object({ items: z.array(z.unknown()) }).parse(list.json()).items).toHaveLength(1);
  });

  it('runs once when two pushes send it at the same moment', async () => {
    const command = newCustomer('Twice Traders');
    const [a, b] = await Promise.all([push([command]), push([command])]);
    expect([a[0]?.status, b[0]?.status]).toEqual(['accepted', 'accepted']);
    const list = await send('GET', '/customers?search=Twice%20Traders');
    expect(z.object({ items: z.array(z.unknown()) }).parse(list.json()).items).toHaveLength(1);
  });

  it('stays refused when the reason is gone; under a new id it runs', async () => {
    const holder = await shop('Code Holder', { code: 'MG-01' });
    const command = newCustomer('Meghna Grocery', { code: 'MG-01' });
    expect(refusal((await push([command]))[0]).code).toBe('customer_code_taken');
    await editOnline(holder, (form) => ({ ...form, code: 'MG-99' }));
    // The same id gets the same answer: the device cannot tell a resend from a lost answer
    expect(refusal((await push([command]))[0]).code).toBe('customer_code_taken');
    // Edited on the Sync page and sent again, it is a new command (18b.6)
    expect(accepted((await push([{ ...command, id: v7() }]))[0]).notices).toEqual([]);
  });
});

describe('the roles of now', () => {
  async function giveRafiq(roleIds: string[]) {
    const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
    const member = items.find((item) => item.email === 'rafiq@meghnadistributors.com');
    if (!member) throw new Error('Rafiq is not a member');
    const res = await send('PUT', `/members/${member.membershipId}/roles`, {
      roleIds,
      version: member.version,
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  it('refuses each command whose permission the person does not have', async () => {
    const results = await push([newCustomer('Rafiq Store'), newOrder(karim.id)], {
      as: rafiq,
      device: rafiqLaptop,
    });
    expect(results.map((result) => refusal(result))).toEqual([
      { code: 'permission_missing', params: { permissions: 'sales.customer.manage' } },
      { code: 'permission_missing', params: { permissions: 'sales.order.manage' } },
    ]);
  });

  it('runs what a role given since allows, and refuses it again once the role is gone', async () => {
    const fieldSales = await created(roleSchema, '/roles', {
      name: 'Field sales',
      description: '',
    });
    const matrix = await send('PUT', '/permission-matrix', {
      roles: [
        { id: fieldSales.id, version: fieldSales.version, permissions: ['sales.customer.manage'] },
      ],
    });
    expect(matrix.statusCode, matrix.body).toBe(200);
    await giveRafiq([fieldSales.id]);
    const customer = newCustomer('Bhairab Route Store');
    expect(
      outcomes(
        await push([customer, newOrder(customer.customerId)], { as: rafiq, device: rafiqLaptop }),
      ),
    ).toEqual(['accepted', 'permission_missing']);

    // Taken away while his laptop was offline: what he wrote then is refused when it arrives
    await giveRafiq([]);
    const later = changeOf(await customerNow(customer.customerId), {
      phone: { from: null, to: '01755-555555' },
    });
    expect(refusal((await push([later], { as: rafiq, device: rafiqLaptop }))[0])).toMatchObject({
      code: 'permission_missing',
    });
  });
});

describe('the answers kept', () => {
  it('are kept 30 days: the worker deletes older ones, and a resend after that runs again', async () => {
    const old = newCustomer('Old Answer Store');
    const recent = newCustomer('Recent Answer Store');
    accepted((await push([old, recent]))[0]);
    await sql`UPDATE sync_commands SET created_at = now() - interval '31 days' WHERE id = ${old.id}`;
    await sql`UPDATE sync_commands SET created_at = now() - interval '29 days'
              WHERE id = ${recent.id}`;

    expect(await worker.get(SyncLogCleanup).deleteOldAnswers()).toBe(1);
    expect(await answerRow(old.id)).toBeNull();
    expect(await answerRow(recent.id)).not.toBeNull();
    expect(await worker.get(SyncLogCleanup).deleteOldAnswers()).toBe(0);
    // A device that kept a command this long is past the pull's 30 days too, so it starts over
    // with a full pull; if it still sent it, the customer is not made twice
    expect(refusal((await push([old]))[0])).toEqual({ code: 'sync_id_taken' });
  });
});
