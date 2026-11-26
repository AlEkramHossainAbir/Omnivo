import { hkdfSync } from 'node:crypto';

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

// Step 27d: online payment. Both processes use it: the API opens payment pages and asks the
// gateway about payments, and the worker's sweep asks it before it deletes an unpaid online order.
const paymentEnvSchema = z.object({
  // Which gateway the API talks to. fake: the shop's own fake page (SHOP_FAKE_GATEWAY_PATH), for
  // development, CI and the tests; it pays nothing and is refused in production (paymentConfig).
  // Left out: sslcommerz in production, fake everywhere else
  PAYMENT_GATEWAY: z.enum(['fake', 'sslcommerz']).optional(),
  // The key that seals each shop's gateway password in the database (decision 4): 32 random bytes,
  // base64 (openssl rand -base64 32). Its own secret, not derived from JWT_SECRET: changing the JWT
  // secret signs everyone out, and must not also make every saved password unreadable. Left out:
  // the Payment card cannot save a password (storefront_gateway_key_missing), and nothing else in
  // the API changes, so a server that takes no online payments needs no key
  CREDENTIALS_KEY: z
    .string()
    .refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'CREDENTIALS_KEY must be 32 bytes in base64 (openssl rand -base64 32)',
    })
    .optional(),
});

// Step 28a: couriers. Both processes use it: the API books a manual parcel and answers the
// courier's webhook and "Test connection", and the worker books an API parcel and polls.
const shippingEnvSchema = z.object({
  // Which couriers the API talks to (decision 6). fake: an answer in the courier's shapes from
  // this process itself (shipping/fake-courier.ts), for development, CI and the tests; it books
  // nothing and is refused in production. live: each provider's own API (Steadfast). Left out:
  // live in production, fake everywhere else, like PAYMENT_GATEWAY
  COURIER_MODE: z.enum(['fake', 'live']).optional(),
});

// process.env-এর সব মান string | undefined — এখানে একবার যাচাই করে টাইপ-নিরাপদ Config বানানো
const envSchema = sharedEnvSchema
  .extend(storageEnvSchema.shape)
  .extend(paymentEnvSchema.shape)
  .extend(shippingEnvSchema.shape)
  .extend({
    PORT: z.coerce.number().int().positive().default(3000),
    API_BASE_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    JWT_SECRET: z.string().min(32),
    // "true" only when a proxy you run (Caddy on staging) is the one thing that can reach the API.
    // Fastify then takes the client's address from X-Forwarded-For, so the audit log records the
    // person's IP, not the proxy's. Left off, a client could write any IP into that header.
    TRUST_PROXY: z.stringbool().default(false),
    // Step 26f: the domain every shop's address ends with. A shop's subdomain is put before it:
    // "acme" + "localhost" = acme.localhost (dev), "acme" + "omnivo.shop" = acme.omnivo.shop. One
    // DNS name, lower case, no port and no dot at either end
    SHOP_BASE_DOMAIN: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/)
      .default('localhost'),
    // Step 26f: the public address of the storage's storefront/ folder's parent, as a shopper's
    // browser reaches it. Left out: the storage's own address and bucket (S3_ENDPOINT/S3_BUCKET),
    // which is right for MinIO in dev and on staging. Cloudflare R2 serves public files from another
    // address than its API, so production sets it
    STOREFRONT_MEDIA_URL: z.url().optional(),
    // Step 26g: the port in a shop's own address, which the Storefront screens link to ("View
    // shop"). In dev the shop's server has its own port (apps/shop runs on 4321); behind a proxy the
    // address has none. Left out: 4321 outside production, none in production
    SHOP_PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    // Step 27a: the key the shop's server sends in X-Shop-Key on the order routes (27a's decision
    // 13); the shop's own SHOP_API_KEY has the same value. Long and random, like the JWT secret
    // (openssl rand -base64 32). Left out: the order routes answer 401 to everyone, so a shop with
    // no key set can show its pages but take no orders, and nothing else in the API changes
    STOREFRONT_SHOP_KEY: z.string().min(32).optional(),
  });

const workerEnvSchema = sharedEnvSchema
  .extend(storageEnvSchema.shape)
  .extend(paymentEnvSchema.shape)
  .extend(shippingEnvSchema.shape)
  .extend({
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

// Step 27d: the gateway and the sealing key, for the API and the worker alike. The key's version is
// 1 for now: a second key (a key change) gets 2, and each sealed password says which one sealed it
// (storefront_payment_gateways.key_version)
function paymentConfig(e: z.output<typeof paymentEnvSchema> & { NODE_ENV: string }) {
  const production = e.NODE_ENV === 'production';
  const gateway = e.PAYMENT_GATEWAY ?? (production ? 'sslcommerz' : 'fake');
  // The fake gateway says "paid" to any val_id that names an amount: on a live shop that would be
  // goods for nothing. Refused here, before the API takes a single request
  if (production && gateway === 'fake') {
    throw new Error(
      'Invalid environment — PAYMENT_GATEWAY=fake pays nothing for real, so production cannot use it.',
    );
  }
  return {
    gateway,
    credentialsKey:
      e.CREDENTIALS_KEY === undefined
        ? null
        : { version: 1, key: Buffer.from(e.CREDENTIALS_KEY, 'base64') },
  };
}

export type PaymentsConfig = ReturnType<typeof paymentConfig>;

// Step 28a: the couriers' mode and the key that seals each courier account's keys. The key is the
// payment gateway's CREDENTIALS_KEY (decision 7): one secret that seals what the tenants typed,
// with the table in each seal's context (payments/credentials.ts), so a key sealed for a courier
// never opens as a gateway password
function shippingConfig(
  e: z.output<typeof shippingEnvSchema> & { NODE_ENV: string },
  payments: PaymentsConfig,
) {
  const production = e.NODE_ENV === 'production';
  const mode = e.COURIER_MODE ?? (production ? 'live' : 'fake');
  // The fake courier "books" every parcel without telling anyone: on a live shop the order would
  // say Booked and no rider would ever come. Refused before the API takes a request
  if (production && mode === 'fake') {
    throw new Error(
      'Invalid environment — COURIER_MODE=fake books nothing for real, so production cannot use it.',
    );
  }
  return { mode, credentialsKey: payments.credentialsKey };
}

export type ShippingConfig = ReturnType<typeof shippingConfig>;

function parseEnv<S extends z.ZodType>(schema: S, env: Record<string, string | undefined>) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment — compare your .env with .env.example:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

// Step 26f: where the shop's photos are, without a "/" at the end (media.ts adds the path). The
// contract allows http only on this computer (dev MinIO), so a production API with an http address
// would answer every page with a broken contract; it refuses to start instead, with the reason
function storefrontMediaUrl(e: z.output<typeof envSchema>): string {
  const url = (
    e.STOREFRONT_MEDIA_URL ?? `${e.S3_ENDPOINT.replace(/\/+$/, '')}/${e.S3_BUCKET}`
  ).replace(/\/+$/, '');
  if (e.NODE_ENV === 'production' && !url.startsWith('https://')) {
    throw new Error(
      `Invalid environment — the shop's photos need an https address. Set STOREFRONT_MEDIA_URL (now ${url}).`,
    );
  }
  return url;
}

// Step 27a: the key of the phone code's HMAC (storefront/orders/order-secrets.ts), derived from
// JWT_SECRET with HKDF instead of being one more secret to set. HKDF with its own label gives a key
// that tells nothing about the JWT secret, and that no JWT can be signed with. Changing JWT_SECRET
// signs everyone out anyway; here it only spoils the codes of the next 10 minutes
function phoneCodeKey(jwtSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', jwtSecret, '', 'omnivo storefront phone code', 32));
}

export function loadConfig(env: Record<string, string | undefined>) {
  const e = parseEnv(envSchema, env);
  const payments = paymentConfig(e);
  return {
    port: e.PORT,
    apiBaseUrl: e.API_BASE_URL,
    trustProxy: e.TRUST_PROXY,
    // /openapi.json আর /docs — production-এ API-র পুরো নকশা বাইরে দেখানো হয় না
    exposeDocs: e.NODE_ENV !== 'production',
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appOrigin: e.APP_ORIGIN,
    // localhost-এ http, তাই dev-এ Secure cookie বন্ধ; production-এ বাধ্যতামূলক
    secureCookies: e.NODE_ENV === 'production',
    storage: storageConfig(e),
    // Step 27d: the payment gateway and the key that seals its passwords
    payments,
    // Step 28a: the couriers (fake or live) and the same key, for the courier accounts' keys
    shipping: shippingConfig(e, payments),
    // Step 26f: the public shop API (storefront/)
    storefront: {
      baseDomain: e.SHOP_BASE_DOMAIN,
      mediaUrl: storefrontMediaUrl(e),
      // Step 26g: how a shop's address starts and ends (storefront/shop-url.ts). https in
      // production, where the browser would refuse a shop on plain http anyway
      shopScheme: e.NODE_ENV === 'production' ? 'https' : 'http',
      shopPort: e.SHOP_PUBLIC_PORT ?? (e.NODE_ENV === 'production' ? null : 4321),
      // Step 27a: null = no shop server may call the order routes (STOREFRONT_SHOP_KEY above)
      shopKey: e.STOREFRONT_SHOP_KEY ?? null,
      codeKey: phoneCodeKey(e.JWT_SECRET),
    },
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
  const payments = paymentConfig(e);
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
    // Step 27d: the sweep asks the gateway before it deletes an unpaid online order
    payments,
    // Step 28a: the worker books the API parcels and polls the ones on their way
    shipping: shippingConfig(e, payments),
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
    // Step 28a (decision 4): booking a parcel tries five times too, but over about 15 minutes (1,
    // 2, 4 and 8 minutes apart): a courier's API that is down is usually down for minutes, not
    // seconds, and a parcel booked 10 minutes late is still picked up the same day. Then the
    // parcel fails, the bell rings and the page offers "Book again"
    courierRetry: {
      attempts: 5,
      backoffMs: 60_000,
    },
    // Published outbox rows are kept this long for debugging ("did the event go out?"), then
    // deleted by an hourly job
    outboxRetentionDays: 7,
  };
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
