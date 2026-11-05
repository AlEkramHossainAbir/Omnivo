import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { INestApplicationContext } from '@nestjs/common';

import { AppModule } from '../app.module.js';
import { type Config, loadConfig, loadWorkerConfig, type WorkerConfig } from '../config.js';
import { configureApp, createAdapter } from '../configure-app.js';
import { WorkerModule } from '../worker/worker.module.js';

// .env না পড়ে টেস্টের নিজস্ব মান — loadConfig দিয়ে গেলে production-এর একই যাচাই চলে
// storageUrl না দিলে অচল ঠিকানা — যে টেস্ট ফাইল ছোঁয় না তার জন্য MinIO container তুলতে হয় না
export function testConfig(urls: {
  databaseUrl: string;
  redisUrl: string;
  storageUrl?: string;
}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urls.databaseUrl,
    REDIS_URL: urls.redisUrl,
    API_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: 'http://localhost:5173',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32-bytes',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-bytes',
    S3_ENDPOINT: urls.storageUrl ?? 'http://127.0.0.1:1',
    S3_ACCESS_KEY_ID: 'omnivo',
    S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
  });
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
// failed job gives up after 2 quick tries, so a test waits well under a second for either. With
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
    DATABASE_URL: urls.databaseUrl,
    WORKER_DATABASE_URL: urls.workerDatabaseUrl,
    REDIS_URL: urls.redisUrl,
    APP_ORIGIN: 'http://localhost:5173',
    SMTP_URL: urls.mailUrl ?? 'smtp://127.0.0.1:1',
    S3_ENDPOINT: urls.storageUrl ?? 'http://127.0.0.1:1',
    S3_ACCESS_KEY_ID: 'omnivo',
    S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
  });
  return {
    ...config,
    relay: { ...config.relay, idleMs: 50, publishTimeoutMs: 500 },
    retry: { attempts: 2, backoffMs: 50 },
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
