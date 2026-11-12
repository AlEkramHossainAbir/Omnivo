import type { ShopCheckoutSettings, ShopDiscount } from '@omnivo/contracts';

// Step 26c: what the mock shop offers at checkout. The zones and charges are Figma's
// (checkout_process: Inside Dhaka ৳80, Outside Dhaka ৳120); the amounts are the ones CLAUDE.md's
// storefront section uses in its examples ("Free delivery on orders over ৳1,000").
export const mockCheckoutSettings = {
  zones: [
    { id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80' },
    { id: 'outside_dhaka', name: 'Outside Dhaka', charge: '120' },
  ],
  paymentMethods: ['cod', 'online'],
  freeDeliveryFrom: '1000',
  // Low enough that one face wash and a tea pack reach it, high enough that a test can go under it
  minimumOrder: '300',
} satisfies ShopCheckoutSettings;

// A coupon as the shop keeps it. Not a contract: the shopper never sees a coupon list, only what
// one code did to their cart (ShopCouponResult). The real coupons live in step 26's API.
export interface MockCoupon {
  // Upper case, as couponCodeSchema leaves the shopper's code
  code: string;
  discount: ShopDiscount;
  // The items must be worth at least this much (the subtotal, decision 8). null: any amount
  minimum: string | null;
  // The last day it works, in the shop's time zone (ISO date). null: it never expires
  lastDay: string | null;
}

// One of each case the promo box has words for: a percent, a fixed amount with a minimum, and an
// expired code. Any other code is unknown
export const mockCoupons: MockCoupon[] = [
  { code: 'WELCOME10', discount: { kind: 'percent', value: 10 }, minimum: null, lastDay: null },
  { code: 'FLAT50', discount: { kind: 'amount', value: '50' }, minimum: '500', lastDay: null },
  {
    code: 'OLD2025',
    discount: { kind: 'percent', value: 20 },
    minimum: null,
    lastDay: '2025-12-31',
  },
];
