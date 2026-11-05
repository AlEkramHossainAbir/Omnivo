import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { notificationPageSchema, unreadCountSchema } from '@omnivo/contracts';
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

// Tenant A's notification must not exist for tenant B — not in the list, not in the count, and
// its id must not work, even for the same person signed in to B
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let ownerA: SignedIn;
let ownerB: SignedIn;
let notificationA: string;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  ownerA = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  ownerB = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  const sql = postgres(pg.superuserUrl, { max: 1 });
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO notifications (id, tenant_id, user_id, type)
    SELECT gen_random_uuid(), t.id, u.id, 'workspace.ready'
    FROM tenants t, users u
    WHERE t.slug = 'rahman-garments' AND u.email = 'farhana@rahmangarments.com'
    RETURNING id`;
  // The same id stored for B's owner too, in tenant A: RLS must hide it even if ids were guessed
  await sql`
    INSERT INTO notifications (id, tenant_id, user_id, type)
    SELECT gen_random_uuid(), t.id, u.id, 'member.joined'
    FROM tenants t, users u
    WHERE t.slug = 'rahman-garments' AND u.email = 'karim@karimpharma.com'`;
  await sql.end();
  if (!row) throw new Error('seed failed');
  notificationA = row.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function send(method: 'GET' | 'POST', url: string, as: SignedIn) {
  return app.inject({ method, url, headers: bearer(as.accessToken) });
}

describe('notifications across workspaces', () => {
  it("tenant B sees none of tenant A's, even rows addressed to B's own user", async () => {
    const page = notificationPageSchema.parse((await send('GET', '/notifications', ownerB)).json());
    expect(page.items).toEqual([]);
    const count = unreadCountSchema.parse(
      (await send('GET', '/notifications/unread-count', ownerB)).json(),
    );
    expect(count.count).toBe(0);
  });

  it("tenant B cannot mark tenant A's notification read (404, and it stays unread)", async () => {
    expect((await send('POST', `/notifications/${notificationA}/read`, ownerB)).statusCode).toBe(
      404,
    );
    expect((await send('POST', '/notifications/read-all', ownerB)).statusCode).toBe(204);
    const count = unreadCountSchema.parse(
      (await send('GET', '/notifications/unread-count', ownerA)).json(),
    );
    expect(count.count).toBe(1);
  });
});
