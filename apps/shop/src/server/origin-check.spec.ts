import { SHOP_PAYMENT_NOTICE_PATH, SHOP_PAYMENT_RETURN_PATH } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { crossSiteForbidden, isForbiddenCrossSite } from './origin-check';

const SHOP = 'https://nirvor.omnivosoft.com';

// A request as a browser sends it. `site` is Sec-Fetch-Site, `origin` the Origin header
function request(
  path: string,
  {
    method = 'POST',
    type = 'application/x-www-form-urlencoded',
    site,
    origin,
  }: { method?: string; type?: string | null; site?: string; origin?: string } = {},
): [Request, URL] {
  const headers = new Headers();
  if (type !== null) headers.set('Content-Type', type);
  if (site !== undefined) headers.set('Sec-Fetch-Site', site);
  if (origin !== undefined) headers.set('Origin', origin);
  const url = new URL(path, SHOP);
  return [new Request(url, { method, headers }), url];
}

describe('the origin check (step 27d)', () => {
  it('refuses a form another site posts, as Astro did', () => {
    expect(isForbiddenCrossSite(...request('/track', { site: 'cross-site' }))).toBe(true);
    expect(
      isForbiddenCrossSite(
        ...request('/api/orders/resend', { type: 'text/plain', site: 'cross-site' }),
      ),
    ).toBe(true);
    // Another tenant's shop on the same domain is another site for this one
    expect(isForbiddenCrossSite(...request('/track', { site: 'same-site' }))).toBe(true);
    // No Content-Type at all is a form too (a body-less post)
    expect(
      isForbiddenCrossSite(...request('/api/payments/retry', { type: null, site: 'cross-site' })),
    ).toBe(true);
    // Older Safari: no Sec-Fetch-Site, so Origin decides
    expect(isForbiddenCrossSite(...request('/track', { origin: 'https://evil.example' }))).toBe(
      true,
    );
  });

  it('lets this shop’s own forms, JSON, safe methods and servers through', () => {
    expect(isForbiddenCrossSite(...request('/track', { site: 'same-origin' }))).toBe(false);
    expect(isForbiddenCrossSite(...request('/track', { site: 'none' }))).toBe(false);
    expect(isForbiddenCrossSite(...request('/track', { origin: SHOP }))).toBe(false);
    // JSON needs a CORS preflight first, which the shop never allows
    expect(
      isForbiddenCrossSite(
        ...request('/api/orders', { type: 'application/json', site: 'cross-site' }),
      ),
    ).toBe(false);
    expect(
      isForbiddenCrossSite(...request('/track', { method: 'GET', site: 'cross-site', type: null })),
    ).toBe(false);
    // curl or a server: no browser, no cookie to protect
    expect(isForbiddenCrossSite(...request('/track'))).toBe(false);
  });

  it('lets the gateway post to its two paths, and only those exact paths', () => {
    for (const path of [SHOP_PAYMENT_RETURN_PATH, SHOP_PAYMENT_NOTICE_PATH]) {
      expect(isForbiddenCrossSite(...request(path, { site: 'cross-site' }))).toBe(false);
      expect(
        isForbiddenCrossSite(...request(path, { origin: 'https://sandbox.sslcommerz.com' })),
      ).toBe(false);
    }
    expect(
      isForbiddenCrossSite(...request(`${SHOP_PAYMENT_RETURN_PATH}/`, { site: 'cross-site' })),
    ).toBe(true);
    expect(isForbiddenCrossSite(...request('/checkout/pay', { site: 'cross-site' }))).toBe(true);
  });

  it('answers 403 with Astro’s words', async () => {
    const response = crossSiteForbidden(new Request(SHOP, { method: 'POST' }));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Cross-site POST form submissions are forbidden');
  });
});
