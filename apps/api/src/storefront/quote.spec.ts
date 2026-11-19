import {
  shopCartQuoteSchema,
  type ShopCartQuoteRequest,
  type ShopCheckoutSettings,
  type ShopListing,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import type { QuoteCoupon, ShopCoupon } from './coupon-sql.js';
import { quoteCart, type QuotedListing } from './quote.js';

const NEEM = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a01';
const STEVIA = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a02';
const DANO = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a03';
const GONE = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a04';

function quoted(id: string, name: string, price: string, free = '10.0000'): QuotedListing {
  const image = { url: `https://media.example.com/storefront/${id}/small.webp`, alt: name };
  const listing: ShopListing = {
    id,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    packSize: '',
    images: [image],
    price,
    compareAtPrice: null,
    saleUntil: null,
    discount: null,
    badges: [],
    inStock: Number(free) > 0,
    categoryId: '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a10',
  };
  return { listing, image, free };
}

// What the database gives: numeric(19,4), so every amount has four decimals
const LISTINGS = new Map([
  [NEEM, quoted(NEEM, 'Himalaya Purifying Neem Face Wash', '229.0000')],
  [STEVIA, quoted(STEVIA, 'Zero Cal Stevia 30 Sachets', '120.0000')],
  [DANO, quoted(DANO, 'Dano Daily Pushti Milk 1kg', '780.0000', '0.0000')],
]);

const SETTINGS: ShopCheckoutSettings = {
  zones: [
    { id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80.0000' },
    { id: 'outside_dhaka', name: 'Outside Dhaka', charge: '120.0000' },
  ],
  paymentMethods: ['cod'],
  freeDeliveryFrom: '1000.0000',
  minimumOrder: '300.0000',
};

// Step 27c: a cart that names no coupon, or one the shop does not have
const TODAY = '2026-11-19';
const NO_COUPON: QuoteCoupon = { coupon: undefined, today: TODAY };

// WELCOME10: 10% off, up to ৳50, 3 orders, once per phone. FLAT50: ৳50 off from ৳300
const WELCOME10: ShopCoupon = {
  id: '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a20',
  rule: {
    code: 'WELCOME10',
    discount: { kind: 'percent', value: 10 },
    upTo: '50.0000',
    minimum: null,
    startsOn: null,
    lastDay: null,
    usageLimit: 3,
    onePerPhone: true,
  },
  used: 1,
};
const FLAT50: ShopCoupon = {
  id: '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a21',
  rule: {
    ...WELCOME10.rule,
    code: 'FLAT50',
    discount: { kind: 'amount', value: '50.0000' },
    upTo: null,
    minimum: '300.0000',
    usageLimit: null,
    onePerPhone: false,
  },
  used: 0,
};

function quote(request: ShopCartQuoteRequest, settings = SETTINGS, coupon = NO_COUPON) {
  const answer = quoteCart(request, LISTINGS, settings, coupon);
  // Every answer goes out through the contract, so a test answer must pass it too
  expect(() => shopCartQuoteSchema.parse(answer)).not.toThrow();
  return answer;
}

describe('quoteCart (public API)', () => {
  it('prices each line at its price now and leaves out what cannot be sold', () => {
    const answer = quote({
      lines: [
        { listingId: NEEM, quantity: 3 },
        { listingId: DANO, quantity: 2 },
        { listingId: GONE, quantity: 1 },
      ],
    });
    expect(answer.lines.map((line) => line.status)).toEqual([
      'available',
      'out_of_stock',
      'unavailable',
    ]);
    expect(answer.lines[0]).toMatchObject({ unitPrice: '229.0000', lineTotal: '687.0000' });
    expect(answer.lines[2]).toEqual({ status: 'unavailable', listingId: GONE });
    expect(answer).toMatchObject({ itemCount: 3, subtotal: '687.0000', belowMinimum: false });
  });

  // Step 27a: an order holds as many as its line asks for, so fewer free is out of stock for it
  it('calls a line out of stock when fewer are free than it asks for', () => {
    const few = new Map([
      [NEEM, quoted(NEEM, 'Himalaya Purifying Neem Face Wash', '229.0000', '2.0000')],
    ]);
    const lines = (quantity: number) =>
      quoteCart({ lines: [{ listingId: NEEM, quantity }] }, few, SETTINGS, NO_COUPON).lines[0]
        ?.status;
    expect(lines(2)).toBe('available');
    expect(lines(3)).toBe('out_of_stock');
  });

  it('adds the zone charge, and none from the free-delivery amount on', () => {
    expect(
      quote({ lines: [{ listingId: STEVIA, quantity: 3 }], zoneId: 'outside_dhaka' }),
    ).toMatchObject({ deliveryCharge: '120.0000', freeDelivery: false, total: '480.0000' });
    // 5 × ৳229 = ৳1,145: over ৳1,000
    expect(
      quote({ lines: [{ listingId: NEEM, quantity: 5 }], zoneId: 'inside_dhaka' }),
    ).toMatchObject({ deliveryCharge: '0.0000', freeDelivery: true, total: '1145.0000' });
  });

  it('treats a zone the shop does not have as no zone', () => {
    expect(
      quote({ lines: [{ listingId: NEEM, quantity: 2 }], zoneId: 'chattogram' }),
    ).toMatchObject({ deliveryCharge: null, total: '458.0000' });
  });

  it('says when the items are under the minimum order', () => {
    expect(quote({ lines: [{ listingId: STEVIA, quantity: 2 }] }).belowMinimum).toBe(true);
    expect(
      quote({ lines: [{ listingId: STEVIA, quantity: 2 }] }, { ...SETTINGS, minimumOrder: null })
        .belowMinimum,
    ).toBe(false);
  });

  it('refuses a code the shop does not have as unknown, and takes nothing off', () => {
    const answer = quote({ lines: [{ listingId: NEEM, quantity: 1 }], couponCode: 'WELCOME10' });
    expect(answer.coupon).toEqual({
      status: 'refused',
      code: 'WELCOME10',
      reason: 'shop_coupon_unknown',
      minimum: null,
    });
    expect(answer).toMatchObject({ discount: '0.0000', total: '229.0000' });
  });

  // Step 27c: the coupon off the items; the delivery charge and its free-delivery line stay on
  // the items before the coupon (26c's decision 8)
  it('takes an applied coupon off the items, cut to its "up to"', () => {
    const welcome = { coupon: WELCOME10, today: TODAY };
    // 10% of ৳458 = ৳45.80, under ৳50
    expect(
      quote(
        {
          lines: [{ listingId: NEEM, quantity: 2 }],
          couponCode: 'WELCOME10',
          zoneId: 'inside_dhaka',
        },
        SETTINGS,
        welcome,
      ),
    ).toMatchObject({
      coupon: { status: 'applied', code: 'WELCOME10', upTo: '50.0000' },
      subtotal: '458.0000',
      discount: '45.8000',
      deliveryCharge: '80.0000',
      total: '492.2000',
    });
    // 10% of ৳1,145 = ৳114.50, cut to ৳50; free delivery from ৳1,000 looks at the ৳1,145
    expect(
      quote(
        {
          lines: [{ listingId: NEEM, quantity: 5 }],
          couponCode: 'WELCOME10',
          zoneId: 'inside_dhaka',
        },
        SETTINGS,
        welcome,
      ),
    ).toMatchObject({ discount: '50.0000', freeDelivery: true, total: '1095.0000' });
  });

  it('gives the reason a coupon does not apply, and takes nothing off', () => {
    const cart = { lines: [{ listingId: STEVIA, quantity: 2 }], couponCode: 'FLAT50' };
    // ৳240 of items, under FLAT50's ৳300
    expect(quote(cart, SETTINGS, { coupon: FLAT50, today: TODAY })).toMatchObject({
      coupon: { status: 'refused', reason: 'shop_coupon_minimum', minimum: '300.0000' },
      discount: '0.0000',
      total: '240.0000',
    });
    // Every use taken: used up, before the minimum
    const usedUp = { ...FLAT50, rule: { ...FLAT50.rule, usageLimit: 4 }, used: 4 };
    expect(quote(cart, SETTINGS, { coupon: usedUp, today: TODAY }).coupon).toMatchObject({
      reason: 'shop_coupon_used_up',
    });
    // Its first day is tomorrow: unknown, so the box does not announce the sale
    const tomorrow = { ...FLAT50, rule: { ...FLAT50.rule, startsOn: '2026-11-20' } };
    expect(quote(cart, SETTINGS, { coupon: tomorrow, today: TODAY }).coupon).toMatchObject({
      reason: 'shop_coupon_unknown',
    });
  });

  it('never takes more off than the items cost', () => {
    const big = {
      ...FLAT50,
      rule: {
        ...FLAT50.rule,
        discount: { kind: 'amount' as const, value: '500.0000' },
        minimum: null,
      },
    };
    expect(
      quote(
        {
          lines: [{ listingId: STEVIA, quantity: 1 }],
          couponCode: 'FLAT50',
          zoneId: 'inside_dhaka',
        },
        SETTINGS,
        { coupon: big, today: TODAY },
      ),
    ).toMatchObject({ subtotal: '120.0000', discount: '120.0000', total: '80.0000' });
  });
});
