import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { INestApplicationContext } from '@nestjs/common';
import type postgres from 'postgres';

import { AppModule } from '../app.module.js';
import { type Config, loadConfig, loadWorkerConfig, type WorkerConfig } from '../config.js';
import { configureApp, createAdapter } from '../configure-app.js';
import { WorkerModule } from '../worker/worker.module.js';

// Step 27a: the shop server's key in the tests, sent in X-Shop-Key on the order routes
export const TEST_SHOP_KEY = 'test-shop-key-that-is-at-least-32-bytes';

// Step 27d: the key that seals gateway passwords in the tests (32 bytes, base64). The gateway is
// the fake one (PAYMENT_GATEWAY's default outside production)
export const TEST_CREDENTIALS_KEY = Buffer.alloc(32, 27).toString('base64');

// The API's and the worker's jobs' connections in the tests carry these application_names, so a
// test can tell them apart in pg_stat_activity (lockWaitsOfApi)
const TEST_API_APP_NAME = 'omnivo-test-api';
const TEST_WORKER_APP_NAME = 'omnivo-test-worker';

// How many of the API's connections wait for a lock now. The "in turn" gates count these, not
// every waiting backend: a worker job (a receipt, the pending-order sweep) that writes a locked
// table waits too, and counting it broke the gate at random on CI ("expected 4 to be 2").
// `withWorker` also counts the worker's jobs, for a test that runs a job into the gate itself.
// Inside a transaction (the gate's) Postgres keeps its first look at pg_stat_activity until the
// transaction ends, so a connection opened after that would be missing from the join: the
// snapshot is cleared first, every time.
export async function lockWaitsOfApi(
  sql: postgres.Sql | postgres.TransactionSql,
  { withWorker = false }: { withWorker?: boolean } = {},
): Promise<number> {
  const names = withWorker ? [TEST_API_APP_NAME, TEST_WORKER_APP_NAME] : [TEST_API_APP_NAME];
  await sql`SELECT pg_stat_clear_snapshot()`;
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE NOT l.granted AND a.application_name IN ${sql(names)}`;
  return row?.n ?? 0;
}

// .env না পড়ে টেস্টের নিজস্ব মান — loadConfig দিয়ে গেলে production-এর একই যাচাই চলে
// storageUrl না দিলে অচল ঠিকানা — যে টেস্ট ফাইল ছোঁয় না তার জন্য MinIO container তুলতে হয় না
export function testConfig(urls: {
  databaseUrl: string;
  redisUrl: string;
  storageUrl?: string;
}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: withAppName(urls.databaseUrl, TEST_API_APP_NAME),
    REDIS_URL: urls.redisUrl,
    API_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: 'http://localhost:5173',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32-bytes',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-bytes',
    S3_ENDPOINT: urls.storageUrl ?? 'http://127.0.0.1:1',
    S3_ACCESS_KEY_ID: 'omnivo',
    S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
    STOREFRONT_SHOP_KEY: TEST_SHOP_KEY,
    CREDENTIALS_KEY: TEST_CREDENTIALS_KEY,
  });
}

// postgres.js sends a query parameter it does not know as a connection parameter
function withAppName(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', name);
  return url.toString();
}

export async function createTestApp(config: Config): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    createAdapter(),
    { logger: false },
  );
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

// The worker's config, checked like production's, but fast: the relay looks every 50 ms and a
// failed job (an email, a booking) gives up after 2 quick tries, so a test waits well under a second for either. With
// no mailUrl the SMTP address is dead (port 1): every send fails at once, which is how the tests
// see "Email not sent". No storageUrl: the same dead address, for tests that write no files.
export function testWorkerConfig(urls: {
  databaseUrl: string;
  workerDatabaseUrl: string;
  redisUrl: string;
  mailUrl?: string;
  storageUrl?: string;
}): WorkerConfig {
  const config = loadWorkerConfig({
    NODE_ENV: 'test',
    DATABASE_URL: withAppName(urls.databaseUrl, TEST_WORKER_APP_NAME),
    WORKER_DATABASE_URL: urls.workerDatabaseUrl,
    REDIS_URL: urls.redisUrl,
    APP_ORIGIN: 'http://localhost:5173',
    SMTP_URL: urls.mailUrl ?? 'smtp://127.0.0.1:1',
    S3_ENDPOINT: urls.storageUrl ?? 'http://127.0.0.1:1',
    S3_ACCESS_KEY_ID: 'omnivo',
    S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
    CREDENTIALS_KEY: TEST_CREDENTIALS_KEY,
  });
  return {
    ...config,
    relay: { ...config.relay, idleMs: 50, publishTimeoutMs: 500 },
    retry: { attempts: 2, backoffMs: 50 },
    // Step 28a: a booking's tries too, so a parcel the courier never answers fails in well under a
    // second, not after the 15 minutes of production's five tries
    courierRetry: { attempts: 2, backoffMs: 50 },
  };
}

// The real worker, in the test's own process: relay, queues and handlers exactly as in
// production — only the timings above differ
export async function createTestWorker(config: WorkerConfig): Promise<INestApplicationContext> {
  const worker = await NestFactory.createApplicationContext(WorkerModule.register(config), {
    logger: process.env.DEBUG_WORKER ? ['log', 'warn', 'error'] : false,
  });
  await worker.init();
  return worker;
}

// Waits until check() stops throwing — for things the worker does a moment later (an email in
// Mailpit, a status that turns 'ready'). Fails with check()'s own error after the timeout, which
// is below vitest's 5-second test timeout: then the report shows the real assertion, and no loop
// keeps running in the background after the test has already been given up.
export async function eventually<T>(check: () => Promise<T>, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
