import { SHOP_PAYMENT_NOTICE_PATH, SHOP_PAYMENT_RETURN_PATH } from '@omnivo/contracts';

// Step 27d (decision 2): the shop's own copy of Astro's origin check (security.checkOrigin), with
// two paths let through. Astro's check stops a form that another site posts to this server (CSRF):
// without it, a page anywhere could post the /track form or "Resend code" in a shopper's name. But
// SSLCommerz sends the shopper back to the shop by posting a form from its own site, which the
// check refuses with 403, and Astro's check cannot leave one path out. So astro.config.ts turns it
// off, and the middleware runs this instead, for every request, before any page or route.
//
// The rules are Astro 7.4's (astro/dist/core/app/origin-check.js), so nothing else changes:
// - GET, HEAD and OPTIONS are never refused: they change nothing
// - only the bodies a plain HTML form can send are checked (or no Content-Type at all). JSON from
//   another site needs the browser to ask this server first (CORS), and this server allows no one
// - Sec-Fetch-Site says where the request came from in every current browser; Origin is the
//   answer for older ones (Safari before 16.4), compared with the request's own origin
// - neither header: not a browser's form (a server, curl), so nothing to protect a cookie from

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The only paths another site may post to. Both read no cookie and settle nothing on the post's
// word: the API asks the gateway about the two ids (server/payments.ts), so a stranger's post can
// at most make the API ask SSLCommerz about a payment that does not exist
export const CROSS_SITE_PATHS: ReadonlySet<string> = new Set([
  SHOP_PAYMENT_RETURN_PATH,
  SHOP_PAYMENT_NOTICE_PATH,
]);

function isFormLike(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return FORM_TYPES.some((formType) => type.includes(formType));
}

// true: refuse with 403, as Astro would. `url` is the request's own address as Astro sees it
// (Astro.url), behind the proxy too (security.allowedDomains)
export function isForbiddenCrossSite(request: Request, url: URL): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  // The exact path only: trailingSlash is 'never', so "/checkout/pay/return/" is not the page
  if (CROSS_SITE_PATHS.has(url.pathname)) return false;
  const contentType = request.headers.get('content-type');
  if (contentType && !isFormLike(contentType)) return false;
  switch (request.headers.get('sec-fetch-site')) {
    case null:
    case '':
      break;
    case 'same-origin':
    case 'none':
      return false;
    // same-site too: another shop on omnivosoft.com is another tenant, not this one
    default:
      return true;
  }
  const origin = request.headers.get('origin');
  if (!origin) return false;
  return origin !== url.origin;
}

// Astro's own answer, word for word, so a refused post looks the same as before
export function crossSiteForbidden(request: Request): Response {
  return new Response(`Cross-site ${request.method} form submissions are forbidden`, {
    status: 403,
  });
}
