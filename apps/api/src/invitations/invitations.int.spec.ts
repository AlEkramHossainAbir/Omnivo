import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type Invitation,
  invitationListSchema,
  invitationPreviewSchema,
  invitationSchema,
  memberPageSchema,
  meResponseSchema,
  notificationPageSchema,
  problemSchema,
  type Role,
  roleSchema,
  settingsSchema,
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
  startMail,
  startPostgres,
  startRedis,
  type TestMail,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, refreshCookieOf, type SignedIn, sessionOf, signUp } from '../testing/http.js';
import { invitationTokenOf, lastMailTo } from '../testing/mailpit.js';
import { hashInvitationToken } from './invitation-token.js';

let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
let accountant: Role;
let merchandiser: Role;

function startWorker(mailUrl?: string): Promise<INestApplicationContext> {
  return createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      ...(mailUrl !== undefined && { mailUrl }),
    }),
  );
}

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  // The API does not send email any more — the worker does, from the outbox
  worker = await startWorker(mail.smtpUrl);
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  // বিদ্যমান অ্যাকাউন্ট: Karim-এর নিজের workspace আছে, পরে Rahman Garments-এ invite হবে
  await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });

  accountant = roleSchema.parse(
    (await send('POST', '/roles', { name: 'Accountant', description: '' })).json(),
  );
  merchandiser = roleSchema.parse(
    (await send('POST', '/roles', { name: 'Merchandiser', description: '' })).json(),
  );
  await send('PUT', '/permission-matrix', {
    roles: [{ id: accountant.id, version: accountant.version, permissions: ['core.user.read'] }],
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as: SignedIn | null = owner,
) {
  return app.inject({
    method,
    url,
    ...(as && { headers: bearer(as.accessToken) }),
    ...(payload && { payload }),
  });
}

async function invite(email: string, roleIds: string[]) {
  const res = await send('POST', '/invitations', { email, roleIds });
  expect(res.statusCode).toBe(201);
  return invitationSchema.parse(res.json());
}

async function openInvitation(email: string): Promise<Invitation> {
  const { items } = invitationListSchema.parse((await send('GET', '/invitations')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`no open invitation for ${email}`);
  return found;
}

// The newest link sent to this address, waiting for the worker to send it
async function tokenSentTo(address: string, notToken?: string): Promise<string> {
  return eventually(async () => {
    const token = invitationTokenOf(await lastMailTo(mail.apiUrl, address));
    if (token === notToken) throw new Error('still the old email');
    return token;
  });
}

function lookup(token: string) {
  return send('POST', '/invitations/lookup', { token }, null);
}

function accept(payload: object) {
  return send('POST', '/invitations/accept', payload, null);
}

describe('inviting', () => {
  it('answers at once with "sending", then the worker emails a one-time link', async () => {
    const invitation = await invite(' Tanvir@RahmanGarments.com ', [accountant.id]);
    expect(invitation).toMatchObject({
      email: 'tanvir@rahmangarments.com',
      roles: [{ id: accountant.id, name: 'Accountant' }],
      invitedBy: { fullName: 'Farhana Rahman' },
      delivery: 'sending',
    });

    const sent = await eventually(() => lastMailTo(mail.apiUrl, 'tanvir@rahmangarments.com'));
    expect(sent.subject).toBe('Farhana Rahman invited you to Rahman Garments Ltd. on Omnivo');
    await eventually(async () => {
      expect((await openInvitation('tanvir@rahmangarments.com')).delivery).toBe('sent');
    });

    // DB-তে token নিজে নেই, শুধু তার hash — and the outbox row holds ids only, never the token
    const token = invitationTokenOf(sent);
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    const [row] = await superuser<{ token_hash: string }[]>`
      SELECT token_hash FROM invitations WHERE email = 'tanvir@rahmangarments.com'`;
    const outbox = await superuser<{ payload: unknown }[]>`
      SELECT payload FROM outbox_events WHERE type = 'invitation.issued'`;
    await superuser.end();
    expect(row?.token_hash).toBe(hashInvitationToken(token));
    expect(JSON.stringify(outbox)).not.toContain(token);
    expect(JSON.stringify(outbox)).not.toContain('tanvir@');
  });

  it('escapes names in the HTML mail, so a company name cannot become a link', async () => {
    await send('PUT', '/settings', {
      ...(await currentSettings()),
      companyName: '<a href="https://evil.example">Rahman</a>',
    });
    await invite('rupa@rahmangarments.com', [merchandiser.id]);
    const sent = await eventually(() => lastMailTo(mail.apiUrl, 'rupa@rahmangarments.com'));
    expect(sent.html).not.toContain('<a href="https://evil.example">');
    expect(sent.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
    await send('PUT', '/settings', {
      ...(await currentSettings()),
      companyName: 'Rahman Garments Ltd.',
    });
  });

  it('refuses a second open invitation, and someone already in the workspace', async () => {
    const twice = await send('POST', '/invitations', {
      email: 'tanvir@rahmangarments.com',
      roleIds: [merchandiser.id],
    });
    expect(twice.statusCode).toBe(409);
    expect(problemSchema.parse(twice.json()).fieldErrors).toEqual({ email: ['already_invited'] });

    const member = await send('POST', '/invitations', {
      email: 'farhana@rahmangarments.com',
      roleIds: [merchandiser.id],
    });
    expect(member.statusCode).toBe(409);
    expect(problemSchema.parse(member.json()).fieldErrors).toEqual({ email: ['already_member'] });

    const noRole = await send('POST', '/invitations', {
      email: 'shafiq@rahmangarments.com',
      roleIds: [],
    });
    expect(problemSchema.parse(noRole.json()).fieldErrors).toEqual({ roleIds: ['role_required'] });
  });
});

describe('accepting', () => {
  it('shows who invited whom, then creates the account and signs in', async () => {
    const token = await tokenSentTo('tanvir@rahmangarments.com');
    const preview = invitationPreviewSchema.parse((await lookup(token)).json());
    expect(preview).toMatchObject({
      workspace: { name: 'Rahman Garments Ltd.', slug: 'rahman-garments' },
      email: 'tanvir@rahmangarments.com',
      invitedBy: 'Farhana Rahman',
      accountExists: false,
    });

    const res = await accept({
      account: 'new',
      token,
      fullName: 'Tanvir Hossain',
      password: 'Konabari-cut-2026',
    });
    expect(res.statusCode).toBe(200);
    // লগইনের মতোই: refresh token শুধু cookie-তে
    expect(refreshCookieOf(res)).toBeTruthy();
    const me = meResponseSchema.parse(
      (await send('GET', '/auth/me', undefined, sessionOf(res))).json(),
    );
    expect(me).toMatchObject({
      user: { fullName: 'Tanvir Hossain', email: 'tanvir@rahmangarments.com' },
      tenant: { slug: 'rahman-garments' },
      roles: ['Accountant'],
      permissions: ['core.user.read'],
    });

    const { items } = invitationListSchema.parse((await send('GET', '/invitations')).json());
    expect(items.map((item) => item.email)).not.toContain('tanvir@rahmangarments.com');
    const audit = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=member')).json(),
    );
    expect(audit.items[0]).toMatchObject({
      action: 'member.joined',
      actor: { fullName: 'Tanvir Hossain' },
      changes: { roles: { from: null, to: 'Accountant' } },
    });
  });

  it('tells the inviter in the bell', async () => {
    const page = await eventually(async () => {
      const list = notificationPageSchema.parse((await send('GET', '/notifications')).json());
      if (!list.items.some((item) => item.type === 'member.joined')) throw new Error('not yet');
      return list;
    });
    expect(page.items.find((item) => item.type === 'member.joined')).toMatchObject({
      params: { name: 'Tanvir Hossain' },
      readAt: null,
    });
  });

  it('works only once', async () => {
    const token = await tokenSentTo('tanvir@rahmangarments.com');
    const res = await lookup(token);
    expect(res.statusCode).toBe(404);
    expect(problemSchema.parse(res.json()).code).toBe('invitation_invalid');
  });

  it('adds an existing account only after checking its password', async () => {
    await invite('karim@karimpharma.com', [merchandiser.id]);
    const token = await tokenSentTo('karim@karimpharma.com');
    expect(invitationPreviewSchema.parse((await lookup(token)).json()).accountExists).toBe(true);

    const wrong = await accept({ account: 'existing', token, password: 'not-his-password' });
    expect(wrong.statusCode).toBe(401);
    expect(problemSchema.parse(wrong.json()).code).toBe('invalid_credentials');
    // "নতুন অ্যাকাউন্ট" দিয়ে অন্যের ইমেইল দখল করা যায় না
    const hijack = await accept({
      account: 'new',
      token,
      fullName: 'Someone Else',
      password: 'Takeover-2026',
    });
    expect(hijack.statusCode).toBe(409);
    expect(problemSchema.parse(hijack.json()).code).toBe('email_taken');

    const res = await accept({ account: 'existing', token, password: 'Batch-expiry-2026' });
    expect(res.statusCode).toBe(200);
    const me = meResponseSchema.parse(
      (await send('GET', '/auth/me', undefined, sessionOf(res))).json(),
    );
    expect(me.tenant.slug).toBe('rahman-garments');
    expect(me.memberships.map((membership) => membership.slug)).toEqual([
      'karim-pharma',
      'rahman-garments',
    ]);
  });

  it('brings a removed member back on the same membership, with only the new roles', async () => {
    const before = memberPageSchema
      .parse((await send('GET', '/members')).json())
      .items.find((member) => member.email === 'tanvir@rahmangarments.com');
    if (!before) throw new Error('setup: Tanvir missing');
    const removed = await send(
      'DELETE',
      `/members/${before.membershipId}?version=${String(before.version)}`,
    );
    expect(removed.statusCode).toBe(204);

    const used = await tokenSentTo('tanvir@rahmangarments.com');
    await invite('tanvir@rahmangarments.com', [merchandiser.id]);
    const token = await tokenSentTo('tanvir@rahmangarments.com', used);
    const res = await accept({ account: 'existing', token, password: 'Konabari-cut-2026' });
    expect(res.statusCode).toBe(200);

    const after = memberPageSchema
      .parse((await send('GET', '/members')).json())
      .items.find((member) => member.email === 'tanvir@rahmangarments.com');
    expect(after?.membershipId).toBe(before.membershipId);
    expect(after?.roles.map((role) => role.name)).toEqual(['Merchandiser']);
  });
});

describe('resending and revoking', () => {
  it('kills the old link at once on resend, then sends a fresh one', async () => {
    const first = await tokenSentTo('rupa@rahmangarments.com');
    const rupa = await openInvitation('rupa@rahmangarments.com');

    const res = await send('POST', `/invitations/${rupa.id}/resend`, { version: rupa.version });
    expect(res.statusCode).toBe(200);
    expect(invitationSchema.parse(res.json())).toMatchObject({
      version: rupa.version + 1,
      delivery: 'sending',
    });
    // Before the new email even exists: the old link is already dead (token_hash is NULL)
    expect((await lookup(first)).statusCode).toBe(404);

    const second = await tokenSentTo('rupa@rahmangarments.com', first);
    expect((await lookup(second)).statusCode).toBe(200);
  });

  it('closes the link on revoke', async () => {
    await eventually(async () => {
      expect((await openInvitation('rupa@rahmangarments.com')).delivery).toBe('sent');
    });
    const token = invitationTokenOf(await lastMailTo(mail.apiUrl, 'rupa@rahmangarments.com'));
    const rupa = await openInvitation('rupa@rahmangarments.com');
    const res = await send('DELETE', `/invitations/${rupa.id}?version=${String(rupa.version)}`);
    expect(res.statusCode).toBe(204);
    expect((await lookup(token)).statusCode).toBe(404);
    expect(
      invitationListSchema.parse((await send('GET', '/invitations')).json()).items,
    ).toHaveLength(0);
  });

  it('replaces an expired invitation instead of blocking a new one', async () => {
    await invite('mahbub@rahmangarments.com', [merchandiser.id]);
    const token = await tokenSentTo('mahbub@rahmangarments.com');
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    await superuser`
      UPDATE invitations SET expires_at = now() - interval '1 day'
      WHERE email = 'mahbub@rahmangarments.com'`;
    await superuser.end();
    expect((await lookup(token)).statusCode).toBe(404);

    const again = await invite('mahbub@rahmangarments.com', [merchandiser.id]);
    expect(again.delivery).toBe('sending');
  });
});

describe('when the mail server is down', () => {
  it('still creates the invitation, then says "failed" and tells the sender', async () => {
    // The same queues, but now served by a worker whose SMTP address is dead
    await worker.close();
    worker = await startWorker();

    const invitation = await invite('sharmin@rahmangarments.com', [merchandiser.id]);
    expect(invitation.delivery).toBe('sending');
    await eventually(async () => {
      expect((await openInvitation('sharmin@rahmangarments.com')).delivery).toBe('failed');
    });
    const { items } = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(items[0]).toMatchObject({
      type: 'invitation.failed',
      params: { email: 'sharmin@rahmangarments.com' },
    });
  });

  it('sends it on Resend once the mail server is back', async () => {
    await worker.close();
    worker = await startWorker(mail.smtpUrl);

    const failed = await openInvitation('sharmin@rahmangarments.com');
    const res = await send('POST', `/invitations/${failed.id}/resend`, {
      version: failed.version,
    });
    expect(invitationSchema.parse(res.json()).delivery).toBe('sending');
    await tokenSentTo('sharmin@rahmangarments.com');
    await eventually(async () => {
      expect((await openInvitation('sharmin@rahmangarments.com')).delivery).toBe('sent');
    });
  });
});

// PUT /settings-এর body = GET-এর উত্তর (version সহ); বাড়তি logo ঘর চুক্তির schema নিজেই ফেলে দেয়
async function currentSettings() {
  return settingsSchema.parse((await send('GET', '/settings')).json());
}
