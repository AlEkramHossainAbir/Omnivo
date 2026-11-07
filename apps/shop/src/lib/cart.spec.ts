import { describe, expect, it } from 'vitest';

import { addLine, MAX_QUANTITY, parseCart } from './cart';

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
    expect(addLine(full, 'lst-a')).toEqual(full);
  });
});
