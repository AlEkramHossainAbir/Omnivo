import { createDb, type Db, tenants } from '@omnivo/db';
import { Queue } from 'bullmq';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { emit } from '../common/outbox/outbox.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
import { createWithTenant, type WithTenant } from '../common/tenant/with-tenant.js';
import type { WorkerConfig } from '../config.js';
import { testWorkerConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { OutboxRelay } from './outbox-relay.js';
import { Queues } from './queues.js';

// The relay on its own: no job runner takes the jobs, so the tests can look at exactly what
// landed on the queue
let pg: TestPostgres;
let redis: TestRedis;
let appDb: Db;
let relayDb: Db;
let withTenant: WithTenant;
let config: WorkerConfig;
let queues: Queues;
let tenantId: string;
const USER = '0192a000-0000-7000-8000-000000000001';

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  appDb = createDb(pg.appUrl, { max: 2 });
  relayDb = createDb(pg.workerUrl, { max: 4 });
  withTenant = createWithTenant(appDb);
  config = testWorkerConfig({
    databaseUrl: pg.appUrl,
    workerDatabaseUrl: pg.workerUrl,
    redisUrl: redis.url,
  });
  queues = new Queues(config);
  const [tenant] = await appDb.insert(tenants).values({ name: 'Acme', slug: 'acme' }).returning();
  if (!tenant) throw new Error('seed failed');
  tenantId = tenant.id;
}, 120_000);

afterAll(async () => {
  await queues.onApplicationShutdown();
  await appDb.$client.end();
  await relayDb.$client.end();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

// Start every test from an empty outbox and empty queues
beforeEach(async () => {
  const sql = postgres(pg.superuserUrl, { max: 1 });
  await sql`DELETE FROM outbox_events`;
  await sql.end();
  for (const name of ['email', 'jobs']) {
    const queue = new Queue(name, { connection: { url: redis.url } });
    await queue.obliterate({ force: true });
    await queue.close();
  }
});

function emitMany(count: number): Promise<void> {
  return runWithTenant(tenantId, () =>
    withTenant(async (tx) => {
      for (let i = 0; i < count; i += 1) {
        await emit(tx, 'workspace.setup_requested', { userId: USER });
      }
    }),
  );
}

async function jobIds(): Promise<string[]> {
  const queue = new Queue('jobs', { connection: { url: redis.url } });
  const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  await queue.close();
  return jobs.map((job) => job.id ?? '').sort();
}

async function unpublishedIds(): Promise<string[]> {
  const sql = postgres(pg.superuserUrl, { max: 1 });
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM outbox_events WHERE published_at IS NULL ORDER BY id`;
  await sql.end();
  return rows.map((row) => row.id);
}

describe('emit()', () => {
  it('leaves no event behind when the transaction rolls back', async () => {
    await expect(
      runWithTenant(tenantId, () =>
        withTenant(async (tx) => {
          await emit(tx, 'workspace.setup_requested', { userId: USER });
          throw new Error('the change itself failed');
        }),
      ),
    ).rejects.toThrow('the change itself failed');
    expect(await unpublishedIds()).toEqual([]);
  });

  it('stores only the fields of the schema', async () => {
    await runWithTenant(tenantId, () =>
      withTenant((tx) =>
        // A wider object (as a careless caller might pass): the extra field must not be stored.
        // The spread keeps TypeScript's excess-property check out of the way, like real code would.
        emit(tx, 'workspace.setup_requested', { ...{ userId: USER, email: 'x@example.com' } }),
      ),
    );
    const sql = postgres(pg.superuserUrl, { max: 1 });
    const [row] = await sql<{ payload: unknown }[]>`SELECT payload FROM outbox_events`;
    await sql.end();
    expect(row?.payload).toEqual({ userId: USER });
  });
});

describe('the relay', () => {
  it('puts each row on the queue once, with the row id as the job id, and marks it', async () => {
    await emitMany(3);
    const ids = await unpublishedIds();
    const relay = new OutboxRelay(relayDb, config, queues);
    expect(await relay.publishBatch()).toBe(3);
    expect(await unpublishedIds()).toEqual([]);
    expect(await jobIds()).toEqual(ids);
  });

  it('adds no second job when a row is published again (the relay died before marking it)', async () => {
    await emitMany(1);
    const relay = new OutboxRelay(relayDb, config, queues);
    await relay.publishBatch();
    const sql = postgres(pg.superuserUrl, { max: 1 });
    await sql`UPDATE outbox_events SET published_at = NULL`;
    await sql.end();
    expect(await relay.publishBatch()).toBe(1);
    // Still one job: the second add used the same job id (the row id), and BullMQ ignored it
    expect(await jobIds()).toHaveLength(1);
  });

  it('never publishes a row twice, even with two relays at the same moment', async () => {
    await emitMany(40);
    const ids = await unpublishedIds();
    // Small batches, so both relays really work at once
    const small = { ...config, relay: { ...config.relay, batchSize: 5 } };
    const one = new OutboxRelay(relayDb, small, queues);
    const two = new OutboxRelay(relayDb, small, queues);
    const drain = async (relay: OutboxRelay): Promise<number> => {
      let total = 0;
      for (let n = await relay.publishBatch(); n > 0; n = await relay.publishBatch()) total += n;
      return total;
    };
    const [a, b] = await Promise.all([drain(one), drain(two)]);
    // SKIP LOCKED: each relay took different rows, and together they took all of them
    expect(a + b).toBe(40);
    expect(await jobIds()).toEqual(ids);
  });

  it('keeps the rows when Redis is down, for the next round', async () => {
    await emitMany(2);
    const deadRedis = new Queues({ ...config, redisUrl: 'redis://127.0.0.1:1' });
    const relay = new OutboxRelay(relayDb, config, deadRedis);
    await expect(relay.publishBatch()).rejects.toThrow();
    await deadRedis.onApplicationShutdown();
    expect(await unpublishedIds()).toHaveLength(2);
  });

  it('deletes old published rows, never unpublished ones', async () => {
    await emitMany(3);
    const sql = postgres(pg.superuserUrl, { max: 1 });
    await sql`
      UPDATE outbox_events SET published_at = now() - interval '8 days'
      WHERE id = (SELECT id FROM outbox_events ORDER BY id LIMIT 1)`;
    await sql`
      UPDATE outbox_events SET created_at = now() - interval '30 days'
      WHERE published_at IS NULL`;
    await sql.end();
    const relay = new OutboxRelay(relayDb, config, queues);
    expect(await relay.deletePublished()).toBe(1);
    expect(await unpublishedIds()).toHaveLength(2);
  });
});
