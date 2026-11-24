import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, envField } from 'astro/config';

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
  // Step 26e: the shop runs behind a proxy (Caddy on staging), which is the only thing that can
  // reach it. Without this, Astro trusts none of the proxy's headers, and two things go wrong:
  // - Astro.clientAddress is the proxy's address for every visitor, so the /track form's limit
  //   (server/track.ts) would stop everyone at once after one guesser's ten misses
  // - Astro.url is http://localhost:4321, so a browser that sends Origin but not Sec-Fetch-Site
  //   (Safari before 16.4, still on many older iPhones) gets 403 for every form it posts: Astro's
  //   origin check compares the two
  // `[{}]` trusts Host, X-Forwarded-Host, -Proto and -For from any request, because a tenant's shop
  // can be on any domain. That is safe only while nothing but the proxy can reach the server, and
  // the proxy writes X-Forwarded-For itself (infra/staging/Caddyfile → the shop), never passing on
  // one the visitor sent
  // Step 27d (decision 2): checkOrigin off, because SSLCommerz posts the shopper back from its own
  // site, and Astro's check would answer that post 403 with no way to leave one path out. The
  // middleware runs the same check itself, with only the gateway's two paths let through
  // (src/server/origin-check.ts). Never turn this off without that: every form here would take a
  // post from any site
  security: { allowedDomains: [{}], checkOrigin: false },
  build: { format: 'file' },
  // Step 26f.5: where the data comes from (src/data/config.ts). "secret" is Astro's word for "read
  // when the server runs, never written into the build": a public server value would be fixed when
  // the image is built, and staging could not switch the same image to the API. Neither is a
  // secret in the usual sense, and neither reaches a browser (context: 'server'). A wrong value
  // (SHOP_SOURCE=apii) fails the first request with Astro's message naming the variable: the
  // node server loads the middleware, which reads them, only when a request comes
  env: {
    schema: {
      SHOP_SOURCE: envField.enum({
        context: 'server',
        access: 'secret',
        values: ['mock', 'api'],
        default: 'mock',
      }),
      SHOP_API_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
      // Step 27a: the key for the order routes (src/data/config.ts). This one is a secret in both
      // senses: anyone who has it can place orders and send SMS in any shop's name
      SHOP_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
});
