import type { MeResponse } from '@omnivo/contracts';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

import { forgetMe, rememberMe } from './remembered-session';

// Step 18c: why the sign-in page is showing, when the person did not sign out themself: this
// device was revoked (its data was deleted), or (step 19a) the server refused the sign-in once the
// connection was back after an offline opening (the data stays).
// Step 19b: 'pin_reset' = "Forgot PIN?", or a PIN that stopped working, on the lock screen: the
// password opens the copy again (the data stays). 'no_pin' = a reload with no connection on a
// device without a PIN: its copy opens only online (decision 5).
export type SignOutNotice = 'device_revoked' | 'session_ended' | 'pin_reset' | 'no_pin';

interface SessionState {
  // unknown = অ্যাপ সবে খুলেছে, refresh cookie দিয়ে session ফেরানো এখনো শেষ হয়নি
  status: 'unknown' | 'signed-in' | 'signed-out';
  // শুধু memory-তে — localStorage-এ রাখলে যেকোনো XSS স্ক্রিপ্ট টোকেন পড়তে পারত
  accessToken: string | null;
  me: MeResponse | null;
  // Step 19a: opened offline with the remembered `me` (offline-session.ts). Signed in for the
  // screens, but the server has not checked this sign-in yet, and there is no token until it has.
  openedOffline: boolean;
  notice: SignOutNotice | null;
  setAccessToken: (accessToken: string) => void;
  signIn: (me: MeResponse) => void;
  openOffline: (me: MeResponse) => void;
  // লগইনের পরে me-র অংশ বদলালে (কোম্পানির নাম, পছন্দ) — status না ছুঁয়ে
  setMe: (me: MeResponse) => void;
  signOut: (notice?: SignOutNotice) => void;
}

// vanilla store: React-এর বাইরে (api.ts, router-এর beforeLoad) থেকেও getState() ডাকা যায়
export const sessionStore = createStore<SessionState>()((set) => ({
  status: 'unknown',
  accessToken: null,
  me: null,
  openedOffline: false,
  notice: null,
  setAccessToken: (accessToken) => {
    set({ accessToken });
  },
  // Step 19a: every `me` the server gives is remembered, for the next reload with no connection
  signIn: (me) => {
    rememberMe(me);
    set({ status: 'signed-in', me, openedOffline: false, notice: null });
  },
  openOffline: (me) => {
    set({ status: 'signed-in', accessToken: null, me, openedOffline: true, notice: null });
  },
  setMe: (me) => {
    rememberMe(me);
    set({ me });
  },
  // Step 18c: a sign-out without a reason keeps the one already there. After a revoke, the requests
  // still on their way get a 401, and api.ts signs out again for each: the notice must stay.
  // Step 19a: every sign-out forgets the remembered `me`: a sign-in the server refused, or one the
  // person ended, never opens offline again.
  // Step 19b: except 'no_pin', which is no sign-out: the server still has the sign-in. Keeping `me`
  // keeps the notice at the next reload with no connection too, instead of the plain one.
  signOut: (notice) => {
    if (notice !== 'no_pin') forgetMe();
    set((state) => ({
      status: 'signed-out',
      accessToken: null,
      me: null,
      openedOffline: false,
      notice: notice ?? (state.status === 'signed-out' ? state.notice : null),
    }));
  },
}));

export function useSession<T>(selector: (state: SessionState) => T): T {
  return useStore(sessionStore, selector);
}
