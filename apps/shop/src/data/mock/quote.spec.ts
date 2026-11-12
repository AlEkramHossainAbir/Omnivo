import { shopCartQuoteSchema, type ShopCartQuoteRequest } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockQuoteContext } from './mock-source';
import { mockCatalog } from './products';
import { quoteCart, type QuoteContext } from './quote';

const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
const STEVIA = 'lst-zero-cal-stevia-30-sachets'; // ৳120
const DANO = 'lst-dano-daily-pushti-milk-1kg'; // out of stock

// 11 Nov 2026, 10 am in Dhaka
const NOW = new Date('2026-11-11T10:00:00+06:00');
const context = mockQuoteContext(NOW);

// The context with Stevia at another price, for carts that must land on an exact amount
function steviaAt(price: string): QuoteContext {
  return {
    ...context,
    catalog: mockCatalog.map((listing) =>
      listing.id === STEVIA ? { ...listing, price } : listing,
    ),
  };
}

function quote(request: ShopCartQuoteRequest, at: QuoteContext = context) {
  const answer = quoteCart(request, at);
  // Every answer must be what the real API will send: the drawer and the checkout trust it as it is
  expect(() => shopCartQuoteSchema.parse(answer)).not.toThrow();
  return answer;
}

describe('quoteCart', () => {
  it('prices each line at today’s price and sums them on the server', () => {
    const answer = quote({
      lines: [
        { listingId: NEEM, quantity: 3 },
        { listingId: STEVIA, quantity: 1 },
      ],
    });
    expect(answer.lines).toMatchObject([
      { status: 'available', listingId: NEEM, unitPrice: '229', lineTotal: '687.0000' },
      { status: 'available', listingId: STEVIA, unitPrice: '120', lineTotal: '120.0000' },
    ]);
    expect(answer.itemCount).toBe(4);
    expect(answer.subtotal).toBe('807.0000');
  });

  it('keeps the cart’s order and leaves out what cannot be sold', () => {
    const answer = quote({
      lines: [
        { listingId: DANO, quantity: 2 },
        { listingId: 'lst-gone', quantity: 1 },
        { listingId: STEVIA, quantity: 2 },
      ],
    });
    expect(answer.lines.map((line) => line.status)).toEqual([
      'out_of_stock',
      'unavailable',
      'available',
    ]);
    // A gone listing says only its id: the browser drops it, and there is nothing else to show
    expect(answer.lines[1]).toEqual({ status: 'unavailable', listingId: 'lst-gone' });
    // The out-of-stock 2 are not counted, and add no money
    expect(answer.itemCount).toBe(2);
    expect(answer.subtotal).toBe('240.0000');
  });

  it('answers an empty cart with nothing to pay', () => {
    expect(quote({ lines: [] })).toEqual({
      lines: [],
      itemCount: 0,
      subtotal: '0.0000',
      discount: '0.0000',
      coupon: { status: 'none' },
      deliveryCharge: null,
      freeDelivery: false,
      total: '0.0000',
      // Under the shop's ৳300: the checkout says how much more is needed
      belowMinimum: true,
    });
  });

  it('never adds money as floating point', () => {
    // 3 × 49.90 is 149.70000000000002 with JavaScript numbers
    const answer = quote({ lines: [{ listingId: STEVIA, quantity: 3 }] }, steviaAt('49.90'));
    expect(answer.subtotal).toBe('149.7000');
  });
});

describe('quoteCart: delivery', () => {
  const lines = [{ listingId: NEEM, quantity: 3 }]; // ৳687

  it('has no charge and the items as the total until a zone is picked', () => {
    // The drawer's request: the 26b answer, with the rest of the bill still empty
    const answer = quote({ lines });
    expect(answer.deliveryCharge).toBeNull();
    expect(answer.total).toBe('687.0000');
  });

  it('adds the zone’s charge', () => {
    expect(quote({ lines, zoneId: 'inside_dhaka' })).toMatchObject({
      deliveryCharge: '80.0000',
      freeDelivery: false,
      total: '767.0000',
    });
    expect(quote({ lines, zoneId: 'outside_dhaka' }).total).toBe('807.0000');
  });

  it('treats a zone the shop does not have as no zone', () => {
    // An old checkout tab after the shop removed a zone: "Pick a location", not an error
    expect(quote({ lines, zoneId: 'chattogram' }).deliveryCharge).toBeNull();
  });

  it('delivers free from the shop’s amount, the amount itself included', () => {
    const below = quote(
      { lines: [{ listingId: STEVIA, quantity: 2 }], zoneId: 'outside_dhaka' },
      steviaAt('499.99'),
    );
    expect(below).toMatchObject({ subtotal: '999.9800', freeDelivery: false });
    expect(below.deliveryCharge).toBe('120.0000');

    const at = quote(
      { lines: [{ listingId: STEVIA, quantity: 2 }], zoneId: 'outside_dhaka' },
      steviaAt('500'),
    );
    expect(at).toMatchObject({ freeDelivery: true, deliveryCharge: '0.0000', total: '1000.0000' });
  });

  it('keeps free delivery when a coupon takes the items under the amount', () => {
    // Decision 8: ৳1,000 of items, ৳100 off. Free delivery looks at the ৳1,000
    const answer = quote(
      {
        lines: [{ listingId: STEVIA, quantity: 2 }],
        zoneId: 'inside_dhaka',
        couponCode: 'WELCOME10',
      },
      steviaAt('500'),
    );
    expect(answer).toMatchObject({
      discount: '100.0000',
      freeDelivery: true,
      deliveryCharge: '0.0000',
      total: '900.0000',
    });
  });

  it('says when the items are under the shop’s minimum order', () => {
    expect(quote({ lines: [{ listingId: STEVIA, quantity: 2 }] }).belowMinimum).toBe(true);
    // ৳300 exactly is enough
    expect(
      quote({ lines: [{ listingId: STEVIA, quantity: 2 }] }, steviaAt('150')).belowMinimum,
    ).toBe(false);
  });
});

describe('quoteCart: coupons', () => {
  const lines = [
    { listingId: NEEM, quantity: 3 },
    { listingId: STEVIA, quantity: 1 },
  ]; // ৳807

  it('takes a percent off the items, never off the delivery', () => {
    const answer = quote({ lines, zoneId: 'inside_dhaka', couponCode: 'WELCOME10' });
    expect(answer).toMatchObject({
      coupon: { status: 'applied', code: 'WELCOME10', discount: { kind: 'percent', value: 10 } },
      // 10% of ৳807, to the paisa
      discount: '80.7000',
      deliveryCharge: '80.0000',
      total: '806.3000',
    });
  });

  it('takes a fixed amount once its minimum is reached', () => {
    expect(quote({ lines, couponCode: 'FLAT50' })).toMatchObject({
      coupon: { status: 'applied', code: 'FLAT50' },
      discount: '50.0000',
      total: '757.0000',
    });
  });

  it('refuses a code under its minimum and says the amount', () => {
    const answer = quote({ lines: [{ listingId: STEVIA, quantity: 2 }], couponCode: 'FLAT50' });
    // Decision 9: the cart is still priced, as if no code was sent
    expect(answer).toMatchObject({
      coupon: { status: 'refused', code: 'FLAT50', reason: 'shop_coupon_minimum', minimum: '500' },
      discount: '0.0000',
      total: '240.0000',
    });
  });

  it('refuses a code that does not exist', () => {
    expect(quote({ lines, couponCode: 'FREEBIES' }).coupon).toEqual({
      status: 'refused',
      code: 'FREEBIES',
      reason: 'shop_coupon_unknown',
      minimum: null,
    });
  });

  it('ends a code at midnight in Dhaka, not in UTC', () => {
    // OLD2025's last day is 31 Dec 2025. 11:30 pm that day in Dhaka: it still works
    const lastEvening = mockQuoteContext(new Date('2025-12-31T23:30:00+06:00'));
    expect(quote({ lines, couponCode: 'OLD2025' }, lastEvening).coupon.status).toBe('applied');

    // 0:30 am on 1 January in Dhaka is 6:30 pm on 31 December in UTC. The shop's day has ended
    const nextMorning = mockQuoteContext(new Date('2026-01-01T00:30:00+06:00'));
    expect(quote({ lines, couponCode: 'OLD2025' }, nextMorning).coupon).toMatchObject({
      status: 'refused',
      reason: 'shop_coupon_expired',
    });
  });

  it('never takes off more than the items cost', () => {
    const generous: QuoteContext = {
      ...context,
      coupons: [
        { code: 'BIG', discount: { kind: 'amount', value: '1000' }, minimum: null, lastDay: null },
      ],
    };
    const answer = quote(
      { lines: [{ listingId: STEVIA, quantity: 1 }], zoneId: 'inside_dhaka', couponCode: 'BIG' },
      generous,
    );
    // ৳120 of items, ৳120 off, and the delivery is still paid
    expect(answer).toMatchObject({ discount: '120.0000', total: '80.0000' });
  });
});
