// Step 26c: the shop's two cookies. Both hold secret tokens and nothing else: no name, no phone, no
// cart. Both are httpOnly, so no script on the page can read them (an injected script could not
// steal an order), SameSite=Lax, so another site's form or script never sends them, and Secure in
// production, so they never travel over plain http.
//
// - shop_checkout: the token of the order that waits for its phone code (decision 4). It lives as
//   long as the order waits (60 minutes) and is cleared when the order is confirmed or dropped
// - shop_orders: "W-000123:<token>" pairs for the orders this browser placed, newest last
//   (decision 5). /order/<no> takes the token paired with <no>, so it asks the source once

export const CHECKOUT_COOKIE = 'shop_checkout';
export const ORDERS_COOKIE = 'shop_orders';

// The same 60 minutes the mock keeps a waiting order (data/mock/orders.ts)
const CHECKOUT_MAX_AGE = 60 * 60;
// Long enough to come back to "View Order Details" from the SMS a few days later. After that, the
// shopper uses /track with the phone and the number (26d)
const ORDERS_MAX_AGE = 30 * 24 * 60 * 60;
// About 2 KB with today's tokens, well under the 4 KB a browser keeps for one cookie. The oldest
// order is forgotten first
const ORDERS_KEPT = 20;

// A token is what a source made (64 hex digits in the mock). The pattern is looser, for the real
// API's tokens, but it still refuses anything that could break the cookie: ; , = and spaces
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const ORDER_NO = /^[A-Za-z0-9-]{1,32}$/;

export interface CookieOptions {
  // import.meta.env.PROD in the routes. Off in `astro dev`, which serves plain http on localhost
  secure: boolean;
}

function serialize(name: string, value: string, maxAge: number, options: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', `Max-Age=${String(maxAge)}`, 'HttpOnly'];
  parts.push('SameSite=Lax');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

// One cookie's value from the request's Cookie header, or null. The browser sends "a=1; b=2"
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

// The waiting order's token, or null when there is none or it is not one of ours (an edited cookie
// is never passed on to the source)
export function checkoutToken(request: Request): string | null {
  const value = readCookie(request, CHECKOUT_COOKIE);
  return value !== null && TOKEN.test(value) ? value : null;
}

export function checkoutCookie(token: string, options: CookieOptions): string {
  return serialize(CHECKOUT_COOKIE, token, CHECKOUT_MAX_AGE, options);
}

// Max-Age=0 tells the browser to delete it now
export function clearCheckoutCookie(options: CookieOptions): string {
  return serialize(CHECKOUT_COOKIE, '', 0, options);
}

// This browser's orders, number → token, in the cookie's order. A pair that does not look right
// is skipped, not an error: the rest of the cookie still works
export function orderTokens(request: Request): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const pair of (readCookie(request, ORDERS_COOKIE) ?? '').split('.')) {
    const at = pair.indexOf(':');
    const orderNo = pair.slice(0, at);
    const token = pair.slice(at + 1);
    if (at > 0 && ORDER_NO.test(orderNo) && TOKEN.test(token)) tokens.set(orderNo, token);
  }
  return tokens;
}

// The orders cookie with one more order. It is written whole each time (a cookie cannot be
// appended to), so the request's cookie is read first
export function ordersCookie(
  request: Request,
  orderNo: string,
  token: string,
  options: CookieOptions,
): string {
  const tokens = orderTokens(request);
  // Deleted first, so a number that is already there moves to the end, as the newest
  tokens.delete(orderNo);
  tokens.set(orderNo, token);
  const pairs = [...tokens].slice(-ORDERS_KEPT).map(([no, value]) => `${no}:${value}`);
  return serialize(ORDERS_COOKIE, pairs.join('.'), ORDERS_MAX_AGE, options);
}
