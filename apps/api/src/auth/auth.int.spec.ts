import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Auth } from '@omnivo/auth';
import {
  meResponseSchema,
  PERMISSION_KEYS,
  problemSchema,
  signUpResultSchema,
  type SignUpInput,
} from '@omnivo/contracts';
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
import {
  bearer,
  refreshCookieOf,
  sessionOf,
  signUp,
  verificationTokenFor,
  verifyEmail,
} from '../testing/http.js';

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

function login(input: { workspace?: string; email: string; password: string }) {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { ...input, keepSignedIn: true },
  });
}

// Step 3b: where a sign-in landed, now that the server picks the workspace
async function workspaceOf(res: Awaited<ReturnType<typeof login>>): Promise<string> {
  const me = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: bearer(sessionOf(res).accessToken),
  });
  return meResponseSchema.parse(me.json()).tenant.slug;
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
  it('creates a workspace but no session; the email’s link starts one, with a locked-down cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/sign-up', payload: rahman });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(signUpResultSchema.parse(res.json())).toEqual({
      status: 'verify_email',
      email: rahman.email,
    });
    // No token until the address is confirmed
    expect(res.cookies.find((c) => c.name === 'omnivo_rt')).toBeUndefined();
    expect(res.body).not.toContain('accessToken');

    const verified = await verifyEmail(app, await verificationTokenFor(app, rahman.email));
    expect(verified.statusCode).toBe(200);
    expect(verified.headers['cache-control']).toBe('no-store');
    const cookie = verified.cookies.find((c) => c.name === 'omnivo_rt');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/auth' });
    // refresh token কখনো JSON-এ না
    expect(verified.body).not.toContain(cookie?.value);

    const me = meResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/auth/me',
          headers: bearer(sessionOf(verified).accessToken),
        })
      ).json(),
    );
    expect(me.user.email).toBe(rahman.email);
    expect(me.tenant.slug).toBe(rahman.workspaceSlug);
    expect(me.roles).toEqual(['Owner']);
    // Owner = catalog-এর সব permission; তালিকা হাতে লিখলে প্রতিটা নতুন permission-এ এই টেস্ট ভাঙত
    expect(me.permissions).toEqual([...PERMISSION_KEYS].sort());
    expect(me.memberships).toHaveLength(1);
  });

  it('rejects a taken workspace address without creating the user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: { ...karim, workspaceSlug: rahman.workspaceSlug },
    });
    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const problem = problemSchema.parse(res.json());
    expect(problem.code).toBe('slug_taken');
    expect(problem.fieldErrors).toEqual({ workspaceSlug: ['slug_taken'] });
    expect(problem.requestId).toBe(res.headers['x-request-id']);

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
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({ email: ['email_taken'] });
  });

  it('returns field errors for invalid input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: { ...karim, email: 'not-an-email', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    const problem = problemSchema.parse(res.json());
    expect(problem.code).toBe('invalid_input');
    expect(problem.fieldErrors).toEqual({
      email: ['email_invalid'],
      password: ['password_too_short'],
    });
  });

  it('never stores the password in plain text', async () => {
    const [row] = await superuser<{ password: string | null }[]>`
      SELECT a.password FROM accounts a JOIN users u ON u.id = a.user_id
      WHERE u.email = ${rahman.email} AND a.provider_id = 'credential'`;
    expect(row?.password).toBeTypeOf('string');
    expect(row?.password).not.toContain(rahman.password);
  });
});

describe('the email check', () => {
  // One owner per test: the link and the "send again" limit are per person
  function owner(slug: string): SignUpInput {
    return {
      companyName: `${slug} Ltd.`,
      workspaceSlug: slug,
      fullName: 'Nadia Islam',
      email: `nadia@${slug}.com`,
      password: 'Depot-Sylhet-2026',
    };
  }

  async function signUpOnly(input: SignUpInput): Promise<void> {
    const res = await app.inject({ method: 'POST', url: '/auth/sign-up', payload: input });
    expect(res.statusCode).toBe(201);
  }

  function codeOf(res: Awaited<ReturnType<typeof login>>): string {
    return problemSchema.parse(res.json()).code;
  }

  it('refuses a sign-in until the address is confirmed; that sign-in’s link lets the person in', async () => {
    const nadia = owner('bogura-agro');
    await signUpOnly(nadia);

    const refused = await login({ email: nadia.email, password: nadia.password });
    expect(refused.statusCode).toBe(403);
    expect(codeOf(refused)).toBe('email_not_verified');
    expect(refused.cookies.find((c) => c.name === 'omnivo_rt')).toBeUndefined();
    // The refused sign-in's session took the sign-up's place, which never had a token and is gone
    const [row] = await superuser<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE u.email = ${nadia.email}`;
    expect(row?.n).toBe(1);

    const verified = await verifyEmail(app, await verificationTokenFor(app, nadia.email));
    expect(verified.statusCode).toBe(200);
    expect(await workspaceOf(verified)).toBe(nadia.workspaceSlug);
    // From now on the password is enough
    const signedIn = await login({ email: nadia.email, password: nadia.password });
    expect(signedIn.statusCode).toBe(200);
  });

  it('opens a link once', async () => {
    const nadia = owner('khulna-fish');
    await signUpOnly(nadia);
    const token = await verificationTokenFor(app, nadia.email);

    expect((await verifyEmail(app, token)).statusCode).toBe(200);
    const again = await verifyEmail(app, token);
    expect(again.statusCode).toBe(400);
    expect(codeOf(again)).toBe('verification_link_invalid');
  });

  it('gives an unknown link and an ended one the same answer', async () => {
    const unknown = await verifyEmail(app, 'not-a-real-token');
    expect(unknown.statusCode).toBe(400);
    expect(codeOf(unknown)).toBe('verification_link_invalid');

    const nadia = owner('rangpur-tea');
    await signUpOnly(nadia);
    const token = await verificationTokenFor(app, nadia.email);
    await superuser`
      UPDATE email_verifications SET expires_at = now() - interval '1 minute'
      WHERE user_id = (SELECT id FROM users WHERE email = ${nadia.email})`;
    const ended = await verifyEmail(app, token);
    expect(ended.statusCode).toBe(400);
    expect(codeOf(ended)).toBe('verification_link_invalid');
  });

  it('answers "send the link again" with 204 for any address, and stops the old link', async () => {
    const nadia = owner('cumilla-rice');
    await signUpOnly(nadia);
    const oldToken = await verificationTokenFor(app, nadia.email);

    for (const email of ['nobody@nowhere.com', rahman.email, nadia.email]) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/resend-verification',
        payload: { email },
      });
      expect(res.statusCode).toBe(204);
    }
    // The new link is the worker's to make; the old one stopped at once
    const [row] = await superuser<{ tokenHash: string | null; sentAt: Date | null }[]>`
      SELECT token_hash AS "tokenHash", sent_at AS "sentAt" FROM email_verifications
      WHERE user_id = (SELECT id FROM users WHERE email = ${nadia.email})`;
    expect(row).toEqual({ tokenHash: null, sentAt: null });
    expect((await verifyEmail(app, oldToken)).statusCode).toBe(400);
  });
});

describe('login', () => {
  it('signs in with an email and a password only, into the only workspace', async () => {
    const res = await login({ email: rahman.email, password: rahman.password });
    expect(res.statusCode).toBe(200);
    expect(refreshCookieOf(res)).toBeTruthy();
    expect(await workspaceOf(res)).toBe(rahman.workspaceSlug);
  });

  it('rejects a wrong password with 401', async () => {
    const res = await login({ email: rahman.email, password: 'wrong-password' });
    expect(res.statusCode).toBe(401);
    expect(problemSchema.parse(res.json()).code).toBe('invalid_credentials');
  });

  it('ignores a hint for a workspace that does not exist', async () => {
    const res = await login({
      workspace: 'nobody-here',
      email: rahman.email,
      password: rahman.password,
    });
    expect(res.statusCode).toBe(200);
    expect(await workspaceOf(res)).toBe(rahman.workspaceSlug);
  });

  it('ignores a hint for a workspace the person is not in', async () => {
    await signUp(app, karim);
    const res = await login({
      workspace: rahman.workspaceSlug,
      email: karim.email,
      password: karim.password,
    });
    expect(res.statusCode).toBe(200);
    expect(await workspaceOf(res)).toBe(karim.workspaceSlug);
  });

  it('refuses an account in no workspace with 403, and ends its session', async () => {
    const alone: SignUpInput = {
      companyName: 'Sylhet Pharmacy',
      workspaceSlug: 'sylhet-pharmacy',
      fullName: 'Ruma Begum',
      email: 'ruma@sylhetpharmacy.com',
      password: 'Zindabazar-2026',
    };
    await signUp(app, alone);
    // Removed from the only workspace (step 7 does it with a soft delete)
    await superuser`
      UPDATE memberships SET deleted_at = now()
      WHERE user_id = (SELECT id FROM users WHERE email = ${alone.email})`;

    const res = await login({ email: alone.email, password: alone.password });
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json()).code).toBe('not_a_member');
    expect(res.cookies.find((c) => c.name === 'omnivo_rt')).toBeUndefined();
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

  // Step 3b: Nabil is in two workspaces, and the first test of this block switched him into
  // Rahman Garments
  it('signs in to the hinted workspace, else to the one used last', async () => {
    const nabil = { email: 'nabil@example.com', password: 'Depot-route-2026' };

    expect(await workspaceOf(await login(nabil))).toBe(rahman.workspaceSlug);

    // A hint wins, and a sign-in by hint becomes the last one too
    const hinted = await login({ ...nabil, workspace: 'nabil-distribution' });
    expect(await workspaceOf(hinted)).toBe('nabil-distribution');
    expect(await workspaceOf(await login(nabil))).toBe('nabil-distribution');
  });
});

describe('permissions', () => {
  it('asks for a sign-in (401) before it checks permissions (403)', async () => {
    // AuthGuard আগে না চললে এখানে 403 আসত (বা principal ছাড়া PermissionGuard crash করত)
    const res = await app.inject({ method: 'GET', url: '/members' });
    expect(res.statusCode).toBe(401);
    expect(problemSchema.parse(res.json()).code).toBe('sign_in_required');
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
    expect(problemSchema.parse(denied.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'core.user.read' },
    });
  });

  it('serves permissions from the Redis cache until they are invalidated', async () => {
    const nabil = sessionOf(
      await login({
        workspace: rahman.workspaceSlug,
        email: 'nabil@example.com',
        password: 'Depot-route-2026',
      }),
    );
    const call = () =>
      app.inject({ method: 'GET', url: '/members', headers: bearer(nabil.accessToken) });
    expect((await call()).statusCode).toBe(403);

    // Nabil-কে core.user.read-ওয়ালা একটা রোল — DB বদলেছে, cache এখনো পুরনো ("কিছুই না")
    const [ids] = await superuser<{ tenant_id: string; user_id: string; membership_id: string }[]>`
      SELECT m.tenant_id, m.user_id, m.id AS membership_id
      FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN users u ON u.id = m.user_id
      WHERE t.slug = ${rahman.workspaceSlug} AND u.email = 'nabil@example.com'`;
    if (!ids) throw new Error('setup: membership missing');
    await superuser.begin(async (sql) => {
      const [role] = await sql<{ id: string }[]>`
        INSERT INTO roles (id, tenant_id, name) VALUES (gen_random_uuid(), ${ids.tenant_id}, 'Depot supervisor')
        RETURNING id`;
      if (!role) throw new Error('setup: role insert failed');
      await sql`
        INSERT INTO role_permissions (id, tenant_id, role_id, permission_id)
        SELECT gen_random_uuid(), ${ids.tenant_id}, ${role.id}, id FROM permissions WHERE key = 'core.user.read'`;
      await sql`
        INSERT INTO membership_roles (id, tenant_id, membership_id, role_id)
        VALUES (gen_random_uuid(), ${ids.tenant_id}, ${ids.membership_id}, ${role.id})`;
    });
    expect((await call()).statusCode).toBe(403);

    await app.get(PermissionService).invalidate(ids.tenant_id, [ids.user_id]);
    expect((await call()).statusCode).toBe(200);
  });
});
