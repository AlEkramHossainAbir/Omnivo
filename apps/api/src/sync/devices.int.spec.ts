import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type Branch,
  deviceKeySchema,
  branchSchema,
  type Device,
  type DeviceListItem,
  deviceListItemSchema,
  devicePageSchema,
  deviceSchema,
  memberPageSchema,
  myDeviceListSchema,
  problemSchema,
  roleListSchema,
  setupSchema,
  syncPullSchema,
  syncPushSchema,
  type Warehouse,
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

// A distributor with a head office and a depot in Chattogram. Four people use devices: the owner,
// Rafiq (a salesperson with no role), Nasrin (the depot manager, whose role template has
// core.device.manage) and Tanvir (a sales officer who is removed from the workspace).
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser, for what no route shows: a device's session, the time of its last sync
let sql: postgres.Sql;
let owner: SignedIn;
let rafiq: SignedIn;
let nasrin: SignedIn;
let tanvir: SignedIn;
let headOffice: Branch;
let chattogram: Branch;
let ctgDepot: Warehouse;

const WORKSPACE = 'meghna-distributors';

// Each person's sign-in details. A test signs in again for a second browser, or a new session.
const people = {
  owner: { email: 'shafiq@meghnadistributors.com', password: 'Narsingdi-depot-2026' },
  rafiq: { email: 'rafiq@meghnadistributors.com', password: 'Bhairab-route-2026' },
  nasrin: { email: 'nasrin@meghnadistributors.com', password: 'Agrabad-depot-2026' },
  tanvir: { email: 'tanvir@meghnadistributors.com', password: 'Sylhet-route-2026' },
};

function signIn(person: keyof typeof people): Promise<SignedIn> {
  return logIn(app, { workspace: WORKSPACE, ...people[person], keepSignedIn: false });
}

function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

function send(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

async function created<T>(schema: z.ZodType<T>, url: string, payload: object): Promise<T> {
  const res = await send('POST', url, payload);
  expect(res.statusCode, res.body).toBe(201);
  return schema.parse(res.json());
}

async function newDevice(name: string, branch: Branch, as = owner): Promise<Device> {
  const res = await send('POST', '/sync/devices', { id: v7(), name, branchId: branch.id }, as);
  expect(res.statusCode, res.body).toBe(201);
  return deviceSchema.parse(res.json());
}

async function mine(as = owner): Promise<DeviceListItem[]> {
  const res = await send('GET', '/me/devices', undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return myDeviceListSchema.parse(res.json()).items;
}

// Every page of the workspace's list, as the Settings page loads them: until nextCursor is null
async function allPages(query: Record<string, string>, as = owner): Promise<DeviceListItem[]> {
  const items: DeviceListItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams(query);
    if (cursor !== null) params.set('cursor', cursor);
    const res = await send('GET', `/devices?${params.toString()}`, undefined, as);
    expect(res.statusCode, res.body).toBe(200);
    const body = devicePageSchema.parse(res.json());
    items.push(...body.items);
    cursor = body.nextCursor;
    if (cursor === null) return items;
  }
  throw new Error('The list did not end in 100 pages');
}

function rename(device: { id: string; version: number }, name: string, as = owner) {
  return send('PATCH', `/devices/${device.id}`, { name, version: device.version }, as);
}

function move(device: { id: string; version: number }, branch: Branch, as = owner) {
  return send(
    'PUT',
    `/devices/${device.id}/branch`,
    { branchId: branch.id, version: device.version },
    as,
  );
}

function revoke(device: { id: string }, as = owner) {
  return send('POST', `/devices/${device.id}/revoke`, undefined, as);
}

function itemOf(res: Awaited<ReturnType<typeof send>>): DeviceListItem {
  expect(res.statusCode, res.body).toBe(200);
  return deviceListItemSchema.parse(res.json());
}

function pull(device: { id: string }, as = owner, cursor?: string) {
  const query = new URLSearchParams({ deviceId: device.id, protocol: '1', limit: '1000' });
  if (cursor !== undefined) query.set('cursor', cursor);
  return send('GET', `/sync/pull?${query.toString()}`, undefined, as);
}

// One page is the whole pull here: a new workspace has a few hundred rows at most
async function pulled(device: { id: string }, as = owner, cursor?: string) {
  const res = await pull(device, as, cursor);
  expect(res.statusCode, res.body).toBe(200);
  const body = syncPullSchema.parse(res.json());
  expect(body.hasMore).toBe(false);
  return body;
}

// A push of one new customer. Its answer does not matter here: only that the device may push.
function push(device: { id: string }, as = owner) {
  return send(
    'POST',
    '/sync/push',
    {
      deviceId: device.id,
      protocol: 1,
      commands: [
        {
          id: v7(),
          type: 'customer.create',
          customerId: v7(),
          input: {
            code: '',
            name: 'Sylhet Pharmacy',
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
          },
        },
      ],
    },
    as,
  );
}

function refresh(who: SignedIn) {
  return app.inject({
    method: 'POST',
    url: '/auth/refresh',
    cookies: { omnivo_rt: who.refreshToken },
  });
}

// The session an access token belongs to: its `sid` claim (18c.3). The token is a JWT, so the
// claims are the base64url JSON between the two dots.
const claimsSchema = z.object({ sid: z.uuid() });
function sidOf(who: SignedIn): string {
  const [, payload = ''] = who.accessToken.split('.');
  return claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).sid;
}

async function sessionExists(id: string): Promise<boolean> {
  const rows = z
    .array(z.object({ n: z.number() }))
    .parse(await sql`SELECT count(*)::int AS n FROM sessions WHERE id = ${id}`);
  return rows[0]?.n === 1;
}

const deviceRowSchema = z.object({
  session_id: z.uuid().nullable(),
  version: z.number(),
  revoked_at: z.date().nullable(),
  last_sync_at: z.date().nullable(),
  // Step 19b: the driver reads a bytea as a Buffer
  secret: z.instanceof(Buffer).nullable(),
});
async function deviceRow(id: string) {
  const [row] = z.array(deviceRowSchema).parse(
    await sql`SELECT session_id, version, revoked_at, last_sync_at, secret
                  FROM devices WHERE id = ${id}`,
  );
  if (!row) throw new Error(`no device ${id}`);
  return row;
}

// Step 19b: the device's key, as the app asks for it after a sign-in or a reload
function key(device: { id: string }, as = owner) {
  return send('GET', `/sync/devices/${device.id}/key`, undefined, as);
}

async function keyOf(device: { id: string }, as = owner): Promise<string> {
  const res = await key(device, as);
  expect(res.statusCode, res.body).toBe(200);
  return deviceKeySchema.parse(res.json()).key;
}

// The Postgres error a statement of the superuser fails with: its code and the constraint
async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof postgres.PostgresError) {
      return { code: error.code, constraint: error.constraint_name };
    }
    throw error;
  }
  throw new Error('The statement worked');
}

async function auditOf(device: { id: string }) {
  const res = await send('GET', `/audit-logs?entityType=device&entityId=${device.id}&limit=100`);
  expect(res.statusCode, res.body).toBe(200);
  return auditPageSchema.parse(res.json()).items;
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
    workspaceSlug: WORKSPACE,
    fullName: 'Shafiq Ahmed',
    ...people.owner,
  });
  // The distribution template makes the Depot manager role
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });

  // Each of the three has a workspace of their own first (sign-up needs one), then joins this one
  const others = [
    ['rafiq', 'Rafiq Islam', 'rafiq-traders'],
    ['nasrin', 'Nasrin Akter', 'nasrin-traders'],
    ['tanvir', 'Tanvir Hasan', 'tanvir-traders'],
  ] as const;
  for (const [person, fullName, slug] of others) {
    await signUp(app, { companyName: fullName, workspaceSlug: slug, fullName, ...people[person] });
    await joinWithoutRoles(pg.superuserUrl, { email: people[person].email, workspace: WORKSPACE });
  }

  // Nasrin gets the template's role as it is: no permission added by the test
  const { items: roles } = roleListSchema.parse((await send('GET', '/roles')).json());
  const depotManager = roles.find((role) => role.name === 'Depot manager');
  if (!depotManager) throw new Error('no Depot manager role');
  expect(depotManager.permissions).toContain('core.device.manage');
  const { items: members } = memberPageSchema.parse((await send('GET', '/members')).json());
  const her = members.find((member) => member.email === people.nasrin.email);
  if (!her) throw new Error('Nasrin is not a member');
  const assigned = await send('PUT', `/members/${her.membershipId}/roles`, {
    roleIds: [depotManager.id],
    version: her.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);

  [rafiq, nasrin, tanvir] = await Promise.all([
    signIn('rafiq'),
    signIn('nasrin'),
    signIn('tanvir'),
  ]);

  const [head] = z
    .object({ items: z.array(branchSchema) })
    .parse((await send('GET', '/branches')).json()).items;
  if (!head) throw new Error('no branch');
  headOffice = head;
  chattogram = await created(branchSchema, '/branches', {
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
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('the lists', () => {
  it('lists your own devices: the active ones first, then by name', async () => {
    const counter = await newDevice('Counter 2', headOffice);
    const laptop = await newDevice('Accounts laptop', headOffice);
    // An old computer, on a sign-in of its own: revoking it ends that sign-in, not the owner's
    const oldBrowser = await signIn('owner');
    const old = await newDevice('Back office PC', headOffice, oldBrowser);
    expect(itemOf(await revoke(old)).revokedAt).not.toBeNull();
    const his = await newDevice('Rafiq on Android', headOffice, rafiq);

    const items = await mine();
    expect(items.map((device) => device.name)).toEqual([
      'Accounts laptop',
      'Counter 2',
      'Back office PC',
    ]);
    expect(items[1]).toEqual({
      ...counter,
      userName: 'Shafiq Ahmed',
      branchName: 'Head office',
      revokedByName: null,
    });
    expect(items[2]).toMatchObject({ id: old.id, revokedByName: 'Shafiq Ahmed' });
    expect(items.map((device) => device.id)).toContain(laptop.id);
    // Rafiq sees his own only, without any permission
    expect((await mine(rafiq)).map((device) => device.id)).toEqual([his.id]);
  });

  it("needs core.device.manage for the workspace's list", async () => {
    const refused = await send('GET', '/devices', undefined, rafiq);
    expect(refused.statusCode).toBe(403);
    expect(problemOf(refused).code).toBe('permission_missing');
    // Nasrin has it from the Depot manager template, and sees everyone's devices
    const names = (await allPages({}, nasrin)).map((device) => device.name);
    expect(names).toEqual(expect.arrayContaining(['Counter 2', 'Rafiq on Android']));
  });

  it('pages by name both ways, two devices with the same name by their id', async () => {
    const phone = await newDevice('Route phone', headOffice);
    const tablets = [
      await newDevice('Route tablet', headOffice),
      await newDevice('Route tablet', headOffice, rafiq),
    ];
    const expected = [phone.id, ...tablets.map((tablet) => tablet.id).sort()];

    // limit 1: every row is the first of a page, so every boundary goes through a cursor
    const byName = await allPages({ search: 'route', sort: 'name', limit: '1' });
    expect(byName.map((device) => device.id)).toEqual(expected);
    const backwards = await allPages({ search: 'route', sort: '-name', limit: '1' });
    expect(backwards.map((device) => device.id)).toEqual([...expected].reverse());
  });

  it('puts the devices that never synced first, and keeps microseconds apart', async () => {
    const vans = [];
    for (const n of [1, 2, 3, 4, 5])
      vans.push(await newDevice(`Van tablet ${String(n)}`, headOffice));
    const [never, later, first, sameA, sameB] = vans;
    if (!never || !later || !first || !sameA || !sameB) throw new Error('five vans');
    // Two syncs in the same millisecond, 100 µs apart: a cursor that kept a JavaScript date would
    // see them as one time. Two more at the very same time: their ids break the tie.
    await sql`UPDATE devices SET last_sync_at = '2026-10-20 09:00:00.000200+06' WHERE id = ${later.id}`;
    await sql`UPDATE devices SET last_sync_at = '2026-10-20 09:00:00.000100+06' WHERE id = ${first.id}`;
    await sql`UPDATE devices SET last_sync_at = '2026-10-21 09:00:00+06'
               WHERE id IN (${sameA.id}, ${sameB.id})`;
    const tie = [sameA.id, sameB.id].sort();
    const expected = [never.id, first.id, later.id, ...tie];

    const oldest = await allPages({ search: 'van tablet', sort: 'lastSync', limit: '1' });
    expect(oldest.map((device) => device.id)).toEqual(expected);
    const newest = await allPages({ search: 'van tablet', sort: '-lastSync', limit: '1' });
    expect(newest.map((device) => device.id)).toEqual([...expected].reverse());
    expect(newest[0]?.lastSyncAt).toBe('2026-10-21T03:00:00.000Z');
  });

  it('refuses a cursor made for another sort, or edited by hand', async () => {
    const byName = devicePageSchema.parse((await send('GET', '/devices?limit=1&sort=name')).json());
    expect(byName.nextCursor).not.toBeNull();
    const other = await send(
      'GET',
      `/devices?limit=1&sort=lastSync&cursor=${byName.nextCursor ?? ''}`,
    );
    expect(other.statusCode).toBe(400);
    expect(problemOf(other).code).toBe('invalid_cursor');

    // A sync key that is not a whole number would fail in Postgres (::bigint) with a 500
    const edited = Buffer.from(JSON.stringify(['lastSync', 'yesterday', v7()])).toString(
      'base64url',
    );
    const res = await send('GET', `/devices?sort=lastSync&cursor=${edited}`);
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).code).toBe('invalid_cursor');
  });

  it('finds a device by its name or its person, in a branch, in a tab', async () => {
    const counter = await newDevice('Agrabad counter', chattogram, rafiq);

    // The person's name, in any case
    const his = await allPages({ search: 'RAFIQ ISLAM' });
    expect(his.length).toBeGreaterThan(0);
    expect(his.every((device) => device.userName === 'Rafiq Islam')).toBe(true);
    // The device's name
    expect((await allPages({ search: 'agrabad' })).map((device) => device.id)).toEqual([
      counter.id,
    ]);
    // A % typed in the box means itself, not "anything"
    expect(await allPages({ search: '%' })).toEqual([]);

    const inCtg = await allPages({ branchId: chattogram.id });
    expect(inCtg.map((device) => device.id)).toEqual([counter.id]);
    expect(inCtg[0]?.branchName).toBe('Chattogram depot');

    // Active is the default tab; Revoked has only the revoked ones
    const active = await allPages({});
    expect(active.every((device) => device.revokedAt === null)).toBe(true);
    const revoked = await allPages({ status: 'revoked' });
    expect(revoked.map((device) => device.name)).toEqual(['Back office PC']);
  });
});

describe('renaming', () => {
  it('renames your own device, with the version you saw', async () => {
    const device = await newDevice('Chrome on Windows', headOffice);
    const renamed = itemOf(await rename(device, 'Counter 1'));
    expect(renamed).toMatchObject({ name: 'Counter 1', version: device.version + 1 });

    // The form still open on the old version is told
    const stale = await rename(device, 'Counter one');
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');

    // The same name again: nothing to write, no new version, no second audit row
    expect(itemOf(await rename(renamed, 'Counter 1')).version).toBe(renamed.version);
    const entries = await auditOf(device);
    const renames = entries.filter((entry) => entry.action === 'device.renamed');
    expect(renames.map((entry) => [entry.actor?.fullName, entry.changes])).toEqual([
      ['Shafiq Ahmed', { name: { from: 'Chrome on Windows', to: 'Counter 1' } }],
    ]);
  });

  it("renames someone else's device only with core.device.manage", async () => {
    const counter = await newDevice('Front counter', headOffice);
    const his = await newDevice('Chrome on Android', headOffice, rafiq);

    // Without the permission it does not exist, like an unknown id
    const refused = await rename(counter, 'Mine now', rafiq);
    expect(refused.statusCode).toBe(404);
    expect(problemOf(refused).code).toBe('device_not_found');
    const unknown = await rename({ id: v7(), version: 1 }, 'Nobody', rafiq);
    expect(problemOf(unknown).code).toBe('device_not_found');

    // Nasrin names it after its person; it stays Rafiq's
    expect(itemOf(await rename(his, 'Rafiq phone', nasrin))).toMatchObject({
      name: 'Rafiq phone',
      userName: 'Rafiq Islam',
    });
  });

  it('refuses to rename a revoked device, before it looks at the version', async () => {
    const browser = await signIn('owner');
    const device = await newDevice('Stolen phone', headOffice, browser);
    itemOf(await revoke(device));
    // device.version is the one before the revoke: still "revoked", not "reload"
    const res = await rename(device, 'Found phone');
    expect(res.statusCode).toBe(403);
    expect(problemOf(res).code).toBe('device_revoked');
  });
});

describe('moving', () => {
  it('moves your own device, and its next pull copies the new branch', async () => {
    const browser = await signIn('rafiq');
    const device = await newDevice('Rafiq laptop', headOffice, browser);
    const { cursor } = await pulled(device, browser);

    const moved = itemOf(await move(device, chattogram, browser));
    expect(moved).toMatchObject({
      branchId: chattogram.id,
      branchName: 'Chattogram depot',
      version: device.version + 1,
    });
    const entries = await auditOf(device);
    expect(entries.find((entry) => entry.action === 'device.moved')).toMatchObject({
      actor: { fullName: 'Rafiq Islam' },
      changes: { branch: { from: 'HO', to: 'CTG' } },
    });

    // The cursor of the head office starts a full pull of Chattogram: its depot only
    const after = await pulled(device, browser, cursor);
    expect(after.full).toBe(true);
    const stores = after.changes.filter((change) => change.entity === 'warehouse');
    expect(stores.map((change) => change.key)).toEqual([ctgDepot.id]);
  });

  it('answers a move to the same branch with the device unchanged', async () => {
    const device = await newDevice('Shelf scanner', chattogram);
    const same = itemOf(await move(device, chattogram));
    expect(same.version).toBe(device.version);
    expect((await auditOf(device)).map((entry) => entry.action)).toEqual(['device.registered']);
  });

  it("never moves someone else's device, nor into a branch that is not active", async () => {
    const his = await newDevice('Rafiq tablet', headOffice, rafiq);
    // Even with core.device.manage: only the device knows that nothing waits in its outbox
    const refused = await move(his, chattogram, nasrin);
    expect(refused.statusCode).toBe(404);
    expect(problemOf(refused).code).toBe('device_not_found');

    let bogura = await created(branchSchema, '/branches', {
      code: 'BOG',
      name: 'Bogura depot',
      phone: '',
      address: '',
    });
    const archived = await send('POST', `/branches/${bogura.id}/archive`, {
      version: bogura.version,
    });
    bogura = branchSchema.parse(archived.json());
    const res = await move(his, bogura, rafiq);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res)).toMatchObject({
      code: 'device_branch_invalid',
      fieldErrors: { branchId: ['device_branch_invalid'] },
    });

    // The form's empty select: the same message, from the contract
    const empty = await send(
      'PUT',
      `/devices/${his.id}/branch`,
      { branchId: '', version: his.version },
      rafiq,
    );
    expect(empty.statusCode).toBe(400);
    expect(problemOf(empty).fieldErrors).toEqual({ branchId: ['device_branch_invalid'] });
  });
});

describe('revoking', () => {
  it('stops your own device and ends its sign-in, and only that one', async () => {
    // Rafiq on two browsers: the phone he lost, and the laptop he revokes it from
    const phoneBrowser = await signIn('rafiq');
    const laptopBrowser = await signIn('rafiq');
    const phone = await newDevice('Rafiq on iPhone', headOffice, phoneBrowser);
    const laptop = await newDevice('Rafiq on Chrome', headOffice, laptopBrowser);
    expect((await deviceRow(phone.id)).session_id).toBe(sidOf(phoneBrowser));

    const revoked = itemOf(await revoke(phone, laptopBrowser));
    expect(revoked).toMatchObject({
      id: phone.id,
      version: phone.version + 1,
      revokedByName: 'Rafiq Islam',
    });
    expect(revoked.revokedAt).not.toBeNull();

    // The phone's sign-in is gone: no new access token for it
    expect(await sessionExists(sidOf(phoneBrowser))).toBe(false);
    expect((await refresh(phoneBrowser)).statusCode).toBe(401);
    // Its sync stops at once
    expect(problemOf(await pull(phone, phoneBrowser)).code).toBe('device_revoked');
    const pushed = await push(phone, phoneBrowser);
    expect(pushed.statusCode).toBe(403);
    expect(problemOf(pushed).code).toBe('device_revoked');
    // Its last access token still reads online pages for its last minutes (decision 18)
    expect((await send('GET', '/me/devices', undefined, phoneBrowser)).statusCode).toBe(200);

    // The laptop is untouched: its sign-in refreshes, its device syncs
    expect(await sessionExists(sidOf(laptopBrowser))).toBe(true);
    expect((await refresh(laptopBrowser)).statusCode).toBe(200);
    expect((await pull(laptop, laptopBrowser)).statusCode).toBe(200);

    const entries = await auditOf(phone);
    const revokes = entries.filter((entry) => entry.action === 'device.revoked');
    expect(revokes.map((entry) => entry.actor?.fullName)).toEqual(['Rafiq Islam']);
  });

  it("revokes someone else's device only with core.device.manage", async () => {
    const browser = await signIn('rafiq');
    const his = await newDevice('Rafiq van tablet', headOffice, browser);
    const counter = await newDevice('Back counter', headOffice);

    const refused = await revoke(counter, rafiq);
    expect(refused.statusCode).toBe(404);
    expect(problemOf(refused).code).toBe('device_not_found');
    expect((await deviceRow(counter.id)).revoked_at).toBeNull();

    expect(itemOf(await revoke(his, nasrin))).toMatchObject({
      userName: 'Rafiq Islam',
      revokedByName: 'Nasrin Akter',
    });
    expect((await refresh(browser)).statusCode).toBe(401);
  });

  it('answers a revoked device as it is, with one audit row', async () => {
    const browser = await signIn('owner');
    const device = await newDevice('Old tablet', headOffice, browser);
    const first = itemOf(await revoke(device));
    // A double click, or someone else at the same moment: the same answer, nothing changed
    expect(itemOf(await revoke(device))).toEqual(first);
    expect(itemOf(await revoke(device, nasrin))).toEqual(first);
    const entries = await auditOf(device);
    expect(entries.filter((entry) => entry.action === 'device.revoked')).toHaveLength(1);
  });

  it('makes a new device when the browser signs in again', async () => {
    const before = await signIn('rafiq');
    const old = await newDevice('Rafiq on Firefox', headOffice, before);
    itemOf(await revoke(old, before));
    const row = await deviceRow(old.id);

    // The browser still holds the old id: registering it answers it revoked, and changes nothing
    const again = await signIn('rafiq');
    const res = await send(
      'POST',
      '/sync/devices',
      { id: old.id, name: 'Rafiq on Firefox', branchId: headOffice.id },
      again,
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(deviceSchema.parse(res.json()).revokedAt).not.toBeNull();
    expect(await deviceRow(old.id)).toEqual(row);

    // So the app makes a new id (decision 4), and the new device syncs
    const fresh = await newDevice('Rafiq on Firefox', headOffice, again);
    expect((await pull(fresh, again)).statusCode).toBe(200);
    const names = (await mine(again)).filter((device) => device.name === 'Rafiq on Firefox');
    expect(names.map((device) => device.revokedAt === null)).toEqual([true, false]);
  });

  it('lets a pull that waited on a revoke finish, and keeps the old sign-in', async () => {
    const first = await signIn('owner');
    const device = await newDevice('Delivery van tablet', headOffice, first);
    // A new sign-in pulls: without the CASE in the pull's last UPDATE, it would write its own
    // session onto a row that is revoked by then, and migration 0048 would answer a 500
    const second = await signIn('owner');

    let pending: ReturnType<typeof pull> | undefined;
    await sql.begin(async (tx) => {
      await tx`UPDATE devices SET revoked_at = now(), revoked_by = user_id, secret = NULL
                 WHERE id = ${device.id}`;
      // The pull checks the device before the revoke commits, reads the data, and then waits on
      // this row for its last UPDATE
      pending = pull(device, second);
      await eventually(async () => {
        const waiting = z.array(z.object({ n: z.number() })).parse(
          await sql`SELECT count(*)::int AS n FROM pg_stat_activity
                       WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE devices SET last_sync_at%'`,
        );
        expect(waiting[0]?.n).toBe(1);
      });
    });
    const res = await pending;
    expect(res?.statusCode, res?.body).toBe(200);

    const row = await deviceRow(device.id);
    expect(row.revoked_at).not.toBeNull();
    expect(row.session_id).toBe(sidOf(first));
    expect(row.last_sync_at).not.toBeNull();
  });
});

describe('the sign-in a device follows', () => {
  it('moves the device to each new sign-in, without a new version', async () => {
    const first = await signIn('nasrin');
    const device = await newDevice('Depot desk', chattogram, first);
    expect((await deviceRow(device.id)).session_id).toBe(sidOf(first));

    // Signed out and in again on the same browser: registering the same id follows it
    const second = await signIn('nasrin');
    const res = await send(
      'POST',
      '/sync/devices',
      { id: device.id, name: 'Depot desk', branchId: chattogram.id },
      second,
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(await deviceRow(device.id)).toMatchObject({
      session_id: sidOf(second),
      version: device.version,
    });

    // A pull follows it too, when it ends (and writes the time of the sync)
    const third = await signIn('nasrin');
    await pulled(device, third);
    expect(await deviceRow(device.id)).toMatchObject({
      session_id: sidOf(third),
      version: device.version,
    });

    // And a push, in its first transaction
    const fourth = await signIn('nasrin');
    const pushed = await push(device, fourth);
    expect(pushed.statusCode, pushed.body).toBe(200);
    syncPushSchema.parse(pushed.json());
    expect(await deviceRow(device.id)).toMatchObject({
      session_id: sidOf(fourth),
      version: device.version,
    });

    // So a revoke now ends the sign-in the device uses now, and leaves the old ones
    itemOf(await revoke(device, fourth));
    expect(await sessionExists(sidOf(fourth))).toBe(false);
    expect(await sessionExists(sidOf(third))).toBe(true);
  });
});

describe('the device key', () => {
  it('gives the device its own key, the same each time, and no cache keeps it', async () => {
    const browser = await signIn('rafiq');
    const counter = await newDevice('Rafiq at the counter', headOffice, browser);
    const van = await newDevice('Rafiq in the van', headOffice, browser);

    const res = await key(counter, browser);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const first = deviceKeySchema.parse(res.json()).key;
    // 32 bytes, and exactly the bytes the database holds
    const bytes = Buffer.from(first, 'base64');
    expect(bytes).toHaveLength(32);
    expect((await deviceRow(counter.id)).secret?.equals(bytes)).toBe(true);
    // The same key on every reload: the copy was wrapped with it
    expect(await keyOf(counter, browser)).toBe(first);
    // Each device has a key of its own
    expect(await keyOf(van, browser)).not.toBe(first);

    // No other answer carries it: not the registration, not the lists, not the audit log
    const again = await send(
      'POST',
      '/sync/devices',
      { id: counter.id, name: counter.name, branchId: headOffice.id },
      browser,
    );
    const lists = [
      again,
      await send('GET', '/me/devices', undefined, browser),
      await send('GET', '/devices?limit=100'),
      await send('GET', `/audit-logs?entityType=device&entityId=${counter.id}&limit=100`),
    ];
    for (const list of lists) {
      expect(list.statusCode, list.body).toBeLessThan(300);
      expect(list.body).not.toContain(first);
      expect(list.body).not.toContain('secret');
    }
  });

  it("never gives another person's device key, even with core.device.manage", async () => {
    const counter = await newDevice('Front desk PC', headOffice);
    for (const someone of [rafiq, nasrin]) {
      const res = await key(counter, someone);
      expect(res.statusCode).toBe(404);
      expect(problemOf(res).code).toBe('device_not_found');
    }
    // An id nobody registered answers the same
    const unknown = await key({ id: v7() });
    expect(unknown.statusCode).toBe(404);
    expect(problemOf(unknown).code).toBe('device_not_found');
  });

  it('deletes the key with the revoke, for good', async () => {
    const browser = await signIn('nasrin');
    const device = await newDevice('Nasrin tablet', chattogram, browser);
    await keyOf(device, browser);

    itemOf(await revoke(device, browser));
    expect((await deviceRow(device.id)).secret).toBeNull();
    // Its last access token still works for a few minutes, but gets no key: the app deletes the
    // copy on device_revoked
    const res = await key(device, browser);
    expect(res.statusCode).toBe(403);
    expect(problemOf(res).code).toBe('device_revoked');
  });

  it('follows the sign-in, like a pull, without a new version', async () => {
    const first = await signIn('owner');
    const device = await newDevice('Accounts laptop', headOffice, first);
    // A reload after a new sign-in asks for the key before anything else
    const second = await signIn('owner');
    await keyOf(device, second);
    expect(await deviceRow(device.id)).toMatchObject({
      session_id: sidOf(second),
      version: device.version,
    });
  });

  it('waits for a revoke that is running, then refuses', async () => {
    const browser = await signIn('owner');
    const device = await newDevice('Warehouse scanner', headOffice, browser);

    let pending: ReturnType<typeof key> | undefined;
    await sql.begin(async (tx) => {
      await tx`UPDATE devices SET revoked_at = now(), revoked_by = user_id, secret = NULL
                 WHERE id = ${device.id}`;
      // Without FOR SHARE, the key request would read the row as it was before this revoke,
      // and send the key after the revoke was done
      pending = key(device, browser);
      await eventually(async () => {
        const waiting = z.array(z.object({ n: z.number() })).parse(
          await sql`SELECT count(*)::int AS n FROM pg_stat_activity
                       WHERE wait_event_type = 'Lock' AND query LIKE '%from "devices"%for share%'`,
        );
        expect(waiting[0]?.n).toBe(1);
      });
    });
    const res = await pending;
    expect(res?.statusCode).toBe(403);
    expect(res && problemOf(res).code).toBe('device_revoked');
  });

  it('is in the database for every active device, and for no revoked one', async () => {
    const device = await newDevice('Back office PC', headOffice);
    // A revoke that keeps the key
    expect(
      await refusal(
        () => sql`UPDATE devices SET revoked_at = now(), revoked_by = user_id
                    WHERE id = ${device.id}`,
      ),
    ).toEqual({ code: '23514', constraint: 'devices_secret_check' });
    // An active device without one
    expect(
      await refusal(() => sql`UPDATE devices SET secret = NULL WHERE id = ${device.id}`),
    ).toEqual({ code: '23514', constraint: 'devices_secret_check' });
    // A key that is not 32 bytes
    expect(
      await refusal(
        () => sql`UPDATE devices SET secret = decode('0102', 'hex') WHERE id = ${device.id}`,
      ),
    ).toEqual({ code: '23514', constraint: 'devices_secret_length_check' });
    // And a revoked device never gets one back
    itemOf(await revoke(device));
    expect(
      await refusal(
        () => sql`UPDATE devices SET secret = gen_random_bytes(32) WHERE id = ${device.id}`,
      ),
    ).toEqual({ code: '23514', constraint: 'devices_secret_check' });
  });
});

describe('removing a member', () => {
  it('revokes all their active devices, in the name of the person who removed them', async () => {
    const phoneBrowser = await signIn('tanvir');
    const phone = await newDevice('Tanvir phone', headOffice, phoneBrowser);
    // The phone he revoked himself last week keeps its revoker
    const ownRevoke = itemOf(await revoke(phone, phoneBrowser));
    const laptop = await newDevice('Tanvir laptop', headOffice, tanvir);
    const tablet = await newDevice('Tanvir tablet', chattogram, tanvir);

    const { items: members } = memberPageSchema.parse((await send('GET', '/members')).json());
    const him = members.find((member) => member.email === people.tanvir.email);
    if (!him) throw new Error('Tanvir is not a member');
    const removed = await send(
      'DELETE',
      `/members/${him.membershipId}?version=${String(him.version)}`,
    );
    expect(removed.statusCode, removed.body).toBe(204);

    // His name stays on his devices after he left (decision 7)
    const his = await allPages({ search: 'tanvir', status: 'revoked' });
    expect(his.map((device) => [device.name, device.userName, device.revokedByName])).toEqual([
      ['Tanvir laptop', 'Tanvir Hasan', 'Shafiq Ahmed'],
      ['Tanvir phone', 'Tanvir Hasan', 'Tanvir Hasan'],
      ['Tanvir tablet', 'Tanvir Hasan', 'Shafiq Ahmed'],
    ]);
    expect(his.find((device) => device.id === phone.id)).toEqual(ownRevoke);
    expect(await allPages({ search: 'tanvir' })).toEqual([]);

    for (const device of [laptop, tablet]) {
      const entries = await auditOf(device);
      expect(entries.find((entry) => entry.action === 'device.revoked')).toMatchObject({
        actor: { fullName: 'Shafiq Ahmed' },
      });
    }
    expect(await sessionExists(sidOf(tanvir))).toBe(false);
    // Step 19b: their keys went with the revoke
    for (const device of [laptop, tablet]) expect((await deviceRow(device.id)).secret).toBeNull();
  });
});

describe('archiving a branch', () => {
  it('waits until no active device is in it, and says how many there are', async () => {
    const sylhet = await created(branchSchema, '/branches', {
      code: 'SYL',
      name: 'Sylhet depot',
      phone: '',
      address: '',
    });
    const store = await created(warehouseSchema, '/warehouses', {
      branchId: sylhet.id,
      code: 'SYL1',
      name: 'Sylhet depot',
      address: '',
    });
    const browser = await signIn('owner');
    const counter = await newDevice('Sylhet counter', sylhet, browser);
    const his = await newDevice('Rafiq in Sylhet', sylhet, rafiq);

    const archive = () =>
      send('POST', `/branches/${sylhet.id}/archive`, { version: sylhet.version });
    // The devices come before the warehouses (decision 20)
    const two = await archive();
    expect(two.statusCode).toBe(409);
    expect(problemOf(two)).toMatchObject({ code: 'branch_has_devices', params: { count: 2 } });

    // A revoked device does not count; a moved one has left
    itemOf(await revoke(counter));
    expect(problemOf(await archive()).params).toEqual({ count: 1 });
    itemOf(await move(his, headOffice, rafiq));
    expect(problemOf(await archive()).code).toBe('branch_has_warehouses');

    const closed = await send('POST', `/warehouses/${store.id}/archive`, {
      version: store.version,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect((await archive()).statusCode).toBe(200);
  });
});
