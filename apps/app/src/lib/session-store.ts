import type { MeResponse } from '@omnivo/contracts';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

interface SessionState {
  // unknown = অ্যাপ সবে খুলেছে, refresh cookie দিয়ে session ফেরানো এখনো শেষ হয়নি
  status: 'unknown' | 'signed-in' | 'signed-out';
  // শুধু memory-তে — localStorage-এ রাখলে যেকোনো XSS স্ক্রিপ্ট টোকেন পড়তে পারত
  accessToken: string | null;
  me: MeResponse | null;
  setAccessToken: (accessToken: string) => void;
  signIn: (me: MeResponse) => void;
  signOut: () => void;
}

// vanilla store: React-এর বাইরে (api.ts, router-এর beforeLoad) থেকেও getState() ডাকা যায়
export const sessionStore = createStore<SessionState>()((set) => ({
  status: 'unknown',
  accessToken: null,
  me: null,
  setAccessToken: (accessToken) => {
    set({ accessToken });
  },
  signIn: (me) => {
    set({ status: 'signed-in', me });
  },
  signOut: () => {
    set({ status: 'signed-out', accessToken: null, me: null });
  },
}));

export function useSession<T>(selector: (state: SessionState) => T): T {
  return useStore(sessionStore, selector);
}
