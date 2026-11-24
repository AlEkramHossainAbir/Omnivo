// Step 27d: what the /checkout/paid page's script reads from the shop's own two routes. Hand-written
// guards, not Zod, like lib/verify.ts: the page has no other use for Zod in the browser.

// Where "Try again" sends the browser, from the route's answer:
// - a string: the new payment page
// - null: the gateway did not open one (the page then shows "The payment page did not open")
// - undefined: not an answer of the route (a proxy's page), so the press failed
// Only an http(s) address is believed. The address goes into location.assign(), where a
// `javascript:` one would run on the shop's page; the API checks it already (shopPaymentUrlSchema),
// and this keeps the browser safe whatever reached it
export function paymentUrlOf(body: unknown): string | null | undefined {
  if (typeof body !== 'object' || body === null || !('paymentUrl' in body)) return undefined;
  const { paymentUrl } = body;
  if (paymentUrl === null) return null;
  if (typeof paymentUrl !== 'string') return undefined;
  try {
    const url = new URL(paymentUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

// "Pay on delivery" answered the verify page's wait: the browser goes there
export function isCodeWait(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'next' in body && body.next === 'verify';
}
