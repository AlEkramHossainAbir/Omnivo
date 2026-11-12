import type { ShopSource } from '../types';
import { mockCheckoutSettings, mockCoupons } from './checkout';
import { mockHome } from './home';
import { createOrderBook, MOCK_CODE } from './orders';
import { mockCatalog, mockProductPage } from './products';
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

// Step 26c: a mock source with its own order book and clock. The shop uses one (mockSource below);
// a test makes its own, so its orders and its time are its own and no test sees another's orders
export function createMockSource(now: () => Date = () => new Date()): ShopSource {
  const orders = createOrderBook(now);
  const context = () => mockQuoteContext(now());

  // The mock answers at once. Still a promise, so the pages are written for the real source, which
  // waits for the network
  return {
    shop: () => Promise.resolve(mockShop),
    categories: () => Promise.resolve(mockCategories),
    home: () => Promise.resolve(mockHome),
    product: (slug) => Promise.resolve(mockProductPage(slug, now())),
    quote: (request) => Promise.resolve(quoteCart(request, context())),

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
  };
}

// The one the shop uses (data/source.ts). Its orders live as long as the server process
export const mockSource: ShopSource = createMockSource();
