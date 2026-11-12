import {
  SHOP_SEARCH_MAX_LENGTH,
  SHOP_SORTS,
  type ShopListingQuery,
  type ShopSort,
} from '@omnivo/contracts';

// Step 26d: the category and search pages keep the shopper's choices in the address (decision 2):
// /c/cosmetics?sort=price_asc&min=100&max=500&stock=1&offer=1, and /search?q=neem. This file reads
// that address into the source's query and writes the links that change one choice. Server only:
// the pages call it in their frontmatter, and no browser script imports it (it brings the
// contracts, and with them Zod)

// /c/all: every listing, the page the home page's Load More goes to. Reserved: a category with the
// slug "all" could not have a page of its own
export const ALL_SLUG = 'all';

// The address is typed by people and kept in old links, so it is read leniently: a value that
// makes no sense is dropped (or put right), never an error page. The query that comes out always
// passes shopListingQuerySchema. `category` is the slug from the path, already checked by the page
// against the shop's categories; null for /c/all and /search
export function readListingQuery(
  category: string | null,
  params: URLSearchParams,
): ShopListingQuery {
  let minPrice = readPrice(params.get('min'));
  let maxPrice = readPrice(params.get('max'));
  // "From 500 to 100" means between the two: swapped, not refused (decision 14)
  if (minPrice !== null && maxPrice !== null && Number(minPrice) > Number(maxPrice)) {
    [minPrice, maxPrice] = [maxPrice, minPrice];
  }
  return {
    category,
    q: readSearch(params.get('q')),
    sort: readSort(params.get('sort')),
    minPrice,
    maxPrice,
    // Only "1" switches a filter on, so stock=0 and stock=yes are off and the link builder below
    // has one way to write it
    inStock: params.get('stock') === '1',
    offer: params.get('offer') === '1',
    cursor: readCursor(params.get('cursor')),
  };
}

// An unknown sort ("popular", an old link) is the default, not an error
function readSort(value: string | null): ShopSort {
  return SHOP_SORTS.find((sort) => sort === value) ?? 'newest';
}

// A Bangla keyboard types ০–৯ (the same rule as the cart and the phone code), and a shopper may
// type the grouping they see on the cards ("1,000"). What is left must be whole taka, at most nine
// digits like the schema; then String(Number()) drops leading zeros, so "0500" and "500" are one
// address. "99.50", "-5" and "abc" are dropped: the filter is off, the page still shows
function readPrice(value: string | null): string | null {
  if (value === null) return null;
  const digits = value
    .trim()
    .replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6))
    .replace(/,/g, '');
  return /^\d{1,9}$/.test(digits) ? String(Number(digits)) : null;
}

// Spaces at the ends and runs of spaces inside are one search ("neem  face" is "neem face"), and
// NFC makes a Bangla word typed two ways one address. Too long a search is cut, not dropped: the
// first 100 characters still find what the shopper wanted. Cut by whole characters, so an emoji at
// the edge is never split in half (a broken half cannot be written in a URL)
function readSearch(value: string | null): string | null {
  const text = (value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');
  let kept = '';
  for (const character of text) {
    if (kept.length + character.length > SHOP_SEARCH_MAX_LENGTH) break;
    kept += character;
  }
  kept = kept.trim();
  return kept === '' ? null : kept;
}

// The cursor stays opaque here: only its length is checked, like the schema. A cursor the source
// did not make is the source's to find (it answers null, and the page starts again)
function readCursor(value: string | null): string | null {
  return value !== null && value !== '' && value.length <= 512 ? value : null;
}

// The page of a category, of a search, or of everything. A search without a category is /search;
// with one it stays on the category's page (/c/skin-care?q=neem), so a chip keeps the search
export function listingPath(category: string | null, q: string | null): string {
  if (category !== null) return `/c/${category}`;
  return q === null ? `/c/${ALL_SLUG}` : '/search';
}

// A link to the same list with some choices changed (a chip, a sort, a filter). The cursor goes
// unless the change sets it (Load More): the next page of an old sort is not a page of the new one.
// Defaults are left out and the keys always come in one order, so one list has one address, which
// matters for the browser's history and for caches
export function listingHref(
  query: ShopListingQuery,
  change: Partial<ShopListingQuery> = {},
): string {
  const next: ShopListingQuery = { ...query, cursor: null, ...change };
  const params = new URLSearchParams();
  if (next.q !== null) params.set('q', next.q);
  if (next.sort !== 'newest') params.set('sort', next.sort);
  if (next.minPrice !== null) params.set('min', next.minPrice);
  if (next.maxPrice !== null) params.set('max', next.maxPrice);
  if (next.inStock) params.set('stock', '1');
  if (next.offer) params.set('offer', '1');
  if (next.cursor !== null) params.set('cursor', next.cursor);
  const search = params.toString();
  return `${listingPath(next.category, next.q)}${search === '' ? '' : `?${search}`}`;
}

// Step 26d.3: where Load More's script asks for the next cards: the partial next to the page
// (/c/cosmetics/more, /search/more) with the same address. The page writes both links, so the
// script needs no URL rules of its own and never imports this file
export function listingMoreHref(query: ShopListingQuery, cursor: string): string {
  const href = listingHref(query, { cursor });
  const [path = '', search = ''] = href.split('?');
  return `${path}/more?${search}`;
}

// Step 26d.3: whether a filter of "All Filter" is on, for the chip's look and the empty state's
// "Clear filters". Offer is not one: it has its own chip
export function hasPanelFilters(query: ShopListingQuery): boolean {
  return query.minPrice !== null || query.maxPrice !== null || query.inStock;
}
