import { describe, expect, it } from 'vitest';

import { type CredentialsKey, openSecret, sealSecret } from './credentials.js';

const KEY: CredentialsKey = { version: 1, key: Buffer.alloc(32, 1) };
const TENANT = '0196f3b0-0000-7000-8000-000000000001';
const OTHER = '0196f3b0-0000-7000-8000-000000000002';

describe('gateway password seal (step 27d.3)', () => {
  it('opens what it sealed, and seals the same password differently each time', () => {
    const first = sealSecret(KEY, TENANT, 'nirvo67412bc0d9f1e@ssl');
    const second = sealSecret(KEY, TENANT, 'nirvo67412bc0d9f1e@ssl');
    expect(first.keyVersion).toBe(1);
    expect(first.sealed.equals(second.sealed)).toBe(false);
    expect(openSecret(KEY, TENANT, first.sealed, 1)).toBe('nirvo67412bc0d9f1e@ssl');
    // The database's check: nonce + tag + at least one byte
    expect(first.sealed.length).toBe(12 + 16 + 'nirvo67412bc0d9f1e@ssl'.length);
  });

  it('keeps a space and Bangla letters as they were typed', () => {
    const { sealed } = sealSecret(KEY, TENANT, ' পাসওয়ার্ড ');
    expect(openSecret(KEY, TENANT, sealed, 1)).toBe(' পাসওয়ার্ড ');
  });

  it('does not open in another workspace, with another key, or once a bit changed', () => {
    const { sealed } = sealSecret(KEY, TENANT, 'secret');
    expect(openSecret(KEY, OTHER, sealed, 1)).toBeNull();
    expect(openSecret({ version: 1, key: Buffer.alloc(32, 2) }, TENANT, sealed, 1)).toBeNull();
    expect(openSecret(KEY, TENANT, sealed, 2)).toBeNull();
    const changed = Buffer.from(sealed);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    expect(openSecret(KEY, TENANT, changed, 1)).toBeNull();
    expect(openSecret(KEY, TENANT, sealed.subarray(0, 28), 1)).toBeNull();
  });
});
