import {
  fakeValId,
  type ShopOrderRequestInput,
  SHOP_PAYMENT_NOTICE_PATH,
  SHOP_PAYMENT_RETURN_PATH,
  shopPaymentRetrySchema,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { fakePageOf } from '../data/mock/fake-payment';
import { createMockSource } from '../data/mock/mock-source';
import type { ShopSource } from '../data/types';
import { answerPlaceOrder } from './orders';
import {
  answerGatewayNotice,
  answerGatewayReturn,
  answerPayOnDelivery,
  answerRetryPayment,
  gatewayIds,
} from './payments';

const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
const OPTIONS = { secure: false };
const ADDRESS = '203.0.113.7';
// Step 27d: the shop's own address, for the mock's fake gateway page (ShopSource.placeOrder)
const ORIGIN = 'http://shop.test';

const ONLINE: ShopOrderRequestInput = {
  lines: [{ listingId: NEEM, quantity: 3 }],
  zoneId: 'inside_dhaka',
  name: 'Nusrat Jahan',
  phone: '01786120356',
  address: 'House 12, Road 5, Mirpur 10, Dhaka',
  paymentMethod: 'online',
  termsAccepted: true,
  expectedTotal: '767',
};

// What SSLCommerz posts: a form, with more fields than the two the shop reads
function gatewayPost(path: string, fields: Record<string, string>, type = 'form'): Request {
  const body = new URLSearchParams({ status: 'VALID', amount: '1.00', ...fields });
  return new Request(`http://shop.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': type === 'form' ? 'application/x-www-form-urlencoded' : type,
    },
    body: body.toString(),
  });
}

function withCookie(path: string, cookie: string | null): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cookie !== null) headers.set('Cookie', cookie);
  return new Request(`http://shop.test${path}`, { method: 'POST', headers });
}

// Places an online order through the route and gives back its cookie and page
async function placeOnline(source: ShopSource) {
  const response = await answerPlaceOrder(
    new Request('http://shop.test/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ONLINE),
    }),
    source,
    ADDRESS,
    ORIGIN,
    OPTIONS,
  );
  const body: unknown = await response.json();
  const line = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('shop_checkout='));
  if (line === undefined || typeof body !== 'object' || body === null || !('paymentUrl' in body)) {
    throw new Error('Not an online order');
  }
  const paymentUrl = typeof body.paymentUrl === 'string' ? body.paymentUrl : null;
  return { cookie: line.slice(0, line.indexOf(';')), page: fakePageOf(paymentUrl) };
}

describe('the gateway’s post (step 27d)', () => {
  it('reads only the two ids, from a form', async () => {
    const tranId = 'A'.repeat(20);
    expect(await gatewayIds(gatewayPost('/', { tran_id: tranId, val_id: ' V1 ' }))).toEqual({
      tranId,
      valId: 'V1',
    });
    // Failed and cancelled posts bring an empty val_id
    expect(await gatewayIds(gatewayPost('/', { tran_id: tranId, val_id: '' }))).toEqual({
      tranId,
      valId: null,
    });
    expect(await gatewayIds(gatewayPost('/', { tran_id: 'W-000001' }))).toBeNull();
    expect(await gatewayIds(gatewayPost('/', { tran_id: tranId }, 'application/json'))).toBeNull();
  });

  it('settles the try on the return path, then sends the browser to /checkout/paid', async () => {
    const source = createMockSource();
    const { page } = await placeOnline(source);
    const response = await answerGatewayReturn(
      gatewayPost(SHOP_PAYMENT_RETURN_PATH, {
        tran_id: page.tranId,
        val_id: fakeValId(page.tranId, { outcome: 'paid', amount: page.amount }),
      }),
      source,
    );
    // 303: the browser asks /checkout/paid with GET, so a reload never posts the form again
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/checkout/paid');
    // Settled already: a second post changes nothing
    expect(await source.settlePayment({ tranId: page.tranId, valId: null })).toEqual({
      status: 'paid',
    });
  });

  it('still sends the browser on when the post cannot settle anything', async () => {
    const source = createMockSource();
    for (const fields of [{ tran_id: 'A'.repeat(20) }, { nothing: 'here' }]) {
      const response = await answerGatewayReturn(
        gatewayPost(SHOP_PAYMENT_RETURN_PATH, fields),
        source,
      );
      expect(response.status).toBe(303);
    }
  });

  it('answers the gateway’s notice for the gateway', async () => {
    const source = createMockSource();
    const { page } = await placeOnline(source);
    const paid = await answerGatewayNotice(
      gatewayPost(SHOP_PAYMENT_NOTICE_PATH, {
        tran_id: page.tranId,
        val_id: fakeValId(page.tranId, { outcome: 'paid', amount: page.amount }),
      }),
      source,
    );
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ status: 'paid' });
    const unknown = await answerGatewayNotice(
      gatewayPost(SHOP_PAYMENT_NOTICE_PATH, { tran_id: 'B'.repeat(20) }),
      source,
    );
    expect(unknown.status).toBe(404);
    const broken = await answerGatewayNotice(gatewayPost(SHOP_PAYMENT_NOTICE_PATH, {}), source);
    expect(broken.status).toBe(400);
  });

  it('answers 500 when the source is down, so the gateway posts again', async () => {
    const down: ShopSource = {
      ...createMockSource(),
      settlePayment: () => Promise.reject(new Error('API down')),
    };
    const response = await answerGatewayNotice(
      gatewayPost(SHOP_PAYMENT_NOTICE_PATH, { tran_id: 'C'.repeat(20) }),
      down,
    );
    expect(response.status).toBe(500);
  });
});

describe('the buttons on /checkout/paid (step 27d)', () => {
  it('opens a new page with "Try again", and refuses after the third try', async () => {
    const source = createMockSource();
    const { cookie, page } = await placeOnline(source);
    const second = await answerRetryPayment(
      withCookie('/api/payments/retry', cookie),
      source,
      ORIGIN,
    );
    expect(second.status).toBe(200);
    expect(second.headers.get('Cache-Control')).toBe('no-store');
    const { paymentUrl } = shopPaymentRetrySchema.parse(await second.json());
    // A new try: its own transaction id
    expect(paymentUrl).toContain('/checkout/fake-gateway?');
    expect(paymentUrl).not.toContain(page.tranId);

    await answerRetryPayment(withCookie('/api/payments/retry', cookie), source, ORIGIN);
    const fourth = await answerRetryPayment(
      withCookie('/api/payments/retry', cookie),
      source,
      ORIGIN,
    );
    expect(fourth.status).toBe(422);
    expect(await fourth.json()).toMatchObject({ code: 'shop_payment_tries_used' });
  });

  it('turns the order into Cash on Delivery and keeps the cookie for the verify page', async () => {
    const source = createMockSource();
    const { cookie } = await placeOnline(source);
    const response = await answerPayOnDelivery(withCookie('/api/payments/cod', cookie), source);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ next: 'verify', resendInSeconds: 45 });
    expect(response.headers.getSetCookie()).toEqual([]);
    // "Try again" is over for it
    const retry = await answerRetryPayment(
      withCookie('/api/payments/retry', cookie),
      source,
      ORIGIN,
    );
    expect(retry.status).toBe(409);
  });

  it('needs the checkout cookie', async () => {
    const source = createMockSource();
    const answers = [
      (request: Request) => answerRetryPayment(request, source, ORIGIN),
      (request: Request) => answerPayOnDelivery(request, source),
    ];
    for (const answer of answers) {
      const response = await answer(withCookie('/api/payments/x', null));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'shop_payment_no_order' });
    }
  });
});
