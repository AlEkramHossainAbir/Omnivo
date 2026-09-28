import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { createAccessTokens } from './access-token.js';

const config = {
  secret: 'test-secret-that-is-at-least-32-bytes-long',
  issuer: 'http://localhost:3000',
  audience: 'omnivo-api',
  ttlSeconds: 900,
};

const claims = {
  userId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8e',
  tenantId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8f',
  membershipId: '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d90',
  roles: ['Owner'],
};

describe('access tokens', () => {
  it('round-trips the claims', async () => {
    const tokens = createAccessTokens(config);
    const { token, expiresAt } = await tokens.sign(claims);
    const principal = await tokens.verify(token);
    expect(principal).toMatchObject(claims);
    expect(principal?.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it('rejects a token signed with another secret', async () => {
    const other = createAccessTokens({
      ...config,
      secret: 'another-secret-that-is-32-bytes-long!!',
    });
    const { token } = await other.sign(claims);
    expect(await createAccessTokens(config).verify(token)).toBeNull();
  });

  it('rejects a token for another audience', async () => {
    const other = createAccessTokens({ ...config, audience: 'someone-else' });
    const { token } = await other.sign(claims);
    expect(await createAccessTokens(config).verify(token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const tokens = createAccessTokens({ ...config, ttlSeconds: -10 });
    const { token } = await tokens.sign(claims);
    expect(await tokens.verify(token)).toBeNull();
  });

  it('rejects an unsigned (alg: none) token', async () => {
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({ sub: claims.userId, iss: config.issuer, aud: config.audience }),
      ).toString('base64url'),
      '',
    ].join('.');
    expect(await createAccessTokens(config).verify(unsigned)).toBeNull();
  });

  it('rejects a correctly signed token without our custom claims', async () => {
    const key = new TextEncoder().encode(config.secret);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setExpirationTime('5m')
      .setJti('x')
      .sign(key);
    expect(await createAccessTokens(config).verify(token)).toBeNull();
  });

  it('refuses a short secret at startup', () => {
    expect(() => createAccessTokens({ ...config, secret: 'short' })).toThrow(/at least 32 bytes/);
  });
});
