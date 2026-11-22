import { describe, expect, it } from 'vitest';

import {
  addressKey,
  fakeGatewayParamsSchema,
  fakeValId,
  readFakeValId,
  SHOP_PAYMENT_NOTICE_PATH,
  SHOP_PAYMENT_RETURN_PATH,
  SHOP_PAYMENT_TRIES,
  shopGatewayPostSchema,
  shopPaymentSettleRequestSchema,
  shopPaymentTranIdSchema,
  shopPaymentWaitSchema,
  listingParamsFromQuery,
  maskPhone,
  publicOrderPlacedSchema,
  SHOP_KEY_HEADER,
  shopCodeWaitSchema,
  shopOrderTokenSchema,
  listingQueryFromParams,
  publicListingParamsSchema,
  publicShopSchema,
  publicStorefrontRoutes,
  SHOP_CART_MAX_LINES,
  SHOP_CART_MAX_QUANTITY,
  shopCartQuoteLineSchema,
  shopCartQuoteRequestSchema,
  shopCartQuoteSchema,
  shopCheckoutSettingsSchema,
  shopHomeSchema,
  shopImageSchema,
  SHOP_PAGE_SIZE,
  shopListingPageSchema,
  shopListingQuerySchema,
  shopOrderPlacedSchema,
  shopOrderRequestSchema,
  shopOrderSchema,
  shopPhoneSchema,
  shopOrderNoSchema,
  shopProductSchema,
  shopTextPageSchema,
  shopTrackingSchema,
  shopTrackingTokenSchema,
  shopTrackRequestSchema,
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
  seo: { title: 'Himalaya Purifying Neem Face Wash 150ml', description: 'Controls excess oil' },
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
    pages: ['terms', 'contact'],
  };

  it('takes the workspace time zone', () => {
    expect(publicShopSchema.parse(SHOP)).toEqual(SHOP);
  });

  // A made-up zone would make every date on the shop throw a RangeError in Intl
  it('refuses a time zone Intl does not know', () => {
    expect(publicShopSchema.safeParse({ ...SHOP, timeZone: 'Asia/Sylhet' }).success).toBe(false);
  });

  // Step 26h: the footer links the written pages only, so a page the shop has no route for is a bug
  it('refuses a text page the footer does not have', () => {
    expect(publicShopSchema.safeParse({ ...SHOP, pages: ['refunds'] }).success).toBe(false);
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

  // Step 27d
  it('sends an online order to the payment page, or says it did not open', () => {
    const pay = { next: 'pay', paymentUrl: 'https://sandbox.sslcommerz.com/EasyCheckOut/abc' };
    expect(shopOrderPlacedSchema.parse(pay)).toEqual(pay);
    expect(shopOrderPlacedSchema.parse({ next: 'pay', paymentUrl: null })).toEqual({
      next: 'pay',
      paymentUrl: null,
    });
    // The fake gateway's page in development is plain http on this computer
    const fake = 'http://nirvor.localhost:4321/checkout/fake-gateway?tranId=A';
    expect(shopOrderPlacedSchema.safeParse({ next: 'pay', paymentUrl: fake }).success).toBe(true);
    // The shop puts it in `location`: a script address would run on the shop's page
    expect(
      shopOrderPlacedSchema.safeParse({ next: 'pay', paymentUrl: 'javascript:alert(1)' }).success,
    ).toBe(false);
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

// Step 26d
describe('listing query', () => {
  // /c/cosmetics?sort=price_asc&min=100&max=500&stock=1, as the page sends it to the source
  const QUERY = {
    category: 'cosmetics',
    q: null,
    sort: 'price_asc',
    minPrice: '100',
    maxPrice: '500',
    inStock: true,
    offer: false,
    cursor: null,
  };

  it('takes a category page with its filters', () => {
    expect(shopListingQuerySchema.parse(QUERY)).toEqual(QUERY);
  });

  it('takes a Bangla search and trims it', () => {
    const query = shopListingQuerySchema.parse({ ...QUERY, category: null, q: '  নিম ফেস ওয়াশ ' });
    expect(query.q).toBe('নিম ফেস ওয়াশ');
  });

  // Spaces only is no search: the page must send null, so the source never matches every listing
  // against an empty word
  it('refuses a search of spaces only', () => {
    expect(shopListingQuerySchema.safeParse({ ...QUERY, q: '   ' }).success).toBe(false);
  });

  // A slug goes into links and the source's lookup as it is
  it('refuses a category that is not a slug', () => {
    for (const category of ['Cosmetics', '../admin', 'skin care', '-tea']) {
      expect(shopListingQuerySchema.safeParse({ ...QUERY, category }).success).toBe(false);
    }
  });

  it('refuses paisa, a minus and a leading zero in a price filter', () => {
    for (const minPrice of ['99.50', '-1', '0100', '1e3']) {
      expect(shopListingQuerySchema.safeParse({ ...QUERY, minPrice }).success).toBe(false);
    }
  });

  // As strings "90" sorts after "500"; the check must compare the amounts
  it('compares the prices as numbers', () => {
    expect(shopListingQuerySchema.safeParse({ ...QUERY, minPrice: '90' }).success).toBe(true);
    const result = shopListingQuerySchema.safeParse({ ...QUERY, minPrice: '600' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ['maxPrice'], message: 'invalid_value' });
  });

  it('refuses a sort the page has no words for', () => {
    expect(shopListingQuerySchema.safeParse({ ...QUERY, sort: 'popular' }).success).toBe(false);
  });
});

describe('listing page', () => {
  const card = { ...NEEM_PRODUCT };

  it('reads a page of cards and the next cursor', () => {
    const page = { items: [card], nextCursor: 'eyJvIjoyMH0' };
    expect(shopListingPageSchema.parse(page)).toMatchObject({ nextCursor: 'eyJvIjoyMH0' });
  });

  it('refuses more cards than one page holds', () => {
    const page = {
      items: Array.from({ length: SHOP_PAGE_SIZE + 1 }, () => card),
      nextCursor: null,
    };
    expect(shopListingPageSchema.safeParse(page).success).toBe(false);
  });
});

// Step 26e
describe('order number', () => {
  it.each([
    ['W-000123', 'W-000123'],
    ['w-000123', 'W-000123'],
    [' W 000123 ', 'W-000123'],
    ['W000123', 'W-000123'],
    ['000123', 'W-000123'],
    ['W-০০০১২৩', 'W-000123'],
  ])('reads %s as %s', (typed, plain) => {
    expect(shopOrderNoSchema.parse(typed)).toBe(plain);
  });

  it.each(['W-123', 'W-0001234567', 'X-000123', 'W--000123', 'SO-2026-27-0001', ''])(
    'refuses %s',
    (typed) => {
      const result = shopOrderNoSchema.safeParse(typed);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe('shop_order_no_format');
    },
  );
});

describe('track request', () => {
  it('takes the phone and the number the way a shopper types them', () => {
    expect(shopTrackRequestSchema.parse({ phone: '+880 1786-120356', orderNo: 'w000123' })).toEqual(
      { phone: '01786120356', orderNo: 'W-000123' },
    );
  });

  it('says which box is wrong', () => {
    const result = shopTrackRequestSchema.safeParse({ phone: '02-9123456', orderNo: '12' });
    expect(result.error?.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
      ['phone', 'shop_phone_format'],
      ['orderNo', 'shop_order_no_format'],
    ]);
  });
});

describe('tracking token', () => {
  it('takes 16 random bytes in base64url', () => {
    expect(shopTrackingTokenSchema.safeParse('kq3Xb9-T_2mVd8LwZpR4aQ').success).toBe(true);
  });

  it.each(['kq3Xb9-T_2mVd8LwZpR4a', 'kq3Xb9-T_2mVd8LwZpR4aQx', 'kq3Xb9+T/2mVd8LwZpR4aQ'])(
    'refuses %s before the source is asked',
    (token) => {
      expect(shopTrackingTokenSchema.safeParse(token).success).toBe(false);
    },
  );
});

describe('tracking', () => {
  // The Sylhet order of 26c, two days later: Steadfast has it, and the rider could not reach her
  const TRACKING = {
    orderNo: 'W-000123',
    placedAt: '2026-11-11T15:20:00+06:00',
    status: 'shipped',
    history: [
      { status: 'pending', at: '2026-11-11T15:20:00+06:00' },
      { status: 'confirmed', at: '2026-11-11T15:21:30+06:00' },
      { status: 'packed', at: '2026-11-12T10:05:00+06:00' },
      { status: 'shipped', at: '2026-11-12T16:40:00+06:00' },
    ],
    itemCount: 3,
    total: '578.0000',
    paymentMethod: 'cod',
    shipments: [
      {
        courier: 'steadfast',
        trackingCode: 'SFR2611120042',
        trackingUrl: 'https://steadfast.com.bd/t/SFR2611120042',
        events: [
          { status: 'booked', at: '2026-11-12T10:06:00+06:00', note: null },
          { status: 'picked_up', at: '2026-11-12T16:40:00+06:00', note: 'Picked up from the shop' },
          { status: 'on_hold', at: '2026-11-13T13:15:00+06:00', note: 'Customer not reachable' },
        ],
      },
    ],
  };

  it('reads an order on its way with the courier', () => {
    expect(shopTrackingSchema.parse(TRACKING)).toEqual(TRACKING);
  });

  it('reads an order the shop has not given to a courier yet', () => {
    const waiting = { ...TRACKING, status: 'confirmed', history: TRACKING.history.slice(0, 2) };
    expect(shopTrackingSchema.parse({ ...waiting, shipments: [] }).shipments).toEqual([]);
  });

  it('never carries the address, the phone or the name', () => {
    const parsed = shopTrackingSchema.parse({
      ...TRACKING,
      name: 'Shamim Ahmed',
      phone: '01786120356',
      address: 'House 12, Road 5, Zindabazar, Sylhet',
    });
    expect(parsed).not.toHaveProperty('name');
    expect(parsed).not.toHaveProperty('phone');
    expect(parsed).not.toHaveProperty('address');
  });

  it('refuses a courier link that is not https', () => {
    const [shipment] = TRACKING.shipments;
    const result = shopTrackingSchema.safeParse({
      ...TRACKING,
      shipments: [{ ...shipment, trackingUrl: 'javascript:alert(1)' }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a parcel with no event and a status the page has no words for', () => {
    const [shipment] = TRACKING.shipments;
    for (const events of [[], [{ status: 'in_review', at: TRACKING.placedAt, note: null }]]) {
      const result = shopTrackingSchema.safeParse({
        ...TRACKING,
        shipments: [{ ...shipment, events }],
      });
      expect(result.success).toBe(false);
    }
  });
});

describe('text page', () => {
  it('reads one of the four pages', () => {
    const page = {
      slug: 'terms',
      html: '<section><h2>Delivery</h2><p>Inside Dhaka in 2 days.</p></section>',
      updatedAt: '2026-11-01T10:00:00+06:00',
    };
    expect(shopTextPageSchema.parse(page)).toEqual(page);
  });

  it('refuses a page the footer has no link to, and an empty one', () => {
    expect(
      shopTextPageSchema.safeParse({ slug: 'refunds', html: '<p>x</p>', updatedAt: null }).success,
    ).toBe(false);
    expect(shopTextPageSchema.safeParse({ slug: 'about', html: '', updatedAt: null }).success).toBe(
      false,
    );
  });
});

describe('public API', () => {
  const PLAIN = {
    category: null,
    q: null,
    sort: 'newest',
    minPrice: null,
    maxPrice: null,
    inStock: false,
    offer: false,
    cursor: null,
  } as const;

  it('sends only what is set, so the first page of /c/all is the plain address', () => {
    expect(listingParamsFromQuery(PLAIN)).toEqual({});
  });

  it('reads back the query it sent', () => {
    const query = {
      category: 'skin-care',
      q: 'neem',
      sort: 'price_asc',
      minPrice: '100',
      maxPrice: '500',
      inStock: true,
      offer: true,
      cursor: 'eyJwIjoiMjI5In0',
    } as const;
    const params = publicListingParamsSchema.parse(listingParamsFromQuery(query));
    expect(params).toMatchObject({ inStock: '1', offer: '1' });
    expect(listingQueryFromParams(params)).toEqual(query);
  });

  it('takes a search of only spaces as no search', () => {
    expect(listingQueryFromParams(publicListingParamsSchema.parse({ q: '   ' })).q).toBeNull();
  });

  it('refuses prices the wrong way round, and flags other than 1', () => {
    const backwards = publicListingParamsSchema.safeParse({ minPrice: '500', maxPrice: '90' });
    expect(backwards.error?.issues[0]).toMatchObject({
      message: 'invalid_value',
      path: ['maxPrice'],
    });
    expect(publicListingParamsSchema.safeParse({ inStock: 'true' }).success).toBe(false);
    expect(publicListingParamsSchema.safeParse({ category: '../admin' }).success).toBe(false);
  });

  it('has no login on any route, and every path under /public/v1', () => {
    for (const route of Object.values(publicStorefrontRoutes)) {
      expect(route.auth).not.toBe('bearer');
      expect(route.path.startsWith('/public/v1/')).toBe(true);
    }
  });
});

describe("the shop server's order routes (step 27a.1)", () => {
  const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';

  it("keeps every route that writes or shows an order behind the shop server's key", () => {
    // The read routes stay open: a shop's pages show them to anyone. Everything that places an
    // order, sends an SMS or answers with an order needs the key, so a stranger who finds the API
    // cannot fill a shop with orders or walk its tracking links
    const byAuth = (auth: 'public' | 'shop') =>
      Object.entries(publicStorefrontRoutes)
        .filter(([, route]) => route.auth === auth)
        .map(([name]) => name)
        .sort();
    expect(byAuth('shop')).toEqual(
      [
        'codeWait',
        'order',
        'placeOrder',
        'resendCode',
        'track',
        'tracking',
        'verifyCode',
        // Step 27d: a payment's answer from the gateway is the API's to check, and the other three
        // answer with an order or change one
        'settlePayment',
        'paymentWait',
        'retryPayment',
        'payOnDelivery',
      ].sort(),
    );
    expect(byAuth('public')).toEqual(
      [
        'categories',
        'checkoutSettings',
        'home',
        'listings',
        'product',
        'quote',
        'shop',
        'textPage',
      ].sort(),
    );
    expect(SHOP_KEY_HEADER).toBe('x-shop-key');
  });

  it('never puts a token or a phone in an address', () => {
    // POST with a body for every shop route: a path or a query ends up in logs and Referer headers
    for (const route of Object.values(publicStorefrontRoutes)) {
      if (route.auth !== 'shop') continue;
      expect(route.method).toBe('POST');
      expect(route.path).not.toContain(':');
      expect('query' in route).toBe(false);
    }
  });

  it("takes a 22-character base64url token, like a tracking link's", () => {
    expect(shopOrderTokenSchema.safeParse(TOKEN).success).toBe(true);
    expect(shopOrderTokenSchema.safeParse(`${TOKEN}A`).success).toBe(false);
    // The mock's 64 hex digits are not the API's: the shop never sends one to the API
    expect(shopOrderTokenSchema.safeParse('a'.repeat(64)).success).toBe(false);
    expect(shopOrderTokenSchema.safeParse('AbCdEfGhIjKlMnOpQrSt+/').success).toBe(false);
  });

  it('checks the code and the token together on verify', () => {
    const body = publicStorefrontRoutes.verifyCode.body;
    expect(body.parse({ token: TOKEN, code: '১২৩ ৪৫৬' })).toEqual({ token: TOKEN, code: '123456' });
    expect(body.safeParse({ code: '123456' }).success).toBe(false);
  });

  it('finds an order by its number however it was typed, with its token', () => {
    const body = publicStorefrontRoutes.order.body;
    expect(body.parse({ token: TOKEN, orderNo: 'w000123' })).toEqual({
      token: TOKEN,
      orderNo: 'W-000123',
    });
  });

  it("answers the placed order with its token beside the shopper's answer", () => {
    const placed = {
      answer: { next: 'verify', maskedPhone: maskPhone('01786120356'), resendInSeconds: 45 },
      token: TOKEN,
    };
    expect(publicOrderPlacedSchema.parse(placed)).toEqual(placed);
    expect(placed.answer.maskedPhone).toBe('+880 17•• ••• 356');
  });

  it('says which listings the waiting order holds', () => {
    const wait = { next: 'verify', maskedPhone: '+880 17•• ••• 356', resendInSeconds: 0 };
    expect(shopCodeWaitSchema.safeParse({ ...wait, listingIds: ['l1'] }).success).toBe(true);
    expect(shopCodeWaitSchema.safeParse({ ...wait, listingIds: [] }).success).toBe(false);
  });
});

describe('paying online (step 27d.1)', () => {
  const TRAN = 'K7Q2M4X9B1C3D5E6F8G0';
  const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';

  it("takes the gateway's post by its two ids only, with an empty val_id as none", () => {
    // What SSLCommerz posts: much more than the ids, all of it typed by whoever sent the post
    const post = { tran_id: TRAN, val_id: '2611221045371uQe8kz1lO', status: 'VALID', amount: '1' };
    expect(shopGatewayPostSchema.parse(post)).toEqual({
      tran_id: TRAN,
      val_id: '2611221045371uQe8kz1lO',
    });
    // A failed or cancelled payment has no val_id, or an empty one
    expect(shopGatewayPostSchema.parse({ tran_id: TRAN, val_id: ' ' }).val_id).toBeNull();
    expect(shopGatewayPostSchema.parse({ tran_id: TRAN }).val_id).toBeNull();
    // A transaction id not in our shape names no try: refused before the API is asked
    expect(shopGatewayPostSchema.safeParse({ tran_id: 'W-000123' }).success).toBe(false);
    expect(shopPaymentTranIdSchema.safeParse(TRAN.toLowerCase()).success).toBe(false);
  });

  it("passes the ids on with the shop server's body", () => {
    expect(shopPaymentSettleRequestSchema.parse({ tranId: TRAN, valId: null })).toEqual({
      tranId: TRAN,
      valId: null,
    });
    expect(shopPaymentSettleRequestSchema.safeParse({ tranId: TRAN }).success).toBe(false);
  });

  it('keeps the return and notice paths on the shop, apart from its pages', () => {
    expect(SHOP_PAYMENT_RETURN_PATH).toBe('/checkout/pay/return');
    expect(SHOP_PAYMENT_NOTICE_PATH.startsWith('/api/')).toBe(true);
  });

  it('draws the three states of /checkout/paid, with the tries it has left', () => {
    const unpaid = {
      state: 'unpaid',
      problem: 'cancelled',
      triesLeft: 2,
      payOnDelivery: true,
      total: '1199.0000',
    };
    expect(shopPaymentWaitSchema.parse(unpaid)).toEqual(unpaid);
    expect(shopPaymentWaitSchema.parse({ state: 'checking' })).toEqual({ state: 'checking' });
    const paid = { state: 'paid', orderNo: 'W-000124', phone: '01786120356', listingIds: ['l1'] };
    expect(shopPaymentWaitSchema.parse(paid)).toEqual(paid);
    // The first try is used before the page ever shows, so at most 2 are left
    expect(
      shopPaymentWaitSchema.safeParse({ ...unpaid, triesLeft: SHOP_PAYMENT_TRIES }).success,
    ).toBe(false);
    expect(shopPaymentWaitSchema.safeParse({ ...unpaid, problem: 'expired' }).success).toBe(false);
  });

  it("takes the cookie's token on the three payment routes, in a POST body", () => {
    for (const name of ['paymentWait', 'retryPayment', 'payOnDelivery'] as const) {
      const route = publicStorefrontRoutes[name];
      expect(route.body.parse({ token: TOKEN })).toEqual({ token: TOKEN });
      expect(route.body.safeParse({}).success).toBe(false);
    }
  });

  it("reads back the fake gateway's val_id, and nothing else", () => {
    const valId = fakeValId(TRAN, { outcome: 'paid', amount: '1199.0000' });
    expect(readFakeValId(valId)).toEqual({ tranId: TRAN, outcome: 'paid', amount: '1199.0000' });
    // Step 27d.3: Fail and Cancel on the fake page say so too
    expect(readFakeValId(fakeValId(TRAN, { outcome: 'failed' }))).toEqual({
      tranId: TRAN,
      outcome: 'failed',
    });
    expect(readFakeValId(fakeValId(TRAN, { outcome: 'cancelled' }))).toEqual({
      tranId: TRAN,
      outcome: 'cancelled',
    });
    expect(readFakeValId(`FAKE_${TRAN}_PAID`)).toBeNull();
    // A real SSLCommerz val_id is not a fake one
    expect(readFakeValId('2611221045371uQe8kz1lO')).toBeNull();
    expect(readFakeValId(`FAKE_${TRAN}_12a`)).toBeNull();
    expect(readFakeValId(`FAKE_${TRAN.slice(1)}_12`)).toBeNull();
    expect(fakeGatewayParamsSchema.safeParse({ tranId: TRAN, amount: '1,199' }).success).toBe(
      false,
    );
  });
});

describe('public API answers (step 26f.3)', () => {
  it('takes a photo from storage over https, a path, or plain http on this computer only', () => {
    const ok = (url: string) => shopImageSchema.safeParse({ url, alt: 'Neem face wash' }).success;
    expect(ok('https://files.omnivosoft.com/omnivo/storefront/a/small.webp')).toBe(true);
    expect(ok('/mock/products/neem.png')).toBe(true);
    expect(ok('http://localhost:9000/omnivo/storefront/a/small.webp')).toBe(true);
    expect(ok('http://127.0.0.1:9000/omnivo/storefront/a/small.webp')).toBe(true);
    // Another computer over plain http, a name that only starts like localhost, and no path at all
    expect(ok('http://files.example.com/a.webp')).toBe(false);
    expect(ok('http://localhost.evil.com/a.webp')).toBe(false);
    expect(ok('http://localhost:9000')).toBe(false);
    expect(ok('//cdn.example.com/a.webp')).toBe(false);
  });

  it('lets a home page have no hero banner', () => {
    expect(
      shopHomeSchema.safeParse({ hero: null, featured: [], hasMoreFeatured: false, blocks: [] })
        .success,
    ).toBe(true);
  });
});

// Step 27a: moved from the shop's server (26e), with its cases, because the API counts by it now
describe('addressKey', () => {
  it('keeps an IPv4 address as it is, also when Node writes it as IPv6', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts an IPv6 address by its /64 block, however it is written', () => {
    const block = addressKey('2001:db8:1:2::a');
    expect(block).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe(block);
    expect(addressKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(addressKey('2001:db8::7')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
  });

  it('gives two neighbouring blocks two keys', () => {
    expect(addressKey('2001:db8:1:2::a')).not.toBe(addressKey('2001:db8:1:3::a'));
  });
});
