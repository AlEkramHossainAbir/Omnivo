import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type Member,
  memberPageSchema,
  memberSchema,
  meResponseSchema,
  problemSchema,
  type Role,
  roleListSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PermissionService } from '../rbac/permission.service.js';
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
let farhana: SignedIn;
let rahim: SignedIn;
let nasrin: SignedIn;

// তিনজন: Farhana (সাইনআপ করা owner), Rahim (পরে দ্বিতীয় owner), Nasrin (সাধারণ সদস্য)
const PEOPLE = [
  { fullName: 'Rahim Uddin', email: 'rahim@rahmangarments.com', password: 'Ashulia-knit-2026' },
  { fullName: 'Nasrin Akter', email: 'nasrin@rahmangarments.com', password: 'Tongi-store-2026' },
] as const;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  farhana = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  const sessions: SignedIn[] = [];
  for (const [index, person] of PEOPLE.entries()) {
    await signUp(app, {
      companyName: `${person.fullName} Traders`,
      workspaceSlug: `own-workspace-${String(index)}`,
      ...person,
    });
    await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'rahman-garments' });
    sessions.push(
      await logIn(app, {
        workspace: 'rahman-garments',
        email: person.email,
        password: person.password,
        keepSignedIn: false,
      }),
    );
  }
  [rahim, nasrin] = sessions as [SignedIn, SignedIn];
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function send(method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: object, as = farhana) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function member(email: string, as = farhana): Promise<Member> {
  const { items } = memberPageSchema.parse((await send('GET', '/members', undefined, as)).json());
  const found = items.find((candidate) => candidate.email === email);
  if (!found) throw new Error(`no member ${email}`);
  return found;
}

async function ownerRole(): Promise<Role> {
  const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
  const found = items.find((role) => role.kind === 'owner');
  if (!found) throw new Error('no owner role');
  return found;
}

describe('changing roles', () => {
  it('never lets someone change their own roles, even an owner', async () => {
    const me = await member('farhana@rahmangarments.com');
    const res = await send('PUT', `/members/${me.membershipId}/roles`, {
      roleIds: [],
      version: me.version,
    });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('own_membership');
  });

  it('makes Rahim a second owner, and refuses a save based on an old version', async () => {
    const target = await member('rahim@rahmangarments.com');
    const owner = await ownerRole();
    const res = await send('PUT', `/members/${target.membershipId}/roles`, {
      roleIds: [owner.id],
      version: target.version,
    });
    expect(res.statusCode).toBe(200);
    expect(memberSchema.parse(res.json())).toMatchObject({
      roles: [{ id: owner.id, name: 'Owner' }],
      version: target.version + 1,
    });

    const stale = await send('PUT', `/members/${target.membershipId}/roles`, {
      roleIds: [],
      version: target.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(problemSchema.parse(stale.json()).code).toBe('version_conflict');
  });

  it('keeps one owner, even when two owners demote each other at the same moment', async () => {
    const farhanaRow = await member('farhana@rahmangarments.com');
    const rahimRow = await member('rahim@rahmangarments.com');
    const owner = await ownerRole();

    // দৌড়টা নিশ্চিতভাবে ঘটানো (branches-এর race টেস্টের মতো): আরেকটা transaction "Rahim Farhana-কে
    // সরাল" করে commit না করে ধরে রাখে, আর সেই ফাঁকে API-তে Farhana Rahim-কে সরাতে চায়। lock থাকলে
    // API অপেক্ষা করে, তারপর দেখে Farhana আর owner না → Rahim-ই শেষ owner → 409
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let pending: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      await tx`
        DELETE FROM membership_roles
        WHERE membership_id = ${farhanaRow.membershipId} AND role_id = ${owner.id}`;
      pending = send('PUT', `/members/${rahimRow.membershipId}/roles`, {
        roleIds: [],
        version: rahimRow.version,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await superuser.end();

    const res = await pending;
    expect(res?.statusCode).toBe(409);
    expect(problemSchema.parse(res?.json()).code).toBe('last_owner');
    const after = await member('rahim@rahmangarments.com');
    expect(after.roles.map((role) => role.name)).toEqual(['Owner']);

    // টেস্টের SQL (superuser) cache মোছে না — Farhana-র পুরনো "owner" মুছে দেওয়া, যাতে পরের টেস্ট
    // তার আসল অবস্থা (কোনো রোল নেই) দেখে
    const me = meResponseSchema.parse((await send('GET', '/auth/me', undefined, rahim)).json());
    await app.get(PermissionService).invalidate(me.tenant.id, [farhanaRow.userId]);
    expect((await send('GET', '/members')).statusCode).toBe(403);
  });
});

describe('removing a member', () => {
  it('locks them out on their next request, although their token has minutes left', async () => {
    // এখন owner শুধু Rahim (আগের টেস্ট) — তাই এখান থেকে সব কাজ Rahim-এর
    expect((await send('GET', '/branches', undefined, nasrin)).statusCode).toBe(200);
    const target = await member('nasrin@rahmangarments.com', rahim);
    const res = await send(
      'DELETE',
      `/members/${target.membershipId}?version=${String(target.version)}`,
      undefined,
      rahim,
    );
    expect(res.statusCode).toBe(204);

    const after = await send('GET', '/branches', undefined, nasrin);
    expect(after.statusCode).toBe(401);
    expect(problemSchema.parse(after.json()).code).toBe('access_revoked');
    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { omnivo_rt: nasrin.refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);

    // তালিকা থেকে গেছে, audit-এ কে কাকে সরাল
    const { items } = memberPageSchema.parse(
      (await send('GET', '/members', undefined, rahim)).json(),
    );
    expect(items.map((m) => m.email)).not.toContain('nasrin@rahmangarments.com');
    const audit = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=member', undefined, rahim)).json(),
    );
    expect(audit.items[0]).toMatchObject({
      action: 'member.removed',
      actor: { fullName: 'Rahim Uddin' },
      changes: { email: { from: 'nasrin@rahmangarments.com', to: null } },
    });
  });
});
