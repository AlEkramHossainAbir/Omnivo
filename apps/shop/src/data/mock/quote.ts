import {
  compareMoney,
  judgeShopCoupon,
  multiplyMoney,
  shopCouponDiscount,
  subtractMoney,
  sumMoney,
  todayIn,
  type ShopCartQuote,
  type ShopCartQuoteLine,
  type ShopCartQuoteRequest,
  type ShopCheckoutSettings,
  type ShopCouponRule,
  type ShopListing,
} from '@omnivo/contracts';

// Step 26c: what the quote needs besides the request: the listings, the shop's checkout settings
// and coupons, the shop's time zone and the moment (a coupon's last day is a day in Dhaka, not in
// UTC). One object, so a test changes only the part it is about.
// Step 27c: the coupons are the contracts' ShopCouponRule, and `used` says how many orders have a
// code now (the order book's count, orders.ts → couponUses)
export interface QuoteContext {
  catalog: ShopListing[];
  settings: ShopCheckoutSettings;
  coupons: readonly ShopCouponRule[];
  used: (code: string) => number;
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

  // Step 27c: judged by the contracts' rule, the one the API's quote uses, so the mock can never
  // apply a code the real shop refuses. The reasons go from "no such code" to "not any more" to
  // "not for this cart" (27c's decision 15)
  const code = request.couponCode;
  const coupon = judgeShopCoupon(
    code,
    context.coupons.find((candidate) => candidate.code === code),
    {
      subtotal,
      // Today in the shop's time zone: at 1 am on 1 January in Dhaka it is still 31 December in
      // UTC, and a code that ended on the 31st must not work then
      today: todayIn(context.timeZone, context.now),
      used: code === undefined ? 0 : context.used(code),
    },
  );
  const discount = coupon.status === 'applied' ? shopCouponDiscount(coupon, subtotal) : '0.0000';

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
