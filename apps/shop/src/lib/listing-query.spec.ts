import { shopListingQuerySchema, type ShopListingQuery } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  hasPanelFilters,
  listingHref,
  listingMoreHref,
  listingPath,
  readListingQuery,
} from './listing-query';

function read(search: string, category: string | null = 'cosmetics'): ShopListingQuery {
  return readListingQuery(category, new URLSearchParams(search));
}

const PLAIN: ShopListingQuery = {
  category: 'cosmetics',
  q: null,
  sort: 'newest',
  minPrice: null,
  maxPrice: null,
  inStock: false,
  offer: false,
  cursor: null,
};

describe('readListingQuery', () => {
  it('reads a bare address as the defaults', () => {
    expect(read('')).toEqual(PLAIN);
  });

  it('reads every choice', () => {
    expect(read('q=neem&sort=price_asc&min=100&max=500&stock=1&offer=1&cursor=abc')).toEqual({
      category: 'cosmetics',
      q: 'neem',
      sort: 'price_asc',
      minPrice: '100',
      maxPrice: '500',
      inStock: true,
      offer: true,
      cursor: 'abc',
    });
  });

  it('drops what makes no sense instead of failing', () => {
    // An old link or a hand-edited address still shows the page, with that filter off
    expect(read('sort=popular&min=99.50&max=-5&stock=yes&offer=0&cursor=')).toEqual(PLAIN);
    expect(read('min=1234567890').minPrice).toBeNull();
  });

  it('takes Bangla digits, grouping and leading zeros', () => {
    const query = read('min=৫০০&max=1,000');
    expect(query.minPrice).toBe('500');
    expect(query.maxPrice).toBe('1000');
    expect(read('min=0500').minPrice).toBe('500');
    expect(read('min=0').minPrice).toBe('0');
  });

  it('swaps a price range typed the wrong way round', () => {
    // As numbers: as strings, "90" > "500" and nothing would be swapped
    const query = read('min=500&max=90');
    expect([query.minPrice, query.maxPrice]).toEqual(['90', '500']);
  });

  it('tidies the search words', () => {
    expect(read('q=%20%20neem%20%20%20face%20').q).toBe('neem face');
    expect(read('q=%20%20%20').q).toBeNull();
    // য় can come as one code point (U+09DF) or as two (য + ়), depending on the keyboard. Both
    // are one search, so one address
    const oneCodePoint = read(`q=${encodeURIComponent('ফেসওয়াশ')}`).q;
    const twoCodePoints = read(`q=${encodeURIComponent('ফেসওয়াশ')}`).q;
    expect(oneCodePoint).toBe(twoCodePoints);
  });

  it('cuts a long search at whole characters', () => {
    expect(read(`q=${'a'.repeat(150)}`).q).toHaveLength(100);
    // 99 letters and an emoji (two UTF-16 units) do not fit in 100: the emoji goes, not half of it
    const cut = read(`q=${'a'.repeat(99)}${encodeURIComponent('🧴')}`).q;
    expect(cut).toBe('a'.repeat(99));
  });

  it('always gives a query the contract accepts', () => {
    const addresses = [
      '',
      'q=neem&sort=name&min=500&max=90&stock=1&offer=1',
      `q=${'অ'.repeat(300)}&min=৯৯৯৯৯৯৯৯৯&cursor=${'x'.repeat(600)}`,
      'min=abc&max=&sort=&q=',
    ];
    for (const address of addresses) {
      expect(() => shopListingQuerySchema.parse(read(address))).not.toThrow();
      expect(() => shopListingQuerySchema.parse(read(address, null))).not.toThrow();
    }
  });
});

describe('listingPath', () => {
  it('names the page of a category, a search, or everything', () => {
    expect(listingPath('tea', null)).toBe('/c/tea');
    expect(listingPath('tea', 'bestleaf')).toBe('/c/tea');
    expect(listingPath(null, 'bestleaf')).toBe('/search');
    expect(listingPath(null, null)).toBe('/c/all');
  });
});

describe('listingHref', () => {
  it('leaves the defaults out', () => {
    expect(listingHref(PLAIN)).toBe('/c/cosmetics');
  });

  it('writes the keys in one order, whatever the address had', () => {
    const query = read('offer=1&max=500&sort=name&q=neem&stock=1&min=100');
    expect(listingHref(query)).toBe(
      '/c/cosmetics?q=neem&sort=name&min=100&max=500&stock=1&offer=1',
    );
  });

  it('drops the cursor when a choice changes, and keeps the search', () => {
    const query = read('q=neem&cursor=abc');
    expect(listingHref(query, { sort: 'price_desc' })).toBe('/c/cosmetics?q=neem&sort=price_desc');
    expect(listingHref(query, { category: 'skin-care' })).toBe('/c/skin-care?q=neem');
    expect(listingHref(query, { category: null })).toBe('/search?q=neem');
  });

  it('sets the cursor for Load More', () => {
    expect(listingHref(read('offer=1'), { cursor: 'bW9jazoyMA' })).toBe(
      '/c/cosmetics?offer=1&cursor=bW9jazoyMA',
    );
  });

  it('writes what it reads back the same', () => {
    // One list, one address: reading a link gives the query that made it
    const query = read('q=হলুদ গুঁড়া&sort=price_asc&min=10&stock=1');
    const href = listingHref(query);
    const url = new URL(href, 'https://shop.example');
    expect(readListingQuery('cosmetics', url.searchParams)).toEqual(query);
  });
});

describe('listingMoreHref', () => {
  it('asks the partial next to the page, with the same address', () => {
    expect(listingMoreHref(read('sort=name'), 'bW9jazoyMA')).toBe(
      '/c/cosmetics/more?sort=name&cursor=bW9jazoyMA',
    );
    expect(listingMoreHref(read('q=neem', null), 'bW9jazoyMA')).toBe(
      '/search/more?q=neem&cursor=bW9jazoyMA',
    );
    expect(listingMoreHref(read('', null), 'bW9jazoyMA')).toBe('/c/all/more?cursor=bW9jazoyMA');
  });
});

describe('hasPanelFilters', () => {
  it('counts the price and the stock, not the sort or the offer', () => {
    expect(hasPanelFilters(read('sort=name&offer=1&q=neem'))).toBe(false);
    expect(hasPanelFilters(read('min=0'))).toBe(true);
    expect(hasPanelFilters(read('max=500'))).toBe(true);
    expect(hasPanelFilters(read('stock=1'))).toBe(true);
  });
});
