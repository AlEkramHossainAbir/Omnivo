import { shopOrderSchema, type ShopOrderRequest, SHOP_CODE_TRIES } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import type { ShopSource } from '../types';
import { createMockSource } from './mock-source';
import { maskPhone, MOCK_CODE } from './orders';

const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
const DANO = 'lst-dano-daily-pushti-milk-1kg'; // out of stock

// What the route hands the source: the request after shopOrderRequestSchema, phone made plain
const ORDER: ShopOrderRequest = {
  lines: [{ listingId: NEEM, quantity: 3 }],
  zoneId: 'inside_dhaka',
  name: 'Nusrat Jahan',
  phone: '01786120356',
  address: 'House 12, Road 5, Mirpur 10, Dhaka',
  paymentMethod: 'cod',
  termsAccepted: true,
  // ৳687 of face wash and ৳80 delivery
  expectedTotal: '767',
};

// A source whose clock the test moves
function withClock() {
  let now = new Date('2026-11-11T10:00:00+06:00');
  const source = createMockSource(() => now);
  return {
    source,
    // An arrow, not a method: the tests take it out of the object (`const { wait } = …`)
    wait: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}

async function placed(source: ShopSource, request: ShopOrderRequest = ORDER) {
  const result = await source.placeOrder(request);
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('the mock’s orders', () => {
  it('hides the middle of the phone', () => {
    expect(maskPhone('01786120356')).toBe('+880 17•• ••• 356');
  });

  it('asks Cash on Delivery for the phone code', async () => {
    const { source } = withClock();
    const order = await placed(source);
    expect(order.answer).toEqual({
      next: 'verify',
      maskedPhone: '+880 17•• ••• 356',
      resendInSeconds: 45,
    });
    expect(order.orderNo).toBe('W-000001');
    expect(order.token).toMatch(/^[0-9a-f]{64}$/);
    // Not an order yet: /order/<no> does not show it, even with the right token
    expect(await source.order(order.orderNo, order.token)).toBeNull();
  });

  it('confirms a right code, and the order then shows with its token only', async () => {
    const { source } = withClock();
    const { orderNo, token } = await placed(source);
    expect(await source.verifyCode(token, MOCK_CODE)).toEqual({
      ok: true,
      value: { orderNo, phone: '01786120356' },
    });

    const order = await source.order(orderNo, token);
    expect(() => shopOrderSchema.parse(order)).not.toThrow();
    expect(order).toMatchObject({
      status: 'confirmed',
      zoneName: 'Inside Dhaka',
      subtotal: '687.0000',
      deliveryCharge: '80.0000',
      total: '767.0000',
      couponCode: null,
    });
    expect(order?.history.map((step) => step.status)).toEqual(['pending', 'confirmed']);

    // Decision 5: the number with another order's token, or a made-up token, finds nothing
    const other = await placed(source, { ...ORDER, paymentMethod: 'online' });
    expect(await source.order(orderNo, other.token)).toBeNull();
    expect(await source.order(orderNo, 'f'.repeat(64))).toBeNull();
    // And the code cannot confirm it twice
    expect(await source.verifyCode(token, MOCK_CODE)).toMatchObject({ code: 'shop_code_no_order' });
  });

  it('confirms Mobile Banking at once, with the next number', async () => {
    const { source } = withClock();
    await placed(source);
    const order = await placed(source, { ...ORDER, paymentMethod: 'online' });
    expect(order.answer).toEqual({ next: 'confirmed', orderNo: 'W-000002', phone: '01786120356' });
    expect((await source.order('W-000002', order.token))?.status).toBe('confirmed');
  });

  it('drops the order after five wrong codes', async () => {
    const { source } = withClock();
    const { token } = await placed(source);
    for (let triesLeft = SHOP_CODE_TRIES - 1; triesLeft > 0; triesLeft -= 1) {
      expect(await source.verifyCode(token, '000000')).toEqual({
        ok: false,
        code: 'shop_code_wrong',
        params: { triesLeft },
      });
    }
    expect(await source.verifyCode(token, '000000')).toEqual({
      ok: false,
      code: 'shop_code_too_many',
    });
    // Gone: even the right code is too late now
    expect(await source.verifyCode(token, MOCK_CODE)).toMatchObject({ code: 'shop_code_no_order' });
    expect(await source.codeWait(token)).toBeNull();
  });

  it('sends a new code only after 45 seconds, and keeps the wrong codes', async () => {
    const { source, wait } = withClock();
    const { token } = await placed(source);
    await source.verifyCode(token, '000000');

    wait(30);
    expect(await source.resendCode(token)).toEqual({
      ok: false,
      code: 'shop_code_resend_wait',
      params: { seconds: 15 },
    });
    expect((await source.codeWait(token))?.resendInSeconds).toBe(15);

    wait(15);
    expect(await source.resendCode(token)).toEqual({ ok: true, value: { resendInSeconds: 45 } });
    // A new SMS does not give a guesser five new tries
    expect(await source.verifyCode(token, '000000')).toMatchObject({ params: { triesLeft: 3 } });
  });

  it('forgets an order that waited more than an hour', async () => {
    const { source, wait } = withClock();
    const { token } = await placed(source);
    wait(59 * 60);
    // Still waiting, with what the verify page needs: where the code went and what was ordered
    expect(await source.codeWait(token)).toEqual({
      next: 'verify',
      maskedPhone: '+880 17•• ••• 356',
      resendInSeconds: 0,
      listingIds: [NEEM],
    });
    wait(60);
    expect(await source.codeWait(token)).toBeNull();
    expect(await source.verifyCode(token, MOCK_CODE)).toMatchObject({ code: 'shop_code_no_order' });
  });

  it('refuses what the shop does not offer', async () => {
    const { source } = withClock();
    expect(await source.placeOrder({ ...ORDER, zoneId: 'chattogram' })).toEqual({
      ok: false,
      code: 'shop_zone_unknown',
    });
  });

  it('refuses an order under the minimum, with the amount', async () => {
    const { source } = withClock();
    // One face wash: ৳229 of items, ৳80 delivery
    const small = { ...ORDER, lines: [{ listingId: NEEM, quantity: 1 }], expectedTotal: '309' };
    expect(await source.placeOrder(small)).toEqual({
      ok: false,
      code: 'shop_order_below_minimum',
      params: { minimum: '300' },
    });
  });

  it('refuses an order whose total or stock changed since the last quote', async () => {
    const { source } = withClock();
    // Decision 10: the shopper saw ৳747 (an old price); the server's total is ৳767
    expect(await source.placeOrder({ ...ORDER, expectedTotal: '747' })).toMatchObject({
      code: 'shop_order_changed',
    });
    // A line went out of stock: the total of what is left might still match, so it is checked
    // on its own
    const withMilk = { ...ORDER, lines: [...ORDER.lines, { listingId: DANO, quantity: 1 }] };
    expect(await source.placeOrder(withMilk)).toMatchObject({ code: 'shop_order_changed' });
  });

  it('keeps the coupon that took money off, and copies the lines', async () => {
    const { source } = withClock();
    // ৳687 − 10% (৳68.70) + ৳80
    const { orderNo, token } = await placed(source, {
      ...ORDER,
      couponCode: 'WELCOME10',
      paymentMethod: 'online',
      expectedTotal: '698.30',
    });
    const order = await source.order(orderNo, token);
    expect(order).toMatchObject({
      couponCode: 'WELCOME10',
      discount: '68.7000',
      total: '698.3000',
    });
    // Decision 13: the line carries what was bought and for how much, not just the listing's id
    expect(order?.lines).toMatchObject([
      { listingId: NEEM, quantity: 3, unitPrice: '229', lineTotal: '687.0000' },
    ]);
  });
});
