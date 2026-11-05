import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  auditPageSchema,
  type Branch,
  branchSchema,
  CASH_DENOMINATIONS,
  type CashCountFormValues,
  type CashDenomination,
  cashNotesSchema,
  type Device,
  deviceSchema,
  journalEntrySchema,
  memberPageSchema,
  type PosCashReason,
  posCashReasonListSchema,
  posCashReasonSchema,
  type PosRegister,
  posRegisterSchema,
  posSalePageSchema,
  type PosShift,
  posShiftPageSchema,
  posShiftSchema,
  problemSchema,
  type Product,
  productSchema,
  roleListSchema,
  settingsSchema,
  setupSchema,
  SYNC_PROTOCOL,
  type SyncCommandInput,
  type SyncResult,
  syncPullSchema,
  syncPushSchema,
  type TaxRate,
  taxRateListSchema,
  todayIn,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
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

// Step 20b. Agora Mini Mart again: Nusrat (the owner) runs the front counter, Sumi is a cashier,
// Kamal the shop manager (pos.shift.manage) and Rafiq a member with no role. The tests run in
// order: the reasons and the registers first, then the shifts of the front counter one after the
// other, then the managers' list, the pull, and what happens at the same moment.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: the journal entries of every shift and the bell, which no route lists together
let sql: postgres.Sql;
let owner: SignedIn;
let sumi: SignedIn;
let kamal: SignedIn;
let rafiq: SignedIn;
let today: string;
let main: Warehouse;
let uttara: Branch;
let accounts: Account[];
let vat: TaxRate;
let pcs: string;
let juice: Product;
let counterPc: Device;
let sumiTablet: Device;
let officeLaptop: Device;
let pos1: PosRegister;
let pos2: PosRegister;
let pos3: PosRegister;
// The reasons of Settings → POS
let floatIn: PosCashReason;
let changeIn: PosCashReason;
let bankOut: PosCashReason;
let teaOut: PosCashReason;
let lunchOut: PosCashReason;
// The front counter's shifts, one after the other
let s1: string;
let s2: string;
let s3: string;
let s4: string;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type OpenCommand = Extract<SyncCommandInput, { type: 'pos_shift.open' }>;
type MoveCommand = Extract<SyncCommandInput, { type: 'pos_cash_movement.create' }>;
type CloseCommand = Extract<SyncCommandInput, { type: 'pos_shift.close' }>;
type Payment = SaleCommand['input']['payments'][number];

function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

// The device's clock: one second later at every command, so the list's "newest first" is the
// order the tests ran in, also when two commands are built in the same millisecond
let clock = Date.now();
function moment(): string {
  clock += 1000;
  return new Date(clock).toISOString();
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

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function accountId(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function codeOf(id: string): string {
  return accounts.find((account) => account.id === id)?.code ?? id;
}

async function addAccount(parent: string, code: string, name: string): Promise<Account> {
  const account = await created(accountSchema, '/accounts', {
    parentId: accountId(parent),
    code,
    name,
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  return account;
}

async function member(fullName: string, email: string, password: string): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Store`,
    workspaceSlug: `${email.split('@')[0] ?? 'member'}-store`,
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'agora-mini-mart' });
  return logIn(app, { workspace: 'agora-mini-mart', email, password, keepSignedIn: false });
}

async function giveRoles(email: string, roleNames: string[]): Promise<void> {
  const roles = roleListSchema.parse((await send('GET', '/roles')).json()).items;
  const roleIds = roleNames.map((name) => {
    const role = roles.find((item) => item.name === name);
    if (!role) throw new Error(`no role ${name}`);
    return role.id;
  });
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const res = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds,
    version: found.version,
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function registerDevice(name: string, as = owner): Promise<Device> {
  const res = await send('POST', '/sync/devices', { id: v7(), name, branchId: main.branchId }, as);
  expect(res.statusCode, res.body).toBe(201);
  return deviceSchema.parse(res.json());
}

function registerForm(code: string, extra: object = {}) {
  return {
    code,
    name: `Counter ${code}`,
    warehouseId: main.id,
    accounts: { cash: accountId('1110'), card: '', bkash: '', nagad: '' },
    maxDiscountPercent: '',
    paperWidth: '80',
    receiptFooter: '',
    overShortAccountId: accountId('5350'),
    varianceAlert: '500',
    lockAfter: '5',
    // Step 20c: no exchanges, and the form's 7 days
    exchangeAccountId: '',
    returnDays: '7',
    ...extra,
  };
}

async function registerNow(register: PosRegister): Promise<PosRegister> {
  const res = await send('GET', `/pos/registers/${register.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterSchema.parse(res.json());
}

async function claimed(register: PosRegister, device: Device, as = owner): Promise<PosRegister> {
  const res = await send(
    'POST',
    `/pos/registers/${register.id}/claim`,
    { deviceId: device.id },
    as,
  );
  expect(res.statusCode, res.body).toBe(200);
  return posRegisterSchema.parse(res.json());
}

function release(register: PosRegister, device: Device) {
  return send('POST', `/pos/registers/${register.id}/release`, { deviceId: device.id });
}

function reasonForm(name: string, direction: 'in' | 'out', account: string) {
  return { name, direction, accountId: accountId(account) };
}

// A count by notes, or by its total alone. The notes not named are 0.
function count(total: string, notes?: Partial<Record<CashDenomination, number>>) {
  return {
    total,
    notes:
      notes === undefined
        ? null
        : cashNotesSchema.parse(
            Object.fromEntries(CASH_DENOMINATIONS.map((note) => [note, notes[note] ?? 0])),
          ),
  } satisfies CashCountFormValues;
}

// The register's next shift, as the device opens it: today, with a new UUIDv7
function open(
  register: PosRegister,
  sequence: number,
  opening: CashCountFormValues,
  floatReasonId = '',
): OpenCommand {
  return {
    id: v7(),
    type: 'pos_shift.open',
    shiftId: v7(),
    input: {
      registerId: register.id,
      sequence,
      date: today,
      openedAt: moment(),
      opening,
      floatReasonId,
    },
  };
}

function move(shiftId: string, reason: PosCashReason, amount: string, note = ''): MoveCommand {
  return {
    id: v7(),
    type: 'pos_cash_movement.create',
    movementId: v7(),
    input: { shiftId, reasonId: reason.id, amount, note, date: today, movedAt: moment() },
  };
}

function close(
  shiftId: string,
  counted: CashCountFormValues,
  deviceExpected: string,
  heldDropped = 0,
): CloseCommand {
  return {
    id: v7(),
    type: 'pos_shift.close',
    shiftId,
    input: { date: today, closedAt: moment(), counted, deviceExpected, heldDropped },
  };
}

// The last sale number each register gave, as its device keeps it
const sequences = new Map<string, number>();

// Two mango juices at ৳25 with 15% VAT: ৳57.50
function sale(register: PosRegister, shiftId: string | null, payments: Payment[]): SaleCommand {
  const sequence = (sequences.get(register.id) ?? 0) + 1;
  sequences.set(register.id, sequence);
  const [variant] = juice.variants;
  return {
    id: v7(),
    type: 'pos_sale.create',
    saleId: v7(),
    input: {
      registerId: register.id,
      sequence,
      shiftId,
      date: today,
      soldAt: moment(),
      customerId: '',
      pricesIncludeVat: false,
      lines: [
        {
          variantId: variant?.id ?? '',
          unitId: pcs,
          quantity: '2',
          description: '',
          unitPrice: '25',
          discountType: 'percent',
          discount: '0',
          taxRateId: vat.id,
          rate: vat.rate,
          startingPrice: '25',
          batchId: '',
          serialNumbers: [],
        },
      ],
      billDiscountType: 'amount',
      billDiscount: '0',
      payments,
    },
  };
}

function numberOf(command: SaleCommand): string {
  return `POS1-${String(command.input.sequence).padStart(6, '0')}`;
}

function cash(amount: string): Payment {
  return { method: 'cash', amount, reference: '' };
}

type Command = SaleCommand | OpenCommand | MoveCommand | CloseCommand;

async function push(commands: Command[], device = counterPc, as = owner): Promise<SyncResult[]> {
  const res = await send(
    'POST',
    '/sync/push',
    { deviceId: device.id, protocol: SYNC_PROTOCOL, commands },
    as,
  );
  expect(res.statusCode, res.body).toBe(200);
  return syncPushSchema.parse(res.json()).results;
}

function outcomes(results: SyncResult[]): string[] {
  return results.map((result) =>
    result.status === 'rejected' ? result.error.code : result.status,
  );
}

function refusal(result: SyncResult | undefined) {
  if (result?.status !== 'rejected') throw new Error(`not refused: ${JSON.stringify(result)}`);
  return result.error;
}

async function accepted(commands: Command[], device = counterPc, as = owner): Promise<void> {
  expect(outcomes(await push(commands, device, as))).toEqual(commands.map(() => 'accepted'));
}

async function shiftNow(id: string, as = owner): Promise<PosShift> {
  const res = await send('GET', `/pos/shifts/${id}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return posShiftSchema.parse(res.json());
}

// An entry as [account code, debit, credit], in its own line order (debit first)
async function linesOf(entry: { id: string } | null | undefined) {
  if (!entry) throw new Error('no entry');
  const res = await send('GET', `/journal-entries/${entry.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return journalEntrySchema
    .parse(res.json())
    .lines.map((line) => [codeOf(line.accountId), line.debit, line.credit]);
}

// How many entries every shift posted together: a refused command posts none
async function shiftEntryCount(): Promise<number> {
  const [row] = z
    .array(z.object({ n: z.number() }))
    .parse(await sql`SELECT count(*)::int AS n FROM journal_entries WHERE source = 'pos_shift'`);
  return row?.n ?? 0;
}

async function auditOf(entityType: string, entityId: string) {
  const res = await send('GET', `/audit-logs?entityType=${entityType}&entityId=${entityId}`);
  expect(res.statusCode, res.body).toBe(200);
  // Oldest first, as the tests tell the story
  return auditPageSchema.parse(res.json()).items.reverse();
}

const bellSchema = z.array(
  z.object({ email: z.string(), params: z.record(z.string(), z.unknown()) }),
);

async function varianceBells() {
  return bellSchema.parse(
    await sql`SELECT u.email, n.params FROM notifications n JOIN users u ON u.id = n.user_id
                WHERE n.type = 'pos.shift_variance' ORDER BY n.created_at, u.email`,
  );
}

async function pulled(device: Device, cursor?: string) {
  const query = new URLSearchParams({
    deviceId: device.id,
    protocol: String(SYNC_PROTOCOL),
    limit: '1000',
  });
  if (cursor !== undefined) query.set('cursor', cursor);
  const res = await send('GET', `/sync/pull?${query.toString()}`);
  expect(res.statusCode, res.body).toBe(200);
  const page = syncPullSchema.parse(res.json());
  expect(page.hasMore).toBe(false);
  return page;
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
    companyName: 'Agora Mini Mart',
    workspaceSlug: 'agora-mini-mart',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@agoramart.com',
    password: 'Dhanmondi-shop-2026',
  });
  expect((await send('POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  today = todayIn(settingsSchema.parse((await send('GET', '/settings')).json()).timezone);

  sumi = await member('Sumi Akter', 'sumi@agoramart.com', 'Counter-two-2026');
  kamal = await member('Kamal Hossain', 'kamal@agoramart.com', 'Shop-manager-2026');
  rafiq = await member('Rafiq Islam', 'rafiq@agoramart.com', 'No-role-yet-2026');
  await giveRoles('sumi@agoramart.com', ['Cashier']);
  await giveRoles('kamal@agoramart.com', ['Shop manager']);

  const [found] = warehouseListSchema
    .parse((await send('GET', '/warehouses')).json())
    .items.filter((warehouse) => warehouse.code === 'MAIN');
  if (!found) throw new Error('no MAIN warehouse');
  main = found;
  uttara = await created(branchSchema, '/branches', {
    code: 'UTT',
    name: 'Uttara shop',
    phone: '',
    address: 'Sector 7, Uttara',
  });

  // The shop's bank, where the card machine settles and the cash goes in the evening, and an
  // expense account of its own for the staff's tea
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  await addAccount('1120', '1121', 'Dutch-Bangla Bank CD A/C 1071');
  await addAccount('5200', '5295', 'Staff tea and snacks');

  const rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const fifteen = rates.find((rate) => rate.name === 'VAT 15%');
  if (!fifteen) throw new Error('no VAT 15%');
  vat = fifteen;
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

  counterPc = await registerDevice('Front counter PC');
  sumiTablet = await registerDevice('Sumi tablet', sumi);
  officeLaptop = await registerDevice('Back office laptop');
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('Pay in and pay out reasons', () => {
  it('are made with pos.register.manage, and listed "in" first, then by name', async () => {
    floatIn = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Float from the owner', 'in', '3100'),
    );
    changeIn = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Change from the bank', 'in', '1121'),
    );
    bankOut = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Cash to the bank', 'out', '1121'),
    );
    teaOut = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Tea for the staff', 'out', '5295'),
    );
    lunchOut = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Staff lunch', 'out', '5295'),
    );
    expect(floatIn).toMatchObject({
      name: 'Float from the owner',
      direction: 'in',
      accountId: accountId('3100'),
      archivedAt: null,
      version: 1,
    });
    // Read by anyone (the devices of every cashier keep them), like the registers
    const res = await send('GET', '/pos/cash-reasons', undefined, rafiq);
    expect(res.statusCode, res.body).toBe(200);
    expect(posCashReasonListSchema.parse(res.json()).items.map((item) => item.name)).toEqual([
      'Change from the bank',
      'Float from the owner',
      'Cash to the bank',
      'Staff lunch',
      'Tea for the staff',
    ]);
    const [entry] = await auditOf('pos_cash_reason', floatIn.id);
    expect(entry).toMatchObject({
      action: 'pos_cash_reason.created',
      changes: {
        name: { from: null, to: 'Float from the owner' },
        direction: { from: null, to: 'in' },
        account: { from: null, to: '3100' },
      },
    });
    const cashier = await send(
      'POST',
      '/pos/cash-reasons',
      reasonForm('Snacks', 'out', '5295'),
      sumi,
    );
    expect(cashier.statusCode).toBe(403);
    expect(problemOf(cashier).code).toBe('permission_missing');
  });

  it('refuse a name that is taken, and an account that cannot take the money', async () => {
    const taken = await send(
      'POST',
      '/pos/cash-reasons',
      reasonForm('TEA FOR THE STAFF', 'in', '3100'),
    );
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken)).toMatchObject({
      code: 'pos_reason_name_taken',
      fieldErrors: { name: ['pos_reason_name_taken'] },
    });
    // A group, the customers' and the suppliers' accounts (kept per party), the stock, and an id
    // that is no account: one answer for all of them
    for (const accountIdOf of [
      accountId('1120'),
      accountId('1140'),
      accountId('2110'),
      accountId('1150'),
      v7(),
    ]) {
      const res = await send('POST', '/pos/cash-reasons', {
        name: 'Somewhere',
        direction: 'out',
        accountId: accountIdOf,
      });
      expect(problemOf(res), codeOf(accountIdOf)).toMatchObject({
        code: 'pos_reason_account_invalid',
        fieldErrors: { accountId: ['pos_reason_account_invalid'] },
      });
    }
    const form = await send('POST', '/pos/cash-reasons', {
      name: 'T',
      direction: 'out',
      accountId: '',
    });
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      name: ['pos_reason_name_required'],
      accountId: ['pos_reason_account_invalid'],
    });
    const list = posCashReasonListSchema.parse((await send('GET', '/pos/cash-reasons')).json());
    expect(list.items).toHaveLength(5);
  });

  it('change the name and the account, never the direction', async () => {
    const res = await send('PUT', `/pos/cash-reasons/${teaOut.id}`, {
      name: 'Tea and snacks for the staff',
      accountId: accountId('5290'),
      // Not part of the edit form: dropped
      direction: 'in',
      version: teaOut.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = posCashReasonSchema.parse(res.json());
    expect(after).toMatchObject({
      name: 'Tea and snacks for the staff',
      direction: 'out',
      accountId: accountId('5290'),
      version: teaOut.version + 1,
    });
    const [, updated] = await auditOf('pos_cash_reason', teaOut.id);
    expect(updated).toMatchObject({
      action: 'pos_cash_reason.updated',
      changes: {
        name: { from: 'Tea for the staff', to: 'Tea and snacks for the staff' },
        account: { from: '5295', to: '5290' },
      },
    });
    expect(updated?.changes).not.toHaveProperty('direction');
    const stale = await send('PUT', `/pos/cash-reasons/${teaOut.id}`, {
      name: 'Tea',
      accountId: accountId('5295'),
      version: teaOut.version,
    });
    expect(problemOf(stale).code).toBe('version_conflict');
    const clash = await send('PUT', `/pos/cash-reasons/${teaOut.id}`, {
      name: 'staff lunch',
      accountId: accountId('5295'),
      version: after.version,
    });
    expect(problemOf(clash).code).toBe('pos_reason_name_taken');
    // Back to the staff's own account, for the shifts below
    const back = await send('PUT', `/pos/cash-reasons/${teaOut.id}`, {
      name: 'Tea for the staff',
      accountId: accountId('5295'),
      version: after.version,
    });
    expect(back.statusCode, back.body).toBe(200);
    teaOut = posCashReasonSchema.parse(back.json());
  });

  it('are archived and restored; an archived name is still taken', async () => {
    const res = await send('POST', `/pos/cash-reasons/${lunchOut.id}/archive`, {
      version: lunchOut.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const archived = posCashReasonSchema.parse(res.json());
    expect(archived.archivedAt).not.toBeNull();
    const active = posCashReasonListSchema.parse((await send('GET', '/pos/cash-reasons')).json());
    expect(active.items.map((item) => item.name)).not.toContain('Staff lunch');
    const old = posCashReasonListSchema.parse(
      (await send('GET', '/pos/cash-reasons?status=archived')).json(),
    );
    expect(old.items.map((item) => item.name)).toEqual(['Staff lunch']);
    const again = await send('POST', '/pos/cash-reasons', reasonForm('Staff Lunch', 'out', '5295'));
    expect(problemOf(again).code).toBe('pos_reason_name_taken');

    // Its account archived meanwhile: it comes back only with an account that takes money
    const staffTea = accounts.find((account) => account.code === '5295');
    if (!staffTea) throw new Error('no 5295');
    const shut = await send('POST', `/accounts/${staffTea.id}/archive`, {
      version: staffTea.version,
    });
    expect(shut.statusCode, shut.body).toBe(200);
    const refused = await send('POST', `/pos/cash-reasons/${lunchOut.id}/restore`, {
      version: archived.version,
    });
    expect(problemOf(refused).code).toBe('pos_reason_account_invalid');
    const reopened = await send('POST', `/accounts/${staffTea.id}/restore`, {
      version: accountSchema.parse(shut.json()).version,
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
    const restored = await send('POST', `/pos/cash-reasons/${lunchOut.id}/restore`, {
      version: archived.version,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    lunchOut = posCashReasonSchema.parse(restored.json());
    expect(lunchOut.archivedAt).toBeNull();
    expect((await auditOf('pos_cash_reason', lunchOut.id)).map((row) => row.action)).toEqual([
      'pos_cash_reason.created',
      'pos_cash_reason.archived',
      'pos_cash_reason.restored',
    ]);
  });
});

describe("A register's shift settings", () => {
  it('need an over/short account, a limit in whole taka and a lock time', async () => {
    const form = await send(
      'POST',
      '/pos/registers',
      registerForm('POS1', { overShortAccountId: '', varianceAlert: '12.50' }),
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      overShortAccountId: ['pos_over_short_required'],
      varianceAlert: ['pos_variance_alert_format'],
    });
    // The cash drawer itself, and a group: over/short is an income or an expense account
    for (const code of ['1110', '5300']) {
      const res = await send(
        'POST',
        '/pos/registers',
        registerForm('POS1', { overShortAccountId: accountId(code) }),
      );
      expect(problemOf(res), code).toMatchObject({
        code: 'pos_over_short_invalid',
        fieldErrors: { overShortAccountId: ['pos_over_short_invalid'] },
      });
    }

    // The front counter, with a card machine: a bell for any difference over ৳10
    pos1 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS1', {
        name: 'Front counter',
        accounts: { cash: accountId('1110'), card: accountId('1121'), bkash: '', nagad: '' },
        varianceAlert: '10',
        lockAfter: '2',
      }),
    );
    expect(pos1).toMatchObject({
      overShortAccountId: accountId('5350'),
      varianceAlert: '10',
      lockAfter: '2',
      lastShift: null,
    });
    // An empty limit is 0: a bell for any difference at all. Over/short as income is fine too.
    pos2 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS2', {
        name: 'Pharmacy counter',
        overShortAccountId: accountId('4220'),
        varianceAlert: '',
        lockAfter: 'off',
      }),
    );
    expect(pos2).toMatchObject({ varianceAlert: '0', lockAfter: 'off' });
    pos3 = await created(
      posRegisterSchema,
      '/pos/registers',
      registerForm('POS3', { name: 'Back counter' }),
    );
    const [entry] = await auditOf('pos_register', pos1.id);
    expect(entry?.changes).toMatchObject({
      overShortAccount: { from: null, to: '5350' },
      varianceAlert: { from: null, to: '10' },
      lockAfter: { from: null, to: '2' },
    });
  });
});

describe('A shift at the front counter', () => {
  it("opens with the float from the owner: the register's first shift", async () => {
    pos1 = await claimed(pos1, counterPc);
    expect(pos1.lastShift).toBeNull();
    sequences.set(pos1.id, pos1.lastNumber);

    // The float must come by an "in" reason the server knows. Nothing is written for a refusal.
    const wrongWay = open(pos1, 1, count('5000', { '1000': 5 }), bankOut.id);
    const unknown = open(pos1, 1, count('5000', { '1000': 5 }), v7());
    const refused = await push([wrongWay, unknown]);
    expect(refused.map(refusal)).toEqual([
      {
        code: 'pos_float_reason_required',
        fieldErrors: { floatReasonId: ['pos_float_reason_required'] },
      },
      {
        code: 'pos_float_reason_required',
        fieldErrors: { floatReasonId: ['pos_float_reason_required'] },
      },
    ]);
    expect(await shiftEntryCount()).toBe(0);

    const first = open(pos1, 1, count('5000', { '1000': 4, '500': 2 }), floatIn.id);
    s1 = first.shiftId;
    await accepted([first]);
    const shift = await shiftNow(s1);
    expect(shift).toMatchObject({
      number: 'POS1-S0001',
      register: { id: pos1.id, code: 'POS1', name: 'Front counter' },
      branchId: main.branchId,
      sequence: 1,
      status: 'open',
      cashier: { fullName: 'Nusrat Jahan' },
      device: { id: counterPc.id, name: 'Front counter PC' },
      openingCash: '5000.00',
      expectedCash: '5000.0000',
      countedCash: null,
      difference: null,
      saleCount: 0,
      opening: {
        count: { total: '5000.00', notes: { '1000': 4, '500': 2, '100': 0 } },
        date: today,
        comparedWith: null,
        difference: null,
        floatReason: { id: floatIn.id, name: 'Float from the owner' },
      },
      closing: null,
      closedBy: null,
      movements: [],
    });
    // The float came from the owner: Dr cash, Cr capital
    expect(await linesOf(shift.opening.entry)).toEqual([
      ['1110', '5000.0000', '0.0000'],
      ['3100', '0.0000', '5000.0000'],
    ]);
    expect((await registerNow(pos1)).lastShift).toEqual({
      id: s1,
      sequence: 1,
      status: 'open',
      cashLeft: null,
    });
    const [opened] = await auditOf('pos_shift', s1);
    expect(opened).toMatchObject({
      action: 'pos_shift.opened',
      changes: {
        number: { to: 'POS1-S0001' },
        floatReason: { to: 'Float from the owner' },
        entry: { to: shift.opening.entry?.number },
      },
    });
  });

  it('is the only open shift of its register, opened by the device that holds it', async () => {
    const before = await shiftEntryCount();
    const results = await push([open(pos1, 2, count('5000'))]);
    expect(outcomes(results)).toEqual(['pos_shift_already_open']);
    const elsewhere = await push([open(pos1, 2, count('100'))], officeLaptop);
    expect(refusal(elsewhere[0])).toEqual({
      code: 'pos_register_not_held',
      fieldErrors: { registerId: ['pos_register_not_held'] },
    });
    expect(await shiftEntryCount()).toBe(before);
  });

  it('takes pay ins and pay outs by their reasons', async () => {
    // Staff lunch is archived after the cashier picked it: the money still moved
    const pickedLunch = move(s1, lunchOut, '80', 'Lunch for two, Star Kabab');
    const res = await send('POST', `/pos/cash-reasons/${lunchOut.id}/archive`, {
      version: lunchOut.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const coins = move(s1, changeIn, '500', 'Coins of ৳1, ৳2 and ৳5');
    const deposit = move(s1, bankOut, '3000', 'Deposit slip 0042, DBBL Dhanmondi');
    const tea = move(s1, teaOut, '120');
    const results = await push([
      coins,
      deposit,
      tea,
      pickedLunch,
      move(s1, { ...teaOut, id: v7() }, '50'),
      move(v7(), teaOut, '50'),
      move(s1, teaOut, '0'),
    ]);
    expect(outcomes(results)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
      'pos_reason_required',
      'pos_shift_unknown',
      'invalid_input',
    ]);
    expect(refusal(results[4]).fieldErrors).toEqual({ reasonId: ['pos_reason_required'] });
    expect(refusal(results[5]).fieldErrors).toEqual({ shiftId: ['pos_shift_unknown'] });

    const shift = await shiftNow(s1);
    expect(
      shift.movements.map((item) => [
        item.reason.name,
        item.direction,
        item.amount,
        codeOf(item.accountId),
      ]),
    ).toEqual([
      // By the device's clock: the lunch was paid before the reason was archived
      ['Staff lunch', 'out', '80.0000', '5295'],
      ['Change from the bank', 'in', '500.0000', '1121'],
      ['Cash to the bank', 'out', '3000.0000', '1121'],
      ['Tea for the staff', 'out', '120.0000', '5295'],
    ]);
    expect(shift.movements[2]?.note).toBe('Deposit slip 0042, DBBL Dhanmondi');
    expect(shift.cash).toEqual({
      opening: '5000.0000',
      cashTaken: '0.0000',
      changeGiven: '0.0000',
      paidIn: '500.0000',
      paidOut: '3200.0000',
      // Step 20c: what returns paid back in cash
      cashRefunded: '0.0000',
    });
    expect(shift.expectedCash).toBe('2300.0000');
    // A pay in brings cash in from the reason's account; a pay out the other way
    expect(await linesOf(shift.movements[1]?.entry)).toEqual([
      ['1110', '500.0000', '0.0000'],
      ['1121', '0.0000', '500.0000'],
    ]);
    expect(await linesOf(shift.movements[2]?.entry)).toEqual([
      ['1121', '3000.0000', '0.0000'],
      ['1110', '0.0000', '3000.0000'],
    ]);
    const moved = (await auditOf('pos_shift', s1)).filter(
      (row) => row.action === 'pos_shift.cash_moved',
    );
    expect(moved).toHaveLength(4);
    const fromTheBank = moved.find((row) =>
      JSON.stringify(row.changes).includes('Change from the bank'),
    );
    expect(fromTheBank?.changes).toMatchObject({
      reason: { to: 'Change from the bank' },
      direction: { to: 'in' },
      shiftStatus: { to: 'open' },
    });
  });

  it('counts the sales of the shift, by how they were paid', async () => {
    // ৳57.50 each: one paid with a ৳100 note (৳42.50 back), one by card
    const first = sale(pos1, s1, [cash('100')]);
    const second = sale(pos1, s1, [{ method: 'card', amount: '57.50', reference: '4471' }]);
    // A sale from an outbox of before 20b has no shift; a shift the server does not know, or one
    // of another register, is a bug on the device
    const old = sale(pos1, null, [cash('57.50')]);
    const unknown = sale(pos1, v7(), [cash('57.50')]);
    const results = await push([first, second, old, unknown]);
    expect(outcomes(results)).toEqual(['accepted', 'accepted', 'accepted', 'pos_shift_unknown']);
    expect(refusal(results[3]).fieldErrors).toEqual({ shiftId: ['pos_shift_unknown'] });

    const shift = await shiftNow(s1);
    expect(shift).toMatchObject({
      saleCount: 2,
      salesTotal: '115.0000',
      cash: {
        opening: '5000.0000',
        cashTaken: '100.0000',
        changeGiven: '42.5000',
        paidIn: '500.0000',
        paidOut: '3200.0000',
      },
      // Cash and card: the methods POS1 takes, and nothing came by bKash or Nagad
      payments: [
        { method: 'cash', amount: '100.0000' },
        { method: 'card', amount: '57.5000' },
      ],
      expectedCash: '2357.5000',
    });
    const sales = posSalePageSchema.parse(
      (await send('GET', `/pos/sales?registerId=${pos1.id}`)).json(),
    );
    // One push writes its sales at the same moment: found by their numbers, not by their order
    const shiftOf = new Map(sales.items.map((item) => [item.number, item.shift?.number ?? null]));
    expect([first, second, old].map((command) => shiftOf.get(numberOf(command)))).toEqual([
      'POS1-S0001',
      'POS1-S0001',
      null,
    ]);
  });

  it('keeps its register held, and its device in Dhanmondi, while it is open', async () => {
    const res = await release(pos1, counterPc);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('pos_shift_still_open');
    const moved = await send('PUT', `/devices/${counterPc.id}/branch`, {
      branchId: uttara.id,
      version: counterPc.version,
    });
    expect(moved.statusCode).toBe(409);
    expect(problemOf(moved).code).toBe('pos_shift_still_open');
    expect((await registerNow(pos1)).deviceId).toBe(counterPc.id);
  });

  it('closes with a count: the difference posts to over/short, and a big one rings the bell', async () => {
    // ৳2,325 in the drawer where ৳2,357.50 should be: ৳32.50 short, over POS1's limit of ৳10
    await accepted([
      close(s1, count('2325', { '1000': 2, '100': 3, '10': 2, '5': 1 }), '2357.50', 2),
    ]);
    const shift = await shiftNow(s1);
    expect(shift).toMatchObject({
      status: 'closed',
      openingCash: '5000.00',
      expectedCash: '2357.5000',
      countedCash: '2325.00',
      difference: '-32.5000',
      closing: {
        count: { total: '2325.00', notes: { '1000': 2, '100': 3, '10': 2, '5': 1 } },
        date: today,
        deviceExpected: '2357.5000',
        heldDropped: 2,
      },
      closedBy: null,
    });
    expect(shift.closedAt).not.toBeNull();
    // Short: the money that is missing is an expense
    expect(await linesOf(shift.closing?.entry)).toEqual([
      ['5350', '32.5000', '0.0000'],
      ['1110', '0.0000', '32.5000'],
    ]);
    const actions = (await auditOf('pos_shift', s1)).map((row) => row.action);
    // The device expected the same: no expected_differs row
    expect(actions).toEqual([
      'pos_shift.opened',
      'pos_shift.cash_moved',
      'pos_shift.cash_moved',
      'pos_shift.cash_moved',
      'pos_shift.cash_moved',
      'pos_shift.closed',
    ]);
    // The owner and the shop manager hear about it, not the cashier or Rafiq
    await eventually(async () => {
      const bells = await varianceBells();
      expect(bells.map((bell) => bell.email)).toEqual([
        'kamal@agoramart.com',
        'nusrat@agoramart.com',
      ]);
      expect(bells[0]?.params).toEqual({
        id: s1,
        number: 'POS1-S0001',
        register: 'Front counter',
        difference: '-32.5000',
      });
    });
    expect((await registerNow(pos1)).lastShift).toEqual({
      id: s1,
      sequence: 1,
      status: 'closed',
      cashLeft: '2325.0000',
    });
  });

  it('lets go of its register once closed, and the claim answers the last shift', async () => {
    const res = await release(pos1, counterPc);
    expect(res.statusCode, res.body).toBe(200);
    const held = await claimed(pos1, counterPc);
    expect(held.lastShift).toMatchObject({ id: s1, status: 'closed', cashLeft: '2325.0000' });
  });

  it('opens the next shift against what the last one left', async () => {
    // ৳5 more than the count of the last close: over, from over/short. A float reason sent with a
    // later shift is not used.
    const next = open(pos1, 2, count('2330'), floatIn.id);
    s2 = next.shiftId;
    await accepted([next]);
    const shift = await shiftNow(s2);
    expect(shift).toMatchObject({
      number: 'POS1-S0002',
      openingCash: '2330.00',
      opening: {
        count: { notes: null, total: '2330.00' },
        comparedWith: '2325.0000',
        difference: '5.0000',
        floatReason: null,
      },
    });
    expect(await linesOf(shift.opening.entry)).toEqual([
      ['1110', '5.0000', '0.0000'],
      ['5350', '0.0000', '5.0000'],
    ]);
  });

  it('writes down when the device expected another amount, and posts nothing for a count that matches', async () => {
    await accepted([sale(pos1, s2, [cash('57.50')])]);
    // The device missed a sale it had: it thought ৳2,400
    await accepted([close(s2, count('2387.50'), '2400')]);
    const shift = await shiftNow(s2);
    expect(shift).toMatchObject({
      status: 'closed',
      expectedCash: '2387.5000',
      countedCash: '2387.50',
      difference: '0.0000',
      closing: { deviceExpected: '2400.0000', entry: null },
    });
    const differs = (await auditOf('pos_shift', s2)).find(
      (row) => row.action === 'pos_shift.expected_differs',
    );
    expect(differs?.changes).toEqual({
      // As the device sent it
      device: { from: null, to: '2400' },
      server: { from: null, to: '2387.5000' },
    });
    // No new bell: the one of the first shift is all
    expect(await varianceBells()).toHaveLength(2);
    // A shift number given twice (a bug on the device) is refused, and posts nothing
    const before = await shiftEntryCount();
    const twice = await push([open(pos1, 2, count('2000'))]);
    expect(refusal(twice[0])).toEqual({
      code: 'pos_number_taken',
      fieldErrors: { sequence: ['pos_number_taken'] },
    });
    expect(await shiftEntryCount()).toBe(before);
  });

  it('keeps a pay out that arrives after its close', async () => {
    const before = await shiftNow(s2);
    await accepted([move(s2, teaOut, '40')]);
    const after = await shiftNow(s2);
    expect(after.movements.map((item) => item.amount)).toEqual(['40.0000']);
    // The close stays as it was: what was counted, against what was expected then
    expect(after).toMatchObject({
      status: 'closed',
      expectedCash: before.expectedCash,
      countedCash: before.countedCash,
      closing: before.closing,
    });
    const late = (await auditOf('pos_shift', s2)).find(
      (row) => row.action === 'pos_shift.cash_moved',
    );
    expect(late?.changes).toMatchObject({ shiftStatus: { to: 'closed' } });
  });
});

describe('A shift nobody can count', () => {
  it('is closed by a manager online, without a count', async () => {
    // The next shift starts with the ৳2,387.50 of the last count: no difference, no entry
    const next = open(pos1, 3, count('2387.50'));
    s3 = next.shiftId;
    await accepted([next, sale(pos1, s3, [cash('57.50')])]);
    expect((await shiftNow(s3)).opening).toMatchObject({ difference: '0.0000', entry: null });

    const cashier = await send('POST', `/pos/shifts/${s3}/close-without-count`, { note: '' }, sumi);
    expect(cashier.statusCode).toBe(403);
    const res = await send(
      'POST',
      `/pos/shifts/${s3}/close-without-count`,
      { note: 'Counter PC would not start' },
      kamal,
    );
    expect(res.statusCode, res.body).toBe(200);
    const shift = posShiftSchema.parse(res.json());
    expect(shift).toMatchObject({
      status: 'closed_without_count',
      expectedCash: '2445.0000',
      countedCash: null,
      difference: null,
      closing: null,
      closedBy: { fullName: 'Kamal Hossain' },
    });
    const done = (await auditOf('pos_shift', s3)).find(
      (row) => row.action === 'pos_shift.closed_without_count',
    );
    expect(done?.changes).toMatchObject({
      expected: { to: '2445.0000' },
      note: { to: 'Counter PC would not start' },
      by: { to: 'manager' },
    });
    const again = await send('POST', `/pos/shifts/${s3}/close-without-count`, { note: '' }, kamal);
    expect(again.statusCode).toBe(409);
    expect(problemOf(again).code).toBe('pos_shift_closed');
    const missing = await send('POST', `/pos/shifts/${v7()}/close-without-count`, { note: '' });
    expect(missing.statusCode).toBe(404);
    expect((await registerNow(pos1)).lastShift).toEqual({
      id: s3,
      sequence: 3,
      status: 'closed_without_count',
      cashLeft: '2445.0000',
    });
  });

  it("keeps what the device sends after the manager's close, and the next opening finds the cash", async () => {
    // The counter PC was offline: it sold once more on the shift, then counted ৳2,502.50 (all
    // there) and closed. All of it arrives after the manager's close.
    const late = sale(pos1, s3, [cash('57.50')]);
    const counted = close(s3, count('2502.50'), '2502.50');
    await accepted([late, counted]);
    const shift = await shiftNow(s3);
    expect(shift).toMatchObject({
      status: 'closed_without_count',
      closedBy: { fullName: 'Kamal Hossain' },
      closing: null,
      saleCount: 2,
    });
    // The count is in the audit log only (decision 38)
    const kept = (await auditOf('pos_shift', s3)).find((row) => row.action === 'pos_shift.closed');
    expect(kept?.changes).toMatchObject({
      counted: { to: '2502.50' },
      kept: { to: false },
      statusBefore: { to: 'closed_without_count' },
    });
    // The late sale's cash is in the drawer and already in the books (the sale's entry). The next
    // shift opens with the same ৳2,502.50, so nothing is over and nothing posts.
    const next = open(pos1, 4, count('2502.50'));
    s4 = next.shiftId;
    await accepted([next]);
    expect((await shiftNow(s4)).opening).toMatchObject({
      comparedWith: '2502.5000',
      difference: '0.0000',
      entry: null,
    });
  });

  it('is closed by itself when its device is revoked', async () => {
    pos3 = await claimed(pos3, officeLaptop);
    const first = open(pos3, 1, count('1000', { '500': 2 }), floatIn.id);
    await accepted([first, sale(pos3, first.shiftId, [cash('100')])], officeLaptop);
    const res = await send('POST', `/devices/${officeLaptop.id}/revoke`);
    expect(res.statusCode, res.body).toBe(200);
    const shift = await shiftNow(first.shiftId);
    expect(shift).toMatchObject({
      number: 'POS3-S0001',
      status: 'closed_without_count',
      expectedCash: '1057.5000',
      closedBy: { fullName: 'Nusrat Jahan' },
      closing: null,
    });
    const done = (await auditOf('pos_shift', first.shiftId)).find(
      (row) => row.action === 'pos_shift.closed_without_count',
    );
    expect(done?.changes).toMatchObject({
      by: { to: 'revoke' },
      device: { to: 'Back office laptop' },
    });
    const register = await registerNow(pos3);
    expect(register).toMatchObject({
      deviceId: null,
      lastShift: { id: first.shiftId, status: 'closed_without_count', cashLeft: '1057.5000' },
    });
    // The lost laptop can send nothing more
    const after = await send('POST', '/sync/push', {
      deviceId: officeLaptop.id,
      protocol: SYNC_PROTOCOL,
      commands: [close(first.shiftId, count('1057.50'), '1057.50')],
    });
    expect(after.statusCode).toBe(403);
    expect(problemOf(after).code).toBe('device_revoked');
  });
});

describe("A cashier's shift", () => {
  it('goes through without the permission that was taken away while the device was offline', async () => {
    pos2 = await claimed(pos2, sumiTablet, sumi);
    // A first shift with ৳300 and no reason: only a device with a bug sends it (the app asks
    // where the float came from). The money is in the drawer, so over/short takes it: POS2's
    // over/short is an income account.
    const first = open(pos2, 1, count('300'));
    await accepted([first], sumiTablet, sumi);
    expect(await linesOf((await shiftNow(first.shiftId)).opening.entry)).toEqual([
      ['1110', '300.0000', '0.0000'],
      ['4220', '0.0000', '300.0000'],
    ]);

    await giveRoles('sumi@agoramart.com', []);
    // ৳1 short: POS2's limit is 0, so any difference rings the bell
    await accepted(
      [move(first.shiftId, changeIn, '200'), close(first.shiftId, count('499'), '500')],
      sumiTablet,
      sumi,
    );
    await giveRoles('sumi@agoramart.com', ['Cashier']);
    const actions = (await auditOf('pos_shift', first.shiftId)).map((row) => row.action);
    expect(actions).toEqual([
      'pos_shift.opened',
      'pos_shift.cash_moved',
      'pos_shift.without_permission',
      'pos_shift.closed',
      'pos_shift.without_permission',
    ]);
    expect(await shiftNow(first.shiftId)).toMatchObject({
      status: 'closed',
      cashier: { fullName: 'Sumi Akter' },
      difference: '-1.0000',
    });
    await eventually(async () => {
      const bells = await varianceBells();
      expect(bells.filter((bell) => bell.params.number === 'POS2-S0001')).toHaveLength(2);
    });
  });
});

describe("The managers' list of shifts", () => {
  it('is newest first, by register and by status, one page at a time', async () => {
    const res = await send('GET', `/pos/shifts?registerId=${pos1.id}`, undefined, kamal);
    expect(res.statusCode, res.body).toBe(200);
    const byRegister = posShiftPageSchema.parse(res.json());
    expect(byRegister.items.map((item) => [item.number, item.status])).toEqual([
      ['POS1-S0004', 'open'],
      ['POS1-S0003', 'closed_without_count'],
      ['POS1-S0002', 'closed'],
      ['POS1-S0001', 'closed'],
    ]);
    // What an open shift should hold now, worked out as the list is read
    expect(byRegister.items[0]).toMatchObject({ expectedCash: '2502.5000', countedCash: null });
    expect(byRegister.items[3]).toMatchObject({
      countedCash: '2325.00',
      difference: '-32.5000',
      saleCount: 2,
      salesTotal: '115.0000',
    });
    const uncounted = posShiftPageSchema.parse(
      (await send('GET', '/pos/shifts?status=closed_without_count')).json(),
    );
    expect(uncounted.items.map((item) => item.number)).toEqual(['POS3-S0001', 'POS1-S0003']);

    const numbers: string[] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor === null ? '' : `&cursor=${cursor}`;
      const page = posShiftPageSchema.parse(
        (await send('GET', `/pos/shifts?limit=2${after}`)).json(),
      );
      numbers.push(...page.items.map((item) => item.number));
      cursor = page.nextCursor;
    } while (cursor !== null);
    const all = posShiftPageSchema.parse((await send('GET', '/pos/shifts?limit=100')).json());
    expect(numbers).toEqual(all.items.map((item) => item.number));
    expect(numbers).toHaveLength(6);
  });

  it('is read with pos.shift.manage only', async () => {
    for (const who of [sumi, rafiq]) {
      const list = await send('GET', '/pos/shifts', undefined, who);
      expect(list.statusCode).toBe(403);
      expect((await send('GET', `/pos/shifts/${s1}`, undefined, who)).statusCode).toBe(403);
    }
    expect((await send('GET', `/pos/shifts/${v7()}`)).statusCode).toBe(404);
  });
});

describe('The pull', () => {
  it('brings every active reason and the latest shift of each register', async () => {
    const full = await pulled(counterPc);
    const reasons = full.changes.filter((change) => change.entity === 'pos_cash_reason');
    // Staff lunch is archived
    expect(reasons.map((change) => change.key).sort()).toEqual(
      [floatIn.id, changeIn.id, bankOut.id, teaOut.id].sort(),
    );
    const front = full.changes.find(
      (change) => change.entity === 'pos_register' && change.key === pos1.id,
    );
    expect(front).toMatchObject({
      op: 'upsert',
      data: { lastShift: { id: s4, sequence: 4, status: 'open', cashLeft: null } },
    });

    // A reason renamed, one archived, and a shift closed: each in the next pull
    const renamed = await send('PUT', `/pos/cash-reasons/${teaOut.id}`, {
      name: 'Tea for the staff and guests',
      accountId: teaOut.accountId,
      version: teaOut.version,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const archived = await send('POST', `/pos/cash-reasons/${changeIn.id}/archive`, {
      version: changeIn.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    await accepted([close(s4, count('2502.50'), '2502.50')]);
    const delta = await pulled(counterPc, full.cursor);
    expect(
      delta.changes
        .filter((change) => change.entity === 'pos_cash_reason')
        .map((change) => [change.op, change.key]),
    ).toEqual([
      ['upsert', teaOut.id],
      ['delete', changeIn.id],
    ]);
    expect(delta.changes.filter((change) => change.entity === 'pos_register')).toMatchObject([
      { key: pos1.id, data: { lastShift: { id: s4, status: 'closed' } } },
    ]);
  });
});

describe('What a shift posts', () => {
  it('is not reversed in the journal, and its accounts are not deleted', async () => {
    const shift = await shiftNow(s1);
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${shift.closing?.entry?.id ?? ''}`)).json(),
    );
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: today,
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('journal_is_pos');

    // 5295 has entries and reasons; an account only a reason or a register points at is in use too
    const tips = await addAccount('4200', '4230', 'Tips left at the counter');
    const reason = await created(
      posCashReasonSchema,
      '/pos/cash-reasons',
      reasonForm('Tips', 'in', '4230'),
    );
    expect(reason.accountId).toBe(tips.id);
    const gone = await send('DELETE', `/accounts/${tips.id}?version=${String(tips.version)}`);
    expect(gone.statusCode).toBe(409);
    expect(problemOf(gone).code).toBe('account_in_use');
    const spare = await addAccount('5300', '5390', 'Counter differences');
    const now = await registerNow(pos3);
    const edited = await send('PUT', `/pos/registers/${pos3.id}`, {
      name: now.name,
      warehouseId: now.warehouseId,
      accounts: { cash: now.accounts.cash, card: '', bkash: '', nagad: '' },
      maxDiscountPercent: now.maxDiscountPercent,
      paperWidth: now.paperWidth,
      receiptFooter: '',
      overShortAccountId: spare.id,
      varianceAlert: now.varianceAlert,
      lockAfter: now.lockAfter,
      exchangeAccountId: now.exchangeAccountId ?? '',
      returnDays: String(now.returnDays),
      version: now.version,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const spareGone = await send(
      'DELETE',
      `/accounts/${spare.id}?version=${String(spare.version)}`,
    );
    expect(problemOf(spareGone).code).toBe('account_in_use');
  });
});

describe('At the same moment', () => {
  it('two opens of one register: one shift', async () => {
    const [a, b] = await Promise.all([
      push([open(pos1, 5, count('2502.50'))]),
      push([open(pos1, 6, count('2502.50'))]),
    ]);
    const answers = [...outcomes(a), ...outcomes(b)].sort();
    expect(answers).toEqual(['accepted', 'pos_shift_already_open']);
    const open5 = posShiftPageSchema.parse(
      (await send('GET', `/pos/shifts?registerId=${pos1.id}&status=open`)).json(),
    );
    expect(open5.items).toHaveLength(1);
  });

  it("a manager's close and a sale: the sale is kept, and counted in the close or after it", async () => {
    const [shift] = posShiftPageSchema.parse(
      (await send('GET', `/pos/shifts?registerId=${pos1.id}&status=open`)).json(),
    ).items;
    if (!shift) throw new Error('no open shift');
    const [closed, sold] = await Promise.all([
      send('POST', `/pos/shifts/${shift.id}/close-without-count`, { note: '' }, kamal),
      push([sale(pos1, shift.id, [cash('57.50')])]),
    ]);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(outcomes(sold)).toEqual(['accepted']);
    // FOR UPDATE against FOR SHARE: the stored expected cash has the sale in it, or the sale came
    // after the close (a late sale) and the next opening compares with the live amount
    const after = await shiftNow(shift.id);
    expect(['2502.5000', '2560.0000']).toContain(posShiftSchema.parse(closed.json()).expectedCash);
    expect(after).toMatchObject({ status: 'closed_without_count', saleCount: 1 });
    expect((await registerNow(pos1)).lastShift?.cashLeft).toBe('2560.0000');
  });

  it("a device's close and a manager's close: one of them closes it", async () => {
    const next = open(pos1, 7, count('2560'));
    await accepted([next]);
    const [counted, manager] = await Promise.all([
      push([close(next.shiftId, count('2560'), '2560')]),
      send('POST', `/pos/shifts/${next.shiftId}/close-without-count`, { note: '' }, kamal),
    ]);
    expect(outcomes(counted)).toEqual(['accepted']);
    const shift = await shiftNow(next.shiftId);
    if (manager.statusCode === 200) {
      // The manager was first: the count is in the audit log only
      expect(shift.status).toBe('closed_without_count');
    } else {
      expect(problemOf(manager).code).toBe('pos_shift_closed');
      expect(shift.status).toBe('closed');
    }
  });

  it('an open and a revoke: no shift is left open on a free register', async () => {
    const tablet = await registerDevice('Spare tablet');
    const held = await claimed(pos3, tablet);
    const opening = open(held, 2, count('1057.50'));
    const [pushed, revoked] = await Promise.all([
      send('POST', '/sync/push', {
        deviceId: tablet.id,
        protocol: SYNC_PROTOCOL,
        commands: [opening],
      }),
      send('POST', `/devices/${tablet.id}/revoke`),
    ]);
    expect(revoked.statusCode, revoked.body).toBe(200);
    if (pushed.statusCode === 200) {
      const [result] = syncPushSchema.parse(pushed.json()).results;
      if (result?.status === 'accepted') {
        // The open was first; the revoke closed it
        expect((await shiftNow(opening.shiftId)).status).toBe('closed_without_count');
      } else {
        expect(refusal(result).code).toBe('pos_register_not_held');
      }
    } else {
      expect(problemOf(pushed).code).toBe('device_revoked');
    }
    const register = await registerNow(pos3);
    expect(register.deviceId).toBeNull();
    expect(register.lastShift?.status).not.toBe('open');
  });
});
