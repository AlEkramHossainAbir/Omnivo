import { describe, expect, it } from 'vitest';

import {
  publicShopSchema,
  SHOP_CART_MAX_LINES,
  SHOP_CART_MAX_QUANTITY,
  shopCartQuoteLineSchema,
  shopCartQuoteRequestSchema,
  shopCartQuoteSchema,
  shopCheckoutSettingsSchema,
  shopOrderPlacedSchema,
  shopOrderRequestSchema,
  shopOrderSchema,
  shopPhoneSchema,
  shopProductSchema,
  shopVerifyCodeRequestSchema,
} from './storefront.js';

// A shopper in Sylhet with two face washes and a tea in her cart
const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml';
const TEA = 'lst-seylon-family-blend-tea-400gm';

const NEEM_PRODUCT = {
  id: NEEM,
  slug: 'himalaya-purifying-neem-face-wash-150ml',
  name: 'Himalaya Purifying Neem Face Wash 150ml',
  packSize: '150ml',
  images: [{ url: '/mock/products/neem.png', alt: 'Himalaya Purifying Neem Face Wash 150ml' }],
  price: '229',
  compareAtPrice: '299',
  saleUntil: '2026-11-14T18:00:00+06:00',
  discount: { kind: 'amount', value: '70' },
  badges: ['most_picked'],
  inStock: true,
  categoryId: 'cat-cosmetics',
  sku: 'MD2346',
  unitName: 'Piece',
  descriptionHtml: '<section><h2>Key Benefits</h2><ul><li>Controls excess oil</li></ul></section>',
};

describe('public shop', () => {
  const SHOP = {
    name: 'Shapla Pharmacy',
    logo: null,
    language: 'bn',
    theme: { brand: '#005859', accent: '#b8ef69' },
    hotline: '+880 1786 120356',
    timeZone: 'Asia/Dhaka',
    address: 'Zindabazar, Sylhet 3100',
    social: { facebook: null, instagram: null, x: null, linkedin: null },
  };

  it('takes the workspace time zone', () => {
    expect(publicShopSchema.parse(SHOP)).toEqual(SHOP);
  });

  // A made-up zone would make every date on the shop throw a RangeError in Intl
  it('refuses a time zone Intl does not know', () => {
    expect(publicShopSchema.safeParse({ ...SHOP, timeZone: 'Asia/Sylhet' }).success).toBe(false);
  });
});

describe('product page', () => {
  it('takes a listing with its SKU, unit and description', () => {
    expect(shopProductSchema.parse(NEEM_PRODUCT)).toEqual(NEEM_PRODUCT);
  });

  it('takes a product with no SKU and no description', () => {
    expect(() =>
      shopProductSchema.parse({ ...NEEM_PRODUCT, sku: null, descriptionHtml: '' }),
    ).not.toThrow();
  });

  it('refuses a fifth photo, which the thumbnail row has no room for', () => {
    const photo = NEEM_PRODUCT.images[0];
    const result = shopProductSchema.safeParse({
      ...NEEM_PRODUCT,
      images: [photo, photo, photo, photo, photo],
    });
    expect(result.success).toBe(false);
  });
});

describe('cart quote request', () => {
  it('takes ids and counts', () => {
    const request = {
      lines: [
        { listingId: NEEM, quantity: 2 },
        { listingId: TEA, quantity: 1 },
      ],
    };
    expect(shopCartQuoteRequestSchema.parse(request)).toEqual(request);
  });

  it('takes an empty cart', () => {
    expect(shopCartQuoteRequestSchema.parse({ lines: [] })).toEqual({ lines: [] });
  });

  it('drops a price the browser tried to send', () => {
    const parsed = shopCartQuoteRequestSchema.parse({
      lines: [{ listingId: NEEM, quantity: 1, price: '1' }],
      subtotal: '1',
    });
    expect(parsed).toEqual({ lines: [{ listingId: NEEM, quantity: 1 }] });
  });

  it.each([
    ['no items', 0],
    ['more than the cart allows', SHOP_CART_MAX_QUANTITY + 1],
    ['half an item', 1.5],
    ['a count as text', '2'],
  ])('refuses %s', (_, quantity) => {
    const result = shopCartQuoteRequestSchema.safeParse({
      lines: [{ listingId: NEEM, quantity }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses one listing on two lines', () => {
    const result = shopCartQuoteRequestSchema.safeParse({
      lines: [
        { listingId: NEEM, quantity: 1 },
        { listingId: TEA, quantity: 1 },
        { listingId: NEEM, quantity: 3 },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([
      { path: ['lines', 2, 'listingId'], message: 'invalid_input' },
    ]);
  });

  it('refuses more lines than any basket needs', () => {
    const lines = Array.from({ length: SHOP_CART_MAX_LINES + 1 }, (_, index) => ({
      listingId: `lst-${String(index)}`,
      quantity: 1,
    }));
    expect(shopCartQuoteRequestSchema.safeParse({ lines }).success).toBe(false);
  });
});

// Step 26c: a quote with nothing in it, for the tests that change one field
const EMPTY_QUOTE = {
  lines: [],
  itemCount: 0,
  subtotal: '0.0000',
  discount: '0.0000',
  coupon: { status: 'none' },
  deliveryCharge: null,
  freeDelivery: false,
  total: '0.0000',
  belowMinimum: false,
};

describe('cart quote', () => {
  const image = NEEM_PRODUCT.images[0];

  it('reads the three kinds of line', () => {
    const quote = {
      lines: [
        {
          status: 'available',
          listingId: NEEM,
          slug: NEEM_PRODUCT.slug,
          name: NEEM_PRODUCT.name,
          packSize: '150ml',
          image,
          quantity: 2,
          unitPrice: '229',
          lineTotal: '458.0000',
        },
        {
          status: 'out_of_stock',
          listingId: TEA,
          slug: 'seylon-family-blend-tea-400gm',
          name: 'Seylon Family Blend Tea',
          packSize: '400gm',
          image,
          quantity: 1,
        },
        { status: 'unavailable', listingId: 'lst-gone' },
      ],
      itemCount: 2,
      subtotal: '458.0000',
      discount: '0.0000',
      coupon: { status: 'none' },
      deliveryCharge: null,
      freeDelivery: false,
      total: '458.0000',
      belowMinimum: false,
    };
    expect(shopCartQuoteSchema.parse(quote)).toEqual(quote);
  });

  it('never has a price on a line that is out of stock', () => {
    const parsed = shopCartQuoteLineSchema.parse({
      status: 'out_of_stock',
      listingId: TEA,
      slug: 'seylon-family-blend-tea-400gm',
      name: 'Seylon Family Blend Tea',
      packSize: '400gm',
      image,
      quantity: 1,
      unitPrice: '520',
    });
    expect(parsed).not.toHaveProperty('unitPrice');
  });

  it('refuses a total written for people', () => {
    const result = shopCartQuoteSchema.safeParse({ ...EMPTY_QUOTE, subtotal: '1,199' });
    expect(result.success).toBe(false);
  });

  it('says why a coupon did nothing, with the minimum when that is the reason', () => {
    const coupon = {
      status: 'refused',
      code: 'FLAT50',
      reason: 'shop_coupon_minimum',
      minimum: '500',
    };
    expect(shopCartQuoteSchema.parse({ ...EMPTY_QUOTE, coupon }).coupon).toEqual(coupon);
  });

  it('never refuses a coupon with a reason it has no words for', () => {
    const coupon = { status: 'refused', code: 'FLAT50', reason: 'internal_error', minimum: null };
    expect(shopCartQuoteSchema.safeParse({ ...EMPTY_QUOTE, coupon }).success).toBe(false);
  });
});

describe('cart quote request at the checkout', () => {
  it('takes the zone and a coupon, written the way the shop stores it', () => {
    const parsed = shopCartQuoteRequestSchema.parse({
      lines: [{ listingId: NEEM, quantity: 2 }],
      zoneId: 'outside_dhaka',
      couponCode: ' welcome10 ',
    });
    expect(parsed).toEqual({
      lines: [{ listingId: NEEM, quantity: 2 }],
      zoneId: 'outside_dhaka',
      couponCode: 'WELCOME10',
    });
  });

  it.each([
    ['a space inside', 'WELCOME 10'],
    ['an empty code', '   '],
    ['a code longer than any flyer prints', 'A'.repeat(21)],
  ])('refuses a coupon with %s', (_, couponCode) => {
    const result = shopCartQuoteRequestSchema.safeParse({ lines: [], couponCode });
    expect(result.error?.issues).toMatchObject([
      { path: ['couponCode'], message: 'shop_coupon_format' },
    ]);
  });
});

describe('checkout settings', () => {
  const SETTINGS = {
    zones: [
      { id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80' },
      { id: 'outside_dhaka', name: 'Outside Dhaka', charge: '120' },
    ],
    paymentMethods: ['cod', 'online'],
    freeDeliveryFrom: '1000',
    minimumOrder: null,
  };

  it('reads the zones and the payment methods', () => {
    expect(shopCheckoutSettingsSchema.parse(SETTINGS)).toEqual(SETTINGS);
  });

  it('refuses a shop that delivers nowhere', () => {
    expect(shopCheckoutSettingsSchema.safeParse({ ...SETTINGS, zones: [] }).success).toBe(false);
  });
});

describe('mobile number', () => {
  it.each([
    ['as it is written on a card', '01786120356'],
    ['with the country code', '+8801786120356'],
    ['with spaces and a dash', '+880 1786-120356'],
    ['without the plus', '8801786120356'],
    ['in Bangla digits', '০১৭৮৬১২০৩৫৬'],
  ])('reads a number %s', (_, phone) => {
    expect(shopPhoneSchema.parse(phone)).toBe('01786120356');
  });

  it.each([
    ['a Dhaka landline', '029123456'],
    ['an operator digit that does not exist', '01286120356'],
    ['a digit short', '0178612035'],
    ['a foreign number', '+447911123456'],
    ['letters', '01786I20356'],
  ])('refuses %s', (_, phone) => {
    expect(shopPhoneSchema.safeParse(phone).error?.issues).toMatchObject([
      { message: 'shop_phone_format' },
    ]);
  });
});

describe('order request', () => {
  const ORDER = {
    lines: [{ listingId: NEEM, quantity: 2 }],
    zoneId: 'outside_dhaka',
    name: 'Shamim Ahmed',
    phone: '+880 1786-120356',
    address: 'House 12, Road 5, Zindabazar, Sylhet',
    paymentMethod: 'cod',
    termsAccepted: true,
    expectedTotal: '578',
  };

  it('takes the delivery details, with the phone made plain', () => {
    expect(shopOrderRequestSchema.parse(ORDER)).toEqual({ ...ORDER, phone: '01786120356' });
  });

  it('drops an amount the browser tried to set', () => {
    const parsed = shopOrderRequestSchema.parse({ ...ORDER, deliveryCharge: '0', discount: '578' });
    expect(parsed).not.toHaveProperty('deliveryCharge');
    expect(parsed).not.toHaveProperty('discount');
  });

  it.each([
    ['an empty cart', { lines: [] }, 'lines', 'shop_cart_empty'],
    ['no name', { name: '   ' }, 'name', 'required'],
    ['an address no courier can find', { address: 'Sylhet' }, 'address', 'shop_address_too_short'],
    ['the terms not ticked', { termsAccepted: false }, 'termsAccepted', 'shop_terms_required'],
  ])('refuses %s', (_, change, field, code) => {
    const result = shopOrderRequestSchema.safeParse({ ...ORDER, ...change });
    expect(result.error?.issues).toMatchObject([{ path: [field], message: code }]);
  });

  it('refuses a payment method the shop has no word for', () => {
    expect(shopOrderRequestSchema.safeParse({ ...ORDER, paymentMethod: 'card' }).success).toBe(
      false,
    );
  });
});

describe('order placed', () => {
  it('sends a cash order to the phone code without its number in full', () => {
    const placed = { next: 'verify', maskedPhone: '+880 17•• ••• 356', resendInSeconds: 45 };
    expect(shopOrderPlacedSchema.parse(placed)).toEqual(placed);
  });

  it('never carries the order token', () => {
    const parsed = shopOrderPlacedSchema.parse({
      next: 'confirmed',
      orderNo: 'W-000123',
      phone: '01786120356',
      token: 'secret',
    });
    expect(parsed).not.toHaveProperty('token');
  });
});

describe('phone code', () => {
  it.each([
    ['six digits', '123456'],
    ['Bangla digits', '১২৩৪৫৬'],
    ['digits a phone pasted with spaces', '123 456'],
  ])('reads %s', (_, code) => {
    expect(shopVerifyCodeRequestSchema.parse({ code })).toEqual({ code: '123456' });
  });

  it.each([
    ['five digits', '12345'],
    ['a letter', '12345O'],
  ])('refuses %s', (_, code) => {
    expect(shopVerifyCodeRequestSchema.safeParse({ code }).error?.issues).toMatchObject([
      { path: ['code'], message: 'shop_code_format' },
    ]);
  });
});

describe('order', () => {
  it('reads a placed order with its history', () => {
    const order = {
      orderNo: 'W-000123',
      placedAt: '2026-11-11T15:20:00+06:00',
      status: 'confirmed',
      history: [
        { status: 'pending', at: '2026-11-11T15:20:00+06:00' },
        { status: 'confirmed', at: '2026-11-11T15:21:30+06:00' },
      ],
      name: 'Shamim Ahmed',
      phone: '01786120356',
      address: 'House 12, Road 5, Zindabazar, Sylhet',
      zoneName: 'Outside Dhaka',
      paymentMethod: 'cod',
      lines: [
        {
          listingId: NEEM,
          slug: NEEM_PRODUCT.slug,
          name: NEEM_PRODUCT.name,
          packSize: '150ml',
          image: NEEM_PRODUCT.images[0],
          quantity: 2,
          unitPrice: '229',
          lineTotal: '458.0000',
        },
      ],
      subtotal: '458.0000',
      discount: '0.0000',
      couponCode: null,
      deliveryCharge: '120',
      total: '578.0000',
    };
    expect(shopOrderSchema.parse(order)).toEqual(order);
  });
});
