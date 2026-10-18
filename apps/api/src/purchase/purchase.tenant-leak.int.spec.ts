import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  costLookupSchema,
  type Customer,
  customerSchema,
  memberPageSchema,
  type Product,
  productSchema,
  problemSchema,
  type Requisition,
  requisitionPageSchema,
  requisitionSchema,
  type Role,
  roleSchema,
  setupSchema,
  type Supplier,
  type SupplierGroup,
  supplierGroupListSchema,
  supplierGroupSchema,
  supplierPageSchema,
  supplierSchema,
  type Unit,
  unitListSchema,
  waitingApprovalPageSchema,
  waitingCountSchema,
  type Warehouse,
  warehouseListSchema,
} from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

// Two workspaces: A must never see, use or change B's suppliers, supplier groups, bank accounts,
// approval levels or requisitions, decide B's approvals, or learn B's costs. Every answer is 404,
// or the same "pick one from the list" as for an id that does not exist — never a hint that it
// does.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let unitsOfA: Unit[];
let accountsOfA: Account[];
let warehouseOfA: Warehouse;
let productOfA: Product;
let groupOfB: SupplierGroup;
let supplierOfB: Supplier;
let customerOfB: Customer;
let roleOfB: Role;
let warehouseOfB: Warehouse;
let productOfB: Product;
// B's requisition, waiting for B's purchase manager
let requisitionOfB: Requisition;

function as(
  who: SignedIn,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload && { payload }),
  });
}

function problemOf(res: Awaited<ReturnType<typeof as>>) {
  return problemSchema.parse(res.json());
}

async function setUp(who: SignedIn): Promise<void> {
  expect((await as(who, 'POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
}

function pcsOf(units: Unit[]): string {
  const pcs = units.find((unit) => unit.code === 'pcs');
  if (!pcs) throw new Error('no pcs');
  return pcs.id;
}

function accountOfA(code: string): string {
  const found = accountsOfA.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function supplierForm(name: string, extra: object = {}) {
  return {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 30,
    address: '',
    bankAccounts: [],
    notes: '',
    ...extra,
  };
}

async function addProduct(who: SignedIn, name: string, units: Unit[]): Promise<Product> {
  const res = await as(who, 'POST', '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcsOf(units),
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
  });
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

function requisitionForm(warehouse: Warehouse, product: Product, units: Unit[], extra = {}) {
  return {
    date: '2026-10-10',
    warehouseId: warehouse.id,
    neededBy: '',
    note: '',
    lines: [
      {
        variantId: variantOf(product),
        unitId: pcsOf(units),
        quantity: '10',
        description: '',
        estimatedCost: '2500',
      },
    ],
    ...extra,
  };
}

// A user of B who may write requisitions: signs up for a workspace of their own, then joins B
async function memberOfB(email: string, fullName: string, password: string): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Trading`,
    workspaceSlug: email.split('@')[0] ?? 'trading',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'banani-denim' });
  const made = await as(tenantB, 'POST', '/roles', { name: 'Merchandising', description: '' });
  const role = roleSchema.parse(made.json());
  const matrix = await as(tenantB, 'PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions: ['purchase.requisition.manage'] }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = memberPageSchema.parse((await as(tenantB, 'GET', '/members')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await as(tenantB, 'PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'banani-denim', email, password, keepSignedIn: false });
}

async function firstWarehouse(who: SignedIn): Promise<Warehouse> {
  const [found] = warehouseListSchema.parse((await as(who, 'GET', '/warehouses')).json()).items;
  if (!found) throw new Error('no warehouse');
  return found;
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
  [tenantA, tenantB] = await Promise.all([
    signUp(app, {
      companyName: 'Ashulia Knit Ltd.',
      workspaceSlug: 'ashulia-knit',
      fullName: 'Arif Chowdhury',
      email: 'arif@ashuliaknit.com',
      password: 'Ashulia-knit-2026',
    }),
    signUp(app, {
      companyName: 'Banani Denim Ltd.',
      workspaceSlug: 'banani-denim',
      fullName: 'Bilkis Rahman',
      email: 'bilkis@bananidenim.com',
      password: 'Banani-denim-2026',
    }),
  ]);
  await Promise.all([setUp(tenantA), setUp(tenantB)]);
  unitsOfA = unitListSchema.parse((await as(tenantA, 'GET', '/units')).json()).items;
  const unitsOfB = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;
  accountsOfA = accountListSchema.parse((await as(tenantA, 'GET', '/accounts')).json()).items;
  warehouseOfA = await firstWarehouse(tenantA);
  warehouseOfB = await firstWarehouse(tenantB);
  productOfA = await addProduct(tenantA, 'Single jersey, black', unitsOfA);
  productOfB = await addProduct(tenantB, 'Denim 12 oz, indigo', unitsOfB);

  groupOfB = supplierGroupSchema.parse(
    (await as(tenantB, 'POST', '/supplier-groups', { name: 'Denim mills' })).json(),
  );
  const supplier = await as(
    tenantB,
    'POST',
    '/suppliers',
    supplierForm('Envoy Denim Mill', {
      groupId: groupOfB.id,
      bankAccounts: [
        {
          id: null,
          bankName: 'Dutch-Bangla Bank',
          branchName: '',
          accountName: 'Envoy Denim Mill',
          accountNumber: '1011100055566',
          routingNumber: '',
        },
      ],
    }),
  );
  expect(supplier.statusCode, supplier.body).toBe(201);
  supplierOfB = supplierSchema.parse(supplier.json());
  const customer = await as(tenantB, 'POST', '/customers', {
    code: '',
    name: 'Levi Strauss Sourcing',
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
  });
  expect(customer.statusCode, customer.body).toBe(201);
  customerOfB = customerSchema.parse(customer.json());

  // B's approval level: a purchase manager from ৳0, so B's requisition waits
  const role = await as(tenantB, 'POST', '/roles', { name: 'Purchase manager', description: '' });
  expect(role.statusCode, role.body).toBe(201);
  roleOfB = roleSchema.parse(role.json());
  const rule = await as(tenantB, 'PUT', '/approval-rules/requisition', {
    levels: [{ minAmount: '0', roleId: roleOfB.id }],
    version: 0,
  });
  expect(rule.statusCode, rule.body).toBe(200);
  // An Owner's own requisition is approved at once, so B's merchandiser writes and submits it
  const merchandiser = await memberOfB('babul@bananidenim.com', 'Babul Mia', 'Denim-desk-2026');
  const made = await as(
    merchandiser,
    'POST',
    '/requisitions',
    requisitionForm(warehouseOfB, productOfB, unitsOfB),
  );
  expect(made.statusCode, made.body).toBe(201);
  const submitted = await as(
    merchandiser,
    'POST',
    `/requisitions/${requisitionSchema.parse(made.json()).id}/submit`,
    { version: 1 },
  );
  expect(submitted.statusCode, submitted.body).toBe(200);
  requisitionOfB = requisitionSchema.parse(submitted.json());
  expect(requisitionOfB.status).toBe('pending');
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('suppliers across workspaces', () => {
  it("never shows B's supplier, its group or its statement to A", async () => {
    const path = `/suppliers/${supplierOfB.id}`;
    expect((await as(tenantA, 'GET', path)).statusCode).toBe(404);
    expect((await as(tenantA, 'GET', `${path}/statement`)).statusCode).toBe(404);
    const list = supplierPageSchema.parse((await as(tenantA, 'GET', '/suppliers')).json());
    expect(list.items.map((item) => item.id)).not.toContain(supplierOfB.id);
    const byGroup = supplierPageSchema.parse(
      (await as(tenantA, 'GET', `/suppliers?groupId=${groupOfB.id}`)).json(),
    );
    expect(byGroup.items).toEqual([]);
    const groups = supplierGroupListSchema.parse(
      (await as(tenantA, 'GET', '/supplier-groups')).json(),
    );
    expect(groups.items.map((item) => item.id)).not.toContain(groupOfB.id);
  });

  it("never changes, archives or deletes B's supplier or group", async () => {
    const path = `/suppliers/${supplierOfB.id}`;
    const version = { version: supplierOfB.version };
    expect(
      (await as(tenantA, 'PUT', path, { ...supplierForm('Mine now'), ...version })).statusCode,
    ).toBe(404);
    expect((await as(tenantA, 'POST', `${path}/archive`, version)).statusCode).toBe(404);
    expect((await as(tenantA, 'POST', `${path}/restore`, version)).statusCode).toBe(404);
    expect((await as(tenantA, 'DELETE', `${path}?version=1`)).statusCode).toBe(404);
    expect(
      (
        await as(tenantA, 'PUT', `/supplier-groups/${groupOfB.id}`, {
          name: 'Mine now',
          version: groupOfB.version,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await as(tenantA, 'DELETE', `/supplier-groups/${groupOfB.id}?version=1`)).statusCode,
    ).toBe(404);
    // B's records are as they were
    const still = supplierSchema.parse((await as(tenantB, 'GET', path)).json());
    expect(still).toMatchObject({ name: 'Envoy Denim Mill', archivedAt: null, version: 1 });
  });

  it("never makes B's customer a supplier, or B's supplier a customer", async () => {
    const toSupplier = await as(tenantA, 'POST', `/customers/${customerOfB.id}/make-supplier`, {
      version: customerOfB.version,
    });
    expect(toSupplier.statusCode).toBe(404);
    const toCustomer = await as(tenantA, 'POST', `/suppliers/${supplierOfB.id}/make-customer`, {
      version: supplierOfB.version,
    });
    expect(toCustomer.statusCode).toBe(404);
  });

  it("never puts A's supplier in B's group, or takes B's bank account", async () => {
    const grouped = await as(
      tenantA,
      'POST',
      '/suppliers',
      supplierForm('Ashulia Yarn', { groupId: groupOfB.id }),
    );
    expect(grouped.statusCode).toBe(400);
    expect(problemOf(grouped).fieldErrors).toEqual({ groupId: ['supplier_group_invalid'] });

    const foreign = supplierOfB.bankAccounts[0];
    if (!foreign) throw new Error('B has no bank account');
    const res = await as(
      tenantA,
      'POST',
      '/suppliers',
      supplierForm('Ashulia Yarn', {
        bankAccounts: [{ ...foreign, branchName: '', routingNumber: '', accountName: 'Ashulia' }],
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(supplierSchema.parse(res.json()).bankAccounts[0]?.id).not.toBe(foreign.id);
    const still = supplierSchema.parse(
      (await as(tenantB, 'GET', `/suppliers/${supplierOfB.id}`)).json(),
    );
    expect(still.bankAccounts).toEqual(supplierOfB.bankAccounts);
  });

  it("never puts B's supplier on a payable line of A's books", async () => {
    const res = await as(tenantA, 'POST', '/journal-entries', {
      date: '2026-10-01',
      narration: 'Yarn on credit',
      post: true,
      lines: [
        {
          accountId: accountOfA('1110'),
          branchId: '',
          partyId: '',
          description: '',
          debit: '1000',
          credit: '',
        },
        {
          accountId: accountOfA('2110'),
          branchId: '',
          partyId: supplierOfB.id,
          description: '',
          debit: '',
          credit: '1000',
        },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'lines.1.partyId': ['journal_party_invalid'] });
  });
});

describe('approvals and requisitions across workspaces', () => {
  it("never puts B's role on A's approval levels", async () => {
    const res = await as(tenantA, 'PUT', '/approval-rules/requisition', {
      levels: [{ minAmount: '0', roleId: roleOfB.id }],
      version: 0,
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'levels.0.roleId': ['approval_role_invalid'] });
  });

  it("never shows or changes B's requisition", async () => {
    const path = `/requisitions/${requisitionOfB.id}`;
    const version = { version: requisitionOfB.version };
    expect((await as(tenantA, 'GET', path)).statusCode).toBe(404);
    const list = requisitionPageSchema.parse((await as(tenantA, 'GET', '/requisitions')).json());
    expect(list.items).toEqual([]);
    expect(
      (
        await as(tenantA, 'PUT', path, {
          ...requisitionForm(warehouseOfA, productOfA, unitsOfA),
          ...version,
        })
      ).statusCode,
    ).toBe(404);
    for (const action of ['submit', 'reopen', 'cancel']) {
      expect((await as(tenantA, 'POST', `${path}/${action}`, version)).statusCode).toBe(404);
    }
    expect((await as(tenantA, 'DELETE', `${path}?version=1`)).statusCode).toBe(404);
    const still = requisitionSchema.parse((await as(tenantB, 'GET', path)).json());
    expect(still).toMatchObject({ status: 'pending', version: requisitionOfB.version });
  });

  it("never lets A's requisition use B's warehouse or item", async () => {
    const warehouse = await as(
      tenantA,
      'POST',
      '/requisitions',
      requisitionForm(warehouseOfB, productOfA, unitsOfA),
    );
    expect(warehouse.statusCode).toBe(409);
    expect(problemOf(warehouse).fieldErrors).toEqual({
      warehouseId: ['purchase_warehouse_invalid'],
    });
    const item = await as(
      tenantA,
      'POST',
      '/requisitions',
      requisitionForm(warehouseOfA, productOfB, unitsOfA),
    );
    expect(item.statusCode).toBe(409);
    expect(problemOf(item).fieldErrors).toEqual({ 'lines.0.variantId': ['purchase_item_invalid'] });
  });

  it("never lets A decide B's approval, or use B's round on its own", async () => {
    const [roundOfB] = requisitionOfB.approval.rounds;
    if (!roundOfB) throw new Error('B has no round');

    const path = `/approvals/requisition/${requisitionOfB.id}`;
    const approve = await as(tenantA, 'POST', `${path}/approve`, {
      roundId: roundOfB.id,
      comment: '',
    });
    expect(approve.statusCode).toBe(404);
    const reject = await as(tenantA, 'POST', `${path}/reject`, {
      roundId: roundOfB.id,
      comment: 'Not ours',
    });
    expect(reject.statusCode).toBe(404);
    // B's round still waits for B
    const still = requisitionSchema.parse(
      (await as(tenantB, 'GET', `/requisitions/${requisitionOfB.id}`)).json(),
    );
    expect(still.approval.rounds[0]).toMatchObject({ status: 'pending' });
    expect(still.approval.rounds[0]?.steps[0]?.decision).toBeNull();

    // A's own draft, with B's round: no round of A's is pending, so nothing happens
    const mine = await as(
      tenantA,
      'POST',
      '/requisitions',
      requisitionForm(warehouseOfA, productOfA, unitsOfA),
    );
    expect(mine.statusCode, mine.body).toBe(201);
    const own = requisitionSchema.parse(mine.json());
    const crossed = await as(tenantA, 'POST', `/approvals/requisition/${own.id}/approve`, {
      roundId: roundOfB.id,
      comment: '',
    });
    expect(crossed.statusCode).toBe(409);
    expect(problemOf(crossed).code).toBe('approval_not_pending');

    const waiting = waitingApprovalPageSchema.parse(
      (await as(tenantA, 'GET', '/approvals/waiting')).json(),
    );
    expect(waiting.items).toEqual([]);
    // B's Owner, who may decide any level of B's, sees it
    const ofB = waitingApprovalPageSchema.parse(
      (await as(tenantB, 'GET', '/approvals/waiting')).json(),
    );
    expect(ofB.items.map((item) => item.id)).toEqual([requisitionOfB.id]);
    expect(
      waitingCountSchema.parse((await as(tenantA, 'GET', '/approvals/waiting/count')).json()),
    ).toEqual({ count: 0 });
  });

  it("never gives A the cost of B's items", async () => {
    const res = await as(tenantA, 'POST', '/purchase/cost-lookup', {
      items: [
        { variantId: variantOf(productOfB), unitId: pcsOf(unitsOfA) },
        { variantId: variantOf(productOfA), unitId: pcsOf(unitsOfA) },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(costLookupSchema.parse(res.json()).items.map((item) => item.variantId)).toEqual([
      variantOf(productOfA),
    ]);
  });
});
