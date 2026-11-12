import { shopOrderRequestSchema, shopVerifyCodeRequestSchema } from '@omnivo/contracts';

import type { ShopRefusalCode, ShopSource, SourceResult } from '../data/types';
import {
  checkoutCookie,
  checkoutToken,
  clearCheckoutCookie,
  ordersCookie,
  type CookieOptions,
} from './cookies';
import { problemResponse, readBody, sourceFailed, type ProblemStatus } from './problem';

// Step 26c: POST /api/orders, /api/orders/verify and /api/orders/resend, without Astro around
// them, like cart-quote.ts. The route files pass the request, the source and whether the cookies
// are Secure.

// Each refusal's HTTP status. `satisfies Record<ShopRefusalCode, …>` makes a new refusal in
// data/types.ts fail the type check here until it has one.
// - 409: the cart changed under the shopper; asking again with a new quote can work
// - 422: the request is well formed but breaks a rule (no such zone, under the minimum, wrong code)
// - 429: asked for a new code too soon; Retry-After says when
// - 404: no order waits for a code in this browser
const REFUSALS = {
  shop_zone_unknown: [422, 'The delivery zone is not one the shop has.'],
  shop_payment_unavailable: [422, 'The shop does not take this payment method.'],
  shop_order_below_minimum: [422, 'The order is under the shop’s minimum.'],
  shop_order_changed: [409, 'The cart’s prices or stock changed since the last quote.'],
  shop_code_wrong: [422, 'The code is wrong.'],
  shop_code_too_many: [422, 'Too many wrong codes; the order was dropped.'],
  shop_code_resend_wait: [429, 'A new code cannot be sent yet.'],
  shop_code_no_order: [404, 'No order waits for a code in this browser.'],
} as const satisfies Record<ShopRefusalCode, readonly [ProblemStatus, string]>;

function refused(
  result: Extract<SourceResult<unknown>, { ok: false }>,
  headers: Headers = new Headers(),
): Response {
  const [status, detail] = REFUSALS[result.code];
  // The standard header for "try again in N seconds", next to the same number in params
  if (result.code === 'shop_code_resend_wait' && typeof result.params?.seconds === 'number') {
    headers.set('Retry-After', String(result.params.seconds));
  }
  return problemResponse(status, result.code, detail, {
    headers,
    ...(result.params ? { params: result.params } : {}),
  });
}

function noOrder(options: CookieOptions): Response {
  // The cookie is cleared with the answer, so the verify page stops offering a form that can only
  // fail. Harmless when there was no cookie
  const headers = new Headers({ 'Set-Cookie': clearCheckoutCookie(options) });
  return refused({ ok: false, code: 'shop_code_no_order' }, headers);
}

// Confirm Order
export async function answerPlaceOrder(
  request: Request,
  source: ShopSource,
  options: CookieOptions,
): Promise<Response> {
  const body = await readBody(request, shopOrderRequestSchema);
  if (!body.ok) return body.response;

  let result;
  try {
    result = await source.placeOrder(body.data);
  } catch (error) {
    return sourceFailed('place order', error);
  }
  if (!result.ok) return refused(result);

  const { answer, orderNo, token } = result.value;
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (answer.next === 'verify') {
    // The order waits for its code; /checkout/verify finds it by this cookie
    headers.append('Set-Cookie', checkoutCookie(token, options));
  } else {
    // Confirmed at once (Mobile Banking in the mock): this browser may now open /order/<no>.
    // An older order that was still waiting for its code is forgotten: the shopper chose to start
    // again, and the verify page must not offer the old one
    headers.append('Set-Cookie', ordersCookie(request, orderNo, token, options));
    headers.append('Set-Cookie', clearCheckoutCookie(options));
  }
  // 201: an order was made. The body says which page comes next; the token is only in the cookie
  return Response.json(answer, { status: 201, headers });
}

// The six digits on /checkout/verify
export async function answerVerifyCode(
  request: Request,
  source: ShopSource,
  options: CookieOptions,
): Promise<Response> {
  // The cookie first: without it no code can be right, whatever the body says
  const token = checkoutToken(request);
  if (token === null) return noOrder(options);

  const body = await readBody(request, shopVerifyCodeRequestSchema);
  if (!body.ok) return body.response;

  let result;
  try {
    result = await source.verifyCode(token, body.data.code);
  } catch (error) {
    return sourceFailed('verify code', error);
  }
  if (!result.ok) {
    // Too many wrong codes ends the order, so its cookie goes with it
    if (result.code === 'shop_code_too_many' || result.code === 'shop_code_no_order') {
      return refused(result, new Headers({ 'Set-Cookie': clearCheckoutCookie(options) }));
    }
    return refused(result);
  }

  // The order moves from "waiting" to "this browser's orders": the same token, now in the cookie
  // that /order/<no> reads
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', ordersCookie(request, result.value.orderNo, token, options));
  headers.append('Set-Cookie', clearCheckoutCookie(options));
  return Response.json(result.value, { headers });
}

// "Resend code". No body: the cookie says which order
export async function answerResendCode(
  request: Request,
  source: ShopSource,
  options: CookieOptions,
): Promise<Response> {
  const token = checkoutToken(request);
  if (token === null) return noOrder(options);

  let result;
  try {
    result = await source.resendCode(token);
  } catch (error) {
    return sourceFailed('resend code', error);
  }
  if (!result.ok) {
    if (result.code === 'shop_code_no_order') return noOrder(options);
    return refused(result);
  }
  return Response.json(result.value, { headers: { 'Cache-Control': 'no-store' } });
}
