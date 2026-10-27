import {
  isPin,
  newDataKey,
  newSalt,
  PIN_ITERATIONS,
  pinWrappingKey,
  serverWrappingKey,
  unwrapDataKey,
  wrapDataKey,
} from './crypto.js';
import type { SyncDatabase } from './database.js';

// Step 19b: the device's data key, kept wrapped in the copy's own database (the `keys` table, one
// row). Deleting the database (sign-out, revoke, a move) deletes the key with it. No Dexie import:
// the lock screen opens the key through the database the session holds.

// After this many wrong PINs in a row the PIN is turned off (decision 7): only a sign-in with the
// password, online, opens the copy again, and then the person sets a new PIN.
export const MAX_WRONG_PINS = 5;

export interface PinWrap {
  salt: Uint8Array<ArrayBuffer>;
  // Kept with the wrap, so a later version of the app can raise PIN_ITERATIONS and still open a
  // PIN set before
  iterations: number;
  wrapped: Uint8Array<ArrayBuffer>;
}

export interface KeyRecord {
  key: 'data';
  // The data key wrapped by the server's key for this device
  server: Uint8Array<ArrayBuffer>;
  // The data key wrapped by the PIN's key. null = no PIN on this device.
  pin: PinWrap | null;
  // Wrong PINs since the last right one. Clear, like the rest of this row: someone who copies the
  // database can reset it, but they can also guess outside the app, which no count stops (the
  // limit the guide states). The count stops a person at the screen.
  wrongPins: number;
  // The PIN was turned off by too many wrong ones: the app asks for a new one after the sign-in
  pinBlocked: boolean;
  // The app asked for a PIN since the last one went (none yet, too many wrong, forgotten), and the
  // person answered: a PIN, or "Not now". Kept here, so a new copy (a sign-out, a revoke) asks again.
  pinAsked: boolean;
}

// What opens the data key: the server's 32 bytes (online, after sign-in), or the PIN (offline,
// and the lock screen)
export type Unlock = { serverKey: Uint8Array<ArrayBuffer> } | { pin: string };

export type KeyProblem =
  | { kind: 'wrong-pin'; left: number }
  // Too many wrong PINs: the PIN is off until a sign-in with the password
  | { kind: 'pin-blocked' }
  // No PIN on this device (never set, or "Not now"): only the server's key opens it
  | { kind: 'no-pin' }
  // The server's key does not open this copy: the server's database was restored to a time before
  // this device registered, and it got a new key. The PIN can still open it (renewServerKey).
  | { kind: 'key-changed' };

export type KeyResult = { kind: 'open'; key: CryptoKey } | KeyProblem;

// For the lock screen and the PIN card: what this device has, without opening anything
export interface KeyStatus {
  // A key was made: the copy was opened once at least
  exists: boolean;
  hasPin: boolean;
  pinBlocked: boolean;
  wrongPins: number;
  pinAsked: boolean;
}

export async function keyStatus(db: SyncDatabase): Promise<KeyStatus> {
  const record = await db.keys.get('data');
  return {
    exists: record !== undefined,
    hasPin: record?.pin != null,
    pinBlocked: record?.pinBlocked ?? false,
    wrongPins: record?.wrongPins ?? 0,
    pinAsked: record?.pinAsked ?? false,
  };
}

// The first opening with the server's key makes the data key. Two tabs may do it at once: the
// transaction keeps the first one's record, and the other tab opens that one, so both tabs end with
// the same key.
async function createRecord(db: SyncDatabase, serverKey: CryptoKey): Promise<KeyRecord> {
  const record: KeyRecord = {
    key: 'data',
    server: await wrapDataKey(await newDataKey(), serverKey),
    pin: null,
    wrongPins: 0,
    pinBlocked: false,
    pinAsked: false,
  };
  return db.transaction('rw', db.keys, async () => {
    const first = await db.keys.get('data');
    if (first) return first;
    await db.keys.add(record);
    return record;
  });
}

// One wrong PIN more, counted in a transaction, so two tabs guessing at once both count. The fifth
// deletes the PIN's wrap: the copy is then closed to every PIN, not only to this screen.
async function countWrongPin(db: SyncDatabase): Promise<KeyProblem> {
  return db.transaction('rw', db.keys, async () => {
    const record = await db.keys.get('data');
    if (!record) return { kind: 'no-pin' };
    const wrongPins = record.wrongPins + 1;
    if (wrongPins >= MAX_WRONG_PINS) {
      await db.keys.put({ ...record, pin: null, wrongPins: 0, pinBlocked: true, pinAsked: false });
      return { kind: 'pin-blocked' };
    }
    await db.keys.put({ ...record, wrongPins });
    return { kind: 'wrong-pin', left: MAX_WRONG_PINS - wrongPins };
  });
}

// `extractable` only for a moment, to wrap the key again (setPin, renewServerKey); the copy itself
// always runs on a key the page cannot read out
async function unwrapWith(
  db: SyncDatabase,
  unlock: Unlock,
  extractable: boolean,
): Promise<KeyResult> {
  let record = await db.keys.get('data');
  if ('serverKey' in unlock) {
    const wrapping = await serverWrappingKey(unlock.serverKey);
    record ??= await createRecord(db, wrapping);
    const key = await unwrapDataKey(record.server, wrapping, extractable);
    return key ? { kind: 'open', key } : { kind: 'key-changed' };
  }
  if (!record?.pin) return { kind: record?.pinBlocked ? 'pin-blocked' : 'no-pin' };
  const { salt, iterations, wrapped } = record.pin;
  const key = await unwrapDataKey(
    wrapped,
    await pinWrappingKey(unlock.pin, salt, iterations),
    extractable,
  );
  if (!key) return countWrongPin(db);
  if (record.wrongPins > 0) await db.keys.update('data', { wrongPins: 0 });
  return { kind: 'open', key };
}

export function openKey(db: SyncDatabase, unlock: Unlock): Promise<KeyResult> {
  return unwrapWith(db, unlock, false);
}

// A new PIN: at set-up and on the Sync page (with the server's key, online), after "Forgot PIN?"
// (the same), or a change (with the current PIN, which a wrong guess here counts like the lock
// screen's). `iterations` is a parameter for the specs only: 600,000 rounds per test would take
// minutes.
export async function setPin(
  db: SyncDatabase,
  unlock: Unlock,
  pin: string,
  iterations: number = PIN_ITERATIONS,
): Promise<{ kind: 'set' } | KeyProblem> {
  if (!isPin(pin)) throw new Error('A PIN is six digits');
  const opened = await unwrapWith(db, unlock, true);
  if (opened.kind !== 'open') return opened;
  const salt = newSalt();
  const wrapped = await wrapDataKey(opened.key, await pinWrappingKey(pin, salt, iterations));
  await db.keys.update('data', {
    pin: { salt, iterations, wrapped },
    wrongPins: 0,
    pinBlocked: false,
    pinAsked: true,
  });
  return { kind: 'set' };
}

// "Not now" in the PIN dialog: not asked again on this copy. The Sync page's card still sets one.
export async function markPinAsked(db: SyncDatabase): Promise<void> {
  await db.keys.update('data', { pinAsked: true });
}

// "Forgot PIN?" on the lock screen, before the sign-in with the password. A PIN nobody remembers
// opens nothing for its owner, but someone could still guess it: so it goes, and the dialog asks
// for a new one after the sign-in.
export async function forgetPin(db: SyncDatabase): Promise<void> {
  await db.keys.update('data', { pin: null, wrongPins: 0, pinAsked: false });
}

// After key-changed: the PIN opens the copy, and the data key is wrapped again with the server's
// new key, so the next online opening needs no PIN
export async function renewServerKey(
  db: SyncDatabase,
  pin: string,
  serverKey: Uint8Array<ArrayBuffer>,
): Promise<{ kind: 'set' } | KeyProblem> {
  const opened = await unwrapWith(db, { pin }, true);
  if (opened.kind !== 'open') return opened;
  const server = await wrapDataKey(opened.key, await serverWrappingKey(serverKey));
  await db.keys.update('data', { server });
  return { kind: 'set' };
}
