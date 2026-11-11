import { shopCartQuoteSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockCatalog } from './products';
import { quoteCart } from './quote';

const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
const STEVIA = 'lst-zero-cal-stevia-30-sachets'; // ৳120
const DANO = 'lst-dano-daily-pushti-milk-1kg'; // out of stock

describe('quoteCart', () => {
  it('prices each line at today’s price and sums them on the server', () => {
    const quote = quoteCart(
      {
        lines: [
          { listingId: NEEM, quantity: 3 },
          { listingId: STEVIA, quantity: 1 },
        ],
      },
      mockCatalog,
    );
    expect(quote.lines).toMatchObject([
      { status: 'available', listingId: NEEM, unitPrice: '229', lineTotal: '687.0000' },
      { status: 'available', listingId: STEVIA, unitPrice: '120', lineTotal: '120.0000' },
    ]);
    expect(quote.itemCount).toBe(4);
    expect(quote.subtotal).toBe('807.0000');
    // The drawer trusts this answer as it is, so it must be what the real API will send
    expect(() => shopCartQuoteSchema.parse(quote)).not.toThrow();
  });

  it('keeps the cart’s order and leaves out what cannot be sold', () => {
    const quote = quoteCart(
      {
        lines: [
          { listingId: DANO, quantity: 2 },
          { listingId: 'lst-gone', quantity: 1 },
          { listingId: STEVIA, quantity: 2 },
        ],
      },
      mockCatalog,
    );
    expect(quote.lines.map((line) => line.status)).toEqual([
      'out_of_stock',
      'unavailable',
      'available',
    ]);
    // A gone listing says only its id: the browser drops it, and there is nothing else to show
    expect(quote.lines[1]).toEqual({ status: 'unavailable', listingId: 'lst-gone' });
    // The out-of-stock 2 are not counted, and add no money
    expect(quote.itemCount).toBe(2);
    expect(quote.subtotal).toBe('240.0000');
  });

  it('answers an empty cart with nothing to pay', () => {
    const quote = quoteCart({ lines: [] }, mockCatalog);
    expect(quote).toEqual({ lines: [], itemCount: 0, subtotal: '0.0000' });
  });

  it('never adds money as floating point', () => {
    // 3 × 49.90 is 149.70000000000002 with JavaScript numbers
    const catalog = mockCatalog.map((listing) =>
      listing.id === STEVIA ? { ...listing, price: '49.90' } : listing,
    );
    const quote = quoteCart({ lines: [{ listingId: STEVIA, quantity: 3 }] }, catalog);
    expect(quote.subtotal).toBe('149.7000');
  });
});
