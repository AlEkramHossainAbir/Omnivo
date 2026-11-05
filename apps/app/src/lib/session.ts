// The route groups by name, not the whole `routes` map: this file is in the first page load, and
// `routes` would bring every module's schemas into it (step 12 found the first load over budget)
import {
  type AcceptInvitationInput,
  type AuthSession,
  authRoutes,
  invitationRoutes,
  type LoginInput,
  type SignUpInput,
} from '@omnivo/contracts';

import { call, isNoAnswer, refreshSession } from './api';
import { applyPreferences } from './preferences';
import { queryClient } from './query-client';
import {
  clearLocked,
  clearSignOutPending,
  markSignOutPending,
  signOutPending,
} from './remembered-session';
import { type SignOutNotice, sessionStore } from './session-store';

async function startSession(session: AuthSession): Promise<void> {
  sessionStore.getState().setAccessToken(session.accessToken);
  const me = await call(authRoutes.me);
  // আগের ইউজার বা workspace-এর ক্যাশ করা ডেটা (টিম, ইনভয়েস) নতুন session-এ এক মুহূর্তের জন্যও
  // দেখা যাবে না — signIn-এর আগে মোছা, তাই নতুন পেজ খালি ক্যাশ থেকে আনে
  queryClient.clear();
  // signIn-এর আগে: প্রথম পেজটাই ইউজারের ভাষা আর থিমে আঁকা হয়, এক ঝলক ভুল ভাষায় না
  await applyPreferences(me.preferences);
  sessionStore.getState().signIn(me);
}

// কোম্পানির নাম বদলানোর পরে switcher আর সাইডবারে নতুন নাম
export async function refreshMe(): Promise<void> {
  sessionStore.getState().setMe(await call(authRoutes.me));
}

// পেজ reload-এ memory-র টোকেন হারায়; httpOnly cookie দিয়ে নতুন টোকেন আনা।
// module-level promise: React StrictMode বা একাধিক route একসাথে ডাকলেও refresh একবারই যায়
let restoring: Promise<void> | null = null;

export function restoreSession(): Promise<void> {
  restoring ??= (async () => {
    // Step 19a: signed out with no connection. The cookie still works, so it is never refreshed:
    // the sign-out is sent first, and the person stays signed out whatever the answer.
    if (signOutPending()) {
      await sendPendingSignOut();
      sessionStore.getState().signOut();
      return;
    }
    try {
      const session = await refreshSession();
      if (session) {
        await startSession(session);
        return;
      }
    } catch (error) {
      // API বন্ধ বা নেটওয়ার্ক নেই — reject হলে প্রতিটা route চিরতরে ভাঙত; লগইন পেজ দেখানোই নিরাপদ,
      // সেখানে চেষ্টা করলে network_error-এর লেখা দেখাবে।
      // Step 19a (decision 2): no answer, and this browser remembers the last person and their copy:
      // the app opens as that person. import(): only such a reload loads the code.
      // Step 19b: a copy without a PIN does not open (decision 5); the sign-in page says why.
      if (isNoAnswer(error)) {
        const opened = await openOffline();
        if (opened === 'opened') return;
        if (opened === 'no-pin') {
          sessionStore.getState().signOut('no_pin');
          return;
        }
      }
    }
    sessionStore.getState().signOut();
  })();
  return restoring;
}

// A failure to load the chunk (no worker yet, and no connection) is the sign-in page, as before
async function openOffline(): Promise<'opened' | 'no-pin' | 'none'> {
  try {
    const offline = await import('./offline-session');
    return await offline.openOffline();
  } catch {
    return 'none';
  }
}

// Step 19a: any answer ends the wait (the server cleared the cookie, or there was no session to
// end); no answer keeps it for the next try
async function sendPendingSignOut(): Promise<void> {
  try {
    await call(authRoutes.logout);
    clearSignOutPending();
  } catch (error) {
    if (!isNoAnswer(error)) clearSignOutPending();
  }
}

// Step 19a: a sign-out still waiting goes before the new sign-in. After it, the new cookie takes
// the old one's place in the browser, and the old session could not be ended from here any more.
// Step 19b: the password proves the person as well as the PIN does, so it ends "Lock now". Not in
// startSession: a reload's refresh proves nothing, and must keep the lock screen.
async function signInWith(request: () => Promise<AuthSession>): Promise<void> {
  if (signOutPending()) await sendPendingSignOut();
  const session = await request();
  clearLocked();
  await startSession(session);
}

export function login(input: LoginInput): Promise<void> {
  return signInWith(() => call(authRoutes.login, { body: input }));
}

export function signUp(input: SignUpInput): Promise<void> {
  return signInWith(() => call(authRoutes.signUp, { body: input }));
}

// invitation গ্রহণ = লগইন: উত্তরে একই session, আর সেই workspace-এ। আগে অন্য অ্যাকাউন্টে লগইন থাকলে
// startSession সেটার ক্যাশ মুছে নতুনটা বসায়
export function acceptInvitation(input: AcceptInvitationInput): Promise<void> {
  return signInWith(() => call(invitationRoutes.accept, { body: input }));
}

export async function switchTenant(tenantId: string): Promise<void> {
  await startSession(await call(authRoutes.switchTenant, { body: { tenantId } }));
}

// Step 19a: no connection. The person is signed out here at once; the server hears of it at the
// next reload or sign-in, and until then the cookie is never refreshed. A refusal is an answer:
// there was no session left to end.
async function endSession(notice?: SignOutNotice): Promise<void> {
  try {
    await call(authRoutes.logout);
  } catch (error) {
    if (isNoAnswer(error)) markSignOutPending();
  } finally {
    // নেটওয়ার্ক ব্যর্থ হলেও এই ট্যাবে লগআউট দেখাতে হবে, আর আগের ইউজারের ক্যাশ মুছতে হবে
    queryClient.clear();
    sessionStore.getState().signOut(notice);
  }
}

// Step 19b (decision 31): "Forgot PIN?" and a PIN that stopped working. The person is sent to prove
// themself with the password, so the sign-in ends on the server too: a cookie still valid would
// let the next reload in without it. The copy stays: the password opens it with the server's key.
export function signInAgain(): Promise<void> {
  return endSession('pin_reset');
}

export async function logout(): Promise<void> {
  const me = sessionStore.getState().me;
  // Step 20a: the device lets go of its POS register first, while the session still works. The
  // module is loaded already (the AppFrame's host brought it); a release that fails never stops
  // the sign-out.
  await import('./local-session')
    .then(({ releaseRegister }) => releaseRegister())
    .catch(() => undefined);
  try {
    await endSession();
  } finally {
    // Step 18a: the copy of the workspace's data on this device goes too (decision 41). import():
    // local-session brings Dexie, which the first page load must not carry. A browser that refuses
    // to delete it changes nothing for the sign-out.
    if (me) {
      void import('./local-session')
        .then(({ deleteLocalData }) => deleteLocalData(me.tenant.id, me.user.id))
        .catch(() => undefined);
    }
  }
}
