import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

// Step 19a: the app's own files on the device. The browser runs this file apart from the page, and
// it answers the page's requests for the app's files from a cache, so the app opens and every
// screen loads without a connection. The data is not here: it lives in IndexedDB (step 18), and
// the API's requests go to the network untouched.

// The WebWorker lib types `self` as a plain worker. This file only ever runs as a service worker.
declare const self: ServiceWorkerGlobalScope;

// Every file of this build, with a hash of its content (see vite.config.ts). The plugin puts the
// list here when it builds this file. A new build makes a new list, so the browser sees a changed
// service worker and installs it next to the running one: the update of decision 3.
precacheAndRoute(self.__WB_MANIFEST);

// The lists of older Workbox versions (a different cache name) are deleted. This build's own
// list deletes the files that left it by itself, when it takes over.
cleanupOutdatedCaches();

// Every page of the app is index.html: the router reads the address in the browser. Opening
// /sales/orders offline, or reloading on it, gets the cached index.html. The API never reaches
// this route: it is on another origin (VITE_API_URL), and a service worker only answers the
// navigations of its own origin.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

// The first time: the page that installed this worker becomes its client at once, so a reload
// without a connection already works. Later versions never take over by themselves (they wait,
// see below), so this only changes the very first install.
clientsClaim();

// A new version waits until every tab of the old one is closed. "Reload" in the app's notice
// (19a.4) sends this message to the waiting worker, which then takes over, and the page reloads.
// It never happens without the click: a reload under an open form would lose what was typed.
self.addEventListener('message', (event) => {
  // MessageEvent's data is `any`; read it as unknown and check its shape (rule 3)
  const data: unknown = event.data;
  if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});
