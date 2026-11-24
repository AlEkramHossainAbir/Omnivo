import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import {
  compareMoney,
  createStorefrontCategoryInputSchema,
  createStorefrontCollectionInputSchema,
  createStorefrontSettingsInputSchema,
  createStorefrontBannerInputSchema,
  listingPricing,
  renderSections,
  saveStorefrontHeroInputSchema,
  saveStorefrontPageInputSchema,
  SHOP_TEXT_PAGES,
  STOREFRONT_COLLECTION_ITEMS_MAX,
  STOREFRONT_IMAGES_MAX,
  updateStorefrontListingInputSchema,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockCatalog } from '../src/data/mock/products';
import {
  heroBody,
  listingBody,
  megaSaleBody,
  seedCategories,
  seedCollections,
  seedListings,
  seedPhotos,
  settingsBody,
} from './seed-plan';
import { PAGES } from './seed-words';

// Step 26h: the seed's plan, checked without an API. Every body is parsed with the schema of
// its route, so a mistake shows here as a field name, not as a 400 halfway through a seed run
// against the dev stack. The prices are checked with the shop's own pricing (listingPricing):
// the real shop must show what the mock shows.

const NOW = new Date('2026-11-17T04:00:00Z');
const listings = seedListings(NOW);
const photos = seedPhotos(listings);
// Every file gets a made-up id, as the seed gets real ones from the uploads
const photoIds = new Map(photos.map((photo) => [photo.url, randomUUID()]));

// The same amount, whatever its decimals: the pricing answers "229.0000" for the mock's "229"
function sameMoney(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return compareMoney(a, b) === 0;
}

describe('the listings', () => {
  it('are the mock catalog, each once', () => {
    expect(listings).toHaveLength(mockCatalog.length);
    expect(new Set(listings.map((listing) => listing.slug)).size).toBe(listings.length);
  });

  it('each pass the editor contract', () => {
    for (const listing of listings) {
      const body = listingBody(listing, 1, randomUUID(), photoIds);
      const parsed = updateStorefrontListingInputSchema.safeParse(body);
      expect(parsed.error?.issues, listing.slug).toBeUndefined();
      // The slug stays the mock's, so the mock's links work on the real shop
      expect(parsed.data?.slug).toBe(listing.slug);
    }
  });

  it('show the mock price, and its struck-out price when it has one', () => {
    for (const listing of listings) {
      const mock = mockCatalog.find((candidate) => candidate.slug === listing.slug);
      const shown = listingPricing(listing.regularPrice, listing.sale, NOW);
      if (mock?.discount?.kind === 'percent' && mock.compareAtPrice === null) {
        // A percent ribbon is a percent sale on the mock's price: same ribbon, lower price
        expect(shown.discount, listing.slug).toEqual(mock.discount);
        continue;
      }
      expect(sameMoney(shown.price, mock?.price), `${listing.slug} price`).toBe(true);
      expect(
        sameMoney(shown.compareAtPrice, mock?.compareAtPrice),
        `${listing.slug} struck out`,
      ).toBe(true);
    }
  });

  it('give the design product its two photos once, its SKU, a description and a sale that ends', () => {
    const neem = listings.find(
      (listing) => listing.slug === 'himalaya-purifying-neem-face-wash-150ml',
    );
    expect(neem?.photos).toHaveLength(2);
    expect(neem?.sku).toBe('MD2346');
    expect(neem?.descriptionSections.length).toBeGreaterThan(0);
    expect(neem?.sale?.endsAt).not.toBeNull();
    for (const listing of listings)
      expect(listing.photos.length).toBeLessThanOrEqual(STOREFRONT_IMAGES_MAX);
  });

  it('put no stock on the ones the mock shows out of stock', () => {
    const out = listings.filter((listing) => listing.stock === null).map((listing) => listing.slug);
    expect(out).toEqual(
      mockCatalog.filter((listing) => !listing.inStock).map((listing) => listing.slug),
    );
  });
});

describe('the photos', () => {
  it('are files in public/, each once', () => {
    expect(new Set(photos.map((photo) => photo.url)).size).toBe(photos.length);
    for (const photo of photos) expect(existsSync(photo.file), photo.file).toBe(true);
  });
});

describe('the shop', () => {
  it('settings pass the first save', () => {
    const parsed = createStorefrontSettingsInputSchema.safeParse(
      settingsBody('demo-shop', randomUUID()),
    );
    expect(parsed.error?.issues).toBeUndefined();
  });

  it('settings ask for Cash on Delivery only (Pay online needs a saved gateway, step 27d)', () => {
    expect(settingsBody('demo-shop', randomUUID()).paymentMethods).toEqual(['cod']);
  });

  it('categories come after their parent and pass the form', () => {
    const made = new Set<string>();
    for (const category of seedCategories) {
      if (category.parentId !== null) expect(made.has(category.parentId), category.slug).toBe(true);
      made.add(category.id);
      const parsed = createStorefrontCategoryInputSchema.safeParse({
        parentId: category.parentId === null ? '' : randomUUID(),
        name: category.name,
        slug: category.slug,
      });
      expect(parsed.error?.issues, category.slug).toBeUndefined();
    }
  });

  it('hero and Mega Sale pass their contracts, contrast included', () => {
    expect(
      saveStorefrontHeroInputSchema.safeParse(heroBody(photoIds)).error?.issues,
    ).toBeUndefined();
    expect(
      createStorefrontBannerInputSchema.safeParse(megaSaleBody(photoIds)).error?.issues,
    ).toBeUndefined();
  });

  it('collections are the mock rows of listings the seed makes', () => {
    const slugs = new Set(listings.map((listing) => listing.slug));
    expect(seedCollections.map((collection) => collection.title)).toEqual([
      'Refresh with Himalaya',
      'Hot & Trending Right Now',
      'Diabetic Corner',
    ]);
    for (const collection of seedCollections) {
      expect(collection.slugs.length).toBeLessThanOrEqual(STOREFRONT_COLLECTION_ITEMS_MAX);
      for (const slug of collection.slugs) expect(slugs.has(slug), slug).toBe(true);
      const parsed = createStorefrontCollectionInputSchema.safeParse({
        title: collection.title,
        icon: collection.icon,
        listingIds: collection.slugs.map(() => randomUUID()),
      });
      expect(parsed.error?.issues, collection.title).toBeUndefined();
    }
  });

  it('pages are all four, and their lists and links come out as HTML', () => {
    for (const slug of SHOP_TEXT_PAGES) {
      const parsed = saveStorefrontPageInputSchema.safeParse({
        version: null,
        sections: PAGES[slug],
      });
      expect(parsed.error?.issues, slug).toBeUndefined();
    }
    expect(renderSections(PAGES.terms)).toContain(
      '<li><strong>Inside Dhaka:</strong> 1 to 2 days, ৳80.</li>',
    );
    expect(renderSections(PAGES.contact)).toContain('<a href="/track">Track Order</a>');
  });
});
