import {
  listingQueryFromParams,
  publicListingParamsSchema,
  SHOP_CLIENT_ADDRESS_HEADER,
  SHOP_HOST_HEADER,
  SHOP_KEY_HEADER,
  shopCartQuoteRequestSchema,
  shopOrderNoSchema,
  shopOrderRequestSchema,
  shopOrderTokenSchema,
  shopTrackingTokenSchema,
  shopTrackRequestSchema,
  shopVerifyCodeRequestSchema,
  type ShopTextPageSlug,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { mockDemoOrders } from '../mock/demo-orders';
import { mockHome } from '../mock/home';
import { createMockSource } from '../mock/mock-source';
import { MOCK_CODE } from '../mock/orders';
import { mockCategories, mockShop } from '../mock/shop';
import type { ShopSource, SourceResult } from '../types';
import { createAnswerCache } from './answer-cache';
import { createApiSource } from './api-source';
import { createShopApi, ShopApiError, ShopMissingError } from './shop-api';

// The tests' ERP API: the mock shop's data behind the /public/v1 routes, for one host. The mock
// matches the public contract (mock.spec.ts), so the answers are real ones in shape. Every request
// is written down, so a test can see what the shop sent
const HOST = 'nirvor.omnivo.test';
const API = 'http://api.test';
// Step 27a: the shop server's key (SHOP_API_KEY) and the shopper's address
const KEY = 'test-shop-key-0123456789abcdef0123456789';
const ADDRESS = '203.0.113.7';
const STEVIA = 'lst-zero-cal-stevia-30-sachets';
const NEEM = 'himalaya-purifying-neem-face-wash-150ml';

function problem(status: number, code: string, params?: Record<string, string | number>): Response {
  return Response.json(
    { title: 'Refused', status, detail: code, code, ...(params ? { params } : {}) },
    { status },
  );
}

// Step 27a: a source's refusal as the API sends it, with the API's statuses
// (shop-orders.service.ts)
const STATUS: Record<string, number> = {
  shop_order_changed: 409,
  shop_order_limit: 429,
  shop_code_resend_wait: 429,
  shop_track_too_many: 429,
  shop_code_no_order: 404,
  shop_track_not_found: 404,
};

function answered<T>(result: SourceResult<T, string>, status = 200): Response {
  if (result.ok) return Response.json(result.value, { status });
  return problem(STATUS[result.code] ?? 422, result.code, result.params);
}

const tokenBody = z.object({ token: shopOrderTokenSchema });

function fakeApi(data: ShopSource = createMockSource()) {
  const requests: Request[] = [];
  let failNext: Response | null = null;

  async function answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get(SHOP_HOST_HEADER) !== HOST) return problem(404, 'storefront_not_found');
    const path = url.pathname.replace(/^\/public\/v1/, '');
    const slug = /^\/(?:products|pages)\/(.+)$/.exec(path)?.[1] ?? '';

    if (request.method === 'POST' && path === '/cart/quote') {
      const body = shopCartQuoteRequestSchema.parse(await request.json());
      return Response.json(await data.quote(body));
    }
    // Step 27a: the order routes, behind the key like the API's ShopKeyGuard. The mock behind them
    // keeps the API's rules for the code (data/mock/orders.ts)
    if (request.method === 'POST' && /^\/(?:orders|tracking|track)(?:\/|$)/.test(path)) {
      if (request.headers.get(SHOP_KEY_HEADER) !== KEY) {
        return problem(401, 'storefront_shop_key_invalid');
      }
      return orderRoute(path, request);
    }
    if (path === '/shop') return Response.json(await data.shop());
    if (path === '/categories') return Response.json(await data.categories());
    if (path === '/home') return Response.json(await data.home());
    if (path === '/checkout-settings') return Response.json(await data.checkoutSettings());
    if (path === '/listings') {
      const params = publicListingParamsSchema.parse(Object.fromEntries(url.searchParams));
      const page = await data.listings(listingQueryFromParams(params));
      return page === null ? problem(400, 'invalid_cursor') : Response.json(page);
    }
    if (path.startsWith('/products/')) {
      const page = await data.product(slug);
      return page === null ? problem(404, 'not_found') : Response.json(page);
    }
    if (path.startsWith('/pages/')) {
      // The route's own schema lets only the four slugs in; the test asks for those only
      const page = await data.textPage(slug as ShopTextPageSlug);
      return page === null ? problem(404, 'not_found') : Response.json(page);
    }
    return problem(404, 'not_found');
  }

  async function orderRoute(path: string, request: Request): Promise<Response> {
    const json: unknown = await request.json();
    const address = request.headers.get(SHOP_CLIENT_ADDRESS_HEADER) ?? 'no address';
    switch (path) {
      case '/orders':
        return answered(await data.placeOrder(shopOrderRequestSchema.parse(json), address), 201);
      case '/orders/code-wait': {
        const wait = await data.codeWait(tokenBody.parse(json).token);
        return wait === null ? problem(404, 'shop_code_no_order') : Response.json(wait);
      }
      case '/orders/verify': {
        const body = tokenBody.extend(shopVerifyCodeRequestSchema.shape).parse(json);
        return answered(await data.verifyCode(body.token, body.code));
      }
      case '/orders/resend':
        return answered(await data.resendCode(tokenBody.parse(json).token));
      case '/orders/find': {
        const body = tokenBody.extend({ orderNo: shopOrderNoSchema }).parse(json);
        const order = await data.order(body.orderNo, body.token);
        return order === null ? problem(404, 'not_found') : Response.json(order);
      }
      case '/tracking': {
        const body = z.object({ token: shopTrackingTokenSchema }).parse(json);
        const tracking = await data.tracking(body.token);
        return tracking === null ? problem(404, 'not_found') : Response.json(tracking);
      }
      case '/track':
        return answered(await data.track(shopTrackRequestSchema.parse(json), address));
      default:
        return problem(404, 'not_found');
    }
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const failure = failNext;
    failNext = null;
    return failure ?? answer(request);
  };

  return {
    fetch,
    requests,
    // The next request gets this answer in place of the real one
    failWith(response: Response) {
      failNext = response;
    },
    paths: () =>
      requests.map((request) => new URL(request.url).pathname + new URL(request.url).search),
  };
}

// A shop source on the fake API, with its own cache, as data/source.ts makes one
function setup({ host = HOST, api = fakeApi(), key = KEY } = {}) {
  const cache = createAnswerCache({ ttlMs: 30_000, maxEntries: 100 });
  const source = createApiSource(
    createShopApi({ apiUrl: API, host, key, cache, fetch: api.fetch }),
  );
  return { source, api, cache };
}

describe('the API source', () => {
  it('reads the shop the host names, and says which one in every request', async () => {
    const { source, api } = setup();
    expect(await source.shop()).toEqual(mockShop);
    expect(await source.categories()).toEqual(mockCategories);
    expect(await source.home()).toEqual(mockHome);
    expect(api.paths()).toEqual(['/public/v1/shop', '/public/v1/categories', '/public/v1/home']);
    expect(api.requests.every((request) => request.headers.get(SHOP_HOST_HEADER) === HOST)).toBe(
      true,
    );
  });

  it('sends a listing query with only what is set', async () => {
    const { source, api } = setup();
    const first = await source.listings({
      category: null,
      q: null,
      sort: 'newest',
      minPrice: null,
      maxPrice: null,
      inStock: false,
      offer: false,
      cursor: null,
    });
    expect(first?.items).toHaveLength(20);
    await source.listings({
      category: 'cosmetics',
      q: 'নিম',
      sort: 'price_asc',
      minPrice: '100',
      maxPrice: null,
      inStock: true,
      offer: false,
      cursor: null,
    });
    expect(api.paths()).toEqual([
      // The first page of /c/all is the plain address, one cache entry for every shopper
      '/public/v1/listings',
      `/public/v1/listings?category=cosmetics&q=${encodeURIComponent('নিম')}&sort=price_asc&minPrice=100&inStock=1`,
    ]);
  });

  it('starts a list again for a cursor the API did not make', async () => {
    const { source } = setup();
    const page = await source.listings({
      category: null,
      q: null,
      sort: 'newest',
      minPrice: null,
      maxPrice: null,
      inStock: false,
      offer: false,
      cursor: 'not-a-cursor',
    });
    expect(page).toBeNull();
  });

  it('answers null for a product or page the shop does not have', async () => {
    const { source, api } = setup();
    expect((await source.product(NEEM))?.product.slug).toBe(NEEM);
    expect(await source.product('no-such-product')).toBeNull();
    // An address the ERP could never have made is not even asked for
    expect(await source.product('Neem Face Wash')).toBeNull();
    expect(api.paths()).not.toContain('/public/v1/products/Neem%20Face%20Wash');
    expect((await source.textPage('terms'))?.slug).toBe('terms');
  });

  it('throws ShopMissingError for a host that is no launched shop', async () => {
    const { source } = setup({ host: 'nobody.omnivo.test' });
    await expect(source.shop()).rejects.toBeInstanceOf(ShopMissingError);
    // Every route, not only shop(): a product of no shop is not "no such product"
    await expect(source.product(NEEM)).rejects.toBeInstanceOf(ShopMissingError);
  });

  it('keeps answers per host for 30 seconds, and never a quote', async () => {
    const api = fakeApi();
    const cache = createAnswerCache({ ttlMs: 30_000, maxEntries: 100 });
    const sourceOf = (host: string) =>
      createApiSource(createShopApi({ apiUrl: API, host, key: KEY, cache, fetch: api.fetch }));
    await sourceOf(HOST).shop();
    await sourceOf(HOST).shop();
    // Another host is another shop: never the first one's answer
    await expect(sourceOf('other.omnivo.test').shop()).rejects.toBeInstanceOf(ShopMissingError);
    // "No such product" is kept as well
    await sourceOf(HOST).product('no-such-product');
    await sourceOf(HOST).product('no-such-product');
    const cart = { lines: [{ listingId: STEVIA, quantity: 1 }] };
    await sourceOf(HOST).quote(cart);
    await sourceOf(HOST).quote(cart);
    expect(api.paths()).toEqual([
      '/public/v1/shop',
      '/public/v1/shop',
      '/public/v1/products/no-such-product',
      '/public/v1/cart/quote',
      '/public/v1/cart/quote',
    ]);
    expect(api.requests.map((request) => request.headers.get(SHOP_HOST_HEADER))).toEqual([
      HOST,
      'other.omnivo.test',
      HOST,
      HOST,
      HOST,
    ]);
  });

  it('fails when the API fails, and asks again next time', async () => {
    const { source, api } = setup();
    api.failWith(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(source.shop()).rejects.toBeInstanceOf(ShopApiError);
    expect(await source.shop()).toEqual(mockShop);
    expect(api.paths()).toEqual(['/public/v1/shop', '/public/v1/shop']);
  });

  it('fails on an answer that breaks the contract', async () => {
    const { source, api } = setup();
    api.failWith(Response.json({ ...mockShop, theme: { brand: 'red', accent: 'lime' } }));
    await expect(source.shop()).rejects.toThrow(/broke its contract/);
  });

  it('fails when no answer comes, or it comes too late', async () => {
    const down = createShopApi({
      apiUrl: API,
      host: HOST,
      key: KEY,
      cache: createAnswerCache({ ttlMs: 30_000, maxEntries: 10 }),
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(createApiSource(down).shop()).rejects.toMatchObject({
      name: 'ShopApiError',
      status: 0,
    });

    // A fetch that answers only when it is aborted, as a hung API does
    const hung = createShopApi({
      apiUrl: API,
      host: HOST,
      key: KEY,
      cache: createAnswerCache({ ttlMs: 30_000, maxEntries: 10 }),
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation timed out.', 'TimeoutError'));
          });
        }),
    });
    await expect(createApiSource(hung).home()).rejects.toBeInstanceOf(ShopApiError);
  });
});

describe('orders on the API source', () => {
  const order = {
    lines: [{ listingId: STEVIA, quantity: 3 }],
    zoneId: 'inside_dhaka',
    name: 'Sumi Akter',
    phone: '01786120356',
    address: 'House 12, Road 5, Mirpur 10, Dhaka',
    paymentMethod: 'cod' as const,
    termsAccepted: true as const,
  };

  // What the checkout saw: the mock's total for the same cart, which is what the fake API answers
  async function expectedTotal() {
    return (await createMockSource().quote({ lines: order.lines, zoneId: order.zoneId })).total;
  }

  async function place(source: ShopSource) {
    const placed = await source.placeOrder(
      { ...order, expectedTotal: await expectedTotal() },
      ADDRESS,
    );
    if (!placed.ok) throw new Error(`refused: ${placed.code}`);
    return placed.value;
  }

  const sentTo = (api: ReturnType<typeof fakeApi>, path: string) =>
    api.requests.filter((request) => new URL(request.url).pathname === `/public/v1${path}`);

  it('places an order with the API, and sends the key and the address on order routes only', async () => {
    const { source, api } = setup();
    await source.shop();
    await source.quote({ lines: order.lines });
    const placed = await place(source);
    expect(placed.answer).toEqual({
      next: 'verify',
      maskedPhone: '+880 17•• ••• 356',
      resendInSeconds: 45,
    });

    // The whole order goes to the API in one request: no quote first (the API prices it itself)
    const [sent] = sentTo(api, '/orders');
    expect(await sent?.json()).toMatchObject({ name: 'Sumi Akter', phone: '01786120356' });
    expect(sent?.headers.get(SHOP_KEY_HEADER)).toBe(KEY);
    expect(sent?.headers.get(SHOP_CLIENT_ADDRESS_HEADER)).toBe(ADDRESS);
    expect(sentTo(api, '/cart/quote')).toHaveLength(1);
    // A read route carries neither
    for (const path of ['/shop', '/cart/quote']) {
      const [read] = sentTo(api, path);
      expect(read?.headers.get(SHOP_KEY_HEADER)).toBeNull();
      expect(read?.headers.get(SHOP_CLIENT_ADDRESS_HEADER)).toBeNull();
    }
  });

  it('confirms with the code and opens the order with its token', async () => {
    const { source, api } = setup();
    const { token } = await place(source);
    expect((await source.codeWait(token))?.listingIds).toEqual([STEVIA]);

    // A real shop shows no code: it goes only to the phone (the fake API is the mock, which takes
    // MOCK_CODE)
    expect(source.testCode).toBeNull();
    expect(await source.verifyCode(token, MOCK_CODE)).toEqual({
      ok: true,
      value: { orderNo: 'W-000001', phone: '01786120356' },
    });
    expect(await source.codeWait(token)).toBeNull();
    expect((await source.order('W-000001', token))?.total).toBe(await expectedTotal());
    // Another browser's token finds nothing
    expect(await source.order('W-000001', 'A'.repeat(22))).toBeNull();
    // Every token went in a body, never in an address (27a's decision 15)
    expect(api.paths().some((path) => path.includes(token))).toBe(false);
  });

  it('passes on the refusals the pages know, with their params', async () => {
    const { source, api } = setup();
    expect(await source.placeOrder({ ...order, expectedTotal: '1.0000' }, ADDRESS)).toEqual({
      ok: false,
      code: 'shop_order_changed',
    });
    const { token } = await place(source);
    expect(await source.verifyCode(token, '000000')).toEqual({
      ok: false,
      code: 'shop_code_wrong',
      params: { triesLeft: 4 },
    });
    expect(await source.resendCode(token)).toMatchObject({
      ok: false,
      code: 'shop_code_resend_wait',
      params: { seconds: 45 },
    });
    api.failWith(problem(429, 'shop_order_limit', { minutes: 12 }));
    expect(await source.placeOrder({ ...order, expectedTotal: '1' }, ADDRESS)).toEqual({
      ok: false,
      code: 'shop_order_limit',
      params: { minutes: 12 },
    });
  });

  it('throws on a refusal the page has no words for', async () => {
    const { source, api } = setup();
    const { token } = await place(source);
    // An order limit is not an answer to a code: a mistake on one side, not a shopper's
    api.failWith(problem(429, 'shop_order_limit', { minutes: 12 }));
    await expect(source.verifyCode(token, MOCK_CODE)).rejects.toBeInstanceOf(ShopApiError);
  });

  it('names the setting to fix when the API refuses the key', async () => {
    const { source } = setup({ key: 'not-the-api-key-0123456789abcdef01234' });
    await expect(
      source.placeOrder({ ...order, expectedTotal: await expectedTotal() }, ADDRESS),
    ).rejects.toThrow(/SHOP_API_KEY/);
    // The read routes need no key, so the shop's pages still work
    expect(await source.shop()).toEqual(mockShop);
  });

  it('does not ask for an order number the API would refuse', async () => {
    const { source, api } = setup();
    // From an edited cookie: the same "not found" as a wrong number, not a 500
    expect(await source.order('abc', 'A'.repeat(22))).toBeNull();
    expect(sentTo(api, '/orders/find')).toHaveLength(0);
  });

  it('tracks by link and by the form, with the API’s limit', async () => {
    const { source, api } = setup({ api: fakeApi(createMockSource(undefined, mockDemoOrders)) });
    expect((await source.tracking('C2etI9zQb8E5ZugpwzVWyA'))?.orderNo).toBe('W-000123');
    expect(await source.tracking('A'.repeat(22))).toBeNull();

    const sylhet = shopTrackRequestSchema.parse({ phone: '01786120356', orderNo: 'W-000123' });
    expect(await source.track(sylhet, ADDRESS)).toMatchObject({
      ok: true,
      value: { orderNo: 'W-000123' },
    });
    const wrong = shopTrackRequestSchema.parse({ phone: '01711284519', orderNo: 'W-000123' });
    expect(await source.track(wrong, ADDRESS)).toEqual({
      ok: false,
      code: 'shop_track_not_found',
    });
    // The form's misses count under the shopper's address, which only the API sees this way
    expect(sentTo(api, '/track')[0]?.headers.get(SHOP_CLIENT_ADDRESS_HEADER)).toBe(ADDRESS);
    api.failWith(problem(429, 'shop_track_too_many', { minutes: 14 }));
    expect(await source.track(sylhet, ADDRESS)).toEqual({
      ok: false,
      code: 'shop_track_too_many',
      params: { minutes: 14 },
    });
    // A real shop offers no demo orders on /track
    expect(source.testTracking).toBeNull();
  });
});
