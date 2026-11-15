// Step 26f: which shop a request is for, from the X-Shop-Host header (SHOP_HOST_HEADER in the
// contracts). The shop's server sends its own Host header in it, as the shopper's browser sent it:
// "acme.omnivo.shop", or "acme.localhost:4331" in dev.

// One DNS label, lower case: the same rule as storefront_settings_subdomain_check (migration 0063),
// so a label that passes here is one the database can hold
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// The shop's subdomain ("acme"), or null when the host is not one of ours. Only a single label
// in front of the base domain: "a.b.omnivo.shop" is not a shop, and neither is the base domain
// itself. The port goes first (dev runs on :4331), then a trailing dot (a fully qualified name,
// "acme.omnivo.shop.", is the same host), and the case: DNS names have none, and the browser
// sends lower case anyway.
export function subdomainOf(host: string | undefined, baseDomain: string): string | null {
  if (host === undefined) return null;
  const name = host
    .trim()
    .replace(/:\d{1,5}$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const suffix = `.${baseDomain}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  return LABEL.test(label) ? label : null;
}
