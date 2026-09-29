import { type AuthSession, type LoginInput, routes, type SignUpInput } from '@omnivo/contracts';

import { call, refreshSession } from './api';
import { queryClient } from './query-client';
import { sessionStore } from './session-store';

async function startSession(session: AuthSession): Promise<void> {
  sessionStore.getState().setAccessToken(session.accessToken);
  const me = await call(routes.auth.me);
  // আগের ইউজার বা workspace-এর ক্যাশ করা ডেটা (টিম, ইনভয়েস) নতুন session-এ এক মুহূর্তের জন্যও
  // দেখা যাবে না — signIn-এর আগে মোছা, তাই নতুন পেজ খালি ক্যাশ থেকে আনে
  queryClient.clear();
  sessionStore.getState().signIn(me);
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
  await startSession(await call(routes.auth.login, { body: input }));
}

export async function signUp(input: SignUpInput): Promise<void> {
  await startSession(await call(routes.auth.signUp, { body: input }));
}

export async function switchTenant(tenantId: string): Promise<void> {
  await startSession(await call(routes.auth.switchTenant, { body: { tenantId } }));
}

export async function logout(): Promise<void> {
  try {
    await call(routes.auth.logout);
  } finally {
    // নেটওয়ার্ক ব্যর্থ হলেও এই ট্যাবে লগআউট দেখাতে হবে, আর আগের ইউজারের ক্যাশ মুছতে হবে
    queryClient.clear();
    sessionStore.getState().signOut();
  }
}
