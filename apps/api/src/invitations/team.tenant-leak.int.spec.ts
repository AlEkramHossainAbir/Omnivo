import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  invitationListSchema,
  memberPageSchema,
  problemSchema,
  roleListSchema,
  roleSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import { hashInvitationToken } from './invitation-token.js';

// ধাপ ৭-এর প্রতিটা নতুন endpoint-এ: টেন্যান্ট A-র টোকেন নিয়ে B-র id। উত্তর 404 (বা ইনপুটের 400) —
// কখনো 403 না, কারণ 403 মানে "আছে, কিন্তু তোমার না", সেটাও একটা ফাঁস
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let tenantA: SignedIn;
let tenantB: SignedIn;
let memberOfB: { id: string; version: number };
let roleOfB: { id: string; version: number };
let invitationOfB: { id: string; version: number };

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  as: SignedIn,
  payload?: object,
) {
  return app.inject({ method, url, headers: bearer(as.accessToken), ...(payload && { payload }) });
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  // অচল SMTP (ডিফল্ট): invitation তৈরি হয়, ইমেইল যায় না — এখানে লিংক লাগে না
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  tenantA = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  tenantB = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });

  const role = roleSchema.parse(
    (await send('POST', '/roles', tenantB, { name: 'Depot manager', description: '' })).json(),
  );
  roleOfB = { id: role.id, version: role.version };
  await send('POST', '/invitations', tenantB, {
    email: 'rupa@karimpharma.com',
    roleIds: [role.id],
  });
  const [invitation] = invitationListSchema.parse(
    (await send('GET', '/invitations', tenantB)).json(),
  ).items;
  if (!invitation) throw new Error('setup: invitation missing');
  invitationOfB = { id: invitation.id, version: invitation.version };

  const [bMember] = memberPageSchema.parse((await send('GET', '/members', tenantB)).json()).items;
  if (!bMember) throw new Error('setup: member missing');
  memberOfB = { id: bMember.membershipId, version: bMember.version };
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe("tenant A can't reach tenant B's team", () => {
  it("answers 404 for B's member, role and invitation ids", async () => {
    const attempts = [
      send('PUT', `/members/${memberOfB.id}/roles`, tenantA, {
        roleIds: [],
        version: memberOfB.version,
      }),
      send('DELETE', `/members/${memberOfB.id}?version=${String(memberOfB.version)}`, tenantA),
      send('PUT', `/roles/${roleOfB.id}`, tenantA, {
        name: 'Taken over',
        description: '',
        version: roleOfB.version,
      }),
      send('DELETE', `/roles/${roleOfB.id}?version=${String(roleOfB.version)}`, tenantA),
      send('PUT', '/permission-matrix', tenantA, {
        roles: [{ id: roleOfB.id, version: roleOfB.version, permissions: ['core.audit.read'] }],
      }),
      send('POST', `/invitations/${invitationOfB.id}/resend`, tenantA, {
        version: invitationOfB.version,
      }),
      send(
        'DELETE',
        `/invitations/${invitationOfB.id}?version=${String(invitationOfB.version)}`,
        tenantA,
      ),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(404);
    }
  });

  it("won't let A invite someone into B's role", async () => {
    // B-র রোলের id — loadRoles-এর tenant filter + RLS সেটা খুঁজে পায় না, তাই "এমন রোল নেই" (ইনপুটের 400)
    const invite = await send('POST', '/invitations', tenantA, {
      email: 'someone@rahmangarments.com',
      roleIds: [roleOfB.id],
    });
    expect(invite.statusCode).toBe(400);
    expect(problemSchema.parse(invite.json()).fieldErrors).toEqual({ roleIds: ['invalid_value'] });
  });

  it("shows A only A's roles and invitations", async () => {
    const roles = roleListSchema.parse((await send('GET', '/roles', tenantA)).json()).items;
    expect(roles.map((role) => role.name)).toEqual(['Owner']);
    const invitations = invitationListSchema.parse(
      (await send('GET', '/invitations', tenantA)).json(),
    ).items;
    expect(invitations).toEqual([]);
  });
});

describe('the invitation_by_token policy', () => {
  it('shows one invitation, and only to someone who holds its token, and never for writing', async () => {
    // omnivo_app হিসেবে (NOBYPASSRLS), টেন্যান্ট context ছাড়া — ঠিক public lookup-এর অবস্থা
    const token = 'a-known-token-for-this-test-0123456789abcdef';
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    await superuser`UPDATE invitations SET token_hash = ${hashInvitationToken(token)} WHERE id = ${invitationOfB.id}`;
    await superuser.end();

    const appDb = postgres(pg.appUrl, { max: 1 });
    try {
      const withoutToken = await appDb`SELECT id FROM invitations`;
      expect(withoutToken).toHaveLength(0);

      await appDb.begin(async (tx) => {
        await tx`SELECT set_config('app.invitation_token_hash', ${hashInvitationToken(token)}, true)`;
        const visible = await tx<{ id: string }[]>`SELECT id FROM invitations`;
        expect(visible.map((row) => row.id)).toEqual([invitationOfB.id]);
        // policy শুধু SELECT-এর — token জেনেও লেখা যায় না (গ্রহণ হয় টেন্যান্ট context-এ)
        const updated = await tx`UPDATE invitations SET revoked_at = now()`;
        expect(updated.count).toBe(0);
        // রোলগুলো দেখা যায় না — policy শুধু invitations-এ
        expect(await tx`SELECT id FROM invitation_roles`).toHaveLength(0);
      });
    } finally {
      await appDb.end();
    }
  });
});
