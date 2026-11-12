import {
  compareMoney,
  SHOP_PAGE_SIZE,
  shopListingPageSchema,
  type ShopListing,
  type ShopListingPage,
  type ShopListingQuery,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, listListings } from './browse';
import { mockHome } from './home';
import { mockBrowseContext } from './mock-source';
import { mockCatalog } from './products';

const ALL: ShopListingQuery = {
  category: null,
  q: null,
  sort: 'newest',
  minPrice: null,
  maxPrice: null,
  inStock: false,
  offer: false,
  cursor: null,
};

function page(change: Partial<ShopListingQuery> = {}): ShopListingPage {
  const answer = listListings({ ...ALL, ...change }, mockBrowseContext);
  if (answer === null) throw new Error('the mock refused its own query');
  return answer;
}

// Every card of a list, page after page, as Load More would get them
function everything(change: Partial<ShopListingQuery> = {}): ShopListing[] {
  const cards: ShopListing[] = [];
  let cursor: string | null = null;
  do {
    const next = page({ ...change, cursor });
    expect(() => shopListingPageSchema.parse(next)).not.toThrow();
    cards.push(...next.items);
    cursor = next.nextCursor;
  } while (cursor !== null);
  return cards;
}

function slugs(listings: ShopListing[]): string[] {
  return listings.map((listing) => listing.slug);
}

describe('the mock shelves', () => {
  it('pages through every listing once, 20 at a time, newest first', () => {
    const first = page();
    expect(first.items).toHaveLength(SHOP_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    // 62 listings: more than three pages, so Load More is on the page twice and then goes
    expect(everything()).toEqual(mockCatalog);
  });

  it('starts /c/all with the home page’s grid', () => {
    // The home page's Load More goes to /c/all: the shopper sees the same five cards first
    expect(page().items.slice(0, mockHome.featured.length)).toEqual(mockHome.featured);
    expect(mockHome.hasMoreFeatured).toBe(mockCatalog.length > mockHome.featured.length);
  });

  it('shows a category with every category under it', () => {
    const cosmetics = everything({ category: 'cosmetics' });
    const categories = new Set(cosmetics.map((listing) => listing.categoryId));
    expect(categories).toEqual(new Set(['cat-skin-care', 'cat-hair-care']));
    expect(slugs(everything({ category: 'beverages' }))).toContain('seylon-family-blend-tea-1kg');
    expect(everything({ category: 'tea' }).every((l) => l.categoryId === 'cat-tea')).toBe(true);
  });

  it('shows nothing for a slug no category has', () => {
    expect(page({ category: 'no-such-category' })).toEqual({ items: [], nextCursor: null });
  });
});

describe('the mock search', () => {
  it('finds a word in any case, in the name, the category or the SKU', () => {
    expect(slugs(everything({ q: 'NEEM' }))).toEqual([
      'himalaya-purifying-neem-face-wash-150ml',
      'himalaya-purifying-neem-face-wash-50ml',
      'himalaya-purifying-neem-face-wash-100ml',
    ]);
    // A category above the listing's own: the teas are beverages
    expect(slugs(everything({ q: 'beverages' }))).toContain('ispahani-mirzapore-bestleaf-400gm');
    expect(slugs(everything({ q: 'md2346' }))).toEqual(['himalaya-purifying-neem-face-wash-150ml']);
  });

  it('needs every word, in any order', () => {
    expect(everything({ q: 'wash neem' })).toHaveLength(3);
    expect(everything({ q: 'neem shampoo' })).toEqual([]);
  });

  it('finds Bangla, however য় was typed', () => {
    expect(slugs(everything({ q: 'নিম' }))).toEqual(['himalaya-purifying-neem-face-wash-200ml']);
    const found = slugs(everything({ q: 'ফেসওয়াশ' }));
    expect(slugs(everything({ q: 'ফেসওয়াশ' }))).toEqual(found);
    expect(found).toEqual(['himalaya-purifying-neem-face-wash-200ml']);
  });
});

describe('the mock filters', () => {
  it('leaves out what is not in stock', () => {
    const cards = everything({ inStock: true });
    expect(cards.every((listing) => listing.inStock)).toBe(true);
    expect(cards.length).toBeLessThan(mockCatalog.length);
  });

  it('keeps only offers: a ribbon or a struck-out price', () => {
    const cards = everything({ offer: true, category: 'hair-care' });
    expect(cards.every((l) => l.discount !== null || l.compareAtPrice !== null)).toBe(true);
    expect(slugs(cards)).toContain('tresemme-hair-fall-defense-1ltr');
    expect(slugs(cards)).not.toContain('tresemme-keratin-smooth-shampoo-580ml');
  });

  it('filters on the price paid, paisa and all', () => {
    // ৳339.50 is over ৳339 and under ৳340
    expect(slugs(everything({ minPrice: '339', maxPrice: '340' }))).toEqual([
      'zero-cal-stevia-100-sachets',
    ]);
    expect(everything({ minPrice: '340', maxPrice: '340' })).toEqual([]);
    // As numbers: as text, "1199" is between "100" and "500" (it starts with "1")
    const cards = everything({ minPrice: '100', maxPrice: '500' });
    expect(slugs(cards)).not.toContain('davidoff-espresso-coffee');
    expect(cards).toEqual(
      mockCatalog.filter(
        (l) => compareMoney(l.price, '100') >= 0 && compareMoney(l.price, '500') <= 0,
      ),
    );
    // Both ends count: ৳50 is between ৳50 and ৳50
    expect(slugs(everything({ minPrice: '50', maxPrice: '50' }))).toEqual([
      'sprite-cold-drink-500ml',
    ]);
  });
});

describe('the mock sorts', () => {
  it('sorts by price, the newest first among equal prices', () => {
    const up = everything({ sort: 'price_asc' });
    for (let i = 1; i < up.length; i += 1) {
      const [before, after] = [up[i - 1], up[i]];
      if (before === undefined || after === undefined) throw new Error('a hole in the list');
      expect(compareMoney(before.price, after.price)).toBeLessThanOrEqual(0);
    }
    // ৳99 twice: the Lemon 50ml is newer in the catalog than the Neem 50ml
    const at99 = slugs(up.filter((listing) => listing.price === '99'));
    expect(at99).toEqual(slugs(mockCatalog.filter((listing) => listing.price === '99')));
    expect(slugs(everything({ sort: 'price_desc' }))[0]).toBe('pusti-plus-full-cream-milk-2-5kg');
  });

  it('sorts names as people read them', () => {
    const names = everything({ sort: 'name', q: 'stevia' }).map((listing) => listing.name);
    // 30 before 100 before 200 (as text, "100" < "200" < "30")
    expect(names).toEqual([
      'Zero Cal Stevia 30 Sachets',
      'Zero Cal Stevia 30 Sachets, gift box',
      'Zero Cal Stevia 100 Sachets',
      'Zero Cal Stevia 200 Sachets',
    ]);
  });
});

describe('the mock cursor', () => {
  it('reads back what it wrote, and nothing else', () => {
    expect(decodeCursor(encodeCursor(20))).toBe(20);
    // base64url: no "+", "/" or "=" to escape in an address
    expect(encodeCursor(40)).toMatch(/^[\w-]+$/);
    for (const broken of ['abc', '%%%', btoa('mock:0'), btoa('mock:-20'), btoa('other:20')]) {
      expect(decodeCursor(broken)).toBeNull();
    }
  });

  it('answers null for a cursor it did not make, and an empty page past the end', () => {
    expect(listListings({ ...ALL, cursor: 'not-ours' }, mockBrowseContext)).toBeNull();
    expect(page({ cursor: encodeCursor(1000) })).toEqual({ items: [], nextCursor: null });
  });
});
