import {
  SHOP_CART_MAX_LINES,
  SHOP_CART_MAX_QUANTITY,
  shopCartQuoteRequestSchema,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  addLine,
  MAX_LINES,
  MAX_QUANTITY,
  parseCart,
  withLine,
  withoutLines,
  withQuantity,
  type CartLine,
} from './cart';

// cart.ts keeps its own copy of the limit, because importing the contracts would bring Zod into
// every page. If they drifted, the browser would keep a 100 the server refuses, and the whole
// cart's quote would fail
it('keeps the same limits as the server', () => {
  expect(MAX_QUANTITY).toBe(SHOP_CART_MAX_QUANTITY);
  expect(MAX_LINES).toBe(SHOP_CART_MAX_LINES);
});

// A full cart: as many lines as allowed, each id as long as allowed
const fullCart: CartLine[] = Array.from({ length: MAX_LINES }, (_, index) => ({
  listingId: String(index).padStart(64, 'x'),
  quantity: MAX_QUANTITY,
}));

describe('parseCart', () => {
  it('reads a cart this code wrote', () => {
    const raw = JSON.stringify([{ listingId: 'lst-a', quantity: 2 }]);
    expect(parseCart(raw)).toEqual([{ listingId: 'lst-a', quantity: 2 }]);
  });

  it('starts empty for nothing stored, broken JSON or a foreign shape', () => {
    expect(parseCart(null)).toEqual([]);
    expect(parseCart('{not json')).toEqual([]);
    expect(parseCart('{"listingId":"lst-a","quantity":1}')).toEqual([]);
    // An older format that kept prices: one bad line drops the whole cart
    expect(
      parseCart(
        JSON.stringify([
          { listingId: 'lst-a', quantity: 1 },
          { listingId: 'lst-b', quantity: '2' },
        ]),
      ),
    ).toEqual([]);
  });

  // Step 26b: whatever the cart keeps, the quote route takes. Otherwise one stored cart would fail
  // every quote, and "Try again" could never help
  it('keeps only carts the quote route takes', () => {
    const parsed = parseCart(JSON.stringify(fullCart));
    expect(parsed).toEqual(fullCart);
    expect(shopCartQuoteRequestSchema.safeParse({ lines: parsed }).success).toBe(true);

    const oneMore = [...fullCart, { listingId: 'lst-a', quantity: 1 }];
    const longId = [{ listingId: 'x'.repeat(65), quantity: 1 }];
    const twice = [
      { listingId: 'lst-a', quantity: 1 },
      { listingId: 'lst-a', quantity: 2 },
    ];
    for (const cart of [oneMore, longId, twice]) {
      expect(shopCartQuoteRequestSchema.safeParse({ lines: cart }).success).toBe(false);
      expect(parseCart(JSON.stringify(cart))).toEqual([]);
    }
  });

  it('refuses quantities a shopper cannot have', () => {
    for (const quantity of [0, -1, 1.5, MAX_QUANTITY + 1]) {
      expect(parseCart(JSON.stringify([{ listingId: 'lst-a', quantity }]))).toEqual([]);
    }
  });
});

describe('addLine', () => {
  it('adds a new line with one, and one more to a line already there', () => {
    const once = addLine([], 'lst-a');
    expect(once).toEqual([{ listingId: 'lst-a', quantity: 1 }]);
    expect(addLine(once, 'lst-a')).toEqual([{ listingId: 'lst-a', quantity: 2 }]);
    expect(addLine(once, 'lst-b')).toEqual([
      { listingId: 'lst-a', quantity: 1 },
      { listingId: 'lst-b', quantity: 1 },
    ]);
  });

  it('stops at the most a line can hold', () => {
    const full = [{ listingId: 'lst-a', quantity: MAX_QUANTITY }];
    expect(addLine(full, 'lst-a')).toBe(full);
  });

  it('adds no line to a full cart', () => {
    expect(addLine(fullCart, 'lst-a')).toBe(fullCart);
  });
});

describe('withLine', () => {
  it('adds the product once, with one', () => {
    expect(withLine([], 'lst-a')).toEqual([{ listingId: 'lst-a', quantity: 1 }]);
  });

  // "Place Order" twice must not buy two: the shopper chose the count already, or will at checkout
  it('leaves a cart that has the product as it is', () => {
    const cart = [{ listingId: 'lst-a', quantity: 3 }];
    expect(withLine(cart, 'lst-a')).toBe(cart);
  });
});

describe('withQuantity', () => {
  const cart = [
    { listingId: 'lst-a', quantity: 2 },
    { listingId: 'lst-b', quantity: 1 },
  ];

  it('sets one line and leaves the others', () => {
    expect(withQuantity(cart, 'lst-a', 5)).toEqual([
      { listingId: 'lst-a', quantity: 5 },
      { listingId: 'lst-b', quantity: 1 },
    ]);
  });

  // A typed 0 or 500 is fixed, not refused: the box shows what the cart really holds
  it('keeps the quantity between 1 and the limit, in whole items', () => {
    expect(withQuantity(cart, 'lst-a', 0)[0]).toEqual({ listingId: 'lst-a', quantity: 1 });
    expect(withQuantity(cart, 'lst-a', 500)[0]).toEqual({
      listingId: 'lst-a',
      quantity: MAX_QUANTITY,
    });
    expect(withQuantity(cart, 'lst-a', 3.7)[0]).toEqual({ listingId: 'lst-a', quantity: 3 });
  });

  it('returns the same cart when nothing changes', () => {
    expect(withQuantity(cart, 'lst-a', 2)).toBe(cart);
    // Removed in another tab a moment ago: a click here does not bring it back
    expect(withQuantity(cart, 'lst-gone', 4)).toBe(cart);
  });
});

describe('withoutLines', () => {
  const cart = [
    { listingId: 'lst-a', quantity: 2 },
    { listingId: 'lst-b', quantity: 1 },
  ];

  it('removes the lines named', () => {
    expect(withoutLines(cart, new Set(['lst-a']))).toEqual([{ listingId: 'lst-b', quantity: 1 }]);
  });

  it('returns the same cart when none of them is there', () => {
    expect(withoutLines(cart, new Set(['lst-gone']))).toBe(cart);
  });
});
