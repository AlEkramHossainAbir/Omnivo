import { describe, expect, it } from 'vitest';

import { mockCatalog } from '../data/mock/products';
import { quoteCart } from '../data/mock/quote';
import { isCartQuote } from './quote';

describe('isCartQuote', () => {
  // The guard is hand-written, so it is tested against what the server really sends: every kind
  // of line the mock source can answer
  it('takes the answers the quote route sends', () => {
    const inStock = mockCatalog.find((listing) => listing.inStock);
    const outOfStock = mockCatalog.find((listing) => !listing.inStock);
    if (!inStock || !outOfStock) throw new Error('the mock catalog needs both kinds');

    const quote = quoteCart(
      {
        lines: [
          { listingId: inStock.id, quantity: 3 },
          { listingId: outOfStock.id, quantity: 1 },
          { listingId: 'lst-gone', quantity: 2 },
        ],
      },
      mockCatalog,
    );
    expect(quote.lines.map((line) => line.status)).toEqual([
      'available',
      'out_of_stock',
      'unavailable',
    ]);
    expect(isCartQuote(quote)).toBe(true);
    expect(isCartQuote(quoteCart({ lines: [] }, mockCatalog))).toBe(true);
  });

  it('refuses a body it could not draw', () => {
    const line = {
      status: 'available',
      listingId: 'lst-a',
      slug: 'neem',
      name: 'Neem',
      packSize: '150ml',
      image: { url: '/mock/neem.png', alt: 'Neem' },
      quantity: 1,
      unitPrice: '229.0000',
      lineTotal: '229.0000',
    };
    const quote = { lines: [line], itemCount: 1, subtotal: '229.0000' };
    expect(isCartQuote(quote)).toBe(true);

    // A problem+json body, an unknown status, a missing price and an image on another scheme
    expect(isCartQuote({ type: 'about:blank', status: 500, code: 'internal_error' })).toBe(false);
    expect(isCartQuote({ ...quote, lines: [{ ...line, status: 'reserved' }] })).toBe(false);
    expect(isCartQuote({ ...quote, lines: [{ ...line, lineTotal: undefined }] })).toBe(false);
    expect(
      isCartQuote({
        ...quote,
        lines: [{ ...line, image: { url: 'javascript:alert(1)', alt: 'x' } }],
      }),
    ).toBe(false);
    expect(isCartQuote({ ...quote, subtotal: 229 })).toBe(false);
  });
});
