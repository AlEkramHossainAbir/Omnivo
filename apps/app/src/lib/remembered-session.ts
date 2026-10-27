import { type MeResponse, meResponseSchema } from '@omnivo/contracts';

// Step 19a: what this browser keeps of the sign-in, for a reload with no connection (decision 2).
// The last `me` the server gave: the offline opening shows the app as that person, in that
// workspace. And a sign-out the server has not heard of yet. localStorage, not the device's
// database: the first page load reads it, and Dexie is not in the first page load.

const ME_KEY = 'omnivo.me';
const SIGN_OUT_KEY = 'omnivo.signOutPending';

// localStorage itself can throw (a sandboxed frame, storage turned off): then no storage.
// Exported for offline-session.ts, which reads the device's identity with it.
export function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// Every sign-in and every new `me` (session-store.ts). A storage that refuses (full, a private
// window) only means no offline opening on this device.
export function rememberMe(me: MeResponse): void {
  try {
    storage()?.setItem(ME_KEY, JSON.stringify(me));
  } catch {
    // Nothing to do: the app works as before step 19a
  }
}

// Every sign-out: the next offline reload shows the sign-in page
export function forgetMe(): void {
  try {
    storage()?.removeItem(ME_KEY);
  } catch {
    // A storage that cannot be read cannot be read at the next reload either
  }
}

// Checked, not trusted: a value from an older version of the app (a `me` without a field added
// since) or a hand-edited one is no `me`, and the app shows the sign-in page
export function rememberedMe(): MeResponse | null {
  try {
    const saved = storage()?.getItem(ME_KEY);
    if (saved === null || saved === undefined) return null;
    const parsed = meResponseSchema.safeParse(JSON.parse(saved));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Sign out with no connection (session.ts): the server still has the session, and the browser
// still has its cookie. Until the server hears of it, the app must never refresh that cookie.
export function markSignOutPending(): void {
  try {
    storage()?.setItem(SIGN_OUT_KEY, '1');
  } catch {
    // The storage refused: the next online reload signs the person in again (see the guide)
  }
}

export function signOutPending(): boolean {
  try {
    const saved = storage()?.getItem(SIGN_OUT_KEY);
    return saved !== null && saved !== undefined;
  } catch {
    return false;
  }
}

export function clearSignOutPending(): void {
  try {
    storage()?.removeItem(SIGN_OUT_KEY);
  } catch {
    // Nothing to clear in a storage that cannot be read
  }
}

// Step 19b (decision 6): "Lock now" is kept here, so a reload (online too) opens the lock screen.
// One value for the whole browser: whoever signs in next does it with the password, which ends
// the lock anyway. Only two things remove it: the right PIN (local-session.ts) and a sign-in with
// the password (session.ts). A sign-out keeps it: another tab that sees it go would open its copy.
export const LOCKED_KEY = 'omnivo.locked';

export function markLocked(): void {
  try {
    storage()?.setItem(LOCKED_KEY, '1');
  } catch {
    // The storage refused: the lock still holds in this page, but not after a reload
  }
}

export function clearLocked(): void {
  try {
    storage()?.removeItem(LOCKED_KEY);
  } catch {
    // Nothing to clear in a storage that cannot be read
  }
}

export function isLocked(): boolean {
  try {
    const saved = storage()?.getItem(LOCKED_KEY);
    return saved !== null && saved !== undefined;
  } catch {
    return false;
  }
}
