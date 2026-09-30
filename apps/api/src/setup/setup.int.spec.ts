import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  meResponseSchema,
  notificationPageSchema,
  problemSchema,
  roleListSchema,
  setupSchema,
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
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import { lastMailTo } from '../testing/mailpit.js';

let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

function send(method: 'GET' | 'POST', url: string, payload?: object, as: SignedIn = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function setup(as: SignedIn = owner) {
  return setupSchema.parse((await send('GET', '/setup', undefined, as)).json());
}

async function superuserSql(fn: (sql: postgres.Sql) => Promise<unknown>): Promise<void> {
  const sql = postgres(pg.superuserUrl, { max: 1 });
  try {
    await fn(sql);
  } finally {
    await sql.end();
  }
}

async function unpublished(expected: number): Promise<void> {
  await superuserSql(async (sql) => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`;
    expect(row?.n).toBe(expected);
  });
}

describe('sign-up', () => {
  it('leaves a new workspace pending, so the app opens the wizard', async () => {
    expect(await setup()).toEqual({ status: 'pending', industry: null });
    const me = meResponseSchema.parse((await send('GET', '/auth/me')).json());
    expect(me.tenant.setupStatus).toBe('pending');
  });

  it('sends the welcome email from the worker, with the workspace address', async () => {
    const welcome = await eventually(() => lastMailTo(mail.apiUrl, 'farhana@rahmangarments.com'));
    expect(welcome.subject).toBe('Welcome to Omnivo, Farhana Rahman');
    expect(welcome.text).toContain('rahman-garments.omnivo.app');
    expect(welcome.text).toContain('http://localhost:5173/login');
  });
});

describe('starting the setup', () => {
  it('answers with "provisioning" at once, then the worker makes the garments roles', async () => {
    const res = await send('POST', '/setup', { industry: 'garments' });
    expect(res.statusCode).toBe(200);
    expect(setupSchema.parse(res.json())).toEqual({ status: 'provisioning', industry: 'garments' });

    await eventually(async () => {
      expect((await setup()).status).toBe('ready');
    });
    const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
    expect(items.map((role) => [role.name, role.permissions])).toEqual([
      ['Owner', expect.any(Array)],
      ['Accountant', ['core.audit.read', 'core.user.read']],
      ['Merchandiser', ['core.user.read']],
      ['Store keeper', []],
    ]);
  });

  it('writes the audit log as the system, with the request that started it', async () => {
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace')).json(),
    );
    const [provisioned, started] = items;
    expect(started).toMatchObject({
      action: 'workspace.setup_started',
      actor: { fullName: 'Farhana Rahman' },
      changes: { industry: { from: null, to: 'garments' } },
    });
    expect(provisioned).toMatchObject({
      action: 'workspace.provisioned',
      actor: null,
      changes: { roles: { from: null, to: 'Accountant, Merchandiser, Store keeper' } },
    });
    // The worker ran in the context of the POST /setup request: one click, traced end to end
    expect(provisioned?.requestId).toBe(started?.requestId);
    expect(provisioned?.ipAddress).toBeNull();
  });

  it('puts "Workspace ready" in the owner\'s bell', async () => {
    const { items } = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(items.map((item) => item.type)).toContain('workspace.ready');
  });

  it('can be started only once', async () => {
    const again = await send('POST', '/setup', { industry: 'pharma' });
    expect(again.statusCode).toBe(409);
    expect(problemSchema.parse(again.json()).code).toBe('setup_started');
  });

  it('ignores the same event published twice, and a second run of the job', async () => {
    await superuserSql(async (sql) => {
      // 1) The relay crashed after Redis took the job but before it marked the row: the row is
      //    published again. The job id is the event id, so BullMQ ignores the second add.
      await sql`UPDATE outbox_events SET published_at = NULL
                WHERE type = 'workspace.setup_requested'`;
      // 2) A second event for the same workspace: the handler really runs again, finds 'ready'
      //    and stops — no second set of roles, no second notification
      await sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                SELECT gen_random_uuid(), tenant_id, type, payload FROM outbox_events
                WHERE type = 'workspace.setup_requested'`;
    });
    await eventually(() => unpublished(0));
    // The relay has handed both over; give the queue a moment to run what it will run
    await new Promise((resolve) => setTimeout(resolve, 500));

    const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
    expect(items).toHaveLength(4);
    const bell = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(bell.items.filter((item) => item.type === 'workspace.ready')).toHaveLength(1);
  });
});

describe('when the setup job fails', () => {
  let pharmaOwner: SignedIn;

  beforeAll(async () => {
    pharmaOwner = await signUp(app, {
      companyName: 'Karim Pharma',
      workspaceSlug: 'karim-pharma',
      fullName: 'Karim Uddin',
      email: 'karim@karimpharma.com',
      password: 'Batch-expiry-2026',
    });
  });

  it('marks it failed, and Retry finishes it once the cause is fixed', async () => {
    const me = meResponseSchema.parse(
      (await send('GET', '/auth/me', undefined, pharmaOwner)).json(),
    );
    // A role named like the template's "Depot manager", made by the owner before the job runs
    const own = await send(
      'POST',
      '/roles',
      { name: 'depot manager', description: 'Our own' },
      pharmaOwner,
    );
    expect(own.statusCode).toBe(201);

    // A broken start: an industry the code does not know. Running the job again cannot help, so
    // it gives up at once (PermanentJobError, no retries) and onGiveUp marks the setup failed.
    await superuserSql(async (sql) => {
      await sql`UPDATE tenants SET setup_status = 'provisioning', industry = 'shipping'
                WHERE slug = 'karim-pharma'`;
      await sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                SELECT gen_random_uuid(), id, 'workspace.setup_requested',
                       jsonb_build_object('userId', ${me.user.id}::text)
                FROM tenants WHERE slug = 'karim-pharma'`;
    });
    // Read from the table: while the industry is broken, GET /setup itself fails its response
    // contract ('shipping' is not an industry) — the API refuses to send data it cannot vouch for
    await eventually(() =>
      superuserSql(async (sql) => {
        const [row] = await sql<{ setup_status: string }[]>`
          SELECT setup_status FROM tenants WHERE slug = 'karim-pharma'`;
        expect(row?.setup_status).toBe('failed');
      }),
    );

    await superuserSql(
      (sql) => sql`UPDATE tenants SET industry = 'pharma' WHERE slug = 'karim-pharma'`,
    );
    const retried = await send('POST', '/setup/retry', undefined, pharmaOwner);
    expect(setupSchema.parse(retried.json())).toEqual({
      status: 'provisioning',
      industry: 'pharma',
    });
    await eventually(async () => {
      expect((await setup(pharmaOwner)).status).toBe('ready');
    });

    // The owner's own "depot manager" is kept as it was; the template's did not overwrite it
    const { items } = roleListSchema.parse(
      (await send('GET', '/roles', undefined, pharmaOwner)).json(),
    );
    // (the list is sorted by name as stored, so the lowercase name comes last)
    expect(items.map((role) => role.name)).toEqual([
      'Owner',
      'Accountant',
      'Sales representative',
      'depot manager',
    ]);
    expect(items.find((role) => role.name === 'depot manager')).toMatchObject({
      description: 'Our own',
      permissions: [],
    });
  });

  it('refuses a retry when nothing failed', async () => {
    const res = await send('POST', '/setup/retry', undefined, pharmaOwner);
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('setup_not_failed');
  });
});
