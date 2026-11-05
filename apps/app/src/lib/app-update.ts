import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

// Step 19a (decision 3): the service worker's updates. A new version downloads in the background
// and waits; the notice (update-notice.tsx) lets the person choose when to reload into it.
//   none       nothing new, or no worker (pnpm dev, an old browser)
//   ready      a new version waits for this tab's Reload
//   other-tab  another tab reloaded into the new version: this tab still runs the old one, whose
//              files the new worker has deleted, so its next lazy page would fail to load
//   reloading  this tab asked the waiting version to take over
export type UpdateState = 'none' | 'ready' | 'other-tab' | 'reloading';

// Exported for the tests (app-update.spec.ts); the screens read it with useUpdateState
export const updateStore = createStore<{ state: UpdateState }>()(() => ({ state: 'none' }));

export function useUpdateState(): UpdateState {
  return useStore(updateStore, (store) => store.state);
}

function setState(state: UpdateState): void {
  updateStore.setState({ state });
}

// A tab can stay open for days (a counter PC). The browser checks sw.js on every load, but not
// while a page stays open, so the app asks again every hour and when the connection comes back.
const CHECK_EVERY_MS = 60 * 60 * 1000;

let registration: ServiceWorkerRegistration | null = null;
// Whether a worker already ran this app before this page loaded. The first install's worker
// takes over the page at once (clientsClaim in sw.ts): that changes nothing under the page, so
// its controllerchange must not say "updated in another tab".
let hadWorker = false;

// A new version has installed while an older one runs this page. With no worker in control it
// is the first install, and there is nothing to update from.
function noticeWaiting(): void {
  if (
    registration?.waiting &&
    navigator.serviceWorker.controller &&
    updateStore.getState().state === 'none'
  ) {
    setState('ready');
  }
}

// Also run by the sync notice when the server says this app is too old (local-state.tsx). An
// update that fails (offline, a 5xx) is tried again by the next check.
export function checkForUpdate(): void {
  void registration?.update().catch(() => undefined);
}

async function register(): Promise<void> {
  let found: ServiceWorkerRegistration;
  try {
    found = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  } catch {
    // Refused (a Firefox private window, a browser setting): the app works online as before 19a
    return;
  }
  registration = found;
  // A hard reload (Shift + Reload) opens the page without the worker in control, though one is
  // active: its next controllerchange is a real update
  if (found.active) hadWorker = true;
  // Downloaded during an earlier visit, while another tab of the old version stayed open
  noticeWaiting();
  found.addEventListener('updatefound', () => {
    const installing = found.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') noticeWaiting();
    });
  });
  setInterval(checkForUpdate, CHECK_EVERY_MS);
  window.addEventListener('online', checkForUpdate);
}

// Called once by main.tsx, in a production build only (decision 11)
export function startAppUpdates(): void {
  // Not in an old browser, or on a plain http:// address other than localhost
  if (!('serviceWorker' in navigator)) return;
  hadWorker = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadWorker) {
      hadWorker = true;
      return;
    }
    // This tab clicked Reload: the new version runs now, so load its files
    if (updateStore.getState().state === 'reloading') window.location.reload();
    else setState('other-tab');
  });
  // After the page's own files: the worker's first download (1.3 MB) must not slow the first load
  if (document.readyState === 'complete') void register();
  else {
    window.addEventListener(
      'load',
      () => {
        void register();
      },
      { once: true },
    );
  }
}

// How long Reload waits for the new version to take over before it reloads anyway
const TAKE_OVER_MS = 5000;

// The notice's Reload, and the sync notice's. A waiting version is asked to take over (sw.ts's
// SKIP_WAITING); its controllerchange then reloads this tab, and tells every other tab. A plain
// reload would not do: the browser keeps the old version while any tab still shows it, and the
// page being reloaded is one of them.
export function reloadApp(): void {
  const waiting = registration?.waiting;
  setState('reloading');
  if (!waiting) {
    // Another tab took the new version already (other-tab), or there is none: the files the
    // browser has now are the newest
    window.location.reload();
    return;
  }
  waiting.postMessage({ type: 'SKIP_WAITING' });
  // A waiting version can stop waiting without taking over (a newer one replaced it): never
  // leave "Reloading…" on the screen
  setTimeout(() => {
    window.location.reload();
  }, TAKE_OVER_MS);
}
