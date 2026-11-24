import { SHOP_PAYMENT_RETURN_PATH, shopGatewayPostSchema } from '@omnivo/contracts';

import type { ShopSource } from '../data/types';
import { checkoutToken } from './cookies';
import { refused } from './orders';
import { problemResponse, sourceFailed } from './problem';

// Step 27d: the shop's payment routes, without Astro around them, like orders.ts. Two kinds:
// - the gateway's two paths (SHOP_PAYMENT_RETURN_PATH and SHOP_PAYMENT_NOTICE_PATH). SSLCommerz
//   posts a form to them from its own site, so they read no cookie and trust nothing in the post
//   but the two ids, which the source checks with the gateway itself. The middleware lets only
//   these two take a post from another site (server/origin-check.ts)
// - "Try again" and "Pay on delivery" on /checkout/paid, which the shop's own page posts as JSON,
//   for the order in this browser's checkout cookie, like "Resend code"

// Where the browser goes after the gateway: the page that reads the cookie and draws the answer
export const PAYMENT_PAGE = '/checkout/paid';

// The two ids from the gateway's form post, or null when the post has none we can use. A post
// that is not a form, is cut, or names a transaction id of the wrong shape is never passed on:
// the API would refuse it with 400 anyway
export async function gatewayIds(
  request: Request,
): Promise<{ tranId: string; valId: string | null } | null> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(type)) return null;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return null;
  }
  // FormData.get is a string, a File (a multipart field with a file name) or null. Only text is
  // an id; a missing val_id is undefined, which the schema makes null like an empty one
  const text = (name: string): string | undefined => {
    const value = form.get(name);
    return typeof value === 'string' ? value : undefined;
  };
  const parsed = shopGatewayPostSchema.safeParse({
    tran_id: text('tran_id'),
    val_id: text('val_id'),
  });
  return parsed.success ? { tranId: parsed.data.tran_id, valId: parsed.data.val_id } : null;
}

// The shopper's browser, back from the gateway's page (paid, failed or cancelled, all to one
// path). Whatever happens here, the browser goes on to /checkout/paid with 303, which turns the
// POST into a GET: a reload there asks again and never posts the form twice. Settling first means
// the page usually has the answer at once; when it could not (the API was down, or the post was
// not one we can read), the page asks the API itself, and the IPN brings the answer too
export async function answerGatewayReturn(request: Request, source: ShopSource): Promise<Response> {
  const ids = await gatewayIds(request);
  if (ids !== null) {
    try {
      await source.settlePayment(ids);
    } catch (error) {
      console.error(`settle payment ${ids.tranId} on ${SHOP_PAYMENT_RETURN_PATH} failed`, error);
    }
  }
  return new Response(null, {
    status: 303,
    headers: { Location: PAYMENT_PAGE, 'Cache-Control': 'no-store' },
  });
}

// The gateway's own server (SSLCommerz's IPN). Its answer is for the gateway only: 200 once the
// try is settled, a 4xx for a post that can never settle (the gateway may stop trying then), and
// 500 when the API was down, so the gateway sends it again later
export async function answerGatewayNotice(request: Request, source: ShopSource): Promise<Response> {
  const ids = await gatewayIds(request);
  if (ids === null) {
    return problemResponse(400, 'invalid_input', 'The post has no transaction id.');
  }
  let settled;
  try {
    settled = await source.settlePayment(ids);
  } catch (error) {
    return sourceFailed('settle payment notice', error);
  }
  if (settled === null) return problemResponse(404, 'not_found', 'No payment has this id.');
  return Response.json(settled, { headers: { 'Cache-Control': 'no-store' } });
}

// "Try again". No body: the cookie says which order. The cookie is never cleared here: an order
// that is not waiting for a payment any more may be waiting for its phone code ("Pay on delivery"
// in another tab), and /checkout/verify needs the same cookie
export async function answerRetryPayment(
  request: Request,
  source: ShopSource,
  origin: string,
): Promise<Response> {
  const token = checkoutToken(request);
  if (token === null) return refused({ ok: false, code: 'shop_payment_no_order' });
  let result;
  try {
    result = await source.retryPayment(token, origin);
  } catch (error) {
    return sourceFailed('retry payment', error);
  }
  if (!result.ok) return refused(result);
  return Response.json(result.value, { headers: { 'Cache-Control': 'no-store' } });
}

// "Pay on delivery instead". The same cookie: the order is the same, it only waits for a code now
export async function answerPayOnDelivery(request: Request, source: ShopSource): Promise<Response> {
  const token = checkoutToken(request);
  if (token === null) return refused({ ok: false, code: 'shop_payment_no_order' });
  let result;
  try {
    result = await source.payOnDelivery(token);
  } catch (error) {
    return sourceFailed('pay on delivery', error);
  }
  if (!result.ok) return refused(result);
  return Response.json(result.value, { headers: { 'Cache-Control': 'no-store' } });
}
