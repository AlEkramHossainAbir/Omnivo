// Step 26f.5: where the shop gets its data, from two settings (astro.config.ts declares them):
// - SHOP_SOURCE: 'mock' (the default: `pnpm dev`, the e2e tests and the staging demo) or 'api'
// - SHOP_API_URL: the ERP API's address as the shop's server reaches it ("http://api:3000" inside
//   the deploy's network). Only read with SHOP_SOURCE=api
// - SHOP_API_KEY (step 27a): the key the shop's server sends on the order routes (SHOP_KEY_HEADER).
//   The API's STOREFRONT_SHOP_KEY has the same value. Only read with SHOP_SOURCE=api
// A plain function of the values, so the tests check the rules without Astro's env module.
export type ShopConfig = { source: 'mock' } | { source: 'api'; apiUrl: string; apiKey: string };

export function shopConfigOf(
  source: 'mock' | 'api',
  apiUrl: string | undefined,
  apiKey: string | undefined,
): ShopConfig {
  if (source === 'mock') return { source };
  // Without an address every page would fail with "fetch failed" and nothing to say why. The
  // first request fails here instead, with the setting to fix in the message
  if (apiUrl === undefined || apiUrl === '') {
    throw new Error('SHOP_SOURCE=api needs SHOP_API_URL (the ERP API, such as http://api:3000)');
  }
  // http is fine: the shop's server calls the API inside the deploy's own network, never across
  // the internet. Anything else (a typo such as "api:3000" reads as the scheme "api:") is refused
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error(`SHOP_API_URL is not an address: ${apiUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`SHOP_API_URL must start with http:// or https://, not ${url.protocol}`);
  }
  // Step 27a: without the key the shop would show its products and then fail at Confirm Order,
  // after the shopper filled in the whole form. The first request fails here instead. Only its
  // presence is checked: the API alone knows the right value, and says so with a 401
  // (shop-api.ts names the setting in that error too)
  if (apiKey === undefined || apiKey === '') {
    throw new Error('SHOP_SOURCE=api needs SHOP_API_KEY (the API’s STOREFRONT_SHOP_KEY)');
  }
  // A path is kept ("https://erp.example.com/api" behind a proxy); the "/" at its end is dropped,
  // so a route's "/public/v1/…" never makes "//"
  return { source, apiUrl: url.href.replace(/\/+$/, ''), apiKey };
}
