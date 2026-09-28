import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Auth } from '@omnivo/auth';
import { apiErrorSchema, meResponseSchema, type SignUpInput } from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, refreshCookieOf, sessionOf, signUp } from '../testing/http.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
// RLS-এর বাইরে থেকে টেস্ট সেটআপ (অন্য টেন্যান্টে membership বসানো ইত্যাদি)
let superuser: postgres.Sql;

const rahman: SignUpInput = {
  companyName: 'Rahman Garments Ltd.',
  workspaceSlug: 'rahman-garments',
  fullName: 'Farhana Rahman',
  email: 'farhana@rahmangarments.com',
  password: 'Gazipur-knit-2026',
};

const karim: SignUpInput = {
  companyName: 'Karim Pharma',
  workspaceSlug: 'karim-pharma',
  fullName: 'Karim Uddin',
  email: 'karim@karimpharma.com',
  password: 'Batch-expiry-2026',
};

function login(input: { workspace: string; email: string; password: string }) {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { ...input, keepSignedIn: true },
  });
}

function refresh(refreshToken: string) {
  return app.inject({ method: 'POST', url: '/auth/refresh', cookies: { omnivo_rt: refreshToken } });
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  superuser = postgres(pg.superuserUrl, { max: 1 });
}, 120_000);

afterAll(async () => {
  await superuser.end();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('sign-up', () => {
  it('creates a workspace, returns an access token and sets a locked-down refresh cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/sign-up', payload: rahman });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');

    const cookie = res.cookies.find((c) => c.name === 'omnivo_rt');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/auth' });
    // refresh token কখনো JSON-এ না
    expect(res.body).not.toContain(cookie?.value);

    const me = meResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/auth/me',
          headers: bearer(sessionOf(res).accessToken),
        })
      ).json(),
    );
    expect(me.user.email).toBe(rahman.email);
    expect(me.tenant.slug).toBe(rahman.workspaceSlug);
    expect(me.roles).toEqual(['Owner']);
    expect(me.permissions).toEqual(['core.role.manage', 'core.user.invite', 'core.user.read']);
    expect(me.memberships).toHaveLength(1);
  });

  it('rejects a taken workspace address without creating the user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: { ...karim, workspaceSlug: rahman.workspaceSlug },
    });
    expect(res.statusCode).toBe(409);
    expect(apiErrorSchema.parse(res.json()).fieldErrors?.workspaceSlug).toBeDefined();

    const [row] = await superuser<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM users WHERE email = ${karim.email}`;
    expect(row?.n).toBe(0);
  });

  it('rejects an email that already has an account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: { ...karim, email: rahman.email },
    });
    expect(res.statusCode).toBe(409);
    expect(apiErrorSchema.parse(res.json()).fieldErrors?.email).toBeDefined();
  });

  it('returns field errors for invalid input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: { ...karim, email: 'not-an-email', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    const error = apiErrorSchema.parse(res.json());
    expect(Object.keys(error.fieldErrors ?? {}).sort()).toEqual(['email', 'password']);
  });

  it('never stores the password in plain text', async () => {
    const [row] = await superuser<{ password: string | null }[]>`
      SELECT a.password FROM accounts a JOIN users u ON u.id = a.user_id
      WHERE u.email = ${rahman.email} AND a.provider_id = 'credential'`;
    expect(row?.password).toBeTypeOf('string');
    expect(row?.password).not.toContain(rahman.password);
  });
});

describe('login', () => {
  it('signs in to the workspace named in the form', async () => {
    const res = await login({
      workspace: rahman.workspaceSlug,
      email: rahman.email,
      password: rahman.password,
    });
    expect(res.statusCode).toBe(200);
    expect(refreshCookieOf(res)).toBeTruthy();
  });

  it('rejects a wrong password with 401', async () => {
    const res = await login({
      workspace: rahman.workspaceSlug,
      email: rahman.email,
      password: 'wrong-password',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown workspace with 404', async () => {
    const res = await login({
      workspace: 'nobody-here',
      email: rahman.email,
      password: rahman.password,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a real user who is not a member of that workspace with 403', async () => {
    await signUp(app, karim);
    const res = await login({
      workspace: rahman.workspaceSlug,
      email: karim.email,
      password: karim.password,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('refresh token rotation', () => {
  it('issues a new refresh token on every refresh', async () => {
    const first = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const res = await refresh(first.refreshToken);
    expect(res.statusCode).toBe(200);
    expect(refreshCookieOf(res)).not.toBe(first.refreshToken);
  });

  it('treats reuse of an old refresh token as theft and ends the whole session', async () => {
    const first = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const second = refreshCookieOf(await refresh(first.refreshToken));

    // চোর পুরনো টোকেনটা চালাল
    const reuse = await refresh(first.refreshToken);
    expect(reuse.statusCode).toBe(401);
    expect(reuse.cookies.find((c) => c.name === 'omnivo_rt')?.value).toBe('');

    // আসল ইউজারের নতুন টোকেনও এখন অচল — পুরো family বাতিল
    expect((await refresh(second)).statusCode).toBe(401);
  });

  it('lets at most one of two parallel refreshes through, and never fails with a 5xx', async () => {
    const { refreshToken } = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const results = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);

    // হেরে যাওয়াটা reuse ধরে পুরো session মোছে; জয়ীটা তার আগে শেষ করলে 200, মাঝপথে থাকলে 401
    const statuses = results.map((r) => r.statusCode).sort();
    expect([
      [200, 401],
      [401, 401],
    ]).toContainEqual(statuses);

    // যে-ই জিতুক, session শেষ — 200 পাওয়া নতুন টোকেনও অচল
    for (const won of results.filter((r) => r.statusCode === 200)) {
      expect((await refresh(refreshCookieOf(won))).statusCode).toBe(401);
    }
  });

  it('reports a session deleted mid-refresh as ended, not as a database error', async () => {
    // সমান্তরাল refresh-এর race নির্ভরযোগ্যভাবে ঘটানো যায় না, তাই সরাসরি: নেই এমন session-এ টোকেন
    const [tenant] = await superuser<
      { id: string }[]
    >`SELECT id FROM tenants WHERE slug = ${rahman.workspaceSlug}`;
    if (!tenant) throw new Error('setup: tenant missing');

    await expect(
      app.get<Auth>(AUTH).issueTokens({
        sessionId: randomUUID(),
        sessionExpiresAt: new Date(Date.now() + 60_000),
        claims: {
          userId: randomUUID(),
          tenantId: tenant.id,
          membershipId: randomUUID(),
          roles: [],
        },
      }),
    ).rejects.toMatchObject({ name: 'AuthError', code: 'SESSION_ENDED' });
  });

  it('rejects a missing or made-up refresh token', async () => {
    expect((await app.inject({ method: 'POST', url: '/auth/refresh' })).statusCode).toBe(401);
    expect((await refresh('made-up-token')).statusCode).toBe(401);
  });
});

describe('logout', () => {
  it('revokes the session so the refresh token stops working', async () => {
    const { refreshToken } = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { omnivo_rt: refreshToken },
    });
    expect(res.statusCode).toBe(204);
    expect((await refresh(refreshToken)).statusCode).toBe(401);
  });
});

describe('tenant switcher', () => {
  it('moves a user who belongs to two workspaces into the other one', async () => {
    const both: SignUpInput = {
      companyName: 'Nabil Distribution',
      workspaceSlug: 'nabil-distribution',
      fullName: 'Nabil Hasan',
      email: 'nabil@example.com',
      password: 'Depot-route-2026',
    };
    const session = await signUp(app, both);

    // Nabil-কে Rahman Garments-এও সদস্য বানানো (ধাপ ৭-এর invite-এর বদলে সরাসরি SQL)
    await superuser.begin(async (sql) => {
      const [tenant] = await sql<
        { id: string }[]
      >`SELECT id FROM tenants WHERE slug = ${rahman.workspaceSlug}`;
      const [user] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${both.email}`;
      if (!tenant || !user) throw new Error('setup: tenant or user missing');
      await sql`INSERT INTO memberships (id, tenant_id, user_id) VALUES (gen_random_uuid(), ${tenant.id}, ${user.id})`;
    });

    const before = meResponseSchema.parse(
      (
        await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(session.accessToken) })
      ).json(),
    );
    expect(before.memberships.map((m) => m.slug)).toEqual([
      both.workspaceSlug,
      rahman.workspaceSlug,
    ]);
    const target = before.memberships.find((m) => m.slug === rahman.workspaceSlug);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/switch-tenant',
      headers: bearer(session.accessToken),
      cookies: { omnivo_rt: session.refreshToken },
      payload: { tenantId: target?.tenantId },
    });
    expect(res.statusCode).toBe(200);

    const after = meResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/auth/me',
          headers: bearer(sessionOf(res).accessToken),
        })
      ).json(),
    );
    expect(after.tenant.slug).toBe(rahman.workspaceSlug);
    // রোল ছাড়া membership — তাই কোনো permission নেই
    expect(after.roles).toEqual([]);
    expect(after.permissions).toEqual([]);
  });

  it('refuses to switch into a workspace the user does not belong to, and keeps the session', async () => {
    const session = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const [karimTenant] = await superuser<
      { id: string }[]
    >`SELECT id FROM tenants WHERE slug = ${karim.workspaceSlug}`;

    const res = await app.inject({
      method: 'POST',
      url: '/auth/switch-tenant',
      headers: bearer(session.accessToken),
      cookies: { omnivo_rt: session.refreshToken },
      payload: { tenantId: karimTenant?.id },
    });
    expect(res.statusCode).toBe(403);
    // refresh token খরচ হয়নি
    expect((await refresh(session.refreshToken)).statusCode).toBe(200);
  });
});

describe('permissions', () => {
  it('asks for a sign-in (401) before it checks permissions (403)', async () => {
    // AuthGuard আগে না চললে এখানে 403 আসত (বা principal ছাড়া PermissionGuard crash করত)
    const res = await app.inject({ method: 'GET', url: '/members' });
    expect(res.statusCode).toBe(401);
  });

  it('lets the owner list members and blocks a member without the permission', async () => {
    const owner = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const allowed = await app.inject({
      method: 'GET',
      url: '/members',
      headers: bearer(owner.accessToken),
    });
    expect(allowed.statusCode).toBe(200);

    // Nabil আগের টেস্টে Rahman Garments-এ রোল ছাড়া যোগ হয়েছে
    const nabil = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: 'nabil@example.com',
        password: 'Depot-route-2026',
      }),
    );
    const denied = await app.inject({
      method: 'GET',
      url: '/members',
      headers: bearer(nabil.accessToken),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('serves permissions from the Redis cache until they are invalidated', async () => {
    const owner = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: rahman.email,
        password: rahman.password,
      }),
    );
    const call = () =>
      app.inject({ method: 'GET', url: '/members', headers: bearer(owner.accessToken) });
    expect((await call()).statusCode).toBe(200);

    // Owner রোল থেকে core.user.read সরানো — DB বদলেছে, cache এখনো পুরনো
    const [ids] = await superuser<{ tenant_id: string; user_id: string }[]>`
      SELECT t.id AS tenant_id, u.id AS user_id FROM tenants t, users u
      WHERE t.slug = ${rahman.workspaceSlug} AND u.email = ${rahman.email}`;
    if (!ids) throw new Error('setup: tenant or user missing');
    await superuser`
      DELETE FROM role_permissions
      WHERE tenant_id = ${ids.tenant_id}
        AND permission_id = (SELECT id FROM permissions WHERE key = 'core.user.read')`;
    expect((await call()).statusCode).toBe(200);

    await app.get(PermissionService).invalidate(ids.tenant_id, ids.user_id);
    expect((await call()).statusCode).toBe(403);
  });
});
