import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

// This browser as a device of one person in one workspace (decision 7). Kept in localStorage, not
// in the local database: signing out deletes the database (the data is the workspace's), but the
// browser stays the same device, so the next sign-in does not register a second one.
export interface DeviceIdentity {
  // Made here, a UUIDv7 like every id (decision 20)
  id: string;
  // The branch it was registered in. null = not registered yet.
  branchId: string | null;
  // The person pressed "Not now" in the branch dialog (decision 40): do not ask again by itself
  later: boolean;
}

// What another version of the app (or a person in the browser's tools) may have left there is
// checked, not trusted: a broken value gives a new identity, never a crash
const identitySchema = z.object({
  id: z.uuidv7(),
  branchId: z.uuid().nullable(),
  later: z.boolean(),
});

// Step 18c: exported for the app's `storage` listener, which follows a move or a revoke made in
// another tab of the same browser
export function deviceStorageKey(tenantId: string, userId: string): string {
  return `omnivo.device.${tenantId}.${userId}`;
}

// A storage that can refuse: Safari in a private window throws on setItem, and a page may be
// opened where localStorage is turned off
export type IdentityStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readDevice(
  storage: IdentityStorage | null,
  tenantId: string,
  userId: string,
): DeviceIdentity {
  try {
    const saved = storage?.getItem(deviceStorageKey(tenantId, userId));
    if (saved !== null && saved !== undefined) {
      const parsed = identitySchema.safeParse(JSON.parse(saved));
      if (parsed.success) return parsed.data;
    }
  } catch {
    // Unreadable or not JSON: a new identity below
  }
  return { id: uuidv7(), branchId: null, later: false };
}

// false = not saved (the storage refused). The app keeps the identity in memory for this visit;
// the next visit registers again with a new id, which is only an extra row in the device list.
export function saveDevice(
  storage: IdentityStorage | null,
  tenantId: string,
  userId: string,
  identity: DeviceIdentity,
): boolean {
  try {
    storage?.setItem(deviceStorageKey(tenantId, userId), JSON.stringify(identity));
    return storage !== null;
  } catch {
    return false;
  }
}

// Step 18c (decision 4): a revoked device is never used again. Without a saved identity, the next
// readDevice makes a new id, so the next set-up registers a new device. false = the storage
// refused; the revoked id then stays, and registering it again finds it revoked once more.
// Its own storage type: reading and saving never remove, and a caller that only reads and saves
// (a test's stand-in) need not write a removeItem
export function forgetDevice(
  storage: Pick<Storage, 'removeItem'> | null,
  tenantId: string,
  userId: string,
): boolean {
  try {
    storage?.removeItem(deviceStorageKey(tenantId, userId));
    return storage !== null;
  } catch {
    return false;
  }
}

export function newDeviceId(): string {
  return uuidv7();
}

// "Chrome" and "Windows" for the name a device gets without a question (decision 12). The app
// puts them into devices.defaultName in the person's language. The order matters: Edge, Opera
// and Samsung Internet also say "Chrome" in their user agent, and Chrome also says "Safari".
const BROWSERS: readonly [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Version\/.*Safari\//, 'Safari'],
];

// Android before Linux (an Android user agent says both), iPhone and iPad before Mac OS X
const SYSTEMS: readonly [RegExp, string][] = [
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

// null when either is unknown: the app then uses devices.fallbackName ("Web browser")
export function deviceNameParts(userAgent: string): { browser: string; os: string } | null {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return browser === undefined || os === undefined ? null : { browser, os };
}
