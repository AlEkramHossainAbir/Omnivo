import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type Member,
  memberPageSchema,
  meResponseSchema,
  PERMISSION_KEYS,
  problemSchema,
  type Role,
  roleListSchema,
  roleSchema,
} from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
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
let owner: SignedIn;
// Nasrin: নিজের workspace আছে, আর Rahman Garments-এ রোল ছাড়া সদস্য — এই ফাইলে তার অধিকার বদলায়
let nasrin: SignedIn;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'nasrin@rahmangarments.com',
    workspace: 'rahman-garments',
  });
  nasrin = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

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

async function roleList(): Promise<Role[]> {
  return roleListSchema.parse((await send('GET', '/roles')).json()).items;
}

async function roleNamed(name: string): Promise<Role> {
  const role = (await roleList()).find((candidate) => candidate.name === name);
  if (!role) throw new Error(`no role ${name}`);
  return role;
}

async function memberByEmail(email: string): Promise<Member> {
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const member = items.find((candidate) => candidate.email === email);
  if (!member) throw new Error(`no member ${email}`);
  return member;
}

async function setMatrix(role: Role, permissions: string[], as = owner) {
  return send(
    'PUT',
    '/permission-matrix',
    { roles: [{ id: role.id, version: role.version, permissions }] },
    as,
  );
}

describe('roles', () => {
  it('starts with the Owner role, holding every permission from code', async () => {
    const [ownerRole, ...rest] = await roleList();
    expect(rest).toEqual([]);
    expect(ownerRole).toMatchObject({
      name: 'Owner',
      kind: 'owner',
      permissions: [...PERMISSION_KEYS].sort(),
      memberCount: 1,
    });
  });

  it('creates an empty custom role and refuses the same name in another case', async () => {
    const res = await send('POST', '/roles', { name: 'Accountant', description: '' });
    expect(res.statusCode).toBe(201);
    expect(roleSchema.parse(res.json())).toMatchObject({
      name: 'Accountant',
      description: null,
      kind: 'custom',
      permissions: [],
      memberCount: 0,
    });

    const twin = await send('POST', '/roles', { name: 'accountant', description: '' });
    expect(twin.statusCode).toBe(409);
    expect(problemSchema.parse(twin.json())).toMatchObject({
      code: 'role_name_taken',
      fieldErrors: { name: ['role_name_taken'] },
    });
  });

  it('never lets the Owner role be renamed, deleted or given a different set', async () => {
    const ownerRole = await roleNamed('Owner');
    const rename = await send('PUT', `/roles/${ownerRole.id}`, {
      name: 'Boss',
      description: '',
      version: ownerRole.version,
    });
    const remove = await send(
      'DELETE',
      `/roles/${ownerRole.id}?version=${String(ownerRole.version)}`,
    );
    const matrix = await setMatrix(ownerRole, ['core.user.read']);
    for (const res of [rename, remove, matrix]) {
      expect(res.statusCode).toBe(409);
      expect(problemSchema.parse(res.json()).code).toBe('owner_role_locked');
    }
  });
});

describe('permission matrix', () => {
  it("changes a member's access on their very next request, without waiting for the cache", async () => {
    // আগে একবার ডাকা — Nasrin-এর "কিছুই না" এখন Redis-এ
    expect((await send('GET', '/members', undefined, nasrin)).statusCode).toBe(403);

    const accountant = await roleNamed('Accountant');
    expect((await setMatrix(accountant, ['core.user.read', 'core.audit.read'])).statusCode).toBe(
      200,
    );
    const member = await memberByEmail('nasrin@rahmangarments.com');
    const assign = await send('PUT', `/members/${member.membershipId}/roles`, {
      roleIds: [accountant.id],
      version: member.version,
    });
    expect(assign.statusCode).toBe(200);
    expect((await send('GET', '/members', undefined, nasrin)).statusCode).toBe(200);

    // রোল থেকে permission তোলা — যাদের রোলটা আছে তাদের cache-ও মোছে
    const updated = await roleNamed('Accountant');
    expect((await setMatrix(updated, ['core.audit.read'])).statusCode).toBe(200);
    expect((await send('GET', '/members', undefined, nasrin)).statusCode).toBe(403);

    const me = meResponseSchema.parse((await send('GET', '/auth/me', undefined, nasrin)).json());
    expect(me.roles).toEqual(['Accountant']);
    expect(me.permissions).toEqual(['core.audit.read']);
  });

  it('saves every role or none: one stale version rolls the whole matrix back', async () => {
    await send('POST', '/roles', { name: 'Store keeper', description: 'Receives stock at depots' });
    const storeKeeper = await roleNamed('Store keeper');
    const accountant = await roleNamed('Accountant');
    const res = await send('PUT', '/permission-matrix', {
      roles: [
        { id: storeKeeper.id, version: storeKeeper.version, permissions: ['core.branch.manage'] },
        // পুরনো version — কেউ এর মধ্যে এই রোল বদলেছে
        { id: accountant.id, version: accountant.version - 1, permissions: [] },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('version_conflict');
    expect((await roleNamed('Store keeper')).permissions).toEqual([]);
  });

  it('writes one audit entry per changed role, with only the ticks that moved', async () => {
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=role&limit=100')).json(),
    );
    const changes = items
      .filter((entry) => entry.action === 'role.permissions_changed')
      .map((entry) => entry.changes);
    // নতুন আগে: শেষ বদল আগে
    expect(changes).toEqual([
      { 'core.user.read': { from: true, to: false } },
      {
        'core.user.read': { from: false, to: true },
        'core.audit.read': { from: false, to: true },
      },
    ]);
  });
});

describe('no escalation', () => {
  it('lets a role manager tick only the permissions they have themselves', async () => {
    // Nasrin-কে "Team lead": রোল সামলাতে পারে, আর সদস্য দেখতে পারে — কিন্তু সেটিংস না
    const created = roleSchema.parse(
      (await send('POST', '/roles', { name: 'Team lead', description: '' })).json(),
    );
    await setMatrix(created, ['core.role.manage', 'core.user.read', 'core.user.manage']);
    const member = await memberByEmail('nasrin@rahmangarments.com');
    const accountant = await roleNamed('Accountant');
    await send('PUT', `/members/${member.membershipId}/roles`, {
      roleIds: [accountant.id, created.id],
      version: member.version,
    });

    const storeKeeper = await roleNamed('Store keeper');
    const tooMuch = await setMatrix(storeKeeper, ['core.settings.manage'], nasrin);
    expect(tooMuch.statusCode).toBe(403);
    expect(problemSchema.parse(tooMuch.json()).code).toBe('cannot_grant');

    expect((await setMatrix(storeKeeper, ['core.user.read'], nasrin)).statusCode).toBe(200);
  });

  it('stops a manager from handing out or taking away the Owner role', async () => {
    // Rahim: আরেকজন, Rahman Garments-এ রোল ছাড়া
    await signUp(app, {
      companyName: 'Rahim Knitwear',
      workspaceSlug: 'rahim-knitwear',
      fullName: 'Rahim Uddin',
      email: 'rahim@rahmangarments.com',
      password: 'Ashulia-knit-2026',
    });
    await joinWithoutRoles(pg.superuserUrl, {
      email: 'rahim@rahmangarments.com',
      workspace: 'rahman-garments',
    });
    const rahim = await memberByEmail('rahim@rahmangarments.com');
    const ownerRole = await roleNamed('Owner');
    const teamLead = await roleNamed('Team lead');

    const makeOwner = await send(
      'PUT',
      `/members/${rahim.membershipId}/roles`,
      { roleIds: [ownerRole.id], version: rahim.version },
      nasrin,
    );
    expect(makeOwner.statusCode).toBe(403);
    expect(problemSchema.parse(makeOwner.json()).code).toBe('cannot_grant');

    // নিজের সমান রোল দেওয়া চলে — Team lead-এর সবই Nasrin-এর আছে
    const makeLead = await send(
      'PUT',
      `/members/${rahim.membershipId}/roles`,
      { roleIds: [teamLead.id], version: rahim.version },
      nasrin,
    );
    expect(makeLead.statusCode).toBe(200);

    // owner-কে বাদ দেওয়া = তার Owner রোল কেড়ে নেওয়া — শুধু আরেকজন owner পারে
    const farhana = await memberByEmail('farhana@rahmangarments.com');
    const removeOwner = await send(
      'DELETE',
      `/members/${farhana.membershipId}?version=${String(farhana.version)}`,
      undefined,
      nasrin,
    );
    expect(removeOwner.statusCode).toBe(403);
    expect(problemSchema.parse(removeOwner.json()).code).toBe('cannot_grant');
  });
});

describe('deleting a role', () => {
  it('refuses while someone has it, and allows it once nobody does', async () => {
    const accountant = await roleNamed('Accountant');
    const blocked = await send(
      'DELETE',
      `/roles/${accountant.id}?version=${String(accountant.version)}`,
    );
    expect(blocked.statusCode).toBe(409);
    expect(problemSchema.parse(blocked.json()).code).toBe('role_in_use');

    const member = await memberByEmail('nasrin@rahmangarments.com');
    const teamLead = await roleNamed('Team lead');
    await send('PUT', `/members/${member.membershipId}/roles`, {
      roleIds: [teamLead.id],
      version: member.version,
    });
    const fresh = await roleNamed('Accountant');
    expect(
      (await send('DELETE', `/roles/${fresh.id}?version=${String(fresh.version)}`)).statusCode,
    ).toBe(204);
    expect((await roleList()).map((role) => role.name)).toEqual([
      'Owner',
      'Store keeper',
      'Team lead',
    ]);
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=role&limit=100')).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'role.deleted',
      changes: { name: { from: 'Accountant', to: null } },
    });
  });
});
