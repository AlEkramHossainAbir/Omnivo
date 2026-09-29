import { z } from 'zod';

// process.env-এর সব মান string | undefined — এখানে একবার যাচাই করে টাইপ-নিরাপদ Config বানানো
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  API_BASE_URL: z.url(),
  APP_ORIGIN: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  JWT_SECRET: z.string().min(32),
});

const DAY = 24 * 60 * 60;

export function loadConfig(env: Record<string, string | undefined>) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment — compare your .env with .env.example:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const e = parsed.data;
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
