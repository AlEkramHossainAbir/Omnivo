import {
  listingParamsFromQuery,
  publicStorefrontRoutes as routes,
  type ShopCartQuoteRequest,
} from '@omnivo/contracts';

import { MOCK_CODE, type MockOrderBook } from '../mock/orders';
import type { ShopSource } from '../types';
import { ShopApiError, type ShopApi, type ShopApiResult } from './shop-api';

// Step 26f.5: the shop's data from the ERP's public API, for the one shop the ShopApi asks for.
// Browsing and the cart's prices come from the API. Orders, the phone code and tracking have no
// API until step 27 (decision 1), so they stay in a mock order book, one per shop (26f.5's
// decision b), priced with the API's quote.

// A refusal where the page has no use for one: shop() refused is not "no shop" (that is a
// ShopMissingError already), it is an API that breaks its own contract
function must<T>(result: ShopApiResult<T>, what: string): T {
  if (result.ok) return result.value;
  throw new ShopApiError(result.status, `${what} was refused (${result.code ?? 'unknown code'})`);
}

// `orders` is called only when an order is placed or looked up, so a shop nobody orders from never
// gets a book (data/source.ts keeps one per host)
export function createApiSource(api: ShopApi, orders: () => MockOrderBook): ShopSource {
  // Only what the quote asks: the lines, the zone and the coupon. An order request also carries
  // the shopper's name, phone and address, and those have no reason to reach the API (or its
  // logs) before step 27 stores orders
  async function quote(request: ShopCartQuoteRequest) {
    const body: ShopCartQuoteRequest = { lines: request.lines };
    if (request.zoneId !== undefined) body.zoneId = request.zoneId;
    if (request.couponCode !== undefined) body.couponCode = request.couponCode;
    return must(await api.post(routes.quote, body), 'cart quote');
  }

  async function checkoutSettings() {
    return must(await api.get(routes.checkoutSettings), 'checkout settings');
  }

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

    quote,

    async listings(query) {
      // Only what is set (decision 13), so the first page of /c/all is one cache entry for every
      // shopper
      const result = await api.get(routes.listings, { query: listingParamsFromQuery(query) });
      // A cursor the API did not make, or made for another sort: the page starts again from the
      // first page (ShopSource.listings)
      if (!result.ok && result.code === 'invalid_cursor') return null;
      return must(result, 'listings');
    },

    checkoutSettings,

    // The order is priced again here, by the API, from its own lines, zone and coupon, never from
    // what the browser says it costs (26c's decision 10). The book only decides whether the order
    // may be placed with that price, as it does for the mock
    async placeOrder(request) {
      const [priced, settings] = await Promise.all([quote(request), checkoutSettings()]);
      return orders().place(request, priced, settings);
    },
    codeWait: (token) => Promise.resolve(orders().codeWait(token)),
    verifyCode: (token, code) => Promise.resolve(orders().verify(token, code)),
    resendCode: (token) => Promise.resolve(orders().resend(token)),
    order: (orderNo, token) => Promise.resolve(orders().find(orderNo, token)),
    // No SMS is sent before step 27, so the verify page shows the code, as the mock's does. The
    // orders are not real yet either: nothing reaches the ERP
    testCode: MOCK_CODE,

    tracking: (token) => Promise.resolve(orders().trackByLink(token)),
    track: (request) => Promise.resolve(orders().track(request)),
    async textPage(slug) {
      const result = await api.get(routes.textPage, { params: { slug } });
      if (!result.ok && result.code === 'not_found') return null;
      return must(result, 'text page');
    },
    // A real shop has no demo orders: their numbers and links would lead nowhere
    testTracking: null,
  };
}
