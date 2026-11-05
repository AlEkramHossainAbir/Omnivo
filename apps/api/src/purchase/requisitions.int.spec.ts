import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type ApprovalRule,
  approvalRuleListSchema,
  approvalRuleSchema,
  auditPageSchema,
  branchListSchema,
  costLookupSchema,
  memberPageSchema,
  notificationPageSchema,
  type PermissionKey,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  type Requisition,
  type RequisitionFormValues,
  type RequisitionLineFormValues,
  requisitionPageSchema,
  requisitionSchema,
  type Role,
  roleListSchema,
  roleSchema,
  setupSchema,
  taxRateListSchema,
  type Unit,
  unitListSchema,
  waitingApprovalPageSchema,
  waitingCountSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
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

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// Sharif, the Owner: may decide any level, and his own requisitions are approved at once
let owner: SignedIn;
// Rupa, a merchandiser: asks for fabric and trims for a buyer's order
let rupa: SignedIn;
// Kamal and Faruk, purchase managers: the first level. Kamal also writes requisitions himself.
let kamal: SignedIn;
let faruk: SignedIn;
// Nabila, the director: the second level, for big amounts. No permission at all: approving needs
// only the role the level names.
let nabila: SignedIn;
let userIds: Map<SignedIn, string>;
let units: Unit[];
// Step 17b: the VAT rate a purchase order line starts with, when the product has none of its own
let defaultRate: string;
let main: Warehouse;
let purchaseManager: Role;
let director: Role;
// Single jersey bought by the kg, and by the roll of 25 kg; an average cost of ৳420 a kg
let jersey: Product;
let buttons: Product;
// A service has no stock, so no average cost
let knitting: Product;

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function unitId(code: string): string {
  const found = units.find((unit) => unit.code === code);
  if (!found) throw new Error(`no unit ${code}`);
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function userOf(who: SignedIn): string {
  const found = userIds.get(who);
  if (!found) throw new Error('unknown user');
  return found;
}

async function addProduct(name: string, extra: Partial<ProductFormValues> = {}) {
  const res = await send('POST', '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: unitId('pcs'),
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
    ...extra,
  } satisfies ProductFormValues);
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

async function addRole(name: string, permissions: PermissionKey[]): Promise<Role> {
  const made = await send('POST', '/roles', { name, description: '' });
  expect(made.statusCode, made.body).toBe(201);
  const role = roleSchema.parse(made.json());
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
  const saved = items.find((item) => item.id === role.id);
  if (!saved) throw new Error(`no role ${name}`);
  return saved;
}

// A user who signs up for a workspace of their own, then joins this one with these roles
async function member(
  email: string,
  fullName: string,
  password: string,
  roles: readonly Role[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Trading`,
    workspaceSlug: email.split('@')[0] ?? 'trading',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'ananta-apparels' });
  const { items } = memberPageSchema.parse((await send('GET', '/members?limit=50')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  if (roles.length > 0) {
    const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
      roleIds: roles.map((role) => role.id),
      version: found.version,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
  }
  return logIn(app, { workspace: 'ananta-apparels', email, password, keepSignedIn: false });
}

// A line as the form sends it: by the piece unless said otherwise
function line(
  product: Product,
  quantity: string,
  estimatedCost: string,
  extra: Partial<RequisitionLineFormValues> = {},
): RequisitionLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    description: '',
    estimatedCost,
    ...extra,
  };
}

function requisitionForm(
  lines: RequisitionLineFormValues[],
  extra: Partial<RequisitionFormValues> = {},
): Omit<RequisitionFormValues, 'version'> {
  return {
    date: '2026-10-10',
    warehouseId: main.id,
    neededBy: '',
    note: '',
    lines,
    ...extra,
  };
}

async function requested(
  lines: RequisitionLineFormValues[],
  as = rupa,
  extra: Partial<RequisitionFormValues> = {},
): Promise<Requisition> {
  const res = await send('POST', '/requisitions', requisitionForm(lines, extra), as);
  expect(res.statusCode, res.body).toBe(201);
  return requisitionSchema.parse(res.json());
}

// A requisition of this amount, one line of buttons at that price
function worth(amount: string, as = rupa): Promise<Requisition> {
  return requested([line(buttons, '1', amount)], as);
}

async function requisition(id: string, as = owner): Promise<Requisition> {
  const res = await send('GET', `/requisitions/${id}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return requisitionSchema.parse(res.json());
}

// A requisition action that takes the version: submit, reopen, cancel
async function act(
  action: 'submit' | 'reopen' | 'cancel',
  doc: Requisition,
  as = rupa,
): Promise<Requisition> {
  const res = await send('POST', `/requisitions/${doc.id}/${action}`, { version: doc.version }, as);
  expect(res.statusCode, res.body).toBe(200);
  return requisitionSchema.parse(res.json());
}

function roundOf(doc: Requisition) {
  const [round] = doc.approval.rounds;
  if (!round) throw new Error(`${doc.number} has no round`);
  return round;
}

function decide(
  decision: 'approve' | 'reject',
  doc: Requisition,
  as: SignedIn,
  comment = '',
  roundId = roundOf(doc).id,
) {
  return send('POST', `/approvals/requisition/${doc.id}/${decision}`, { roundId, comment }, as);
}

async function approved(doc: Requisition, as: SignedIn, comment = ''): Promise<Requisition> {
  const res = await decide('approve', doc, as, comment);
  expect(res.statusCode, res.body).toBe(204);
  return requisition(doc.id);
}

async function saveRule(levels: { minAmount: string; roleId: string }[]): Promise<ApprovalRule> {
  const { items } = approvalRuleListSchema.parse((await send('GET', '/approval-rules')).json());
  const current = items.find((item) => item.document === 'requisition');
  const res = await send('PUT', '/approval-rules/requisition', {
    levels,
    version: current?.version ?? 0,
  });
  expect(res.statusCode, res.body).toBe(200);
  return approvalRuleSchema.parse(res.json());
}

// The approval notifications a person has, as [type, number]
async function bell(who: SignedIn): Promise<[string, string | number | undefined][]> {
  const page = notificationPageSchema.parse(
    (await send('GET', '/notifications?limit=50', undefined, who)).json(),
  );
  return page.items
    .filter((item) => item.type.startsWith('approval.'))
    .map((item) => [item.type, item.params.number]);
}

async function waiting(who: SignedIn) {
  return waitingApprovalPageSchema.parse(
    (await send('GET', '/approvals/waiting?limit=50', undefined, who)).json(),
  );
}

async function waitingCount(who: SignedIn): Promise<number> {
  return waitingCountSchema.parse(
    (await send('GET', '/approvals/waiting/count', undefined, who)).json(),
  ).count;
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
  owner = await signUp(app, {
    companyName: 'Ananta Apparels Ltd.',
    workspaceSlug: 'ananta-apparels',
    fullName: 'Sharif Zahir',
    email: 'sharif@anantaapparels.com',
    password: 'Kanchpur-apparel-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  const rate = taxRateListSchema
    .parse((await send('GET', '/tax-rates')).json())
    .items.find((item) => item.isDefault);
  if (!rate) throw new Error('setup made no default VAT rate');
  defaultRate = rate.id;
  const [first] = warehouseListSchema.parse((await send('GET', '/warehouses')).json()).items;
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;

  const merchandising = await addRole('Merchandising', ['purchase.requisition.manage']);
  purchaseManager = await addRole('Purchase manager', ['purchase.requisition.manage']);
  director = await addRole('Director', []);
  rupa = await member('rupa@anantaapparels.com', 'Rupa Sultana', 'Buyer-order-2026', [
    merchandising,
  ]);
  kamal = await member('kamal@anantaapparels.com', 'Kamal Hossain', 'Purchase-desk-2026', [
    purchaseManager,
  ]);
  faruk = await member('faruk@anantaapparels.com', 'Faruk Ahmed', 'Purchase-desk-2027', [
    purchaseManager,
  ]);
  nabila = await member('nabila@anantaapparels.com', 'Nabila Zahir', 'Board-room-2026', [director]);
  const { items: members } = memberPageSchema.parse(
    (await send('GET', '/members?limit=50')).json(),
  );
  const byEmail = (email: string) => {
    const found = members.find((item) => item.email === email);
    if (!found) throw new Error(`${email} is not a member`);
    return found.userId;
  };
  userIds = new Map([
    [owner, byEmail('sharif@anantaapparels.com')],
    [rupa, byEmail('rupa@anantaapparels.com')],
    [kamal, byEmail('kamal@anantaapparels.com')],
    [faruk, byEmail('faruk@anantaapparels.com')],
    [nabila, byEmail('nabila@anantaapparels.com')],
  ]);

  jersey = await addProduct('Single jersey 160 GSM, white', {
    baseUnitId: unitId('kg'),
    units: [{ unitId: unitId('roll'), factor: '25', barcode: '' }],
  });
  buttons = await addProduct('Polo button, 4-hole, 18L');
  knitting = await addProduct('Knitting charge', { type: 'service' });
  // Opening stock: 500 kg of jersey at ৳420 a kg
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      {
        variantId: variantOf(jersey),
        unitId: unitId('kg'),
        quantity: '500',
        batchId: '',
        lotNumber: '',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
        unitCost: '420',
      },
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('approval rules', () => {
  it('start with no levels, and the first save is made from version 0', async () => {
    const { items } = approvalRuleListSchema.parse((await send('GET', '/approval-rules')).json());
    // One rule per kind of document (step 17b added the purchase order's, 17c the bill's and the
    // supplier payment's), each its own form
    expect(items).toEqual([
      { document: 'requisition', levels: [], version: 0, updatedAt: null },
      { document: 'purchase_order', levels: [], version: 0, updatedAt: null },
      { document: 'bill', levels: [], version: 0, updatedAt: null },
      { document: 'supplier_payment', levels: [], version: 0, updatedAt: null },
    ]);

    const stale = await send('PUT', '/approval-rules/requisition', { levels: [], version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');

    // Up to ৳20,000 nobody needs to approve; from ৳20,000 a purchase manager; from ৳1,00,000 the
    // director as well
    const saved = await saveRule([
      { minAmount: '20000', roleId: purchaseManager.id },
      { minAmount: '100000', roleId: director.id },
    ]);
    expect(saved).toMatchObject({
      version: 1,
      levels: [
        { minAmount: '20000.0000', role: { id: purchaseManager.id, name: 'Purchase manager' } },
        { minAmount: '100000.0000', role: { id: director.id, name: 'Director' } },
      ],
    });
    // A second "first save" from a page opened before it
    const again = await send('PUT', '/approval-rules/requisition', { levels: [], version: 0 });
    expect(again.statusCode).toBe(409);
    expect(problemOf(again).code).toBe('version_conflict');

    const log = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace&limit=5')).json(),
    );
    const changed = log.items.find((entry) => entry.action === 'approval_rules.changed');
    expect(changed?.changes).toEqual({
      requisition: {
        from: null,
        to: 'Purchase manager from 20000.0000; Director from 100000.0000',
      },
    });
  });

  it('refuse levels out of order, a role twice, an unknown role, and anyone but settings', async () => {
    const res = await send('PUT', '/approval-rules/requisition', {
      levels: [
        { minAmount: '50000', roleId: purchaseManager.id },
        { minAmount: '10000', roleId: director.id },
        { minAmount: '90000', roleId: purchaseManager.id },
      ],
      version: 1,
    });
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({
      'levels.1.minAmount': ['approval_level_order'],
      'levels.2.roleId': ['approval_role_twice'],
    });

    const unknown = await send('PUT', '/approval-rules/requisition', {
      levels: [
        { minAmount: '0', roleId: purchaseManager.id },
        { minAmount: '0', roleId: '01939d1c-0000-7000-8000-000000000000' },
      ],
      version: 1,
    });
    expect(unknown.statusCode).toBe(409);
    expect(problemOf(unknown).fieldErrors).toEqual({
      'levels.1.roleId': ['approval_role_invalid'],
    });

    const notMine = await send(
      'PUT',
      '/approval-rules/requisition',
      { levels: [], version: 1 },
      kamal,
    );
    expect(notMine.statusCode).toBe(403);
    // Reading them needs nothing: the requisition form says "Needs 2 approvals"
    expect((await send('GET', '/approval-rules', undefined, rupa)).statusCode).toBe(200);
  });

  it('keep a role a level names from being deleted', async () => {
    const res = await send('DELETE', `/roles/${director.id}?version=${String(director.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('role_in_use');
  });
});

describe('requisitions', () => {
  it('are numbered when saved, with the amount of their lines', async () => {
    const doc = await requested(
      [
        line(jersey, '2', '10500', { unitId: unitId('roll') }),
        line(jersey, '40', '410.50', { unitId: unitId('kg') }),
      ],
      rupa,
      { neededBy: '2026-10-20', note: 'Buyer PO 4410, H&M polo' },
    );
    expect(doc).toMatchObject({
      status: 'draft',
      amount: '37420.0000',
      lineCount: 2,
      neededBy: '2026-10-20',
      requestedBy: { id: userOf(rupa), name: 'Rupa Sultana' },
      approval: { rounds: [], canDecide: false },
    });
    expect(doc.number).toMatch(/^PR-/);
    expect(doc.lines.map((item) => [item.quantity, item.baseQuantity, item.amount])).toEqual([
      ['2.0000', '50.0000', '21000.0000'],
      ['40.0000', '40.0000', '16420.0000'],
    ]);
    expect(doc.lines[0]?.description).toBe('Single jersey 160 GSM, white');

    // A draft changes freely; a page opened before the change cannot save over it
    const res = await send(
      'PUT',
      `/requisitions/${doc.id}`,
      { ...requisitionForm([line(buttons, '5000', '1.20')]), version: doc.version },
      rupa,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(requisitionSchema.parse(res.json())).toMatchObject({
      amount: '6000.0000',
      lineCount: 1,
    });
    const stale = await send(
      'PUT',
      `/requisitions/${doc.id}`,
      { ...requisitionForm([line(buttons, '1', '1')]), version: doc.version },
      rupa,
    );
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');

    const list = requisitionPageSchema.parse(
      (await send('GET', '/requisitions?status=draft')).json(),
    );
    expect(list.items.map((item) => item.number)).toContain(doc.number);
  });

  it('check the form: dates, costs and lines', async () => {
    const res = await send(
      'POST',
      '/requisitions',
      requisitionForm([line(buttons, '10', '')], { neededBy: '2026-10-01' }),
      rupa,
    );
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({
      neededBy: ['requisition_needed_by'],
      'lines.0.estimatedCost': ['requisition_cost_required'],
    });
    const empty = await send('POST', '/requisitions', requisitionForm([]), rupa);
    expect(problemOf(empty).fieldErrors).toEqual({ lines: ['purchase_lines_required'] });
  });

  it('check the warehouse and every item, each problem under its line', async () => {
    const old = await addProduct('Zipper, metal, 7 inch');
    const archived = await send('POST', `/products/${old.id}/archive`, { version: old.version });
    expect(archived.statusCode, archived.body).toBe(200);
    const res = await send(
      'POST',
      '/requisitions',
      requisitionForm([
        line(old, '10', '12'),
        line(buttons, '10', '1', { unitId: unitId('roll') }),
        line(buttons, '1.5', '1'),
        line(knitting, '1', '25000'),
      ]),
      rupa,
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.0.variantId': ['purchase_item_invalid'],
      'lines.1.unitId': ['stock_unit_invalid'],
      'lines.2.quantity': ['stock_quantity_decimals'],
    });

    const nowhere = await send(
      'POST',
      '/requisitions',
      requisitionForm([line(buttons, '10', '1')], {
        warehouseId: '01939d1c-0000-7000-8000-000000000000',
      }),
      rupa,
    );
    expect(nowhere.statusCode).toBe(409);
    expect(problemOf(nowhere).fieldErrors).toEqual({ warehouseId: ['purchase_warehouse_invalid'] });
  });

  it('keep a warehouse archived since on a draft, but not on a new one', async () => {
    const [branch] = branchListSchema.parse((await send('GET', '/branches')).json()).items;
    if (!branch) throw new Error('no branch');
    const made = await send('POST', '/warehouses', {
      branchId: branch.id,
      code: 'TRIM',
      name: 'Trims store',
      address: '',
    });
    expect(made.statusCode, made.body).toBe(201);
    const store = warehouseSchema.parse(made.json());
    const doc = await requested([line(buttons, '100', '1.10')], rupa, { warehouseId: store.id });
    const archived = await send('POST', `/warehouses/${store.id}/archive`, {
      version: store.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const kept = await send(
      'PUT',
      `/requisitions/${doc.id}`,
      {
        ...requisitionForm([line(buttons, '120', '1.10')], { warehouseId: store.id }),
        version: doc.version,
      },
      rupa,
    );
    expect(kept.statusCode, kept.body).toBe(200);
    const fresh = await send(
      'POST',
      '/requisitions',
      requisitionForm([line(buttons, '10', '1')], { warehouseId: store.id }),
      rupa,
    );
    expect(problemOf(fresh).fieldErrors).toEqual({ warehouseId: ['purchase_warehouse_invalid'] });
  });

  it('keep a product its lines name from being deleted', async () => {
    const thread = await addProduct('Sewing thread, 40/2, white');
    await requested([line(thread, '200', '85')]);
    const res = await send('DELETE', `/products/${thread.id}?version=${String(thread.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('product_in_use');
  });

  it('delete a draft that was never submitted', async () => {
    const doc = await worth('500');
    const res = await send(
      'DELETE',
      `/requisitions/${doc.id}?version=${String(doc.version)}`,
      undefined,
      rupa,
    );
    expect(res.statusCode, res.body).toBe(204);
    expect((await send('GET', `/requisitions/${doc.id}`)).statusCode).toBe(404);
  });
});

describe('approval', () => {
  it('approves a requisition below every level at once, with no steps', async () => {
    const doc = await act('submit', await worth('5000'));
    expect(doc.status).toBe('approved');
    expect(roundOf(doc)).toMatchObject({ status: 'approved', amount: '5000.0000', steps: [] });
    expect(roundOf(doc).closedAt).not.toBeNull();
  });

  it("approves an Owner's own requisition at once, every step signed by the Owner", async () => {
    const doc = await act('submit', await worth('150000', owner), owner);
    expect(doc.status).toBe('approved');
    expect(
      roundOf(doc).steps.map((step) => [step.role.name, step.decision, step.decidedBy?.name]),
    ).toEqual([
      ['Purchase manager', 'approved', 'Sharif Zahir'],
      ['Director', 'approved', 'Sharif Zahir'],
    ]);
    // Nobody is asked about it
    expect(await bell(kamal)).not.toContainEqual(['approval.requested', doc.number]);
  });

  it('waits for each level in order, and tells each level when it is its turn', async () => {
    const draft = await worth('150000');
    const doc = await act('submit', draft);
    expect(doc.status).toBe('pending');
    expect(roundOf(doc)).toMatchObject({ status: 'pending', closedAt: null });
    expect(
      roundOf(doc).steps.map((step) => [step.position, step.role.name, step.decision]),
    ).toEqual([
      [1, 'Purchase manager', null],
      [2, 'Director', null],
    ]);
    // A pending requisition is not changed: it is reopened first
    const locked = await send(
      'PUT',
      `/requisitions/${doc.id}`,
      { ...requisitionForm([line(buttons, '1', '1')]), version: doc.version },
      rupa,
    );
    expect(problemOf(locked).code).toBe('purchase_not_draft');

    // Both purchase managers hear of it; the director not yet; Rupa, who sent it, not at all
    expect(await bell(kamal)).toContainEqual(['approval.requested', doc.number]);
    expect(await bell(faruk)).toContainEqual(['approval.requested', doc.number]);
    expect(await bell(nabila)).not.toContainEqual(['approval.requested', doc.number]);
    expect((await waiting(kamal)).items.find((item) => item.id === doc.id)).toMatchObject({
      document: 'requisition',
      number: doc.number,
      subject: main.name,
      amount: '150000.0000',
      submittedBy: { name: 'Rupa Sultana' },
      position: 1,
      stepCount: 2,
    });
    expect((await waiting(nabila)).items.map((item) => item.id)).not.toContain(doc.id);
    expect((await requisition(doc.id, kamal)).approval.canDecide).toBe(true);
    expect((await requisition(doc.id, nabila)).approval.canDecide).toBe(false);

    // Not the director's turn yet, and never Rupa's
    const early = await decide('approve', doc, nabila);
    expect(early.statusCode).toBe(403);
    expect(problemOf(early).code).toBe('approval_not_allowed');
    expect(problemOf(await decide('approve', doc, rupa)).code).toBe('approval_own_document');

    const halfway = await approved(doc, kamal, 'Rate checked against the last two POs');
    expect(halfway.status).toBe('pending');
    expect(await bell(nabila)).toContainEqual(['approval.requested', doc.number]);
    expect((await waiting(nabila)).items.find((item) => item.id === doc.id)?.position).toBe(2);
    expect((await waiting(faruk)).items.map((item) => item.id)).not.toContain(doc.id);

    const done = await approved(halfway, nabila);
    expect(done.status).toBe('approved');
    expect(roundOf(done)).toMatchObject({ status: 'approved' });
    expect(
      roundOf(done).steps.map((step) => [step.decision, step.decidedBy?.name, step.comment]),
    ).toEqual([
      ['approved', 'Kamal Hossain', 'Rate checked against the last two POs'],
      ['approved', 'Nabila Zahir', null],
    ]);
    // Rupa hears it was approved; the version moved, so a page opened before cannot reopen it
    expect(await bell(rupa)).toContainEqual(['approval.approved', doc.number]);
    const stale = await send(
      'POST',
      `/requisitions/${doc.id}/reopen`,
      { version: halfway.version },
      rupa,
    );
    expect(problemOf(stale).code).toBe('version_conflict');

    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=requisition&entityId=${doc.id}`)).json(),
    );
    expect(log.items.map((entry) => entry.action)).toEqual([
      'approval.approved',
      'approval.approved',
      'approval.submitted',
      'requisition.created',
    ]);
  });

  it('never lets the person who submitted it approve it, unless an Owner', async () => {
    const doc = await act('submit', await worth('30000', kamal), kamal);
    expect(roundOf(doc).steps).toHaveLength(1);
    const own = await decide('approve', doc, kamal);
    expect(own.statusCode).toBe(403);
    expect(problemOf(own).code).toBe('approval_own_document');
    expect((await waiting(kamal)).items.map((item) => item.id)).not.toContain(doc.id);
    expect((await requisition(doc.id, kamal)).approval.canDecide).toBe(false);
    // Faruk is told; Kamal, who holds the same role, is not told about his own
    expect(await bell(faruk)).toContainEqual(['approval.requested', doc.number]);
    expect(await bell(kamal)).not.toContainEqual(['approval.requested', doc.number]);
    // The Owner sees every waiting step
    expect((await waiting(owner)).items.map((item) => item.id)).toContain(doc.id);
  });

  it('sends a rejected requisition back to draft with the reason; the next round starts at level 1', async () => {
    const doc = await act('submit', await worth('120000'));
    const noReason = await decide('reject', doc, faruk, ' ');
    expect(noReason.statusCode).toBe(400);
    expect(problemOf(noReason).fieldErrors).toEqual({ comment: ['approval_comment_required'] });

    const res = await decide('reject', doc, faruk, 'Use the 18L buttons left from PO 4302 first');
    expect(res.statusCode, res.body).toBe(204);
    const back = await requisition(doc.id);
    expect(back.status).toBe('draft');
    expect(roundOf(back)).toMatchObject({ status: 'rejected' });
    expect(roundOf(back).steps.map((step) => [step.decision, step.comment])).toEqual([
      ['rejected', 'Use the 18L buttons left from PO 4302 first'],
      [null, null],
    ]);
    expect(await bell(rupa)).toContainEqual(['approval.rejected', doc.number]);
    // The page Kamal had open still shows the old round: nothing happens
    const late = await decide('approve', doc, kamal);
    expect(late.statusCode).toBe(409);
    expect(problemOf(late).code).toBe('approval_not_pending');

    // Changed and sent again: a new round from the first level, the old one kept below it
    const changed = await send(
      'PUT',
      `/requisitions/${doc.id}`,
      { ...requisitionForm([line(buttons, '1', '80000')]), version: back.version },
      rupa,
    );
    expect(changed.statusCode, changed.body).toBe(200);
    const again = await act('submit', requisitionSchema.parse(changed.json()));
    expect(again.approval.rounds.map((round) => [round.status, round.steps.length])).toEqual([
      ['pending', 1],
      ['rejected', 2],
    ]);
    // Once submitted, it is never deleted: its history stays
    const reopened = await act('reopen', again);
    const removed = await send(
      'DELETE',
      `/requisitions/${doc.id}?version=${String(reopened.version)}`,
      undefined,
      rupa,
    );
    expect(removed.statusCode).toBe(409);
    expect(problemOf(removed).code).toBe('purchase_was_submitted');
  });

  it('reopens a pending requisition (its round ends) and an approved one (its round stays)', async () => {
    const pending = await act('submit', await worth('45000'));
    const back = await act('reopen', pending);
    expect(back.status).toBe('draft');
    expect(roundOf(back)).toMatchObject({ status: 'reopened' });
    expect(await waitingCount(faruk)).toBe((await waiting(faruk)).items.length);
    expect((await waiting(faruk)).items.map((item) => item.id)).not.toContain(pending.id);

    const small = await act('submit', await worth('9000'));
    expect(small.status).toBe('approved');
    const changedMind = await act('reopen', small);
    expect(changedMind.status).toBe('draft');
    expect(roundOf(changedMind)).toMatchObject({ status: 'approved' });
  });

  it('cancels only a draft or an approved requisition', async () => {
    const pending = await act('submit', await worth('25000'));
    const refused = await send(
      'POST',
      `/requisitions/${pending.id}/cancel`,
      { version: pending.version },
      rupa,
    );
    expect(problemOf(refused).code).toBe('purchase_cannot_cancel');

    const cancelled = await act('cancel', await act('reopen', pending));
    expect(cancelled.status).toBe('cancelled');
    const reopen = await send(
      'POST',
      `/requisitions/${cancelled.id}/reopen`,
      { version: cancelled.version },
      rupa,
    );
    expect(problemOf(reopen).code).toBe('purchase_cannot_reopen');
    const submit = await send(
      'POST',
      `/requisitions/${cancelled.id}/submit`,
      { version: cancelled.version },
      rupa,
    );
    expect(problemOf(submit).code).toBe('purchase_not_draft');
  });

  it('lets one of two people deciding the same step at once win', async () => {
    const doc = await act('submit', await worth('60000'));
    const answers = await Promise.all([
      decide('approve', doc, kamal),
      decide('approve', doc, faruk),
    ]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([204, 409]);
    const loser = answers.find((res) => res.statusCode === 409);
    if (loser) expect(problemOf(loser).code).toBe('approval_not_pending');
    const done = await requisition(doc.id);
    expect(done.status).toBe('approved');
    expect(roundOf(done).steps.filter((step) => step.decision !== null)).toHaveLength(1);
  });

  it('counts what waits for each person, and pages the list oldest first', async () => {
    const first = await act('submit', await worth('21000'));
    const second = await act('submit', await worth('22000'));
    const mine = await waiting(faruk);
    expect(await waitingCount(faruk)).toBe(mine.items.length);
    const ids = mine.items.map((item) => item.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));

    const page = waitingApprovalPageSchema.parse(
      (await send('GET', '/approvals/waiting?limit=1', undefined, faruk)).json(),
    );
    expect(page.items).toHaveLength(1);
    if (page.nextCursor === null) throw new Error('expected a second page');
    const next = waitingApprovalPageSchema.parse(
      (
        await send('GET', `/approvals/waiting?limit=1&cursor=${page.nextCursor}`, undefined, faruk)
      ).json(),
    );
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    // Rupa holds no approving role: nothing waits for her
    expect(await waitingCount(rupa)).toBe(0);
  });
});

describe('a level nobody holds', () => {
  it('rings the Owners, keeps its role while a step waits for it, then lets it go', async () => {
    const compliance = await addRole('Compliance', []);
    await saveRule([{ minAmount: '0', roleId: compliance.id }]);
    const doc = await act('submit', await worth('1000'));
    expect(await bell(owner)).toContainEqual(['approval.requested', doc.number]);

    // The level no longer names it, but the waiting step still does
    await saveRule([{ minAmount: '20000', roleId: purchaseManager.id }]);
    const refused = await send(
      'DELETE',
      `/roles/${compliance.id}?version=${String(compliance.version)}`,
    );
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused).code).toBe('role_in_use');

    const done = await approved(doc, owner);
    expect(done.status).toBe('approved');
    const deleted = await send(
      'DELETE',
      `/roles/${compliance.id}?version=${String(compliance.version)}`,
    );
    expect(deleted.statusCode, deleted.body).toBe(204);
    // The history keeps the role's name after the role is gone
    expect(roundOf(await requisition(doc.id)).steps.map((step) => step.role)).toEqual([
      { id: null, name: 'Compliance' },
    ]);
  });
});

describe('cost lookup', () => {
  it('starts a line at the average cost, per the unit asked for', async () => {
    const res = await send('POST', '/purchase/cost-lookup', {
      items: [
        { variantId: variantOf(jersey), unitId: unitId('roll') },
        { variantId: variantOf(knitting), unitId: unitId('pcs') },
        { variantId: '01939d1c-0000-7000-8000-000000000000', unitId: unitId('pcs') },
        { variantId: variantOf(jersey), unitId: unitId('pcs') },
        { variantId: variantOf(jersey), unitId: unitId('kg') },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    // An unknown item and a unit that is not the product's are left out; the order stays
    expect(costLookupSchema.parse(res.json()).items).toEqual([
      {
        variantId: variantOf(jersey),
        unitId: unitId('roll'),
        cost: '10500.0000',
        source: 'average_cost',
        taxRateId: defaultRate,
      },
      {
        variantId: variantOf(knitting),
        unitId: unitId('pcs'),
        cost: null,
        source: null,
        taxRateId: defaultRate,
      },
      {
        variantId: variantOf(jersey),
        unitId: unitId('kg'),
        cost: '420.0000',
        source: 'average_cost',
        taxRateId: defaultRate,
      },
    ]);
  });

  it('gives no cost to someone who may not see stock values', async () => {
    const res = await send(
      'POST',
      '/purchase/cost-lookup',
      { items: [{ variantId: variantOf(jersey), unitId: unitId('kg') }] },
      rupa,
    );
    expect(costLookupSchema.parse(res.json()).items).toEqual([
      {
        variantId: variantOf(jersey),
        unitId: unitId('kg'),
        cost: null,
        source: null,
        taxRateId: defaultRate,
      },
    ]);
  });
});
