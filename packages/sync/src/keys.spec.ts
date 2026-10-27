import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { seal, unseal } from './crypto.js';
import type { SyncDatabase } from './database.js';
import {
  forgetPin,
  keyStatus,
  markPinAsked,
  MAX_WRONG_PINS,
  openKey,
  renewServerKey,
  setPin,
} from './keys.js';
import { newDatabase, SERVER_KEY } from './test-fixtures.js';

// Few rounds: 600,000 per PIN would make this file take minutes
const ROUNDS = 1000;
const PIN = '482913';
const OTHER_SERVER_KEY = new Uint8Array(32).fill(9);

async function opened(db: SyncDatabase, unlock: Parameters<typeof openKey>[1]) {
  const result = await openKey(db, unlock);
  if (result.kind !== 'open') throw new Error(`not opened: ${result.kind}`);
  return result.key;
}

async function withPin(): Promise<SyncDatabase> {
  const db = newDatabase();
  expect(await setPin(db, { serverKey: SERVER_KEY }, PIN, ROUNDS)).toEqual({ kind: 'set' });
  return db;
}

describe('openKey', () => {
  it('makes the data key the first time, and opens the same one after', async () => {
    const db = newDatabase();
    expect(await keyStatus(db)).toMatchObject({ exists: false, hasPin: false });
    const first = await opened(db, { serverKey: SERVER_KEY });
    const box = await seal(first, 'units\nu1', { code: 'pcs' });
    const again = await opened(db, { serverKey: SERVER_KEY });
    expect(await unseal(again, 'units\nu1', box)).toEqual({ code: 'pcs' });
    expect(await keyStatus(db)).toMatchObject({ exists: true, hasPin: false });
  });

  it('says key-changed when another server key comes, and no-pin offline without a PIN', async () => {
    const db = newDatabase();
    await opened(db, { serverKey: SERVER_KEY });
    expect(await openKey(db, { serverKey: OTHER_SERVER_KEY })).toEqual({ kind: 'key-changed' });
    expect(await openKey(db, { pin: PIN })).toEqual({ kind: 'no-pin' });
    // A device never opened has no key at all: the PIN cannot open it either
    expect(await openKey(newDatabase(), { pin: PIN })).toEqual({ kind: 'no-pin' });
  });

  it('opens the same key with the PIN as with the server key', async () => {
    const db = await withPin();
    const online = await opened(db, { serverKey: SERVER_KEY });
    const box = await seal(online, 'units\nu1', { code: 'pcs' });
    expect(await unseal(await opened(db, { pin: PIN }), 'units\nu1', box)).toEqual({ code: 'pcs' });
    expect(await keyStatus(db)).toMatchObject({ hasPin: true, wrongPins: 0 });
    expect((await db.keys.get('data'))?.pin?.iterations).toBe(ROUNDS);
  });
});

describe('wrong PINs', () => {
  it('counts them, and the right one starts the count again', async () => {
    const db = await withPin();
    expect(await openKey(db, { pin: '000000' })).toEqual({ kind: 'wrong-pin', left: 4 });
    expect(await openKey(db, { pin: '000001' })).toEqual({ kind: 'wrong-pin', left: 3 });
    await opened(db, { pin: PIN });
    expect((await keyStatus(db)).wrongPins).toBe(0);
  });

  it('turns the PIN off at the fifth, until a new one is set online', async () => {
    const db = await withPin();
    for (let wrong = 1; wrong < MAX_WRONG_PINS; wrong += 1) {
      expect((await openKey(db, { pin: '000000' })).kind).toBe('wrong-pin');
    }
    expect(await openKey(db, { pin: '000000' })).toEqual({ kind: 'pin-blocked' });
    // The wrap is gone: the right PIN cannot open it any more either
    expect((await db.keys.get('data'))?.pin).toBeNull();
    expect(await openKey(db, { pin: PIN })).toEqual({ kind: 'pin-blocked' });
    expect(await keyStatus(db)).toMatchObject({ hasPin: false, pinBlocked: true });
    // Online, the server key still opens the copy; then a new PIN
    await opened(db, { serverKey: SERVER_KEY });
    expect(await setPin(db, { serverKey: SERVER_KEY }, '193746', ROUNDS)).toEqual({ kind: 'set' });
    expect(await keyStatus(db)).toMatchObject({ hasPin: true, pinBlocked: false });
    await opened(db, { pin: '193746' });
  });

  it('counts a wrong current PIN when the PIN is changed', async () => {
    const db = await withPin();
    expect(await setPin(db, { pin: '000000' }, '193746', ROUNDS)).toEqual({
      kind: 'wrong-pin',
      left: 4,
    });
    expect(await setPin(db, { pin: PIN }, '193746', ROUNDS)).toEqual({ kind: 'set' });
    expect((await openKey(db, { pin: PIN })).kind).toBe('wrong-pin');
    await opened(db, { pin: '193746' });
  });

  it('refuses a PIN that is not six digits', async () => {
    await expect(
      setPin(newDatabase(), { serverKey: SERVER_KEY }, '1234', ROUNDS),
    ).rejects.toThrow();
  });
});

describe('renewServerKey', () => {
  it('wraps the key again for a new server key, with the PIN', async () => {
    const db = await withPin();
    expect(await openKey(db, { serverKey: OTHER_SERVER_KEY })).toEqual({ kind: 'key-changed' });
    expect(await renewServerKey(db, PIN, OTHER_SERVER_KEY)).toEqual({ kind: 'set' });
    await opened(db, { serverKey: OTHER_SERVER_KEY });
    expect(await openKey(db, { serverKey: SERVER_KEY })).toEqual({ kind: 'key-changed' });
  });
});

describe('asking for a PIN', () => {
  it('asks until a PIN is set or the person says not now', async () => {
    const db = newDatabase();
    await opened(db, { serverKey: SERVER_KEY });
    expect((await keyStatus(db)).pinAsked).toBe(false);
    await markPinAsked(db);
    expect(await keyStatus(db)).toMatchObject({ hasPin: false, pinAsked: true });
  });

  it('asks again after a forgotten PIN and after the fifth wrong one', async () => {
    const db = await withPin();
    expect((await keyStatus(db)).pinAsked).toBe(true);
    await forgetPin(db);
    expect(await keyStatus(db)).toMatchObject({
      hasPin: false,
      pinBlocked: false,
      pinAsked: false,
    });
    expect(await openKey(db, { pin: PIN })).toEqual({ kind: 'no-pin' });
    expect(await setPin(db, { serverKey: SERVER_KEY }, PIN, ROUNDS)).toEqual({ kind: 'set' });
    for (let wrong = 0; wrong < MAX_WRONG_PINS; wrong += 1) await openKey(db, { pin: '000000' });
    expect(await keyStatus(db)).toMatchObject({ pinBlocked: true, pinAsked: false });
  });
});
