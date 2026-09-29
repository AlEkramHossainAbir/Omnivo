import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../app.module.js';
import { type Config, loadConfig } from '../config.js';
import { configureApp, createAdapter } from '../configure-app.js';

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
