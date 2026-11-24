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
    expect(storefront).toMatchObject({
      baseDomain: 'localhost',
      mediaUrl: 'http://localhost:9000/omnivo',
      shopScheme: 'http',
      shopPort: 4321,
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
    expect(storefront).toMatchObject({
      baseDomain: 'omnivo.shop',
      mediaUrl: 'https://media.omnivo.shop',
      shopScheme: 'https',
      shopPort: null,
    });
  });

  // Step 26g: the "View shop" link's port. The shop runs on its own port in dev only
  it('puts the shop port in the address only where one is set or in dev', () => {
    expect(loadConfig(env({ SHOP_PUBLIC_PORT: '4331' })).storefront.shopPort).toBe(4331);
    expect(
      loadConfig(
        env({
          NODE_ENV: 'production',
          STOREFRONT_MEDIA_URL: 'https://media.omnivo.shop',
          SHOP_PUBLIC_PORT: '8443',
        }),
      ).storefront.shopPort,
    ).toBe(8443);
    expect(() => loadConfig(env({ SHOP_PUBLIC_PORT: '70000' }))).toThrow(/Invalid environment/);
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

// Step 27a: the shop server's key and the phone code's key
describe('order keys', () => {
  it('has no shop key until one is set, and refuses a short one', () => {
    expect(loadConfig(env({})).storefront.shopKey).toBeNull();
    const key = 'a-shop-key-of-at-least-thirty-two-chars';
    expect(loadConfig(env({ STOREFRONT_SHOP_KEY: key })).storefront.shopKey).toBe(key);
    expect(() => loadConfig(env({ STOREFRONT_SHOP_KEY: 'short' }))).toThrow(/Invalid environment/);
  });

  it('derives the code key from JWT_SECRET: 32 bytes, never the secret itself', () => {
    const { codeKey } = loadConfig(env({})).storefront;
    expect(codeKey).toHaveLength(32);
    expect(codeKey.toString('utf8')).not.toContain('test-jwt-secret');
    // The same secret gives the same key (a code sent before a restart still works) …
    expect(loadConfig(env({})).storefront.codeKey.equals(codeKey)).toBe(true);
    // … and another secret another key
    const other = loadConfig(env({ JWT_SECRET: 'another-jwt-secret-that-is-32-bytes-long' }));
    expect(other.storefront.codeKey.equals(codeKey)).toBe(false);
  });
});

// Step 27d.3: the gateway and the key that seals its passwords
describe('payment config', () => {
  const production = { NODE_ENV: 'production', STOREFRONT_MEDIA_URL: 'https://files.example.com' };
  const key = Buffer.alloc(32, 7).toString('base64');

  it('uses the fake gateway outside production and SSLCommerz in production', () => {
    expect(loadConfig(env({})).payments.gateway).toBe('fake');
    expect(loadConfig(env(production)).payments.gateway).toBe('sslcommerz');
    expect(loadConfig(env({ PAYMENT_GATEWAY: 'sslcommerz' })).payments.gateway).toBe('sslcommerz');
  });

  it('refuses the fake gateway in production', () => {
    expect(() => loadConfig(env({ ...production, PAYMENT_GATEWAY: 'fake' }))).toThrow(
      /PAYMENT_GATEWAY=fake/,
    );
  });

  it('has no key until one is set, and takes only 32 bytes', () => {
    expect(loadConfig(env({})).payments.credentialsKey).toBeNull();
    const { credentialsKey } = loadConfig(env({ CREDENTIALS_KEY: key })).payments;
    expect(credentialsKey?.version).toBe(1);
    expect(credentialsKey?.key.equals(Buffer.alloc(32, 7))).toBe(true);
    const short = Buffer.alloc(16, 7).toString('base64');
    expect(() => loadConfig(env({ CREDENTIALS_KEY: short }))).toThrow(/Invalid environment/);
  });
});
