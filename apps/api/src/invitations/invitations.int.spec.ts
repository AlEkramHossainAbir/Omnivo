import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  invitationListSchema,
  invitationPreviewSchema,
  invitationSchema,
  memberPageSchema,
  meResponseSchema,
  problemSchema,
  type Role,
  roleSchema,
  settingsSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startMail,
  startPostgres,
  startRedis,
  type TestMail,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, refreshCookieOf, type SignedIn, sessionOf, signUp } from '../testing/http.js';
import { hashInvitationToken } from './invitation-token.js';

let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let owner: SignedIn;
let accountant: Role;
let merchandiser: Role;

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, mailUrl: mail.smtpUrl }),
  );
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

// Mailpit-এর HTTP API — বাইরের ডেটা, তাই schema দিয়ে পড়া (cast না)
const mailboxSchema = z.object({
  messages: z.array(
    z.object({
      ID: z.string(),
      Subject: z.string(),
      To: z.array(z.object({ Address: z.string() })),
    }),
  ),
});
const messageSchema = z.object({ Text: z.string(), HTML: z.string() });

// এই ঠিকানায় সবশেষ চিঠি আর তার লিংকের token (Mailpit নতুন আগে দেয়)
async function lastMailTo(address: string) {
  const mailbox = mailboxSchema.parse(await (await fetch(`${mail.apiUrl}/api/v1/messages`)).json());
  const found = mailbox.messages.find((message) => message.To.some((to) => to.Address === address));
  if (!found) throw new Error(`no mail to ${address}`);
  const message = messageSchema.parse(
    await (await fetch(`${mail.apiUrl}/api/v1/message/${found.ID}`)).json(),
  );
  const token = /http:\/\/localhost:5173\/invite#([\w-]+)/.exec(message.Text)?.[1];
  if (!token) throw new Error('no invitation link in the mail');
  return { subject: found.Subject, html: message.HTML, token };
}

function lookup(token: string) {
  return send('POST', '/invitations/lookup', { token }, null);
}

function accept(payload: object) {
  return send('POST', '/invitations/accept', payload, null);
}

describe('inviting', () => {
  it('emails a one-time link and lists the invitation as sent', async () => {
    const invitation = await invite(' Tanvir@RahmanGarments.com ', [accountant.id]);
    expect(invitation).toMatchObject({
      email: 'tanvir@rahmangarments.com',
      roles: [{ id: accountant.id, name: 'Accountant' }],
      invitedBy: { fullName: 'Farhana Rahman' },
    });
    expect(invitation.sentAt).not.toBeNull();

    const sent = await lastMailTo('tanvir@rahmangarments.com');
    expect(sent.subject).toBe('Farhana Rahman invited you to Rahman Garments Ltd. on Omnivo');

    // DB-তে token নিজে নেই, শুধু তার hash
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    const [row] = await superuser<{ token_hash: string }[]>`
      SELECT token_hash FROM invitations WHERE email = 'tanvir@rahmangarments.com'`;
    await superuser.end();
    expect(row?.token_hash).toBe(hashInvitationToken(sent.token));
    expect(row?.token_hash).not.toContain(sent.token);

    const { items } = invitationListSchema.parse((await send('GET', '/invitations')).json());
    expect(items.map((item) => item.email)).toEqual(['tanvir@rahmangarments.com']);
  });

  it('escapes names in the HTML mail, so a company name cannot become a link', async () => {
    await send('PUT', '/settings', {
      ...(await currentSettings()),
      companyName: '<a href="https://evil.example">Rahman</a>',
    });
    await invite('rupa@rahmangarments.com', [merchandiser.id]);
    const sent = await lastMailTo('rupa@rahmangarments.com');
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
    const { token } = await lastMailTo('tanvir@rahmangarments.com');
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

  it('works only once', async () => {
    const { token } = await lastMailTo('tanvir@rahmangarments.com');
    const res = await lookup(token);
    expect(res.statusCode).toBe(404);
    expect(problemSchema.parse(res.json()).code).toBe('invitation_invalid');
  });

  it('adds an existing account only after checking its password', async () => {
    await invite('karim@karimpharma.com', [merchandiser.id]);
    const { token } = await lastMailTo('karim@karimpharma.com');
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

    await invite('tanvir@rahmangarments.com', [merchandiser.id]);
    const { token } = await lastMailTo('tanvir@rahmangarments.com');
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
  it('sends a fresh link on resend; the old one stops working', async () => {
    const first = await lastMailTo('rupa@rahmangarments.com');
    const { items } = invitationListSchema.parse((await send('GET', '/invitations')).json());
    const rupa = items.find((item) => item.email === 'rupa@rahmangarments.com');
    if (!rupa) throw new Error('setup: Rupa missing');

    const res = await send('POST', `/invitations/${rupa.id}/resend`, { version: rupa.version });
    expect(res.statusCode).toBe(200);
    expect(invitationSchema.parse(res.json()).version).toBe(rupa.version + 1);

    const second = await lastMailTo('rupa@rahmangarments.com');
    expect(second.token).not.toBe(first.token);
    expect((await lookup(first.token)).statusCode).toBe(404);
    expect((await lookup(second.token)).statusCode).toBe(200);
  });

  it('closes the link on revoke', async () => {
    const { token } = await lastMailTo('rupa@rahmangarments.com');
    const { items } = invitationListSchema.parse((await send('GET', '/invitations')).json());
    const rupa = items.find((item) => item.email === 'rupa@rahmangarments.com');
    if (!rupa) throw new Error('setup: Rupa missing');
    const res = await send('DELETE', `/invitations/${rupa.id}?version=${String(rupa.version)}`);
    expect(res.statusCode).toBe(204);
    expect((await lookup(token)).statusCode).toBe(404);
    expect(
      invitationListSchema.parse((await send('GET', '/invitations')).json()).items,
    ).toHaveLength(0);
  });

  it('replaces an expired invitation instead of blocking a new one', async () => {
    await invite('mahbub@rahmangarments.com', [merchandiser.id]);
    const { token } = await lastMailTo('mahbub@rahmangarments.com');
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    await superuser`
      UPDATE invitations SET expires_at = now() - interval '1 day'
      WHERE email = 'mahbub@rahmangarments.com'`;
    await superuser.end();
    expect((await lookup(token)).statusCode).toBe(404);

    const again = await invite('mahbub@rahmangarments.com', [merchandiser.id]);
    expect(again.sentAt).not.toBeNull();
  });
});

describe('when the mail server is down', () => {
  it('still creates the invitation, and says it was not sent', async () => {
    // একই DB আর Redis, কিন্তু অচল SMTP (testConfig-এর ডিফল্ট)
    const offline = await createTestApp(
      testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }),
    );
    try {
      const res = await offline.inject({
        method: 'POST',
        url: '/invitations',
        headers: bearer(owner.accessToken),
        payload: { email: 'sharmin@rahmangarments.com', roleIds: [merchandiser.id] },
      });
      expect(res.statusCode).toBe(201);
      expect(invitationSchema.parse(res.json()).sentAt).toBeNull();
    } finally {
      await offline.close();
    }
  });
});

// PUT /settings-এর body = GET-এর উত্তর (version সহ); বাড়তি logo ঘর চুক্তির schema নিজেই ফেলে দেয়
async function currentSettings() {
  return settingsSchema.parse((await send('GET', '/settings')).json());
}
