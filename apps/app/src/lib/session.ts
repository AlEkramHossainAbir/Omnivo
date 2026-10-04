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

import { call, refreshSession } from './api';
import { applyPreferences } from './preferences';
import { queryClient } from './query-client';
import { sessionStore } from './session-store';

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
    try {
      const session = await refreshSession();
      if (session) {
        await startSession(session);
        return;
      }
    } catch {
      // API বন্ধ বা নেটওয়ার্ক নেই — reject হলে প্রতিটা route চিরতরে ভাঙত; লগইন পেজ দেখানোই নিরাপদ,
      // সেখানে চেষ্টা করলে network_error-এর লেখা দেখাবে
    }
    sessionStore.getState().signOut();
  })();
  return restoring;
}

export async function login(input: LoginInput): Promise<void> {
  await startSession(await call(authRoutes.login, { body: input }));
}

export async function signUp(input: SignUpInput): Promise<void> {
  await startSession(await call(authRoutes.signUp, { body: input }));
}

// invitation গ্রহণ = লগইন: উত্তরে একই session, আর সেই workspace-এ। আগে অন্য অ্যাকাউন্টে লগইন থাকলে
// startSession সেটার ক্যাশ মুছে নতুনটা বসায়
export async function acceptInvitation(input: AcceptInvitationInput): Promise<void> {
  await startSession(await call(invitationRoutes.accept, { body: input }));
}

export async function switchTenant(tenantId: string): Promise<void> {
  await startSession(await call(authRoutes.switchTenant, { body: { tenantId } }));
}

export async function logout(): Promise<void> {
  try {
    await call(authRoutes.logout);
  } finally {
    // নেটওয়ার্ক ব্যর্থ হলেও এই ট্যাবে লগআউট দেখাতে হবে, আর আগের ইউজারের ক্যাশ মুছতে হবে
    queryClient.clear();
    sessionStore.getState().signOut();
  }
}
