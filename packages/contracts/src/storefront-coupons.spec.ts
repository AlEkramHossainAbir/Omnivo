import { describe, expect, it } from 'vitest';

import { shopCartQuoteSchema } from './storefront.js';
import {
  createStorefrontCouponInputSchema,
  judgeShopCoupon,
  shopCouponDiscount,
  storefrontCouponQuerySchema,
  storefrontCouponRoutes,
  storefrontCouponStatus,
  updateStorefrontCouponInputSchema,
  type ShopCouponRule,
  type StorefrontCouponFormValues,
} from './storefront-coupons.js';

// The field paths and codes of a failed parse, the way the forms show them
function errorsOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of result.error?.issues ?? []) {
    const key = issue.path.map(String).join('.');
    errors[key] = [...(errors[key] ?? []), issue.message];
  }
  return errors;
}

// "10% off, up to ৳200, on items worth ৳500 or more, in November, 100 orders"
const RULE: ShopCouponRule = {
  code: 'WELCOME10',
  discount: { kind: 'percent', value: 10 },
  upTo: '200',
  minimum: '500',
  startsOn: '2026-11-01',
  lastDay: '2026-11-30',
  usageLimit: 100,
  onePerPhone: true,
};
const CHECK = { subtotal: '1000.0000', today: '2026-11-19', used: 12 };

describe('judgeShopCoupon', () => {
  it('applies a code that fits, with what the promo box names', () => {
    expect(judgeShopCoupon('WELCOME10', RULE, CHECK)).toEqual({
      status: 'applied',
      code: 'WELCOME10',
      discount: { kind: 'percent', value: 10 },
      upTo: '200',
    });
    expect(judgeShopCoupon(undefined, RULE, CHECK)).toEqual({ status: 'none' });
  });

  it('calls a missing code and one that has not started yet unknown', () => {
    expect(judgeShopCoupon('NOPE', undefined, CHECK)).toMatchObject({
      reason: 'shop_coupon_unknown',
    });
    // The day before its first day: the sale is not announced through the promo box
    expect(judgeShopCoupon('WELCOME10', RULE, { ...CHECK, today: '2026-10-31' })).toMatchObject({
      reason: 'shop_coupon_unknown',
    });
    // Its first and last days both count
    expect(judgeShopCoupon('WELCOME10', RULE, { ...CHECK, today: '2026-11-01' }).status).toBe(
      'applied',
    );
    expect(judgeShopCoupon('WELCOME10', RULE, { ...CHECK, today: '2026-11-30' }).status).toBe(
      'applied',
    );
  });

  it('gives the reason that matters most: expired, then used up, then the minimum', () => {
    const late = { ...CHECK, today: '2026-12-01', used: 100, subtotal: '100.0000' };
    expect(judgeShopCoupon('WELCOME10', RULE, late)).toMatchObject({
      reason: 'shop_coupon_expired',
      minimum: null,
    });
    expect(judgeShopCoupon('WELCOME10', RULE, { ...late, today: '2026-11-19' })).toMatchObject({
      reason: 'shop_coupon_used_up',
    });
    expect(judgeShopCoupon('WELCOME10', RULE, { ...late, today: '2026-11-19', used: 99 })).toEqual({
      status: 'refused',
      code: 'WELCOME10',
      reason: 'shop_coupon_minimum',
      minimum: '500',
    });
  });

  it('answers in the quote’s own shape', () => {
    const coupon = judgeShopCoupon('WELCOME10', RULE, CHECK);
    const quote = {
      lines: [],
      itemCount: 0,
      subtotal: '1000.0000',
      discount: '100.0000',
      coupon,
      deliveryCharge: null,
      freeDelivery: false,
      total: '900.0000',
      belowMinimum: false,
    };
    expect(shopCartQuoteSchema.safeParse(quote).success).toBe(true);
  });
});

describe('shopCouponDiscount', () => {
  it('takes a percent of the items, to the paisa, cut to its "up to"', () => {
    const tenPercent = { discount: { kind: 'percent', value: 10 } as const, upTo: null };
    expect(shopCouponDiscount(tenPercent, '1234.5600')).toBe('123.4600');
    expect(shopCouponDiscount({ ...tenPercent, upTo: '200' }, '5000.0000')).toBe('200.0000');
    expect(shopCouponDiscount({ ...tenPercent, upTo: '200' }, '1500.0000')).toBe('150.0000');
  });

  it('never takes more than the items cost', () => {
    const fifty = { discount: { kind: 'amount', value: '50' } as const, upTo: null };
    expect(shopCouponDiscount(fifty, '458.0000')).toBe('50.0000');
    expect(shopCouponDiscount(fifty, '30.0000')).toBe('30.0000');
  });
});

describe('storefrontCouponStatus', () => {
  const coupon = { archivedAt: null, startsOn: null, lastDay: null, usageLimit: null, used: 0 };

  it('works the pill out from the archive, the days and the uses', () => {
    expect(storefrontCouponStatus(coupon, '2026-11-19')).toBe('active');
    expect(storefrontCouponStatus({ ...coupon, startsOn: '2026-11-20' }, '2026-11-19')).toBe(
      'scheduled',
    );
    expect(storefrontCouponStatus({ ...coupon, lastDay: '2026-11-18' }, '2026-11-19')).toBe(
      'ended',
    );
    expect(storefrontCouponStatus({ ...coupon, usageLimit: 5, used: 5 }, '2026-11-19')).toBe(
      'ended',
    );
    expect(
      storefrontCouponStatus(
        { ...coupon, archivedAt: '2026-11-01T04:00:00.000Z', startsOn: '2026-12-01' },
        '2026-11-19',
      ),
    ).toBe('archived');
  });
});

const FORM: StorefrontCouponFormValues = {
  code: ' welcome10 ',
  kind: 'percent',
  value: '10',
  upTo: '200',
  minimum: '',
  startsOn: '2026-11-01',
  lastDay: '',
  usageLimit: '100',
  onePerPhone: true,
};

describe('the coupon form', () => {
  it('saves the boxes as the API keeps them', () => {
    expect(createStorefrontCouponInputSchema.parse(FORM)).toEqual({
      code: 'WELCOME10',
      discount: { kind: 'percent', value: 10 },
      upTo: '200',
      minimum: null,
      startsOn: '2026-11-01',
      lastDay: null,
      usageLimit: 100,
      onePerPhone: true,
    });
    expect(
      createStorefrontCouponInputSchema.parse({ ...FORM, kind: 'amount', value: '50.5', upTo: '' })
        .discount,
    ).toEqual({ kind: 'amount', value: '50.5' });
    expect(updateStorefrontCouponInputSchema.parse({ ...FORM, version: 3 }).version).toBe(3);
  });

  it('checks the value for its kind', () => {
    const errors = (values: Partial<StorefrontCouponFormValues>) =>
      errorsOf(createStorefrontCouponInputSchema.safeParse({ ...FORM, ...values }));
    expect(errors({ value: '100' })).toEqual({ value: ['storefront_sale_percent'] });
    expect(errors({ value: '12.5' })).toEqual({ value: ['storefront_sale_percent'] });
    expect(errors({ kind: 'amount', upTo: '', value: '0' })).toEqual({
      value: ['storefront_sale_zero'],
    });
    // To the paisa: the discount is spread over the sales order's lines to the paisa
    expect(errors({ kind: 'amount', upTo: '', value: '10.555' })).toEqual({
      value: ['money_format'],
    });
    expect(errors({ kind: 'amount', value: '50' })).toEqual({ upTo: ['storefront_coupon_up_to'] });
  });

  it('refuses empty-looking limits, odd uses and days in the wrong order', () => {
    const errors = (values: Partial<StorefrontCouponFormValues>) =>
      errorsOf(createStorefrontCouponInputSchema.safeParse({ ...FORM, ...values }));
    expect(errors({ minimum: '0', upTo: '0.00' })).toEqual({
      minimum: ['storefront_sale_zero'],
      upTo: ['storefront_sale_zero'],
    });
    expect(errors({ usageLimit: '0' })).toEqual({ usageLimit: ['storefront_coupon_limit_format'] });
    expect(errors({ usageLimit: '1e3' })).toEqual({
      usageLimit: ['storefront_coupon_limit_format'],
    });
    expect(errors({ usageLimit: '1000001' })).toEqual({
      usageLimit: ['storefront_coupon_limit_format'],
    });
    expect(errors({ lastDay: '2026-10-31' })).toEqual({ lastDay: ['storefront_coupon_dates'] });
    // One day: the same date twice
    expect(errors({ lastDay: '2026-11-01' })).toEqual({});
    expect(errors({ code: 'EID SALE' })).toEqual({ code: ['shop_coupon_format'] });
  });
});

describe('the coupons list', () => {
  it('searches by part of the code, current coupons first', () => {
    expect(storefrontCouponQuerySchema.parse({ search: ' wel ' })).toMatchObject({
      search: 'WEL',
      view: 'current',
    });
  });

  it('asks storefront.manage on every route', () => {
    for (const route of Object.values(storefrontCouponRoutes)) {
      expect(route.permission).toBe('storefront.manage');
    }
  });
});
