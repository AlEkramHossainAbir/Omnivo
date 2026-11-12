import {
  compareMoney,
  multiplyMoney,
  percentOfMoney,
  subtractMoney,
  sumMoney,
  todayIn,
  type ShopCartQuote,
  type ShopCartQuoteLine,
  type ShopCartQuoteRequest,
  type ShopCheckoutSettings,
  type ShopCouponResult,
  type ShopDiscount,
  type ShopListing,
} from '@omnivo/contracts';

import type { MockCoupon } from './checkout';

// Step 26c: what the quote needs besides the request: the listings, the shop's checkout settings
// and coupons, the shop's time zone and the moment (a coupon's last day is a day in Dhaka, not in
// UTC). One object, so a test changes only the part it is about.
export interface QuoteContext {
  catalog: ShopListing[];
  settings: ShopCheckoutSettings;
  coupons: MockCoupon[];
  timeZone: string;
  now: Date;
}

// Step 26b: the mock's cart prices, worked out the way the real API will (step 26): each line at
// the listing's price today, summed on the server. Never with JavaScript numbers: 3 × ৳49.90 is
// 149.70000000000002 in floating point, so the money helpers work in whole ten-thousandths.
// Step 26c: also the coupon, the delivery charge, the total and the minimum order.
export function quoteCart(request: ShopCartQuoteRequest, context: QuoteContext): ShopCartQuote {
  const byId = new Map(context.catalog.map((listing) => [listing.id, listing]));

  const lines = request.lines.map((line): ShopCartQuoteLine => {
    const listing = byId.get(line.listingId);
    // The schema needs at least one photo, so `image` is there for every listing that passed it.
    // TypeScript cannot know that (noUncheckedIndexedAccess); a listing without one is treated as
    // gone, never drawn with a broken image
    const image = listing?.images[0];
    if (!listing || !image) return { status: 'unavailable', listingId: line.listingId };

    const shown = {
      listingId: listing.id,
      slug: listing.slug,
      name: listing.name,
      packSize: listing.packSize,
      image,
      quantity: line.quantity,
    };
    if (!listing.inStock) return { ...shown, status: 'out_of_stock' };
    return {
      ...shown,
      status: 'available',
      unitPrice: listing.price,
      lineTotal: multiplyMoney(String(line.quantity), listing.price),
    };
  });

  // Only what can be sold counts: an out-of-stock line stays on screen but adds nothing
  const sold = lines.filter((line) => line.status === 'available');
  const subtotal = sumMoney(sold.map((line) => line.lineTotal));

  const coupon = couponResult(request.couponCode, subtotal, context);
  const discount = coupon.status === 'applied' ? discountOf(coupon.discount, subtotal) : '0.0000';

  const { settings } = context;
  // Decision 8: both rules look at the subtotal, the items before the coupon
  const freeDelivery =
    settings.freeDeliveryFrom !== null && compareMoney(subtotal, settings.freeDeliveryFrom) >= 0;
  const belowMinimum =
    settings.minimumOrder !== null && compareMoney(subtotal, settings.minimumOrder) < 0;

  // A zone id the shop does not have (any more) is treated as no zone: the checkout then says
  // "Pick a location", which is what the shopper must do. Confirm Order refuses it on its own
  const zone = settings.zones.find((candidate) => candidate.id === request.zoneId);
  const deliveryCharge = zone ? (freeDelivery ? '0.0000' : sumMoney([zone.charge])) : null;

  return {
    lines,
    itemCount: sold.reduce((count, line) => count + line.quantity, 0),
    subtotal,
    discount,
    coupon,
    deliveryCharge,
    freeDelivery,
    total: sumMoney([subtractMoney(subtotal, discount), deliveryCharge ?? '0']),
    belowMinimum,
  };
}

// Decision 9: a code that does not apply is an answer, never an error. The checks go from "no such
// code" to "not any more" to "not for this cart", so the reason given is the one that matters most
function couponResult(
  code: string | undefined,
  subtotal: string,
  context: QuoteContext,
): ShopCouponResult {
  if (code === undefined) return { status: 'none' };

  const coupon = context.coupons.find((candidate) => candidate.code === code);
  if (!coupon) return { status: 'refused', code, reason: 'shop_coupon_unknown', minimum: null };

  // Today in the shop's time zone: at 1 am on 1 January in Dhaka it is still 31 December in UTC,
  // and a code that ended on the 31st must not work then. ISO dates compare correctly as strings
  if (coupon.lastDay !== null && todayIn(context.timeZone, context.now) > coupon.lastDay) {
    return { status: 'refused', code, reason: 'shop_coupon_expired', minimum: null };
  }
  if (coupon.minimum !== null && compareMoney(subtotal, coupon.minimum) < 0) {
    return { status: 'refused', code, reason: 'shop_coupon_minimum', minimum: coupon.minimum };
  }
  return { status: 'applied', code, discount: coupon.discount };
}

// What a coupon takes off the subtotal, to the paisa. A fixed amount never takes off more than the
// items cost: ৳50 off a ৳30 cart is ৳30 off, so the total never goes below the delivery charge
function discountOf(discount: ShopDiscount, subtotal: string): string {
  if (discount.kind === 'percent') return percentOfMoney(subtotal, String(discount.value));
  const amount = sumMoney([discount.value]);
  return compareMoney(amount, subtotal) > 0 ? subtotal : amount;
}
