import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// One route's summary in the built contracts, a whole line: `summary: 'Sales orders, newest date
// first',` (a summary with an apostrophe is in double quotes). Never `summary: route.summary,`.
const ROUTE_SUMMARY = /^[ \t]*summary: (?:'[^'\n]*'|"[^"\n]*"),\n/gm;

// Step 17b: a route's summary is English for the OpenAPI document (contracts' gen-openapi and the
// API's docs). The browser never reads it, and every page's chunk carried all 244 of them: 4 KB gz
// of each page's 100 KB budget, growing with every step's routes. The built contracts lose them
// here, in the app's bundle only. The type still says `summary: string`; no app code may read it.
function dropRouteSummaries(): Plugin {
  return {
    name: 'omnivo:drop-route-summaries',
    transform(code, id) {
      if (!id.includes('/packages/contracts/dist/')) return null;
      return { code: code.replace(ROUTE_SUMMARY, ''), map: null };
    },
  };
}

// Step 19a: the service worker (sw/sw.ts) and the web app manifest. The worker is written by hand
// (injectManifest): the plugin only builds it and puts the list of this build's files in it.
const pwa = VitePWA({
  strategies: 'injectManifest',
  srcDir: 'sw',
  filename: 'sw.ts',
  // The app registers the worker itself, after the first render and only in a production build
  // (19a.4). `pnpm dev` and `pnpm dev:mock` never get it: MSW's worker needs the same scope (/).
  injectRegister: false,
  devOptions: { enabled: false },
  manifest: {
    id: '/',
    name: 'Omnivo',
    short_name: 'Omnivo',
    description: 'Accounting, sales, purchase and stock, online and offline',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    lang: 'en',
    // The window's title bar (surface) and the splash screen while it opens (bg). A manifest
    // cannot read the CSS tokens, so these are the light theme's hex values, like favicon.svg.
    theme_color: '#ffffff',
    background_color: '#f6f7f9',
    icons: [
      { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
      {
        src: 'maskable-icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  },
  injectManifest: {
    // Decision 4: every script, style and font of the build. Each page and each dialog is a chunk
    // of its own, and one that was never opened online must still open offline. Not *.woff: the
    // font CSS lists it after woff2 for old browsers, and every browser we support takes woff2.
    globPatterns: ['**/*.{js,css,html,svg,woff2}'],
    // MSW's worker is in public/ for `pnpm dev:mock`, and Vite copies public/ into the build.
    globIgnores: ['mockServiceWorker.js'],
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), dropRouteSummaries(), pwa],
  server: { port: 5173, strictPort: true },
  // dist/.vite/manifest.json: কোন chunk কোন chunk-কে import করে — bundle-size চেক এটা পড়ে
  build: { manifest: true },
});
