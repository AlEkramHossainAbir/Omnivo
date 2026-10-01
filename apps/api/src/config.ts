import { z } from 'zod';

// Both processes (API and worker) read the same .env, but each checks only what it uses. So the
// worker never holds the JWT secret, and the API never holds the SMTP password.
const sharedEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  APP_ORIGIN: z.url(),
});

// S3-এর মতো storage: dev-এ MinIO (docker-compose), production-এ Cloudflare R2 (system-design §৩.৭).
// Both processes use it from step 11: the API for uploads and downloads, the worker to store the
// report files it writes.
const storageEnvSchema = z.object({
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('omnivo'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

// process.env-এর সব মান string | undefined — এখানে একবার যাচাই করে টাইপ-নিরাপদ Config বানানো
const envSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
  PORT: z.coerce.number().int().positive().default(3000),
  API_BASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  JWT_SECRET: z.string().min(32),
});

const workerEnvSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
  // The relay's own database role (omnivo_worker): it may read every tenant's outbox rows, and
  // nothing else. The jobs themselves use DATABASE_URL (omnivo_app) with a tenant context.
  WORKER_DATABASE_URL: z.url(),
  // ইমেইল: dev-এ docker-compose-এর Mailpit (smtp://localhost:1025, সব চিঠি http://localhost:8025-এ),
  // production-এ আসল SMTP (smtps://user:pass@host:465)। পাসওয়ার্ড URL-এর ভেতরেই — একটাই secret
  SMTP_URL: z.url(),
  MAIL_FROM: z.string().min(3).default('Omnivo <no-reply@omnivo.app>'),
});

const DAY = 24 * 60 * 60;

function storageConfig(e: z.output<typeof storageEnvSchema> & { NODE_ENV: string }) {
  return {
    endpoint: e.S3_ENDPOINT,
    region: e.S3_REGION,
    bucket: e.S3_BUCKET,
    accessKeyId: e.S3_ACCESS_KEY_ID,
    secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    // dev আর test-এ bucket না থাকলে API নিজে বানায়; production-এ bucket IaC-র কাজ (ধাপ ২৫),
    // সেখানে API-র bucket বানানোর অধিকারই থাকবে না
    createBucket: e.NODE_ENV !== 'production',
  };
}

export type StorageConfig = ReturnType<typeof storageConfig>;

function parseEnv<S extends z.ZodType>(schema: S, env: Record<string, string | undefined>) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment — compare your .env with .env.example:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function loadConfig(env: Record<string, string | undefined>) {
  const e = parseEnv(envSchema, env);
  return {
    port: e.PORT,
    apiBaseUrl: e.API_BASE_URL,
    // /openapi.json আর /docs — production-এ API-র পুরো নকশা বাইরে দেখানো হয় না
    exposeDocs: e.NODE_ENV !== 'production',
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appOrigin: e.APP_ORIGIN,
    // localhost-এ http, তাই dev-এ Secure cookie বন্ধ; production-এ বাধ্যতামূলক
    secureCookies: e.NODE_ENV === 'production',
    storage: storageConfig(e),
    auth: {
      betterAuthSecret: e.BETTER_AUTH_SECRET,
      baseURL: e.API_BASE_URL,
      sessionTtlSeconds: 30 * DAY,
      accessToken: {
        secret: e.JWT_SECRET,
        issuer: e.API_BASE_URL,
        audience: 'omnivo-api',
        ttlSeconds: 15 * 60,
      },
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function loadWorkerConfig(env: Record<string, string | undefined>) {
  const e = parseEnv(workerEnvSchema, env);
  return {
    databaseUrl: e.DATABASE_URL,
    relayDatabaseUrl: e.WORKER_DATABASE_URL,
    redisUrl: e.REDIS_URL,
    // Links inside emails (the invitation link) point at the app
    appOrigin: e.APP_ORIGIN,
    mail: {
      url: e.SMTP_URL,
      from: e.MAIL_FROM,
    },
    // The report exports (step 11) go to the same bucket as the uploads
    storage: storageConfig(e),
    relay: {
      // How long the relay sleeps when it found nothing to publish. One second keeps an invitation
      // email about a second behind the click, for one cheap index read per second.
      idleMs: 1_000,
      batchSize: 100,
      // How long one publish to Redis may take before the relay gives up and rolls back
      publishTimeoutMs: 5_000,
    },
    retry: {
      // A failed job runs again after 2, 4, 8 and 16 seconds, then gives up (about 30 seconds in
      // all). Long enough to ride out a mail server restart, short enough that "Email not sent"
      // shows up while the admin is still looking at the team page.
      attempts: 5,
      backoffMs: 2_000,
    },
    // Published outbox rows are kept this long for debugging ("did the event go out?"), then
    // deleted by an hourly job
    outboxRetentionDays: 7,
  };
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
