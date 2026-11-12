import {
  multiplyMoney,
  sumMoney,
  type ShopCartQuote,
  type ShopCartQuoteLine,
  type ShopCartQuoteRequest,
  type ShopListing,
} from '@omnivo/contracts';

// Step 26b: the mock's cart prices, worked out the way the real API will (step 26): each line at
// the listing's price today, summed on the server. Never with JavaScript numbers: 3 × ৳49.90 is
// 149.70000000000002 in floating point, so the money helpers work in whole ten-thousandths.
export function quoteCart(request: ShopCartQuoteRequest, catalog: ShopListing[]): ShopCartQuote {
  const byId = new Map(catalog.map((listing) => [listing.id, listing]));

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
  return {
    lines,
    itemCount: sold.reduce((count, line) => count + line.quantity, 0),
    subtotal: sumMoney(sold.map((line) => line.lineTotal)),
  };
}
