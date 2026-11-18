import {
  compareMoney,
  compareQuantity,
  multiplyMoney,
  subtractMoney,
  sumMoney,
  type ShopCartQuote,
  type ShopCartQuoteLine,
  type ShopCartQuoteRequest,
  type ShopCheckoutSettings,
  type ShopCouponResult,
  type ShopImage,
  type ShopListing,
} from '@omnivo/contracts';

// A listing as the quote needs it: the card (price, stock) and the photo a cart line draws. The
// line's photo is the small size (media.ts), the same as the card's, so it is the card's own.
// Step 27a: and how much is free to sell (on hand minus held, in the base unit), as a decimal string
export interface QuotedListing {
  listing: ShopListing;
  image: ShopImage;
  free: string;
}

// Step 26f: the cart's prices, the same rules as the shop's mock (apps/shop/src/data/mock/quote.ts,
// step 26c), so the drawer and the checkout do not change when the shop moves to this API. Each
// line at the listing's price now, summed with the money helpers (never JavaScript numbers). Only
// coupons differ: the ERP has none until step 27c, so a code is always refused as unknown. Step
// 27a: placing an order prices it with this same function, so the order and the last quote agree.
//
// `listings` has only what the shop shows now: a listing that is unpublished, deleted, archived in
// the ERP or without a price is not in it, and its line is 'unavailable'.
export function quoteCart(
  request: ShopCartQuoteRequest,
  listings: ReadonlyMap<string, QuotedListing>,
  settings: ShopCheckoutSettings,
): ShopCartQuote {
  const lines = request.lines.map((line): ShopCartQuoteLine => {
    const found = listings.get(line.listingId);
    if (found === undefined) return { status: 'unavailable', listingId: line.listingId };
    const { listing, image, free } = found;
    const shown = {
      listingId: listing.id,
      slug: listing.slug,
      name: listing.name,
      packSize: listing.packSize,
      image,
      quantity: line.quantity,
    };
    // Step 27a: as many as the cart asks for must be free, because placing the order holds that
    // many (27a's decision 6). Fewer is out of stock for this line: the quote has no "only 3
    // left", and calling it available would let Confirm Order fail on it again and again
    if (!listing.inStock || compareQuantity(free, String(line.quantity)) < 0) {
      return { ...shown, status: 'out_of_stock' };
    }
    return {
      ...shown,
      status: 'available',
      unitPrice: listing.price,
      lineTotal: multiplyMoney(String(line.quantity), listing.price),
    };
  });

  const sold = lines.filter((line) => line.status === 'available');
  const subtotal = sumMoney(sold.map((line) => line.lineTotal));

  // No coupon takes anything off yet (see above). The promo box then says "This code does not
  // exist", which is true of every code in a shop with no coupons
  const coupon: ShopCouponResult =
    request.couponCode === undefined
      ? { status: 'none' }
      : {
          status: 'refused',
          code: request.couponCode,
          reason: 'shop_coupon_unknown',
          minimum: null,
        };
  const discount = '0.0000';

  // Both rules look at the subtotal, the items before the coupon (step 26c's decision 8)
  const freeDelivery =
    settings.freeDeliveryFrom !== null && compareMoney(subtotal, settings.freeDeliveryFrom) >= 0;
  const belowMinimum =
    settings.minimumOrder !== null && compareMoney(subtotal, settings.minimumOrder) < 0;

  // A zone the shop no longer has is no zone: the checkout says "Pick a location"
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
