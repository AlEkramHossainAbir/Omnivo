import { shopOrderTokenSchema, shopTrackingTokenSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { codeHash, codeMatches, newCode, newToken, tokenHash } from './order-secrets.js';

const KEY = Buffer.alloc(32, 7);
const ORDER = tokenHash('order-token');

describe('order secrets', () => {
  it('makes tokens the contract takes, never the same twice', () => {
    const tokens = new Set(Array.from({ length: 100 }, newToken));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(shopOrderTokenSchema.safeParse(token).success).toBe(true);
      expect(shopTrackingTokenSchema.safeParse(token).success).toBe(true);
    }
  });

  it('hashes a token to the 64 hex characters the database checks', () => {
    expect(tokenHash('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash('abc')).toBe(tokenHash('abc'));
  });

  it('makes six-digit codes, leading zeros kept', () => {
    for (let i = 0; i < 200; i += 1) expect(newCode()).toMatch(/^\d{6}$/);
  });

  it('matches only the right code of the right order with the right key', () => {
    const stored = codeHash(KEY, ORDER, '042317');
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(codeMatches(KEY, ORDER, '042317', stored)).toBe(true);
    expect(codeMatches(KEY, ORDER, '042318', stored)).toBe(false);
    expect(codeMatches(KEY, tokenHash('another order'), '042317', stored)).toBe(false);
    expect(codeMatches(Buffer.alloc(32, 8), ORDER, '042317', stored)).toBe(false);
    // A broken stored value never matches, and never throws
    expect(codeMatches(KEY, ORDER, '042317', 'abc')).toBe(false);
  });
});
