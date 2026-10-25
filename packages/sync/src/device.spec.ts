import { describe, expect, it } from 'vitest';

import {
  deviceNameParts,
  forgetDevice,
  type IdentityStorage,
  readDevice,
  saveDevice,
} from './device.js';

const TENANT = '01928c4e-2222-7000-8000-000000000001';
const USER = '01928c4e-3333-7000-8000-000000000001';
const BRANCH = '01928c4e-4444-7000-8000-000000000001';

function memoryStorage(): IdentityStorage &
  Pick<Storage, 'removeItem'> & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

describe('readDevice / saveDevice', () => {
  it('makes a new UUIDv7 identity the first time, and reads the saved one after', () => {
    const storage = memoryStorage();
    const fresh = readDevice(storage, TENANT, USER);
    expect(fresh).toMatchObject({ branchId: null, later: false });
    expect(fresh.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(saveDevice(storage, TENANT, USER, { ...fresh, branchId: BRANCH })).toBe(true);
    expect(readDevice(storage, TENANT, USER)).toEqual({ ...fresh, branchId: BRANCH });
  });

  it('keeps one identity per person and workspace', () => {
    const storage = memoryStorage();
    const mine = readDevice(storage, TENANT, USER);
    saveDevice(storage, TENANT, USER, mine);
    const theirs = readDevice(storage, TENANT, BRANCH);
    expect(theirs.id).not.toBe(mine.id);
  });

  it('does not trust what it finds: a broken value gives a new identity', () => {
    const storage = memoryStorage();
    storage.items.set(`omnivo.device.${TENANT}.${USER}`, '{"id":"not-a-uuid","branchId":null}');
    expect(readDevice(storage, TENANT, USER).id).toMatch(/^[0-9a-f-]{36}$/);
    storage.items.set(`omnivo.device.${TENANT}.${USER}`, '{oops');
    expect(readDevice(storage, TENANT, USER).branchId).toBeNull();
  });

  it('works without a storage, or with one that throws (Safari private window)', () => {
    const refusing: IdentityStorage & Pick<Storage, 'removeItem'> = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const identity = readDevice(refusing, TENANT, USER);
    expect(saveDevice(refusing, TENANT, USER, identity)).toBe(false);
    expect(saveDevice(null, TENANT, USER, identity)).toBe(false);
    expect(readDevice(null, TENANT, USER).branchId).toBeNull();
    expect(forgetDevice(refusing, TENANT, USER)).toBe(false);
    expect(forgetDevice(null, TENANT, USER)).toBe(false);
  });
});

describe('forgetDevice', () => {
  it('drops the saved identity, so the next read makes a new id (step 18c, decision 4)', () => {
    const storage = memoryStorage();
    const revoked = { ...readDevice(storage, TENANT, USER), branchId: BRANCH };
    saveDevice(storage, TENANT, USER, revoked);
    const other = { ...readDevice(storage, TENANT, BRANCH), branchId: BRANCH };
    saveDevice(storage, TENANT, BRANCH, other);

    expect(forgetDevice(storage, TENANT, USER)).toBe(true);
    const next = readDevice(storage, TENANT, USER);
    expect(next.id).not.toBe(revoked.id);
    expect(next).toMatchObject({ branchId: null, later: false });
    // Another person's identity on the same browser stays
    expect(readDevice(storage, TENANT, BRANCH)).toEqual(other);
  });
});

describe('deviceNameParts', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      { browser: 'Chrome', os: 'Windows' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      { browser: 'Edge', os: 'Windows' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
      { browser: 'Samsung Internet', os: 'Android' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', os: 'iOS' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:143.0) Gecko/20100101 Firefox/143.0',
      { browser: 'Firefox', os: 'macOS' },
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/122.0.0.0',
      { browser: 'Opera', os: 'Linux' },
    ],
  ])('%s', (userAgent, expected) => {
    expect(deviceNameParts(userAgent)).toEqual(expected);
  });

  it('gives null for a browser it does not know', () => {
    expect(deviceNameParts('curl/8.7.1')).toBeNull();
  });
});
