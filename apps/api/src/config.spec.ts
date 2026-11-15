import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

// Step 26f: the shop's settings in the API's config. Every other value is the same as in
// testConfig (testing/app.ts); only the ones under test change.
function env(extra: Record<string, string>): Record<string, string> {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://omnivo_app:app@localhost:5432/omnivo',
    REDIS_URL: 'redis://localhost:6379',
    API_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: 'http://localhost:5173',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32-bytes',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-bytes',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY_ID: 'omnivo',
    S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
    ...extra,
  };
}

describe('storefront config', () => {
  it('serves the photos from the storage bucket in dev, on localhost', () => {
    const { storefront } = loadConfig(env({}));
    expect(storefront).toEqual({
      baseDomain: 'localhost',
      mediaUrl: 'http://localhost:9000/omnivo',
    });
  });

  it('takes the public address and the base domain, without a slash at the end', () => {
    const { storefront } = loadConfig(
      env({
        NODE_ENV: 'production',
        SHOP_BASE_DOMAIN: 'omnivo.shop',
        STOREFRONT_MEDIA_URL: 'https://media.omnivo.shop/',
      }),
    );
    expect(storefront).toEqual({
      baseDomain: 'omnivo.shop',
      mediaUrl: 'https://media.omnivo.shop',
    });
  });

  // The contract takes http only on this computer, so a production API with an http address would
  // answer every shop page with a broken contract. It refuses to start instead, and says why
  it('refuses to start in production with photos on plain http', () => {
    expect(() => loadConfig(env({ NODE_ENV: 'production' }))).toThrow(/https address/);
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', STOREFRONT_MEDIA_URL: 'http://media.omnivo.shop' })),
    ).toThrow(/STOREFRONT_MEDIA_URL/);
  });

  it('refuses a base domain that is not one lower-case DNS name', () => {
    for (const domain of ['Omnivo.shop', 'omnivo.shop:4331', '.omnivo.shop', 'omnivo.shop.']) {
      expect(() => loadConfig(env({ SHOP_BASE_DOMAIN: domain })), domain).toThrow(
        /Invalid environment/,
      );
    }
  });
});
