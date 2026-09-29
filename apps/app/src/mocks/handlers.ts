import { type AuthSession, routes } from '@omnivo/contracts';
import { delay } from 'msw';

import { MEMBERS, meIn, WORKSPACES, type Workspace } from './fixtures';
import { mock, problem, readBody, readQuery, reply } from './mock';

// mock সার্ভারের অবস্থা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে
let signedIn = true;
let workspace: Workspace = WORKSPACES[0];

function session(): AuthSession {
  return {
    accessToken: `mock-${crypto.randomUUID()}`,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

// UI-র প্রতিটা পথ দেখার জন্য: লগইনে পাসওয়ার্ড "wrong-password" → invalid_credentials,
// সাইনআপে ঠিকানা "rahman-garments" → slug_taken
export const handlers = [
  mock(routes.health.check, () => reply(routes.health.check, { status: 'ok' })),

  mock(routes.auth.refresh, () =>
    signedIn ? reply(routes.auth.refresh, session()) : problem(401, 'session_ended'),
  ),

  mock(routes.auth.me, () => reply(routes.auth.me, meIn(workspace))),

  mock(routes.auth.login, async ({ request }) => {
    const body = await readBody(routes.auth.login.body, request);
    await delay();
    if (body.password === 'wrong-password') return problem(401, 'invalid_credentials');
    signedIn = true;
    return reply(routes.auth.login, session());
  }),

  mock(routes.auth.signUp, async ({ request }) => {
    const body = await readBody(routes.auth.signUp.body, request);
    await delay();
    if (body.workspaceSlug === WORKSPACES[0].slug) {
      return problem(409, 'slug_taken', { workspaceSlug: ['slug_taken'] });
    }
    signedIn = true;
    return reply(routes.auth.signUp, session());
  }),

  mock(routes.auth.switchTenant, async ({ request }) => {
    const { tenantId } = await readBody(routes.auth.switchTenant.body, request);
    const target = WORKSPACES.find((candidate) => candidate.tenantId === tenantId);
    if (!target) return problem(403, 'switch_denied');
    workspace = target;
    return reply(routes.auth.switchTenant, session());
  }),

  mock(routes.auth.logout, () => {
    signedIn = false;
    return reply(routes.auth.logout, undefined);
  }),

  mock(routes.members.list, async ({ request }) => {
    const query = readQuery(routes.members.list.query, request);
    // আসল API keyset ব্যবহার করে; mock-এ cursor শুধু একটা offset — ক্লায়েন্টের কাছে দুটোই অস্বচ্ছ
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const sorted = MEMBERS.toSorted((a, b) => a.fullName.localeCompare(b.fullName));
    if (query.sort === '-name') sorted.reverse();
    const items = sorted.slice(start, start + query.limit);
    const end = start + items.length;
    // পাতার মাঝে একটু দেরি — "Loading more…" চোখে দেখা যায়
    await delay(400);
    return reply(routes.members.list, {
      items,
      nextCursor: end < sorted.length ? String(end) : null,
    });
  }),
];
