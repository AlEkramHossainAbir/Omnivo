import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// Step 26b: every page is made per request on a Node server. The real source (step 26's public
// API) answers for the shop the request's Host names, so a page built ahead of time would show one
// shop on every domain. The server also prices the cart (/api/cart/quote): the browser never works
// out money (system design §14.4).
export default defineConfig({
  output: 'server',
  adapter: node({
    // `node dist/server/entry.mjs` is the whole server, with no Express around it. It reads HOST
    // and PORT from the environment
    mode: 'standalone',
    // The shop takes small JSON bodies only (a cart of 50 lines is about 3 KB). The default is
    // 1 GB, which would let anyone make the server read a huge body into memory
    bodySizeLimit: 64 * 1024,
  }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
  // The shop is one site per tenant on its own domain (shop.acme.com), always at the root
  trailingSlash: 'never',
  build: { format: 'file' },
});
