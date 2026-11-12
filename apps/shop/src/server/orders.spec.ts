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
  const response = await answerPlaceOrder(post('/api/orders', ORDER), source, OPTIONS);
  expect(response.status).toBe(201);
  return sentBack(cookiesOf(response).get('shop_checkout'));
}

describe('POST /api/orders', () => {
  it('places a Cash on Delivery order and keeps its token out of reach of scripts', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, OPTIONS);
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
      /^shop_checkout=[0-9a-f]{64}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/,
    );
    // The token is only in the cookie, never in the body a script can read
    expect(text).not.toContain(sentBack(cookie).split('=')[1]);
  });

  it('marks the cookies Secure in production', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, { secure: true });
    expect(cookiesOf(response).get('shop_checkout')).toMatch(/; Secure$/);
  });

  it('confirms Mobile Banking at once and remembers the order in this browser', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(
      post('/api/orders', { ...ORDER, paymentMethod: 'online' }),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      next: 'confirmed',
      orderNo: 'W-000001',
      phone: '01786120356',
    });
    const cookies = cookiesOf(response);
    expect(cookies.get('shop_orders')).toMatch(
      /^shop_orders=W-000001:[0-9a-f]{64}; Path=\/; Max-Age=2592000;/,
    );
    // A code that was still waiting from an earlier try is forgotten
    expect(cookies.get('shop_checkout')).toMatch(/^shop_checkout=; Path=\/; Max-Age=0;/);
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
    const response = await answerPlaceOrder(request, source, OPTIONS);
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('malformed_request');
  });

  it('answers 409 when the total is not the one the shopper saw', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(
      post('/api/orders', { ...ORDER, expectedTotal: '700' }),
      source,
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
      OPTIONS,
    );
    expect(response.status).toBe(422);
    const problem = await problemOf(response);
    expect(problem).toMatchObject({ code: 'shop_order_below_minimum', params: { minimum: '300' } });
  });

  it('hides a failing source behind internal_error', async () => {
    const down: ShopSource = {
      ...createMockSource(),
      placeOrder: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:3000')),
    };
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const response = await answerPlaceOrder(post('/api/orders', ORDER), down, OPTIONS);
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

  it('answers 404 without a cookie, or with one it never made', async () => {
    const { source } = withClock();
    for (const cookie of [
      undefined,
      'shop_checkout=not-a-token',
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
  const token = (n: number) => String(n).padStart(64, '0');

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
