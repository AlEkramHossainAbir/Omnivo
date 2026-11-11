import { describe, expect, it } from 'vitest';

import {
  publicShopSchema,
  SHOP_CART_MAX_LINES,
  SHOP_CART_MAX_QUANTITY,
  shopCartQuoteLineSchema,
  shopCartQuoteRequestSchema,
  shopCartQuoteSchema,
  shopProductSchema,
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
    const result = shopCartQuoteSchema.safeParse({ lines: [], itemCount: 0, subtotal: '1,199' });
    expect(result.success).toBe(false);
  });
});
