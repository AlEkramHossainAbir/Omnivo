import type { ShopCategory, ShopListingPage, ShopListingQuery } from '@omnivo/contracts';

import { shopSource } from '../data/source';
import type { ShopSource } from '../data/types';
import { ALL_SLUG, listingHref, readListingQuery } from './listing-query';

// Step 26d.3: what the category page, the search page and their Load More partials do first, in
// one place, so the four agree. Server only, like listing-query.ts

// What the page does next. A union, so a page cannot draw a list it did not get
export type ListingLoad =
  // No category has this slug: the page answers 404, like an unknown product
  | { kind: 'missing' }
  // The address cannot be shown as it is; this one can (decision 17, and /search without words)
  | { kind: 'restart'; href: string }
  | {
      kind: 'found';
      query: ShopListingQuery;
      page: ShopListingPage;
      // null on /c/all and /search
      category: ShopCategory | null;
      // Every category, for the filter row's chips and menus
      categories: ShopCategory[];
    };

// `slug` is the path's: a category's slug, 'all' for every listing, or null on /search. The
// source is a parameter for the tests, which use a mock source of their own
export async function loadListing(
  slug: string | null,
  params: URLSearchParams,
  source: ShopSource = shopSource,
): Promise<ListingLoad> {
  const categories = await source.categories();
  let category: ShopCategory | null = null;
  if (slug !== null && slug !== ALL_SLUG) {
    category = categories.find((candidate) => candidate.slug === slug) ?? null;
    if (category === null) return { kind: 'missing' };
  }

  const query = readListingQuery(category?.slug ?? null, params);
  // /search with no words (an empty box, or "q=   "): every listing, with the other choices kept.
  // listingHref writes /c/all for a query with no category and no search
  if (slug === null && query.q === null) return { kind: 'restart', href: listingHref(query) };

  const page = await source.listings(query);
  // A cursor the source did not make: the same list from its first page. listingHref drops the
  // cursor, so the next request cannot land here again. An empty page after a cursor too: the
  // cards it pointed past were taken off the shop since, and "No products here yet" would be
  // wrong about the list
  if (page === null || (page.items.length === 0 && query.cursor !== null)) {
    return { kind: 'restart', href: listingHref(query) };
  }

  return { kind: 'found', query, page, category, categories };
}
