import { contractErrorMap, type ShopCartQuote, type ShopCartQuoteLine } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  changedPrices,
  checkoutFormSchema,
  discountText,
  errorText,
  fill,
  orderRequest,
  parseCouponCode,
  parseQuantity,
  quoteKey,
  quoteRequest,
  refusalErrors,
  shortBy,
  type CheckoutFormValues,
} from './checkout';
import { shopLocale } from '../../lib/locale';
import { checkoutWords } from './words';

// Step 26c: the checkout island's plain logic. The island itself is checked in the browser
// (26c.4's "Check this part"); what it decides with is checked here.

const image = { url: '/images/neem.webp', alt: 'Neem face wash' };

function available(listingId: string, unitPrice: string, quantity = 1): ShopCartQuoteLine {
  return {
    status: 'available',
    listingId,
    slug: listingId,
    name: listingId,
    packSize: '150ml',
    image,
    quantity,
    unitPrice,
    lineTotal: unitPrice,
  };
}

function quote(lines: ShopCartQuoteLine[], total = '500.0000'): ShopCartQuote {
  return {
    lines,
    itemCount: lines.length,
    subtotal: total,
    discount: '0.0000',
    coupon: { status: 'none' },
    deliveryCharge: '80.0000',
    freeDelivery: false,
    total,
    belowMinimum: false,
  };
}

// The real English words, made the way the page makes them: errorText is tested with the
// sentences the shopper reads, and a word that lost its placeholder fails here
const words = checkoutWords(await shopLocale('en'), {
  zones: [{ id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80' }],
  paymentMethods: ['cod'],
  freeDeliveryFrom: null,
  minimumOrder: null,
});

const values: CheckoutFormValues = {
  name: 'Nusrat Jahan',
  phone: '01786120356',
  address: 'House 12, Road 5, Mirpur 10, Dhaka',
  zoneId: 'inside_dhaka',
  paymentMethod: 'cod',
  termsAccepted: true,
};

describe('checkoutFormSchema', () => {
  const parse = (input: Record<string, unknown>) =>
    checkoutFormSchema.safeParse({ ...values, ...input }, { error: contractErrorMap });

  it('says "pick a location" for an empty zone, not "too short"', () => {
    const result = parse({ zoneId: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('shop_zone_unknown');
  });

  it('makes the phone plain, as the server will', () => {
    expect(parse({ phone: '+880 1786-120356' }).data?.phone).toBe('01786120356');
    expect(parse({ phone: '০১৭৮৬১২০৩৫৬' }).data?.phone).toBe('01786120356');
    expect(parse({ phone: '029876543' }).error?.issues[0]?.message).toBe('shop_phone_format');
  });

  it('refuses a name of spaces with the code the words have', () => {
    expect(parse({ name: '   ' }).error?.issues[0]?.message).toBe('required');
  });
});

describe('fill and errorText', () => {
  it('puts the values into their placeholders and leaves unknown ones', () => {
    expect(fill('One less {{name}} {{other}}', { name: 'Neem' })).toBe('One less Neem {{other}}');
  });

  it('falls back to "Enter a valid value" for a code without words', () => {
    expect(errorText(words, 'some_new_code')).toBe('Enter a valid value.');
    expect(errorText(words, 'shop_zone_unknown')).toBe('Pick a delivery location.');
    // hasOwn, not `in`: an object's own methods are not words
    expect(errorText(words, 'toString')).toBe('Enter a valid value.');
    expect(errorText(words, 'shop_coupon_minimum', { minimum: '৳500' })).toBe(
      'This code needs items worth ৳500 or more.',
    );
  });
});

describe('parseCouponCode', () => {
  it('reads a code the way the server does', () => {
    expect(parseCouponCode('   ')).toBeNull();
    expect(parseCouponCode(' welcome10 ')).toEqual({ ok: true, code: 'WELCOME10' });
    expect(parseCouponCode('WELCOME 10')).toEqual({ ok: false, error: 'shop_coupon_format' });
  });

  it('writes a discount like the ribbon', () => {
    const money = (value: string) => `৳${value}`;
    expect(discountText({ kind: 'percent', value: 10 }, money)).toBe('10%');
    expect(discountText({ kind: 'amount', value: '50' }, money)).toBe('৳50');
  });
});

describe('quoteRequest and quoteKey', () => {
  const lines = [{ listingId: 'neem', quantity: 2 }];

  it('leaves out an empty zone and no code, which the route would refuse', () => {
    expect(quoteRequest(lines, '', undefined)).toEqual({ lines });
    expect(quoteRequest(lines, 'inside_dhaka', 'WELCOME10')).toEqual({
      lines,
      zoneId: 'inside_dhaka',
      couponCode: 'WELCOME10',
    });
  });

  it('gives each cart, zone and code its own key', () => {
    const plain = quoteKey(quoteRequest(lines, '', undefined));
    expect(quoteKey(quoteRequest(lines, 'inside_dhaka', undefined))).not.toBe(plain);
    expect(quoteKey(quoteRequest(lines, '', 'WELCOME10'))).not.toBe(plain);
    expect(quoteKey(quoteRequest([{ listingId: 'neem', quantity: 3 }], '', undefined))).not.toBe(
      plain,
    );
    expect(quoteKey(quoteRequest([...lines], '', undefined))).toBe(plain);
  });
});

describe('changedPrices', () => {
  it('names the lines whose price moved, with the old price', () => {
    const before = quote([available('neem', '229.0000'), available('tea', '120.0000')]);
    const after = quote([available('neem', '249.0000'), available('tea', '120.0000')]);
    expect(changedPrices(before, after)).toEqual(new Map([['neem', '229.0000']]));
  });

  it('leaves out a line that went out of stock or had no price before', () => {
    const outOfStock: ShopCartQuoteLine = {
      status: 'out_of_stock',
      listingId: 'tea',
      slug: 'tea',
      name: 'tea',
      packSize: '100g',
      image,
      quantity: 1,
    };
    const before = quote([available('neem', '229.0000'), outOfStock]);
    const after = quote([
      { ...outOfStock, listingId: 'neem', slug: 'neem' },
      available('tea', '99.0000'),
    ]);
    expect(changedPrices(before, after).size).toBe(0);
  });
});

describe('orderRequest', () => {
  const lines = [{ listingId: 'neem', quantity: 2 }];
  const seen = quote([available('neem', '229.0000', 2)], '538.0000');

  it('sends the total on screen and the code the quote used', () => {
    expect(orderRequest(values, lines, 'WELCOME10', seen)).toMatchObject({
      lines,
      zoneId: 'inside_dhaka',
      couponCode: 'WELCOME10',
      termsAccepted: true,
      expectedTotal: '538.0000',
    });
    expect(orderRequest(values, lines, undefined, seen)).not.toHaveProperty('couponCode');
  });

  it('builds nothing while the terms are not ticked', () => {
    expect(orderRequest({ ...values, termsAccepted: false }, lines, undefined, seen)).toBeNull();
  });

  it('says by how much the items are under the minimum', () => {
    expect(shortBy('300', '240.0000')).toBe('60.0000');
  });
});

describe('refusalErrors', () => {
  const problem = { title: 'x', status: 400, detail: 'x' };

  it('puts a field error under its field', () => {
    expect(
      refusalErrors({
        ...problem,
        code: 'invalid_input',
        fieldErrors: { phone: ['shop_phone_format'] },
      }),
    ).toEqual({ fields: [{ field: 'phone', code: 'shop_phone_format' }], general: null });
  });

  it('says a broken cart line once, above the button', () => {
    expect(
      refusalErrors({
        ...problem,
        code: 'invalid_input',
        fieldErrors: { 'lines.0.quantity': ['too_large'] },
      }),
    ).toEqual({ fields: [], general: 'invalid_input' });
  });

  it('points the zone and payment refusals at their groups, the rest above the button', () => {
    expect(refusalErrors({ ...problem, status: 422, code: 'shop_zone_unknown' }).fields).toEqual([
      { field: 'zoneId', code: 'shop_zone_unknown' },
    ]);
    expect(refusalErrors({ ...problem, status: 422, code: 'shop_payment_unavailable' })).toEqual({
      fields: [{ field: 'paymentMethod', code: 'shop_payment_unavailable' }],
      general: null,
    });
    expect(refusalErrors({ ...problem, status: 409, code: 'shop_order_changed' })).toEqual({
      fields: [],
      general: 'shop_order_changed',
    });
  });
});

describe('parseQuantity', () => {
  it('takes ASCII and Bangla digits, nothing else', () => {
    expect(parseQuantity(' 12 ')).toBe(12);
    expect(parseQuantity('১২')).toBe(12);
    expect(parseQuantity('1.5')).toBeUndefined();
    expect(parseQuantity('two')).toBeUndefined();
  });
});
