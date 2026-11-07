import { publicShopSchema, shopCategorySchema, shopHomeSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockHome } from './home';
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
