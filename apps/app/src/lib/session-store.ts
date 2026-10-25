import type { MeResponse } from '@omnivo/contracts';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

// Step 18c: why the sign-in page is showing, when the person did not sign out themself. Only one
// reason so far: this device was revoked (its data was deleted).
export type SignOutNotice = 'device_revoked';

interface SessionState {
  // unknown = অ্যাপ সবে খুলেছে, refresh cookie দিয়ে session ফেরানো এখনো শেষ হয়নি
  status: 'unknown' | 'signed-in' | 'signed-out';
  // শুধু memory-তে — localStorage-এ রাখলে যেকোনো XSS স্ক্রিপ্ট টোকেন পড়তে পারত
  accessToken: string | null;
  me: MeResponse | null;
  notice: SignOutNotice | null;
  setAccessToken: (accessToken: string) => void;
  signIn: (me: MeResponse) => void;
  // লগইনের পরে me-র অংশ বদলালে (কোম্পানির নাম, পছন্দ) — status না ছুঁয়ে
  setMe: (me: MeResponse) => void;
  signOut: (notice?: SignOutNotice) => void;
}

// vanilla store: React-এর বাইরে (api.ts, router-এর beforeLoad) থেকেও getState() ডাকা যায়
export const sessionStore = createStore<SessionState>()((set) => ({
  status: 'unknown',
  accessToken: null,
  me: null,
  notice: null,
  setAccessToken: (accessToken) => {
    set({ accessToken });
  },
  signIn: (me) => {
    set({ status: 'signed-in', me, notice: null });
  },
  setMe: (me) => {
    set({ me });
  },
  // Step 18c: a sign-out without a reason keeps the one already there. After a revoke, the requests
  // still on their way get a 401, and api.ts signs out again for each: the notice must stay.
  signOut: (notice) => {
    set((state) => ({
      status: 'signed-out',
      accessToken: null,
      me: null,
      notice: notice ?? (state.status === 'signed-out' ? state.notice : null),
    }));
  },
}));

export function useSession<T>(selector: (state: SessionState) => T): T {
  return useStore(sessionStore, selector);
}
