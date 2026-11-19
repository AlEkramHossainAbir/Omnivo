import { SHOP_API_KEY, SHOP_API_URL, SHOP_SOURCE } from 'astro:env/server';

import { createAnswerCache } from './api/answer-cache';
import { createApiSource } from './api/api-source';
import { createShopApi } from './api/shop-api';
import { shopConfigOf } from './config';
import { mockSource } from './mock/mock-source';
import type { ShopSource } from './types';

// Step 26a: the only door to the shop's data. No page or component imports the mock directly
// (src/boundaries.spec.ts), so swapping the source cannot leave one page on fake data.
// Step 26f.5: the door is per request. The real source answers for the shop the request's host
// names, so src/middleware.ts asks sourceFor() once per request and puts the answer in
// Astro.locals.source, which every page and route reads.

// Read once, when the server starts. astro:env reads them at run time ("secret" in
// astro.config.ts), so one built image serves the mock or the API by its environment
const config = shopConfigOf(SHOP_SOURCE, SHOP_API_URL, SHOP_API_KEY);

// One cache for the whole server, every shop's answers in it, keyed by host (decision 24):
// 30 seconds, so a price changed in the ERP shows within half a minute, and at most 1,000 answers
const cache = createAnswerCache({ ttlMs: 30_000, maxEntries: 1_000 });

// Step 27a: no mock order books here any more (26f.5's decision b kept one per host). The API keeps
// every shop's orders in its own tables, numbered per shop

export function sourceFor(url: URL): ShopSource {
  if (config.source === 'mock') return mockSource;
  // The host without its port: the API strips it too, and "acme.localhost:4331" and
  // "acme.localhost" are one shop. URL has made it lower case already. Behind the proxy this is the
  // shopper's host, not the proxy's (security.allowedDomains in astro.config.ts)
  const host = url.hostname;
  return createApiSource(createShopApi({ apiUrl: config.apiUrl, key: config.apiKey, host, cache }));
}
