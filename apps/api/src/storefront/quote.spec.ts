import {
  shopCartQuoteSchema,
  type ShopCartQuoteRequest,
  type ShopCheckoutSettings,
  type ShopListing,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

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

function quote(request: ShopCartQuoteRequest, settings = SETTINGS) {
  const answer = quoteCart(request, LISTINGS, settings);
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
      quoteCart({ lines: [{ listingId: NEEM, quantity }] }, few, SETTINGS).lines[0]?.status;
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

  it('refuses every coupon as unknown, and takes nothing off', () => {
    const answer = quote({ lines: [{ listingId: NEEM, quantity: 1 }], couponCode: 'WELCOME10' });
    expect(answer.coupon).toEqual({
      status: 'refused',
      code: 'WELCOME10',
      reason: 'shop_coupon_unknown',
      minimum: null,
    });
    expect(answer).toMatchObject({ discount: '0.0000', total: '229.0000' });
  });
});
