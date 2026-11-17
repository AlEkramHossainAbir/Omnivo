import {
  compareMoney,
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
// line's photo is the small size (media.ts), the same as the card's, so it is the card's own
export interface QuotedListing {
  listing: ShopListing;
  image: ShopImage;
}

// Step 26f: the cart's prices, the same rules as the shop's mock (apps/shop/src/data/mock/quote.ts,
// step 26c), so the drawer and the checkout do not change when the shop moves to this API. Each
// line at the listing's price now, summed with the money helpers (never JavaScript numbers). Only
// coupons differ: the ERP has none until step 27, so a code is always refused as unknown.
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
    const { listing, image } = found;
    const shown = {
      listingId: listing.id,
      slug: listing.slug,
      name: listing.name,
      packSize: listing.packSize,
      image,
      quantity: line.quantity,
    };
    // Decision 3: the shop knows only "in stock" (one or more in the shop's warehouse). Whether
    // there are as many as the cart asks for is step 27's question, when an order holds the stock
    if (!listing.inStock) return { ...shown, status: 'out_of_stock' };
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
