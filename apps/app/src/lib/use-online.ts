import { useSyncExternalStore } from 'react';

// Whether the browser thinks it is online. It can be wrong one way: "online" on a network with no
// internet. That only means a request fails like any other; "offline" is always true, so it is
// what the pages use to say "Needs a connection" instead of an error.
function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine);
}
