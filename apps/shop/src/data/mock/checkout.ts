import type { ShopCheckoutSettings, ShopCouponRule } from '@omnivo/contracts';

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

// Step 27c: the mock's coupons, as the API's quote reads them (ShopCouponRule in the contracts),
// judged with the same judgeShopCoupon(). How many orders have each one is not kept here: the mock
// counts its own order book (orders.ts → couponUses), like the API counts its orders table.
// One of each case the promo box has words for:
// - WELCOME10: a percent with a most it takes off, once per mobile number (the ERP mockup's)
// - FLAT50: a fixed amount from a minimum
// - OLD2025: ended (its last day has passed)
// - EID100: used up from the start, by the demo order W-000121 (demo-orders.ts). A coupon a test
//   uses up would be used up for every later test: the shop's server is shared by all of them
// - SOON: not started, which the shopper is told is unknown (27c's decision 3)
// Any other code is unknown
export const mockCoupons: ShopCouponRule[] = [
  {
    code: 'WELCOME10',
    discount: { kind: 'percent', value: 10 },
    upTo: '200',
    minimum: null,
    startsOn: null,
    lastDay: null,
    usageLimit: null,
    onePerPhone: true,
  },
  {
    code: 'FLAT50',
    discount: { kind: 'amount', value: '50' },
    upTo: null,
    minimum: '500',
    startsOn: null,
    lastDay: null,
    usageLimit: null,
    onePerPhone: false,
  },
  {
    code: 'OLD2025',
    discount: { kind: 'percent', value: 20 },
    upTo: null,
    minimum: null,
    startsOn: null,
    lastDay: '2025-12-31',
    usageLimit: null,
    onePerPhone: false,
  },
  {
    code: 'EID100',
    discount: { kind: 'amount', value: '100' },
    upTo: null,
    minimum: null,
    startsOn: null,
    lastDay: null,
    usageLimit: 1,
    onePerPhone: false,
  },
  {
    code: 'SOON',
    discount: { kind: 'percent', value: 15 },
    upTo: null,
    minimum: null,
    startsOn: '2099-01-01',
    lastDay: null,
    usageLimit: null,
    onePerPhone: false,
  },
];
