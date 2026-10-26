import { authRoutes, type MeResponse } from '@omnivo/contracts';
import { readDevice } from '@omnivo/sync';

import { call, refreshSession, setOfflineCheck } from './api';
import { applyPreferences } from './preferences';
import { queryClient } from './query-client';
import { rememberedMe, storage } from './remembered-session';
import { sessionStore } from './session-store';

// Step 19a (decision 2): a reload with no answer from the server opens the app as the last person,
// with the `me` the browser remembered, on their copy of the data. session.ts loads this file with
// import(), only after such a reload: the first page load of every other visit does not carry it.
// The service worker keeps its chunk like every other, so it loads with no connection.

// Only a device set up for that person opens: a branch chosen, so the copy was pulled (step 18a).
// A revoked device has no identity any more (step 18c), so it never opens offline; neither does a
// person who pressed "Not now" in the branch dialog, who has no copy to open.
function hasCopy(me: MeResponse): boolean {
  return readDevice(storage(), me.tenant.id, me.user.id).branchId !== null;
}

export async function openOffline(): Promise<boolean> {
  const me = rememberedMe();
  if (!me || !hasCopy(me)) return false;
  // The person's theme and language, as after an online sign-in. The Bangla words are a chunk of
  // their own; the worker keeps it. Failing to load them only leaves the page in English.
  await applyPreferences(me.preferences).catch(() => undefined);
  sessionStore.getState().openOffline(me);
  watchForServer();
  return true;
}

// Read again after each await: a sign-out may end the offline opening at any of them
function stillOffline(): boolean {
  return sessionStore.getState().openedOffline;
}

// The check runs when the browser says the connection is back, and every minute while it says it
// is online: a reload while the API was down (a 502) opened offline with the browser online, and
// no `online` event comes then. Both stop when the offline opening ends, however it ends.
function watchForServer(): void {
  const again = () => {
    void resume().catch(() => undefined);
  };
  const timer = setInterval(() => {
    if (navigator.onLine) again();
  }, 60_000);
  window.addEventListener('online', again);
  const unsubscribe = sessionStore.subscribe((state) => {
    if (state.openedOffline) return;
    clearInterval(timer);
    window.removeEventListener('online', again);
    unsubscribe();
  });
}

// One check at a time: the `online` event, the timer and the first 401 of api.ts often come
// together, and each refresh uses the cookie up (the server rotates it)
let checking: Promise<string | null> | null = null;

function resume(): Promise<string | null> {
  checking ??= check().finally(() => {
    checking = null;
  });
  return checking;
}

// The new token, or null when the server refused the sign-in. Throws while there is still no
// answer: the opening stays as it is, and the next check tries again.
async function check(): Promise<string | null> {
  const remembered = sessionStore.getState().me;
  if (!stillOffline() || !remembered) return null;
  const session = await refreshSession();
  if (!stillOffline()) return null;
  if (!session) {
    // Refused: the sign-in expired, the password was reset, the person was removed, or the device
    // was revoked (the server ends its session and says no more). Signed out as after any refused
    // refresh, and the remembered `me` goes with it, but the copy stays (decision 19).
    queryClient.clear();
    sessionStore.getState().signOut('session_ended');
    return null;
  }
  sessionStore.getState().setAccessToken(session.accessToken);
  const me = await call(authRoutes.me);
  if (!stillOffline()) return session.accessToken;
  await applyPreferences(me.preferences).catch(() => undefined);
  if (me.user.id !== remembered.user.id || me.tenant.id !== remembered.tenant.id) {
    // The cookie is another sign-in's (another tab signed in as someone else while this one was
    // offline). That sign-in wins, from an empty cache, as in session.ts's startSession; the
    // LocalDataHost then opens that person's copy, and this one stays for its owner.
    queryClient.clear();
    sessionStore.getState().signIn(me);
    return session.accessToken;
  }
  sessionStore.getState().signIn(me);
  // What failed or read the device while offline asks again. invalidate, not clear: the screens
  // keep showing what they have until the answer comes, and an open form keeps its pickers.
  void queryClient.invalidateQueries();
  return session.accessToken;
}

setOfflineCheck(resume);
