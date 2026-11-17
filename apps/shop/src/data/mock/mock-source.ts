import type { ShopSource } from '../types';
import { listListings, type BrowseContext } from './browse';
import { mockCheckoutSettings, mockCoupons } from './checkout';
import { mockDemoOrders } from './demo-orders';
import { mockHome } from './home';
import { createOrderBook, MOCK_CODE, type MockDemoOrder } from './orders';
import { mockTextPages } from './pages';
import { mockCatalog, mockProductPage, mockSkus } from './products';
import { quoteCart, type QuoteContext } from './quote';
import { mockCategories, mockShop } from './shop';

// Step 26c: everything the mock prices a cart with, at one moment. Exported for the tests, which
// price carts without a source
export function mockQuoteContext(now: Date): QuoteContext {
  return {
    catalog: mockCatalog,
    settings: mockCheckoutSettings,
    coupons: mockCoupons,
    timeZone: mockShop.timeZone,
    now,
  };
}

// Step 26d: what the category and search pages read. Exported for the tests, like the quote's
export const mockBrowseContext: BrowseContext = {
  catalog: mockCatalog,
  categories: mockCategories,
  skus: mockSkus,
};

// Step 26c: a mock source with its own order book and clock. The shop uses one (mockSource below);
// a test makes its own, so its orders and its time are its own and no test sees another's orders.
// Step 26e: `demo` are the orders its book starts with. A test passes them only when it tracks
// orders, so the checkout's tests still get W-000001 for their first order
export function createMockSource(
  now: () => Date = () => new Date(),
  demo: readonly MockDemoOrder[] = [],
): ShopSource {
  const orders = createOrderBook(now, demo);
  const context = () => mockQuoteContext(now());

  // The mock answers at once. Still a promise, so the pages are written for the real source, which
  // waits for the network
  return {
    shop: () => Promise.resolve(mockShop),
    categories: () => Promise.resolve(mockCategories),
    home: () => Promise.resolve(mockHome),
    product: (slug) => Promise.resolve(mockProductPage(slug, now())),
    quote: (request) => Promise.resolve(quoteCart(request, context())),
    listings: (query) => Promise.resolve(listListings(query, mockBrowseContext)),

    checkoutSettings: () => Promise.resolve(mockCheckoutSettings),
    // The order is priced again here from its own lines, zone and coupon, never from anything the
    // browser says it costs (decision 10)
    placeOrder: (request) =>
      Promise.resolve(orders.place(request, quoteCart(request, context()), mockCheckoutSettings)),
    codeWait: (token) => Promise.resolve(orders.codeWait(token)),
    verifyCode: (token, code) => Promise.resolve(orders.verify(token, code)),
    resendCode: (token) => Promise.resolve(orders.resend(token)),
    order: (orderNo, token) => Promise.resolve(orders.find(orderNo, token)),
    testCode: MOCK_CODE,

    // Step 26e
    tracking: (token) => Promise.resolve(orders.trackByLink(token)),
    track: (request) => Promise.resolve(orders.track(request)),
    textPage: (slug) => Promise.resolve(mockTextPages[slug] ?? null),
    // What the /track page offers a tester: the demo orders' numbers, phones and links. null
    // without them, so the page does not offer links that lead nowhere
    testTracking:
      demo.length === 0
        ? null
        : demo.map(({ order, trackingToken }) => ({
            orderNo: order.orderNo,
            phone: order.phone,
            token: trackingToken,
          })),
  };
}

// The one the shop uses (data/source.ts). Its orders live as long as the server process; it starts
// with the demo orders (step 26e), so tracking has something to show after every restart
export const mockSource: ShopSource = createMockSource(undefined, mockDemoOrders);
