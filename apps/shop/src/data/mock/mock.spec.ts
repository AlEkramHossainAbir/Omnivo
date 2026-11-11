import {
  publicShopSchema,
  shopCategorySchema,
  shopHomeSchema,
  shopProductPageSchema,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockHome } from './home';
import { mockCatalog, mockProductPage } from './products';
import { mockCategories, mockShop } from './shop';

// `satisfies` checks the shape at compile time, but not what only runtime sees: a price like
// "1,199" is a string to TypeScript and still wrong. The schemas the real API will be checked
// against catch it here, so the mock can never teach the pages something the API won't send.
describe('the mock shop', () => {
  it('matches the public contract', () => {
    expect(() => publicShopSchema.parse(mockShop)).not.toThrow();
    expect(() => shopCategorySchema.array().parse(mockCategories)).not.toThrow();
    expect(() => shopHomeSchema.parse(mockHome)).not.toThrow();
  });

  it('gives every listing a unique id and slug', () => {
    const listings = [
      ...mockHome.featured,
      ...mockHome.blocks.flatMap((block) =>
        block.kind === 'collection' ? block.collection.listings : [],
      ),
    ];
    expect(new Set(listings.map((listing) => listing.id)).size).toBe(listings.length);
    expect(new Set(listings.map((listing) => listing.slug)).size).toBe(listings.length);
  });

  it('puts every listing in a known category', () => {
    const ids = new Set(mockCategories.map((category) => category.id));
    for (const listing of mockHome.featured) expect(ids.has(listing.categoryId)).toBe(true);
  });
});

describe('the mock product pages', () => {
  const now = new Date('2026-11-11T10:00:00+06:00');

  it('has a page for every listing, in the public contract', () => {
    // Every card links to /p/<slug>; a listing without a page would be a 404 in the mock
    expect(new Set(mockCatalog.map((listing) => listing.id)).size).toBe(mockCatalog.length);
    for (const listing of mockCatalog) {
      const page = mockProductPage(listing.slug, now);
      expect(() => shopProductPageSchema.parse(page)).not.toThrow();
      expect(page?.related.map((related) => related.id)).not.toContain(listing.id);
    }
  });

  it('answers null for a slug no listing has', () => {
    expect(mockProductPage('no-such-product', now)).toBeNull();
  });

  it('ends the design’s sale 1 day 12:10:32 after the page is asked for', () => {
    const page = mockProductPage('himalaya-purifying-neem-face-wash-150ml', now);
    expect(page?.product.saleUntil).toBe('2026-11-12T16:10:32.000Z');
    expect(page?.product.images).toHaveLength(4);
  });
});
