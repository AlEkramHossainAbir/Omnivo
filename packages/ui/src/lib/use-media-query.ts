import { useSyncExternalStore } from 'react';

// CSS-এর min-[860px] আর JS-এর সিদ্ধান্ত একই জায়গা থেকে — সাইডবার আর টেবিল একসাথে বদলায়
export const DESKTOP_QUERY = '(min-width: 860px)';

// useSyncExternalStore: resize-এ matchMedia-র change event এলে সাথে সাথে নতুন মান,
// আর React-এর concurrent render-এ "tearing" (একই render-এ দুই রকম মান) হয় না
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    () => window.matchMedia(query).matches,
  );
}
