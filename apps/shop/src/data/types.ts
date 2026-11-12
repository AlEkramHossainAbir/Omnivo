import type {
  PublicShop,
  ShopCartQuote,
  ShopCartQuoteRequest,
  ShopCategory,
  ShopCheckoutSettings,
  ShopCodeResent,
  ShopHome,
  ShopListingPage,
  ShopListingQuery,
  ShopOrder,
  ShopOrderConfirmed,
  ShopOrderPlaced,
  ShopOrderRequest,
  ShopProductPage,
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
  | 'shop_code_no_order';

// What a source answers when it may say no. A refusal is a normal answer (a wrong code, a price
// that changed), not an exception: `throw` stays for a source that is down, which the routes turn
// into internal_error. `params` go into the error's words ("2 tries left", "Orders start at ৳300")
export type SourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ShopRefusalCode; params?: Record<string, string | number> };

// A placed order and its secret token. The token never reaches the browser's scripts: the route
// puts it in an httpOnly cookie (decision 4), and only `answer` goes into the body
export interface PlacedOrder {
  answer: ShopOrderPlaced;
  orderNo: string;
  token: string;
}

// What /checkout/verify draws for the order that waits: the same as the `verify` answer, plus the
// listings it holds. Step 26c.5: a right code takes them out of this browser's cart (decision 23),
// and the page cannot know them otherwise: the order is on the server, and the cart may have
// changed in another tab since Confirm Order
export type ShopCodeWait = Extract<ShopOrderPlaced, { next: 'verify' }> & { listingIds: string[] };

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
  placeOrder(request: ShopOrderRequest): Promise<SourceResult<PlacedOrder>>;
  // The order that waits for its phone code, found by the token from the cookie. null: none
  // waits (never placed, confirmed already, dropped, or past its hour)
  codeWait(token: string): Promise<ShopCodeWait | null>;
  verifyCode(token: string, code: string): Promise<SourceResult<ShopOrderConfirmed>>;
  resendCode(token: string): Promise<SourceResult<ShopCodeResent>>;
  // A confirmed order for /order/<no>. Both must match: the number alone is easy to guess, and the
  // page shows a phone and an address (decision 5). null for anything else
  order(orderNo: string, token: string): Promise<ShopOrder | null>;
  // The code a test shop takes, which the verify page shows because no SMS is sent. null for a real
  // shop: its code goes only to the phone
  readonly testCode: string | null;
}
