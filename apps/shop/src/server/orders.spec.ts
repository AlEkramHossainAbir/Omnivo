import {
  problemSchema,
  shopOrderConfirmedSchema,
  shopOrderPlacedSchema,
  type ShopOrderRequestInput,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { createMockSource } from '../data/mock/mock-source';
import type { ShopSource } from '../data/types';
import { orderTokens, ordersCookie } from './cookies';
import { answerPlaceOrder, answerResendCode, answerVerifyCode } from './orders';

const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
const OPTIONS = { secure: false };
// The shopper's address, which the route passes on to the source (the API counts orders by it)
const ADDRESS = '203.0.113.7';
// Step 27d: the shop's own address, for the mock's fake gateway page (ShopSource.placeOrder)
const ORIGIN = 'http://shop.test';

// What the checkout sends: the phone as the shopper typed it
const ORDER: ShopOrderRequestInput = {
  lines: [{ listingId: NEEM, quantity: 3 }],
  zoneId: 'inside_dhaka',
  name: 'Nusrat Jahan',
  phone: '+880 1786-120356',
  address: 'House 12, Road 5, Mirpur 10, Dhaka',
  paymentMethod: 'cod',
  termsAccepted: true,
  expectedTotal: '767',
};

function post(path: string, body: unknown, cookie?: string): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cookie !== undefined) headers.set('Cookie', cookie);
  return new Request(`http://shop.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function problemOf(response: Response) {
  expect(response.headers.get('Content-Type')).toBe('application/problem+json');
  return problemSchema.parse(await response.json());
}

// The Set-Cookie lines by cookie name, and the "name=value" a browser would send back
function cookiesOf(response: Response): Map<string, string> {
  return new Map(
    response.headers.getSetCookie().map((line) => [line.slice(0, line.indexOf('=')), line]),
  );
}

function sentBack(setCookie: string | undefined): string {
  if (setCookie === undefined) throw new Error('no such cookie');
  return setCookie.slice(0, setCookie.indexOf(';'));
}

function withClock() {
  let now = new Date('2026-11-11T10:00:00+06:00');
  return {
    source: createMockSource(() => now),
    // An arrow, not a method: the tests take it out of the object (`const { wait } = …`)
    wait: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}

// Places a Cash on Delivery order and gives back the cookie the browser keeps
async function placeCod(source: ShopSource): Promise<string> {
  const response = await answerPlaceOrder(
    post('/api/orders', ORDER),
    source,
    ADDRESS,
    ORIGIN,
    OPTIONS,
  );
  expect(response.status).toBe(201);
  return sentBack(cookiesOf(response).get('shop_checkout'));
}

describe('POST /api/orders', () => {
  it('places a Cash on Delivery order and keeps its token out of reach of scripts', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(
      post('/api/orders', ORDER),
      source,
      ADDRESS,
      ORIGIN,
      OPTIONS,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const text = await response.clone().text();
    expect(shopOrderPlacedSchema.parse(JSON.parse(text))).toEqual({
      next: 'verify',
      maskedPhone: '+880 17•• ••• 356',
      resendInSeconds: 45,
    });

    const cookie = cookiesOf(response).get('shop_checkout') ?? '';
    expect(cookie).toMatch(
      /^shop_checkout=[A-Za-z0-9_-]{22}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/,
    );
    // The token is only in the cookie, never in the body a script can read
    expect(text).not.toContain(sentBack(cookie).split('=')[1]);
  });

  it('marks the cookies Secure in production', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, ADDRESS, ORIGIN, {
      secure: true,
    });
    expect(cookiesOf(response).get('shop_checkout')).toMatch(/; Secure$/);
  });

  // Step 27d: Pay online waits for its payment, as Cash on Delivery waits for its code
  it('sends Pay online to the payment page, with the order in the checkout cookie', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(
      post('/api/orders', { ...ORDER, paymentMethod: 'online' }),
      source,
      ADDRESS,
      ORIGIN,
      OPTIONS,
    );
    expect(response.status).toBe(201);
    const answer = shopOrderPlacedSchema.parse(await response.json());
    if (answer.next !== 'pay') throw new Error(`The order answered ${answer.next}`);
    // On this shop's own address (ORIGIN), as the API's fake gateway puts it
    expect(answer.paymentUrl).toMatch(
      /^http:\/\/shop\.test\/checkout\/fake-gateway\?tranId=[A-Z0-9]{20}&/,
    );
    const cookies = cookiesOf(response);
    expect(cookies.get('shop_checkout')).toMatch(/^shop_checkout=[A-Za-z0-9_-]{22}; Path=\//);
    // Not this browser's order yet: /order/<no> opens only once it is paid
    expect(cookies.has('shop_orders')).toBe(false);
  });

  it('names the fields the shopper must fix', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(
      post('/api/orders', {
        ...ORDER,
        phone: '02 9876543',
        termsAccepted: false,
        address: 'Dhaka',
      }),
      source,
      ADDRESS,
      ORIGIN,
      OPTIONS,
    );
    expect(response.status).toBe(400);
    expect((await problemOf(response)).fieldErrors).toEqual({
      phone: ['shop_phone_format'],
      address: ['shop_address_too_short'],
      termsAccepted: ['shop_terms_required'],
    });
  });

  it('refuses a body that does not say it is JSON', async () => {
    // What a form on another site can send without asking (text/plain needs no CORS preflight)
    const { source } = withClock();
    const request = new Request('http://shop.test/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(ORDER),
    });
    const response = await answerPlaceOrder(request, source, ADDRESS, ORIGIN, OPTIONS);
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('malformed_request');
  });

  it('answers 409 when the total is not the one the shopper saw', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(
      post('/api/orders', { ...ORDER, expectedTotal: '700' }),
      source,
      ADDRESS,
      ORIGIN,
      OPTIONS,
    );
    expect(response.status).toBe(409);
    expect((await problemOf(response)).code).toBe('shop_order_changed');
  });

  it('says the minimum order in the problem', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(
      post('/api/orders', {
        ...ORDER,
        lines: [{ listingId: NEEM, quantity: 1 }],
        expectedTotal: '309',
      }),
      source,
      ADDRESS,
      ORIGIN,
      OPTIONS,
    );
    expect(response.status).toBe(422);
    const problem = await problemOf(response);
    expect(problem).toMatchObject({ code: 'shop_order_below_minimum', params: { minimum: '300' } });
  });

  // Step 27a
  it('passes the shopper’s address to the source', async () => {
    const { source } = withClock();
    const addresses: string[] = [];
    const watched: ShopSource = {
      ...source,
      placeOrder: (request, address, origin) => {
        addresses.push(address);
        return source.placeOrder(request, address, origin);
      },
    };
    await answerPlaceOrder(post('/api/orders', ORDER), watched, ADDRESS, ORIGIN, OPTIONS);
    expect(addresses).toEqual([ADDRESS]);
  });

  it('answers the order limit with 429 and the wait in Retry-After', async () => {
    const limited: ShopSource = {
      ...createMockSource(),
      placeOrder: () =>
        Promise.resolve({ ok: false, code: 'shop_order_limit', params: { minutes: 12 } }),
    };
    const response = await answerPlaceOrder(
      post('/api/orders', ORDER),
      limited,
      ADDRESS,
      ORIGIN,
      OPTIONS,
    );
    expect(response.status).toBe(429);
    // Retry-After is in seconds; the words say minutes
    expect(response.headers.get('Retry-After')).toBe('720');
    expect(await problemOf(response)).toMatchObject({
      code: 'shop_order_limit',
      params: { minutes: 12 },
    });
  });

  // Step 27c
  it('answers a coupon this mobile number has had with 422', async () => {
    const source = createMockSource();
    // ৳687 − 10% (৳68.70) + ৳80. The first order holds the use while it waits for its code
    const welcome = { ...ORDER, couponCode: 'WELCOME10', expectedTotal: '698.30' };
    await answerPlaceOrder(post('/api/orders', welcome), source, ADDRESS, ORIGIN, OPTIONS);
    const response = await answerPlaceOrder(
      post('/api/orders', welcome),
      source,
      ADDRESS,
      ORIGIN,
      OPTIONS,
    );
    expect(response.status).toBe(422);
    expect(await problemOf(response)).toMatchObject({ code: 'shop_coupon_used_by_phone' });
  });

  it('hides a failing source behind internal_error', async () => {
    const down: ShopSource = {
      ...createMockSource(),
      placeOrder: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:3000')),
    };
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const response = await answerPlaceOrder(
        post('/api/orders', ORDER),
        down,
        ADDRESS,
        ORIGIN,
        OPTIONS,
      );
      expect(response.status).toBe(500);
      expect(JSON.stringify(await problemOf(response))).not.toContain('10.0.0.5');
    } finally {
      console.error = quiet;
    }
  });
});

describe('POST /api/orders/verify', () => {
  it('confirms the order with the code typed in Bangla digits', async () => {
    const { source } = withClock();
    const checkout = await placeCod(source);
    const response = await answerVerifyCode(
      post('/api/orders/verify', { code: '১২৩ ৪৫৬' }, checkout),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(200);
    expect(shopOrderConfirmedSchema.parse(await response.json())).toEqual({
      orderNo: 'W-000001',
      phone: '01786120356',
    });

    // The token moves from the waiting cookie to this browser's orders, and the order shows
    const cookies = cookiesOf(response);
    expect(cookies.get('shop_checkout')).toMatch(/Max-Age=0/);
    const orders = sentBack(cookies.get('shop_orders'));
    const token = checkout.split('=')[1] ?? '';
    expect(orders).toBe(`shop_orders=W-000001:${token}`);
    expect(await source.order('W-000001', token)).not.toBeNull();
  });

  it('says how many tries are left after a wrong code', async () => {
    const { source } = withClock();
    const checkout = await placeCod(source);
    const response = await answerVerifyCode(
      post('/api/orders/verify', { code: '000000' }, checkout),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(422);
    expect(await problemOf(response)).toMatchObject({
      code: 'shop_code_wrong',
      params: { triesLeft: 4 },
    });
    // The order still waits: its cookie is not touched
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('clears the cookie when the fifth wrong code drops the order', async () => {
    const { source } = withClock();
    const checkout = await placeCod(source);
    let response = new Response();
    for (let i = 0; i < 5; i += 1) {
      response = await answerVerifyCode(
        post('/api/orders/verify', { code: '000000' }, checkout),
        source,
        OPTIONS,
      );
    }
    expect((await problemOf(response)).code).toBe('shop_code_too_many');
    expect(cookiesOf(response).get('shop_checkout')).toMatch(/Max-Age=0/);
  });

  // Step 27a: no try is spent, and the cookie stays: a new code still confirms the order
  it('refuses a code after its 10 minutes and keeps the order', async () => {
    const { source, wait } = withClock();
    const checkout = await placeCod(source);
    wait(10 * 60);
    const response = await answerVerifyCode(
      post('/api/orders/verify', { code: '123456' }, checkout),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe('shop_code_expired');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('answers 404 without a cookie, or with one it never made', async () => {
    const { source } = withClock();
    for (const cookie of [
      undefined,
      'shop_checkout=not-a-token',
      `shop_checkout=${'a'.repeat(22)}`,
      // Step 27a: a cookie in 26c's old shape (64 hex digits) is not the API's token
      `shop_checkout=${'a'.repeat(64)}`,
    ]) {
      const response = await answerVerifyCode(
        post('/api/orders/verify', { code: '123456' }, cookie),
        source,
        OPTIONS,
      );
      expect(response.status).toBe(404);
      expect((await problemOf(response)).code).toBe('shop_code_no_order');
    }
  });

  it('refuses a code that is not six digits before asking the source', async () => {
    const { source } = withClock();
    const checkout = await placeCod(source);
    const response = await answerVerifyCode(
      post('/api/orders/verify', { code: '12345' }, checkout),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(400);
    expect((await problemOf(response)).fieldErrors).toEqual({ code: ['shop_code_format'] });
    // Not counted as a wrong code: a typo of length is not a guess
    const right = await answerVerifyCode(
      post('/api/orders/verify', { code: '000000' }, checkout),
      source,
      OPTIONS,
    );
    expect((await problemOf(right)).params).toEqual({ triesLeft: 4 });
  });
});

describe('POST /api/orders/resend', () => {
  it('waits 45 seconds between codes, and says so in Retry-After', async () => {
    const { source, wait } = withClock();
    const checkout = await placeCod(source);

    wait(40);
    const early = await answerResendCode(post('/api/orders/resend', {}, checkout), source, OPTIONS);
    expect(early.status).toBe(429);
    expect(early.headers.get('Retry-After')).toBe('5');
    expect(await problemOf(early)).toMatchObject({
      code: 'shop_code_resend_wait',
      params: { seconds: 5 },
    });

    wait(5);
    const sent = await answerResendCode(post('/api/orders/resend', {}, checkout), source, OPTIONS);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ resendInSeconds: 45 });
  });

  // Step 27a: the first code and two more
  it('refuses a fourth code and keeps the order', async () => {
    const { source, wait } = withClock();
    const checkout = await placeCod(source);
    for (let send = 0; send < 2; send += 1) {
      wait(45);
      const sent = await answerResendCode(
        post('/api/orders/resend', {}, checkout),
        source,
        OPTIONS,
      );
      expect(sent.status).toBe(200);
    }
    wait(45);
    const fourth = await answerResendCode(
      post('/api/orders/resend', {}, checkout),
      source,
      OPTIONS,
    );
    expect(fourth.status).toBe(422);
    expect((await problemOf(fourth)).code).toBe('shop_code_sends_used');
    expect(fourth.headers.getSetCookie()).toEqual([]);
  });

  it('answers 404 and clears the cookie for an order that stopped waiting', async () => {
    const { source, wait } = withClock();
    const checkout = await placeCod(source);
    wait(60 * 60);
    const response = await answerResendCode(
      post('/api/orders/resend', {}, checkout),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(404);
    expect(cookiesOf(response).get('shop_checkout')).toMatch(/Max-Age=0/);
  });
});

describe('the orders cookie', () => {
  const token = (n: number) => String(n).padStart(22, '0');

  it('keeps the newest 20 orders', () => {
    let cookie = '';
    for (let n = 1; n <= 21; n += 1) {
      const request = new Request('http://shop.test/', { headers: { Cookie: cookie } });
      cookie = sentBack(
        ordersCookie(request, `W-${String(n).padStart(6, '0')}`, token(n), OPTIONS),
      );
    }
    const kept = orderTokens(new Request('http://shop.test/', { headers: { Cookie: cookie } }));
    expect(kept.size).toBe(20);
    expect(kept.has('W-000001')).toBe(false);
    expect(kept.get('W-000021')).toBe(token(21));
  });

  it('skips a pair that was edited, and keeps the rest', () => {
    const request = new Request('http://shop.test/', {
      headers: {
        Cookie: `theme=x; shop_orders=W-000001:${token(1)}.W-000002:<script>.:${token(3)}`,
      },
    });
    expect([...orderTokens(request)]).toEqual([['W-000001', token(1)]]);
  });
});
