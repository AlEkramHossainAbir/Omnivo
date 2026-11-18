import {
  listingParamsFromQuery,
  publicStorefrontRoutes as routes,
  type ShopCartQuoteRequest,
} from '@omnivo/contracts';

import type { ShopSource, SourceResult } from '../types';
import { ShopApiError, type ShopApi, type ShopApiResult } from './shop-api';

// Step 26f.5: the shop's data from the ERP's public API, for the one shop the ShopApi asks for.
// Step 27a: everything comes from the API now, orders, the phone code and tracking too. The mock
// order book is gone from this source: an order placed here is a real one, in the ERP's tables.

function refusedError(result: Extract<ShopApiResult<unknown>, { ok: false }>, what: string) {
  return new ShopApiError(result.status, `${what} was refused (${result.code ?? 'unknown code'})`);
}

// A refusal where the page has no use for one: shop() refused is not "no shop" (that is a
// ShopMissingError already), it is an API that breaks its own contract
function must<T>(result: ShopApiResult<T>, what: string): T {
  if (result.ok) return result.value;
  throw refusedError(result, what);
}

// Step 27a: the API's answer as a source's answer. A refusal in `codes` is one the page knows how to
// tell the shopper (a wrong code, a changed price); any other is a mistake on one side or the
// other, so it throws, and the route answers internal_error. `codes` is a list, not "any
// ShopRefusalCode": verify() has no reason to get shop_order_limit, and a page that got it would
// show words that do not fit
function answerOf<T, C extends string>(
  result: ShopApiResult<T>,
  codes: readonly C[],
  what: string,
): SourceResult<T, C> {
  if (result.ok) return { ok: true, value: result.value };
  const code = codes.find((candidate) => candidate === result.code);
  if (code === undefined) throw refusedError(result, what);
  // `params` only when there are any, as the mock answers: the routes copy them into the problem
  return Object.keys(result.params).length === 0
    ? { ok: false, code }
    : { ok: false, code, params: result.params };
}

// The answer, or null for the one refusal that means "no such order" for this route
function orNull<T>(result: ShopApiResult<T>, notFound: string, what: string): T | null {
  if (!result.ok && result.code === notFound) return null;
  return must(result, what);
}

export function createApiSource(api: ShopApi): ShopSource {
  return {
    shop: async () => must(await api.get(routes.shop), 'shop'),
    categories: async () => must(await api.get(routes.categories), 'categories'),
    home: async () => must(await api.get(routes.home), 'home'),

    async product(slug) {
      // An address the ERP could never have made ("Neem", "a b") is not asked for: it can only be
      // a typo, and the API would refuse it with 400, which is not "no such product"
      if (!routes.product.params.shape.slug.safeParse(slug).success) return null;
      const result = await api.get(routes.product, { params: { slug } });
      if (!result.ok && result.code === 'not_found') return null;
      return must(result, 'product');
    },

    // Only what the quote asks: the lines, the zone and the coupon. The checkout's island sends its
    // whole form to the shop's own route, and the name, phone and address have no reason to reach
    // the API's quote (or its logs). Only placeOrder sends them, to store them
    async quote(request: ShopCartQuoteRequest) {
      const body: ShopCartQuoteRequest = { lines: request.lines };
      if (request.zoneId !== undefined) body.zoneId = request.zoneId;
      if (request.couponCode !== undefined) body.couponCode = request.couponCode;
      return must(await api.post(routes.quote, body), 'cart quote');
    },

    async listings(query) {
      // Only what is set (decision 13), so the first page of /c/all is one cache entry for every
      // shopper
      const result = await api.get(routes.listings, { query: listingParamsFromQuery(query) });
      // A cursor the API did not make, or made for another sort: the page starts again from the
      // first page (ShopSource.listings)
      if (!result.ok && result.code === 'invalid_cursor') return null;
      return must(result, 'listings');
    },

    checkoutSettings: async () => must(await api.get(routes.checkoutSettings), 'checkout settings'),

    // Step 27a: the API prices the order again from its own lines, zone and coupon (26c's decision
    // 10), holds its stock and sends the code. The shop's server no longer asks for a quote first:
    // the price that counts is the one the API takes in the same transaction as the hold
    async placeOrder(request, address) {
      const result = await api.post(routes.placeOrder, request, { clientAddress: address });
      return answerOf(
        result,
        [
          'shop_zone_unknown',
          'shop_payment_unavailable',
          'shop_order_below_minimum',
          'shop_order_changed',
          'shop_order_limit',
        ],
        'place order',
      );
    },
    async codeWait(token) {
      return orNull(await api.post(routes.codeWait, { token }), 'shop_code_no_order', 'code wait');
    },
    async verifyCode(token, code) {
      return answerOf(
        await api.post(routes.verifyCode, { token, code }),
        ['shop_code_no_order', 'shop_code_expired', 'shop_code_wrong', 'shop_code_too_many'],
        'verify code',
      );
    },
    async resendCode(token) {
      return answerOf(
        await api.post(routes.resendCode, { token }),
        ['shop_code_no_order', 'shop_code_sends_used', 'shop_code_resend_wait'],
        'resend code',
      );
    },
    async order(orderNo, token) {
      // The number comes from the orders cookie, which the browser can edit. One the API would
      // refuse with 400 ("abc") cannot be an order of this browser's: the same null as a wrong one,
      // as product() does for a slug, and the page answers 404
      if (!routes.order.body.shape.orderNo.safeParse(orderNo).success) return null;
      return orNull(await api.post(routes.order, { orderNo, token }), 'not_found', 'order');
    },
    // A real shop's code goes only to the phone, by SMS
    testCode: null,

    async tracking(token) {
      return orNull(await api.post(routes.tracking, { token }), 'not_found', 'tracking');
    },
    async track(request, address) {
      const result = await api.post(routes.track, request, { clientAddress: address });
      return answerOf(result, ['shop_track_not_found', 'shop_track_too_many'], 'track');
    },
    async textPage(slug) {
      const result = await api.get(routes.textPage, { params: { slug } });
      if (!result.ok && result.code === 'not_found') return null;
      return must(result, 'text page');
    },
    // A real shop has no demo orders: their numbers and links would lead nowhere
    testTracking: null,
  };
}
