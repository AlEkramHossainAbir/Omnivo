import type {
  PublicOrderPlaced,
  PublicShop,
  ShopCartQuote,
  ShopCartQuoteRequest,
  ShopCategory,
  ShopCheckoutSettings,
  ShopCodeResent,
  ShopCodeWait,
  ShopHome,
  ShopListingPage,
  ShopListingQuery,
  ShopOrder,
  ShopOrderConfirmed,
  ShopOrderRequest,
  ShopPaymentRetry,
  ShopPaymentSettled,
  ShopPaymentSettleRequest,
  ShopPaymentWait,
  ShopProductPage,
  ShopTextPage,
  ShopTextPageSlug,
  ShopTracking,
  ShopTrackRequest,
} from '@omnivo/contracts';

// Step 26c: the reasons a source may refuse an order or a phone code. A closed list, not any
// ErrorCode: the routes give each one its HTTP status (server/orders.ts), and a reason added here
// without a status there fails the type check
export type ShopRefusalCode =
  | 'shop_zone_unknown'
  | 'shop_payment_unavailable'
  | 'shop_order_below_minimum'
  | 'shop_order_changed'
  | 'shop_code_wrong'
  | 'shop_code_too_many'
  | 'shop_code_resend_wait'
  | 'shop_code_no_order'
  // Step 27a: the API's own limits (27a's decision 17)
  | 'shop_order_limit'
  | 'shop_code_expired'
  | 'shop_code_sends_used'
  // Step 27c: a once-per-mobile-number coupon this phone has an order with (27c's decision 3)
  | 'shop_coupon_used_by_phone'
  // Step 27d: "Try again" and "Pay on delivery" on /checkout/paid. shop_payment_unavailable above
  // is reused: the shop stopped taking the method the button asks for
  | 'shop_payment_no_order'
  | 'shop_payment_tries_used'
  | 'shop_payment_settled';

// Step 27d: what the two buttons on /checkout/paid may be refused with. Their own lists, as for
// verifyCode(): "Pay on delivery" never uses up tries, so it has no reason to get that refusal
export type ShopRetryRefusal =
  | 'shop_payment_no_order'
  | 'shop_payment_tries_used'
  | 'shop_payment_settled'
  | 'shop_payment_unavailable';
export type ShopPayOnDeliveryRefusal =
  'shop_payment_no_order' | 'shop_payment_settled' | 'shop_payment_unavailable';

// Step 27a: the /track form's refusals. Their own list, not ShopRefusalCode: the form is a page,
// not one of the order routes, and draws them itself (server/track.ts), so they need no status in
// server/orders.ts
export type ShopTrackRefusal = 'shop_track_not_found' | 'shop_track_too_many';

// What a source answers when it may say no. A refusal is a normal answer (a wrong code, a price
// that changed), not an exception: `throw` stays for a source that is down, which the routes turn
// into internal_error. `params` go into the error's words ("2 tries left", "Orders start at ৳300").
// Step 27a: `C` is the list of refusals the method may give; the order routes' list by default
export type SourceResult<T, C extends string = ShopRefusalCode> =
  { ok: true; value: T } | { ok: false; code: C; params?: Record<string, string | number> };

// A placed order is the API's answer as it is (27a.1's PublicOrderPlaced): what the shopper is told
// (`answer`) and the order's secret token. The token never reaches the browser's scripts: the route
// puts it in an httpOnly cookie (decision 4), and only `answer` goes into the body. Step 27a: there
// is no order number next to them any more. An order that waits for its code has none yet (27a's
// decision 20); one confirmed at once has it in `answer`
export type PlacedOrder = PublicOrderPlaced;

// Step 26e: an order a test shop starts with, and how to track it. The verify page shows a test
// shop's code (testCode); the /track page shows these, because a test shop sends no SMS with the
// link. Never filled for a real shop: its numbers, phones and links belong to its buyers
export interface ShopTestTracking {
  orderNo: string;
  phone: string;
  // The tracking link's token (/t/<token>)
  token: string;
}

// What every data source answers. Its own file, so the mock can implement it without importing
// source.ts, which imports the mock (a circle .dependency-cruiser.cjs refuses)
export interface ShopSource {
  shop(): Promise<PublicShop>;
  categories(): Promise<ShopCategory[]>;
  home(): Promise<ShopHome>;
  // Step 26b: one product's page. null: no published listing has this slug, so the page answers
  // 404. Not an error: an old link or a typo is normal traffic
  product(slug: string): Promise<ShopProductPage | null>;
  // Step 26b: today's prices for a cart. The route checks the request first
  // (shopCartQuoteRequestSchema), so a source never sees a quantity of 0 or one listing twice
  quote(request: ShopCartQuoteRequest): Promise<ShopCartQuote>;
  // Step 26d: one page of cards for /c/<slug> and /search. The page builds the query from the
  // address (lib/listing-query.ts), so a source never sees a broken price or an unknown sort. null:
  // the cursor is not one this source made (edited by hand, or left from an older source); the page
  // then starts again from the first page. Not an error, like an unknown slug in product()
  listings(query: ShopListingQuery): Promise<ShopListingPage | null>;

  // Step 26c: the checkout. The routes check every request with its schema first, as for quote()
  checkoutSettings(): Promise<ShopCheckoutSettings>;
  // Step 27a: `address` is the shopper's own (Astro's clientAddress). The API counts the orders
  // from one connection with it (SHOP_ORDERS_PER_ADDRESS); the mock has no such limit.
  // Step 27d: `origin` is this shop's own address as the shopper's browser sees it (Astro.url's
  // origin, behind the proxy too). Only the mock reads it, to build its fake gateway page's whole
  // address (shopPaymentUrlSchema); the API builds that address from its own settings
  placeOrder(
    request: ShopOrderRequest,
    address: string,
    origin: string,
  ): Promise<SourceResult<PlacedOrder>>;
  // The order that waits for its phone code, found by the token from the cookie. null: none
  // waits (never placed, confirmed already, dropped, or past its hour). Step 27a: the type is the
  // API's answer (shopCodeWaitSchema), so the verify page draws exactly what the API sends
  codeWait(token: string): Promise<ShopCodeWait | null>;
  verifyCode(token: string, code: string): Promise<SourceResult<ShopOrderConfirmed>>;
  resendCode(token: string): Promise<SourceResult<ShopCodeResent>>;
  // A confirmed order for /order/<no>. Both must match: the number alone is easy to guess, and the
  // page shows a phone and an address (decision 5). null for anything else
  order(orderNo: string, token: string): Promise<ShopOrder | null>;
  // The code a test shop takes, which the verify page shows because no SMS is sent. null for a real
  // shop: its code goes only to the phone
  readonly testCode: string | null;

  // Step 27d: paying online. The gateway came back with a try's ids (the return path or the
  // notice); the source asks the gateway and records the answer. null: no try of this shop has the
  // transaction id (a made-up post, or an order dropped since)
  settlePayment(request: ShopPaymentSettleRequest): Promise<ShopPaymentSettled | null>;
  // /checkout/paid, by the checkout cookie's token. null: no online order waits in this browser
  // (it became Cash on Delivery, was dropped, or the cookie names none)
  paymentWait(token: string): Promise<ShopPaymentWait | null>;
  // "Try again": a new payment page for the same order and hold
  retryPayment(
    token: string,
    origin: string,
  ): Promise<SourceResult<ShopPaymentRetry, ShopRetryRefusal>>;
  // "Pay on delivery instead": the order becomes Cash on Delivery and gets its phone code. The
  // answer is the verify page's (codeWait's)
  payOnDelivery(token: string): Promise<SourceResult<ShopCodeWait, ShopPayOnDeliveryRefusal>>;

  // Step 26e: tracking. The order a tracking link names, or null for "no such order", never an
  // error: an old link is normal traffic, like an unknown slug in product(). The page checks the
  // token's shape first (shopTrackingTokenSchema), so a source never sees a cut or edited link
  tracking(token: string): Promise<ShopTracking | null>;
  // The /track form: the order with this number, only when it was placed with this phone. Both come
  // from shopTrackRequestSchema, so the phone is 01XXXXXXXXX and the number W-000123.
  // Step 27a: a refusal, not null, because there are two: no such pair, and too many misses from
  // this `address` (the shopper's, as for placeOrder). The limit moved into the source: the API
  // keeps it in Redis, next to the orders, and the mock in its own memory (mock/rate-limit.ts)
  track(
    request: ShopTrackRequest,
    address: string,
  ): Promise<SourceResult<ShopTracking, ShopTrackRefusal>>;
  // A footer page. null: the shop has not written it, and the page answers 404
  textPage(slug: ShopTextPageSlug): Promise<ShopTextPage | null>;
  // A test shop's demo orders (ShopTestTracking); null for a real shop
  readonly testTracking: readonly ShopTestTracking[] | null;
}
