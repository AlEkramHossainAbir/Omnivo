import {
  type AuthSession,
  authSessionSchema,
  type LoginInput,
  meResponseSchema,
  type SignUpInput,
} from '@omnivo/contracts';

import { apiFetch, logoutRequest, refreshSession } from './api';
import { sessionStore } from './session-store';

async function startSession(session: AuthSession): Promise<void> {
  sessionStore.getState().setAccessToken(session.accessToken);
  const me = await apiFetch('/auth/me', meResponseSchema);
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
      // সেখানে চেষ্টা করলে "Could not reach the server" দেখাবে
    }
    sessionStore.getState().signOut();
  })();
  return restoring;
}

export async function login(input: LoginInput): Promise<void> {
  await startSession(
    await apiFetch('/auth/login', authSessionSchema, { method: 'POST', body: input }),
  );
}

export async function signUp(input: SignUpInput): Promise<void> {
  await startSession(
    await apiFetch('/auth/sign-up', authSessionSchema, { method: 'POST', body: input }),
  );
}

export async function switchTenant(tenantId: string): Promise<void> {
  await startSession(
    await apiFetch('/auth/switch-tenant', authSessionSchema, {
      method: 'POST',
      body: { tenantId },
    }),
  );
}

export async function logout(): Promise<void> {
  try {
    await logoutRequest();
  } finally {
    // নেটওয়ার্ক ব্যর্থ হলেও এই ট্যাবে লগআউট দেখাতে হবে
    sessionStore.getState().signOut();
  }
}
