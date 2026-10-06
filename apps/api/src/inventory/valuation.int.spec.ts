import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  auditPageSchema,
  branchSchema,
  journalEntrySchema,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  setupSchema,
  stockAccountsSchema,
  stockAdjustmentSchema,
  type StockAdjustmentFormValues,
  stockCardSchema,
  stockMovementPageSchema,
  stockPageSchema,
  stockRevaluationSchema,
  stockTransferSchema,
  stockValuePageSchema,
  type Unit,
  unitListSchema,
  valuationSummarySchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
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

// Step 14: what the stock is worth, and the books that follow it. One distributor again: juice in
// cartons of 24 at a typed cost, a depot in the same branch, a Chattogram store in another branch,
// rice that came in at zero cost and is revalued, and two people taking the last tea at once.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// A member with no role: reads stock, sees no cost
let viewer: SignedIn;
let units: Unit[];
let accounts: Account[];
let main: Warehouse;
let depot: Warehouse;
let ctg: Warehouse;
let juice: Product;

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

function accountId(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function codeOf(id: string): string {
  return accounts.find((account) => account.id === id)?.code ?? id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function product(name: string, extra: Partial<ProductFormValues> = {}): Promise<Product> {
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
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

function line(variantId: string, quantity: string, unitCost = '', extra: object = {}) {
  return {
    variantId,
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost,
    ...extra,
  };
}

function adjustment(
  direction: 'in' | 'out',
  lines: object[],
  extra: Partial<StockAdjustmentFormValues> = {},
) {
  return {
    date: '2026-10-01',
    warehouseId: main.id,
    direction,
    reason: direction === 'in' ? 'opening' : 'damaged',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

async function posted(body: object) {
  const res = await send('POST', '/stock-adjustments', body);
  expect(res.statusCode, res.body).toBe(201);
  return stockAdjustmentSchema.parse(res.json());
}

function transfer(from: Warehouse, to: Warehouse, variantId: string, quantity: string) {
  return {
    fromWarehouseId: from.id,
    toWarehouseId: to.id,
    date: '2026-10-02',
    note: '',
    lines: [{ variantId, unitId: unitId('pcs'), quantity, batchId: '', serialNumbers: [] }],
    send: true,
  };
}

async function sent(body: object) {
  const res = await send('POST', '/stock-transfers', body);
  expect(res.statusCode, res.body).toBe(201);
  return stockTransferSchema.parse(res.json());
}

async function received(id: string, quantity: string) {
  const before = stockTransferSchema.parse((await send('GET', `/stock-transfers/${id}`)).json());
  const res = await send('POST', `/stock-transfers/${id}/receive`, {
    version: before.version,
    date: '2026-10-03',
    lines: before.lines.map((item) => ({
      lineId: item.id,
      receivedQuantity: quantity,
      serialNumbers: [],
    })),
  });
  expect(res.statusCode, res.body).toBe(200);
  return stockTransferSchema.parse(res.json());
}

// A journal entry as [account code, branch, debit, credit] rows — what an accountant reads
async function entryLines(id: string) {
  const entry = journalEntrySchema.parse((await send('GET', `/journal-entries/${id}`)).json());
  return entry.lines.map((item) => [
    codeOf(item.accountId),
    item.branchId,
    item.debit,
    item.credit,
  ]);
}

async function cardOf(variantId: string) {
  return stockCardSchema.parse((await send('GET', `/stock/variants/${variantId}`)).json());
}

async function summary() {
  const res = await send('GET', '/stock/valuation/summary');
  expect(res.statusCode, res.body).toBe(200);
  return valuationSummarySchema.parse(res.json());
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
    companyName: 'Padma Traders',
    workspaceSlug: 'padma-traders',
    fullName: 'Nasrin Sultana',
    email: 'nasrin@padmatraders.com',
    password: 'Ledger-stock-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const { items } = warehouseListSchema.parse((await send('GET', '/warehouses')).json());
  const first = items[0];
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;
  depot = warehouseSchema.parse(
    (
      await send('POST', '/warehouses', {
        branchId: main.branchId,
        code: 'DEPOT',
        name: 'Tejgaon depot',
        address: '',
      })
    ).json(),
  );
  const branch = branchSchema.parse(
    (
      await send('POST', '/branches', {
        code: 'CTG',
        name: 'Chattogram',
        phone: '',
        address: '',
      })
    ).json(),
  );
  ctg = warehouseSchema.parse(
    (
      await send('POST', '/warehouses', {
        branchId: branch.id,
        code: 'CTG',
        name: 'Chattogram store',
        address: '',
      })
    ).json(),
  );
  juice = await product('Pran Mango Juice 250 ml', {
    units: [{ unitId: unitId('case'), factor: '24', barcode: '' }],
  });

  await signUp(app, {
    companyName: 'Rina Store',
    workspaceSlug: 'rina-store',
    fullName: 'Rina Akter',
    email: 'rina@padmatraders.com',
    password: 'Counter-cash-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'rina@padmatraders.com',
    workspace: 'padma-traders',
  });
  viewer = await logIn(app, {
    workspace: 'padma-traders',
    email: 'rina@padmatraders.com',
    password: 'Counter-cash-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('the value of stock', () => {
  it('values opening stock at its typed cost, and posts it against opening balance equity', async () => {
    // 3 cartons at ৳1,200 a carton: 72 pieces worth ৳3,600, ৳50 a piece
    const opening = await posted(
      adjustment('in', [line(variantOf(juice), '3', '1200', { unitId: unitId('case') })]),
    );
    expect(opening.lines[0]).toMatchObject({
      baseQuantity: '72.0000',
      unitCost: '1200.0000',
      value: '3600.0000',
    });
    if (!opening.entry) throw new Error('expected a journal entry');
    expect(await entryLines(opening.entry.id)).toEqual([
      ['1150', main.branchId, '3600.0000', '0.0000'],
      ['3300', main.branchId, '0.0000', '3600.0000'],
    ]);
    expect((await cardOf(variantOf(juice))).item).toMatchObject({
      onHand: '72.0000',
      unitCost: '50.0000',
      value: '3600.0000',
    });
  });

  it('moves the average with each inflow, and takes outflows at it', async () => {
    // 48 more at ৳56.25: 120 pieces worth ৳6,300, ৳52.50 a piece
    await posted(adjustment('in', [line(variantOf(juice), '48', '56.25')], { reason: 'found' }));
    // 20 damaged go at the average: ৳1,050 to the loss account
    const damaged = await posted(adjustment('out', [line(variantOf(juice), '20')]));
    expect(damaged.lines[0]).toMatchObject({ unitCost: null, value: '1050.0000' });
    if (!damaged.entry) throw new Error('expected a journal entry');
    expect(await entryLines(damaged.entry.id)).toEqual([
      ['1150', main.branchId, '0.0000', '1050.0000'],
      ['5330', main.branchId, '1050.0000', '0.0000'],
    ]);
    const history = stockMovementPageSchema.parse(
      (await send('GET', `/stock/variants/${variantOf(juice)}/movements`)).json(),
    );
    expect(history.items.map((item) => [item.quantity, item.value])).toEqual([
      ['72.0000', '3600.0000'],
      ['48.0000', '2700.0000'],
      ['-20.0000', '-1050.0000'],
    ]);
    expect((await cardOf(variantOf(juice))).item).toMatchObject({
      onHand: '100.0000',
      unitCost: '52.5000',
      value: '5250.0000',
    });
  });

  it('prices an in-line without a cost at the average, and refuses the first stock of an item without one', async () => {
    const more = await posted(
      adjustment('in', [line(variantOf(juice), '10')], { reason: 'correction' }),
    );
    expect(more.lines[0]).toMatchObject({ unitCost: null, value: '525.0000' });

    const biscuit = await product('Olympic Energy Plus');
    const res = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(biscuit), '5')]),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'lines.0.unitCost': ['stock_cost_required'] });
  });

  it('empties the value with the stock: the last piece takes what is left', async () => {
    // 3 pieces at ৳33.3333 = ৳100 (99.9999, to the paisa). Out one by one: 33.33, 33.34, 33.33.
    const soap = await product('Lux Soap 100 g');
    await posted(adjustment('in', [line(variantOf(soap), '3', '33.3333')]));
    const values: (string | null | undefined)[] = [];
    for (let piece = 0; piece < 3; piece++) {
      const out = await posted(adjustment('out', [line(variantOf(soap), '1')]));
      values.push(out.lines[0]?.value);
    }
    expect(values).toEqual(['33.3300', '33.3400', '33.3300']);
    expect((await cardOf(variantOf(soap))).item).toMatchObject({
      onHand: '0.0000',
      value: '0.0000',
      // The last average stays: an outflow below zero (if allowed) is priced at it
      unitCost: '33.3300',
    });
  });
});

describe('transfers', () => {
  it('posts nothing inside a branch, and only the shortage when it arrives short', async () => {
    // 110 pieces worth ৳5,775; 24 of them are worth ৳1,260
    const transferred = await sent(transfer(main, depot, variantOf(juice), '24'));
    expect(transferred.entries).toEqual([]);
    expect(transferred.lines[0]?.value).toBe('1260.0000');
    expect(await summary()).toMatchObject({ inTransitValue: '1260.0000', difference: '0.0000' });

    // 20 arrive: ৳1,050 into the depot, ৳210 lost on the way
    const arrived = await received(transferred.id, '20');
    expect(arrived.lines[0]).toMatchObject({ value: '1260.0000', receivedValue: '1050.0000' });
    const [entry] = arrived.entries;
    if (!entry) throw new Error('expected a journal entry for the shortage');
    expect(await entryLines(entry.id)).toEqual([
      ['5330', main.branchId, '210.0000', '0.0000'],
      ['1150', main.branchId, '0.0000', '210.0000'],
    ]);
    expect(await summary()).toMatchObject({ inTransitValue: '0.0000', difference: '0.0000' });
  });

  it('sends between branches through goods in transit', async () => {
    // 106 pieces worth ৳5,565; 10 of them ৳525
    const transferred = await sent(transfer(main, ctg, variantOf(juice), '10'));
    const [sentEntry] = transferred.entries;
    if (!sentEntry) throw new Error('expected a journal entry for the sending');
    expect(await entryLines(sentEntry.id)).toEqual([
      ['1175', null, '525.0000', '0.0000'],
      ['1150', main.branchId, '0.0000', '525.0000'],
    ]);
    expect(await summary()).toMatchObject({ inTransitValue: '525.0000', difference: '0.0000' });

    // 8 arrive in Chattogram: ৳420 into its stock, ৳105 lost (Dhaka's loss: it left there)
    const arrived = await received(transferred.id, '8');
    expect(arrived.entries).toHaveLength(2);
    const receivedEntry = arrived.entries[1];
    if (!receivedEntry) throw new Error('expected a journal entry for the receipt');
    expect(await entryLines(receivedEntry.id)).toEqual([
      ['1150', ctg.branchId, '420.0000', '0.0000'],
      ['5330', main.branchId, '105.0000', '0.0000'],
      ['1175', null, '0.0000', '525.0000'],
    ]);
    expect(await summary()).toMatchObject({ inTransitValue: '0.0000', difference: '0.0000' });
  });
});

describe('revaluation', () => {
  it('gives stock that came in at zero cost its value, and posts the difference', async () => {
    const rice = await product('Chinigura Rice 1 kg');
    const free = await posted(adjustment('in', [line(variantOf(rice), '50', '0')]));
    // Nothing to post: the stock is worth nothing yet
    expect(free.entry).toBeNull();

    const res = await send('POST', '/stock-revaluations', {
      date: '2026-10-04',
      note: 'At the supplier invoice price',
      lines: [{ variantId: variantOf(rice), unitCost: '80' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const revaluation = stockRevaluationSchema.parse(res.json());
    expect(revaluation.number).toMatch(/^REV-/);
    expect(revaluation.difference).toBe('4000.0000');
    expect(revaluation.lines[0]).toMatchObject({
      quantity: '50.0000',
      oldUnitCost: '0.0000',
      oldValue: '0.0000',
      unitCost: '80.0000',
      newValue: '4000.0000',
      difference: '4000.0000',
    });
    if (!revaluation.entry) throw new Error('expected a journal entry');
    expect(await entryLines(revaluation.entry.id)).toEqual([
      ['1150', main.branchId, '4000.0000', '0.0000'],
      ['5190', main.branchId, '0.0000', '4000.0000'],
    ]);
    // On the stock card: a movement of no quantity and ৳4,000
    const history = stockMovementPageSchema.parse(
      (await send('GET', `/stock/variants/${variantOf(rice)}/movements`)).json(),
    );
    expect(history.items.at(-1)).toMatchObject({
      kind: 'revaluation',
      quantity: '0.0000',
      value: '4000.0000',
      balance: '50.0000',
    });
    expect((await cardOf(variantOf(rice))).item).toMatchObject({
      unitCost: '80.0000',
      value: '4000.0000',
    });
  });

  it('refuses an item with no stock, and never changes once posted', async () => {
    const empty = await product('Fresh Atta 2 kg');
    const res = await send('POST', '/stock-revaluations', {
      date: '2026-10-04',
      note: '',
      lines: [{ variantId: variantOf(empty), unitCost: '120' }],
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'lines.0.variantId': ['revaluation_no_stock'] });

    await expect(
      superuserSql((sql) => sql`UPDATE stock_revaluations SET note = 'changed'`),
    ).rejects.toThrow(/cannot be changed or deleted/);
  });
});

describe('the books stay with the stock', () => {
  it('refuses a manual entry or an opening balance on the inventory or transit account', async () => {
    for (const code of ['1150', '1175']) {
      const res = await send('POST', '/journal-entries', {
        date: '2026-10-05',
        narration: '',
        lines: [
          { accountId: accountId(code), branchId: '', description: '', debit: '100', credit: '' },
          { accountId: accountId('1110'), branchId: '', description: '', debit: '', credit: '100' },
        ],
        post: false,
      });
      expect(res.statusCode, code).toBe(409);
      expect(problemOf(res).fieldErrors).toEqual({
        'lines.0.accountId': ['journal_account_stock'],
      });
    }
    const opening = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [{ accountId: accountId('1150'), debit: '5000', credit: '' }],
    });
    expect(opening.statusCode).toBe(409);
    expect(problemOf(opening).fieldErrors).toEqual({
      'lines.0.accountId': ['journal_account_stock'],
    });
  });

  it('refuses to reverse a stock entry from the journal', async () => {
    const out = await posted(adjustment('out', [line(variantOf(juice), '1')], { reason: 'lost' }));
    if (!out.entry) throw new Error('expected a journal entry');
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${out.entry.id}`)).json(),
    );
    expect(entry).toMatchObject({
      source: 'stock_adjustment',
      document: { id: out.id, number: out.number },
    });
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-05',
    });
    expect(problemOf(res).code).toBe('journal_is_stock');
  });

  it('keeps every value equal to the sum of its movements, and the books equal to the stock', async () => {
    const drift = await superuserSql(
      (sql) => sql`
        SELECT v.variant_id FROM stock_values v
          LEFT JOIN LATERAL (
            SELECT coalesce(sum(m.quantity), 0) AS quantity, coalesce(sum(m.value), 0) AS value
              FROM stock_movements m
             WHERE m.tenant_id = v.tenant_id AND m.variant_id = v.variant_id
          ) m ON true
         WHERE v.quantity <> m.quantity OR v.value <> m.value`,
    );
    expect(drift).toEqual([]);
    expect((await summary()).difference).toBe('0.0000');
  });
});

describe('who sees what stock costs', () => {
  it('shows quantities to everyone, and costs only with inventory.stock.value', async () => {
    const page = stockPageSchema.parse((await send('GET', '/stock', undefined, viewer)).json());
    const item = page.items.find((row) => row.variantId === variantOf(juice));
    expect(item).toMatchObject({ unitCost: null, value: null });
    expect(item?.onHand).not.toBe('0.0000');

    const { items } = stockValuePageSchema.parse((await send('GET', '/stock/valuation')).json());
    expect(items.map((row) => row.productName)).toContain('Pran Mango Juice 250 ml');
    expect((await send('GET', '/stock/valuation', undefined, viewer)).statusCode).toBe(403);
    expect((await send('GET', '/stock-revaluations', undefined, viewer)).statusCode).toBe(403);
  });

  it('keeps a typed cost on the document, and hides what the books worked out', async () => {
    const found = await posted(
      adjustment('in', [line(variantOf(juice), '2', '60')], { reason: 'found' }),
    );
    const asViewer = stockAdjustmentSchema.parse(
      (await send('GET', `/stock-adjustments/${found.id}`, undefined, viewer)).json(),
    );
    expect(asViewer.lines[0]).toMatchObject({ unitCost: '60.0000', value: null });
  });
});

describe('stock accounts', () => {
  it('starts with the template choices, and refuses an account that does not fit', async () => {
    const choices = stockAccountsSchema.parse((await send('GET', '/stock-accounts')).json());
    expect(codeOf(choices.in_transit ?? '')).toBe('1175');
    expect(codeOf(choices.sample ?? '')).toBe('5310');

    const body = {
      ...Object.fromEntries(Object.entries(choices).map(([use, id]) => [use, id ?? ''])),
      // Cash is an asset, not a loss
      damaged: accountId('1110'),
      // The inventory account itself
      in_transit: accountId('1150'),
    };
    const res = await send('PUT', '/stock-accounts', body);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      in_transit: ['stock_account_inventory'],
      damaged: ['stock_account_invalid'],
    });

    const changed = await send('PUT', '/stock-accounts', {
      ...body,
      damaged: choices.damaged,
      in_transit: choices.in_transit,
      sample: accountId('5320'),
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(codeOf(stockAccountsSchema.parse(changed.json()).sample ?? '')).toBe('5320');
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace')).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'stock_accounts.changed',
      changes: { sample: { from: '5310', to: '5320' } },
    });
  });

  it('keeps a chosen account from being archived or deleted', async () => {
    const chosen = accounts.find((account) => account.code === '5190');
    if (!chosen) throw new Error('no 5190');
    const archive = await send('POST', `/accounts/${chosen.id}/archive`, {
      version: chosen.version,
    });
    expect(problemOf(archive).code).toBe('account_used_by_stock');
    const remove = await send('DELETE', `/accounts/${accountId('5290')}?version=1`);
    expect(problemOf(remove).code).toBe('account_used_by_stock');
  });

  it('refuses a posting whose account is not chosen, and posts nothing', async () => {
    await superuserSql(
      (sql) => sql`DELETE FROM stock_accounts WHERE use = 'sample'
                    AND tenant_id = (SELECT id FROM tenants WHERE slug = 'padma-traders')`,
    );
    const before = (await cardOf(variantOf(juice))).item.onHand;
    const res = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(juice), '2')], { reason: 'sample' }),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res)).toMatchObject({
      code: 'stock_account_missing',
      params: { use: 'sample' },
    });
    expect((await cardOf(variantOf(juice))).item.onHand).toBe(before);
  });

  it('gives a workspace from before step 14 its stock accounts', async () => {
    const shopOwner = await signUp(app, {
      companyName: 'Corner Shop',
      workspaceSlug: 'corner-shop',
      fullName: 'Kamal Uddin',
      email: 'kamal@cornershop.com',
      password: 'Corner-shop-2026',
    });
    const asShop = (method: 'GET' | 'POST', url: string, payload?: object) =>
      send(method, url, payload, shopOwner);
    expect((await asShop('POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
    await eventually(async () => {
      expect(setupSchema.parse((await asShop('GET', '/setup')).json()).status).toBe('ready');
    });
    // As migration 0024 finds it: a chart without the new accounts, and nothing chosen
    await superuserSql(async (sql) => {
      const [tenant] = await sql<
        { id: string }[]
      >`SELECT id FROM tenants WHERE slug = 'corner-shop'`;
      if (!tenant) throw new Error('no corner-shop');
      await sql`DELETE FROM stock_accounts WHERE tenant_id = ${tenant.id}`;
      await sql`DELETE FROM ledger_accounts
                 WHERE tenant_id = ${tenant.id} AND code IN ('1175', '5150', '5190', '5290')`;
      await sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                VALUES (gen_random_uuid(), ${tenant.id}, 'workspace.stock_accounts_requested', '{}'::jsonb)`;
    });
    await eventually(async () => {
      const choices = stockAccountsSchema.parse((await asShop('GET', '/stock-accounts')).json());
      expect(Object.values(choices).every((id) => id !== null)).toBe(true);
    }, 10_000);
    const chart = accountListSchema.parse((await asShop('GET', '/accounts')).json()).items;
    expect(chart.find((account) => account.code === '1175')).toMatchObject({
      name: 'Goods in transit',
      type: 'asset',
    });
    // Retail's own loss account is used, not a new one
    const choices = stockAccountsSchema.parse((await asShop('GET', '/stock-accounts')).json());
    expect(chart.find((account) => account.id === choices.damaged)?.code).toBe('5340');
  });
});

describe('two people at once', () => {
  it('prices two outflows of the same item one after the other', async () => {
    // Tea in two warehouses: 20 in Main store at 25.0008 (৳500.02) and 20 in the depot at
    // 25.0007 (৳500.01) — ৳1,000.03 in all. Main sends its 20 to Chattogram while the depot writes
    // its 20 off, at the same moment. Priced one after the other: the first takes its share
    // (৳500.02), the second what is left (৳500.01), and the value ends at exactly zero. Priced
    // from the same old average, both would take ৳500.02 and leave −৳0.01 with no stock.
    // A transfer and an adjustment on purpose: they take different number series, so only the
    // value row makes them wait for each other. A third connection holds that row until both wait.
    const tea = await product('Ispahani Mirzapore Tea 400 g');
    await posted(adjustment('in', [line(variantOf(tea), '20', '25.0008')]));
    await posted(
      adjustment('in', [line(variantOf(tea), '20', '25.0007')], { warehouseId: depot.id }),
    );

    const sendOut = () =>
      send('POST', '/stock-transfers', transfer(main, ctg, variantOf(tea), '20'));
    const writeOff = () =>
      send(
        'POST',
        '/stock-adjustments',
        adjustment('out', [line(variantOf(tea), '20')], { warehouseId: depot.id, reason: 'lost' }),
      );
    const blocker = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
    const probe = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
    let answers: Awaited<ReturnType<typeof sendOut>>[] = [];
    try {
      let both: Promise<typeof answers> | undefined;
      await blocker.begin(async (sql) => {
        await sql`SELECT 1 FROM stock_values WHERE variant_id = ${variantOf(tea)} FOR UPDATE`;
        both = Promise.all([sendOut(), writeOff()]);
        await eventually(async () => {
          const [waiting] = await probe<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND datname = 'omnivo'`;
          expect(waiting?.n).toBe(2);
        });
      });
      answers = await (both ?? Promise.resolve([]));
    } finally {
      await Promise.all([blocker.end(), probe.end()]);
    }
    expect(answers.map((res) => res.statusCode)).toEqual([201, 201]);
    const [transferred, lost] = answers;
    const values = [
      stockTransferSchema.parse(transferred?.json()).lines[0]?.value,
      stockAdjustmentSchema.parse(lost?.json()).lines[0]?.value,
    ].sort();
    expect(values).toEqual(['500.0100', '500.0200']);
    expect((await cardOf(variantOf(tea))).item).toMatchObject({
      onHand: '0.0000',
      value: '0.0000',
    });
  });
});
