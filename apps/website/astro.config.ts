import { defineConfig, envField } from 'astro/config';

// The marketing site is the same for every visitor, so every page is built ahead of time
// (static output). It needs no server, and a CDN can serve it as plain files.
export default defineConfig({
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file' },
  vite: {
    // The book's chunk is three.js (about 560 KB, 140 KB gzipped). It loads with a dynamic
    // import after the page's text has painted, never on the page's critical path, so the
    // default 500 KB warning only hides a real one. Anything else this large is still flagged
    build: { chunkSizeWarningLimit: 600 },
  },
  env: {
    schema: {
      // Where "Start free trial" and the workspace form send the visitor. It is read at build
      // time, so staging and production build with their own value
      PUBLIC_APP_URL: envField.string({
        context: 'client',
        access: 'public',
        default: 'http://localhost:5173',
      }),
    },
  },
});
