import { describe, expect, it } from 'vitest';

import {
  isPin,
  newDataKey,
  pinWrappingKey,
  seal,
  serverWrappingKey,
  unseal,
  unwrapDataKey,
  wrapDataKey,
} from './crypto.js';

const LABEL = 'customers\n01928c4e-2222-7000-8000-000000000001';
const rahman = { name: 'Rahman Traders', phone: '01711-234567', creditLimit: '200000.0000' };

describe('seal and unseal', () => {
  it('gives back the value, and a new iv every time', async () => {
    const key = await newDataKey();
    const one = await seal(key, LABEL, rahman);
    const two = await seal(key, LABEL, rahman);
    expect(await unseal(key, LABEL, one)).toEqual(rahman);
    expect(one.slice(0, 12)).not.toEqual(two.slice(0, 12));
  });

  it('does not open under another label, with another key, or with one byte changed', async () => {
    const key = await newDataKey();
    const box = await seal(key, LABEL, rahman);
    // The same box under another customer's key: moved rows do not open
    await expect(
      unseal(key, 'customers\n01928c4e-2222-7000-8000-000000000002', box),
    ).rejects.toThrow();
    await expect(unseal(await newDataKey(), LABEL, box)).rejects.toThrow();
    const changed = box.slice();
    changed[20] = (changed[20] ?? 0) ^ 1;
    await expect(unseal(key, LABEL, changed)).rejects.toThrow();
  });
});

describe('wrapping the data key', () => {
  it('opens with the wrapping key only, and as a key the page cannot read out', async () => {
    const dataKey = await newDataKey();
    const server = await serverWrappingKey(new Uint8Array(32).fill(1));
    const wrapped = await wrapDataKey(dataKey, server);
    const opened = await unwrapDataKey(wrapped, server, false);
    if (!opened) throw new Error('not opened');
    expect(await unseal(opened, LABEL, await seal(dataKey, LABEL, rahman))).toEqual(rahman);
    await expect(crypto.subtle.exportKey('raw', opened)).rejects.toThrow();
    const other = await serverWrappingKey(new Uint8Array(32).fill(2));
    expect(await unwrapDataKey(wrapped, other, false)).toBeNull();
  });

  it('turns a PIN and its salt into the same key every time, and another PIN into another', async () => {
    const salt = new Uint8Array(16).fill(3);
    const dataKey = await newDataKey();
    const wrapped = await wrapDataKey(dataKey, await pinWrappingKey('482913', salt, 1000));
    expect(
      await unwrapDataKey(wrapped, await pinWrappingKey('482913', salt, 1000), false),
    ).not.toBeNull();
    expect(
      await unwrapDataKey(wrapped, await pinWrappingKey('482914', salt, 1000), false),
    ).toBeNull();
    // The rounds are part of the key: a PIN set with other rounds needs them to open
    expect(
      await unwrapDataKey(wrapped, await pinWrappingKey('482913', salt, 1001), false),
    ).toBeNull();
  });

  it('refuses a server key that is not 32 bytes', () => {
    expect(() => serverWrappingKey(new Uint8Array(16))).toThrow();
  });
});

describe('isPin', () => {
  it('takes six ASCII digits only', () => {
    expect(isPin('048213')).toBe(true);
    expect(isPin('48213')).toBe(false);
    expect(isPin('4821390')).toBe(false);
    // Bangla digits are turned into ASCII by the app before
    expect(isPin('৪৮২৯১৩')).toBe(false);
    expect(isPin('48 213')).toBe(false);
  });
});
