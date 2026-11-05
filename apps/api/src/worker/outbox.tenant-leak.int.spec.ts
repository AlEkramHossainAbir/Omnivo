import { createDb, type Db, tenants } from '@omnivo/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emit } from '../common/outbox/outbox.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
import { createWithTenant, type WithTenant } from '../common/tenant/with-tenant.js';
import { startPostgres, type TestPostgres } from '../testing/containers.js';

// Who may see the outbox. It holds the work of every tenant, so the rules are tight:
// omnivo_app (API and jobs) may only ADD events, for its own tenant; omnivo_worker (the relay)
// sees every tenant's events and nothing else in the database.
let pg: TestPostgres;
let appDb: Db;
let withTenant: WithTenant;
let tenantA: string;
let tenantB: string;
const USER = '0192a000-0000-7000-8000-000000000001';

beforeAll(async () => {
  pg = await startPostgres();
  appDb = createDb(pg.appUrl, { max: 1 });
  withTenant = createWithTenant(appDb);
  const rows = await appDb
    .insert(tenants)
    .values([
      { name: 'A', slug: 'tenant-a' },
      { name: 'B', slug: 'tenant-b' },
    ])
    .returning({ id: tenants.id });
  const [a, b] = rows;
  if (!a || !b) throw new Error('seed failed');
  [tenantA, tenantB] = [a.id, b.id];
  for (const tenantId of [tenantA, tenantB]) {
    await runWithTenant(tenantId, () =>
      withTenant((tx) => emit(tx, 'workspace.created', { userId: USER })),
    );
  }
}, 120_000);

afterAll(async () => {
  await appDb.$client.end();
  await pg.container.stop();
});

// Postgres error code of a statement run as the given role, or null when it worked
async function errorCodeAs(url: string, run: (sql: postgres.Sql) => Promise<unknown>) {
  const sql = postgres(url, { max: 1 });
  try {
    await run(sql);
    return null;
  } catch (error) {
    return error instanceof postgres.PostgresError ? error.code : String(error);
  } finally {
    await sql.end();
  }
}

// 42501 = insufficient_privilege
describe('the outbox as omnivo_app', () => {
  it('cannot read events, not even its own tenant’s', async () => {
    expect(
      await errorCodeAs(pg.appUrl, (sql) =>
        sql.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
          await tx`SELECT id FROM outbox_events`;
        }),
      ),
    ).toBe('42501');
  });

  it('cannot mark events published or delete them', async () => {
    expect(
      await errorCodeAs(pg.appUrl, (sql) => sql`UPDATE outbox_events SET published_at = now()`),
    ).toBe('42501');
    expect(await errorCodeAs(pg.appUrl, (sql) => sql`DELETE FROM outbox_events`)).toBe('42501');
  });

  it('cannot add an event for another tenant (RLS WITH CHECK)', async () => {
    // 42501 here too: a row that breaks the policy's WITH CHECK is refused as a privilege error
    expect(
      await errorCodeAs(pg.appUrl, (sql) =>
        sql.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
          await tx`INSERT INTO outbox_events (id, tenant_id, type, payload)
                   VALUES (gen_random_uuid(), ${tenantB}, 'workspace.created', '{}')`;
        }),
      ),
    ).toBe('42501');
  });
});

describe('omnivo_worker, the relay role', () => {
  it('sees the events of every tenant, without a tenant context', async () => {
    const sql = postgres(pg.workerUrl, { max: 1 });
    const rows = await sql<{ tenant_id: string }[]>`SELECT tenant_id FROM outbox_events`;
    await sql.end();
    expect(rows.map((row) => row.tenant_id).sort()).toEqual([tenantA, tenantB].sort());
  });

  it('can read no other table', async () => {
    for (const table of ['memberships', 'invitations', 'notifications', 'users', 'tenants']) {
      expect(
        await errorCodeAs(pg.workerUrl, (sql) => sql`SELECT 1 FROM ${sql(table)} LIMIT 1`),
      ).toBe('42501');
    }
  });

  it('cannot add events — only the API does that, inside its transactions', async () => {
    expect(
      await errorCodeAs(
        pg.workerUrl,
        (sql) =>
          sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
            VALUES (gen_random_uuid(), ${tenantA}, 'workspace.created', '{}')`,
      ),
    ).toBe('42501');
  });
});
