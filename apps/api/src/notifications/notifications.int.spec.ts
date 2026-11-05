import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  meResponseSchema,
  notificationPageSchema,
  problemSchema,
  unreadCountSchema,
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
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// The API side only. Notifications are made by the worker (see the invitation and setup tests);
// here they are inserted directly, so every case is exact and quick.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let farhana: SignedIn;
let karim: SignedIn;

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
  await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  // Karim is also a colleague of Farhana's, in the same workspace
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'karim@karimpharma.com',
    workspace: 'rahman-garments',
  });
  karim = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
    keepSignedIn: false,
  });

  // Three for Farhana, one second apart (oldest first), and one for Karim
  const farhanaId = await userId(farhana);
  const karimId = await userId(karim);
  const sql = postgres(pg.superuserUrl, { max: 1 });
  await sql`
    INSERT INTO notifications (id, tenant_id, user_id, type, params, created_at)
    SELECT gen_random_uuid(), t.id, n.user_id::uuid, n.type, n.params::jsonb,
           now() - (n.age || ' seconds')::interval
    FROM tenants t,
         (VALUES (${farhanaId}, 'workspace.ready', '{}', 3),
                 (${farhanaId}, 'member.joined', '{"name":"Tanvir Hossain"}', 2),
                 (${farhanaId}, 'invitation.failed', '{"email":"rupa@rahmangarments.com"}', 1),
                 (${karimId}, 'workspace.ready', '{}', 1))
           AS n(user_id, type, params, age)
    WHERE t.slug = 'rahman-garments'`;
  await sql.end();
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

async function userId(as: SignedIn): Promise<string> {
  return meResponseSchema.parse(
    (await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(as.accessToken) })).json(),
  ).user.id;
}

function send(method: 'GET' | 'POST', url: string, as: SignedIn = farhana) {
  return app.inject({ method, url, headers: bearer(as.accessToken) });
}

async function list(url = '/notifications', as: SignedIn = farhana) {
  return notificationPageSchema.parse((await send('GET', url, as)).json());
}

async function unread(as: SignedIn = farhana): Promise<number> {
  return unreadCountSchema.parse((await send('GET', '/notifications/unread-count', as)).json())
    .count;
}

describe('notifications', () => {
  it('lists only my own, newest first, a page at a time', async () => {
    const first = await list('/notifications?limit=2');
    expect(first.items.map((item) => item.type)).toEqual(['invitation.failed', 'member.joined']);
    expect(first.items[0]?.params).toEqual({ email: 'rupa@rahmangarments.com' });
    if (first.nextCursor === null) throw new Error('expected a second page');

    const second = await list(`/notifications?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((item) => item.type)).toEqual(['workspace.ready']);
    expect(second.nextCursor).toBeNull();

    // Karim's own list has only his one
    expect((await list('/notifications', karim)).items).toHaveLength(1);
  });

  it('counts the unread ones', async () => {
    expect(await unread()).toBe(3);
    expect(await unread(karim)).toBe(1);
  });

  it('marks one as read, and a second time changes nothing', async () => {
    const [newest] = (await list()).items;
    if (!newest) throw new Error('setup: no notification');
    expect((await send('POST', `/notifications/${newest.id}/read`)).statusCode).toBe(204);
    const readAt = (await list()).items[0]?.readAt;
    expect(readAt).not.toBeNull();

    expect((await send('POST', `/notifications/${newest.id}/read`)).statusCode).toBe(204);
    expect((await list()).items[0]?.readAt).toBe(readAt);
    expect(await unread()).toBe(2);
  });

  it("does not let a colleague read or clear mine — it looks like it isn't there", async () => {
    const [mine] = (await list()).items;
    if (!mine) throw new Error('setup: no notification');
    const res = await send('POST', `/notifications/${mine.id}/read`, karim);
    expect(res.statusCode).toBe(404);
    expect(problemSchema.parse(res.json()).code).toBe('not_found');

    // "Mark all as read" by Karim clears only Karim's
    expect((await send('POST', '/notifications/read-all', karim)).statusCode).toBe(204);
    expect(await unread(karim)).toBe(0);
    expect(await unread()).toBe(2);
  });

  it('marks all of mine as read', async () => {
    expect((await send('POST', '/notifications/read-all')).statusCode).toBe(204);
    expect(await unread()).toBe(0);
  });
});
