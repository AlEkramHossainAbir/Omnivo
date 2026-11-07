import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// Step 26a: every page is built to HTML ahead of time from the mock data. Step 26b turns on
// `output: 'server'` with the Node adapter, when the pages read the public API per request.
export default defineConfig({
  output: 'static',
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
  // The shop is one site per tenant on its own domain (shop.acme.com), always at the root
  trailingSlash: 'never',
  build: { format: 'file' },
});
