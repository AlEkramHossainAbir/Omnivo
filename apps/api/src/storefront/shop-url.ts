import type { Config } from '../config.js';

// Step 26g: a shop's own address, made the way the shop's server reads it (26f.5's middleware
// takes the subdomain off SHOP_BASE_DOMAIN): "nirvor" → https://nirvor.omnivosoft.com in
// production, http://nirvor.localhost:4321 in dev. path starts with "/" ("/p/neem-face-wash")
export function shopUrl(config: Config['storefront'], subdomain: string, path = ''): string {
  const port = config.shopPort === null ? '' : `:${String(config.shopPort)}`;
  return `${config.shopScheme}://${subdomain}.${config.baseDomain}${port}${path}`;
}
