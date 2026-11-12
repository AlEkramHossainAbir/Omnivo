import {
  compareMoney,
  SHOP_PAGE_SIZE,
  type ShopCategory,
  type ShopListing,
  type ShopListingPage,
  type ShopListingQuery,
  type ShopSort,
} from '@omnivo/contracts';

// Step 26d: the mock's category and search pages, worked out the way the real API will: filter,
// sort, then cut one page. What the mock reads, in one object like QuoteContext, so a test can give
// it a small catalog of its own
export interface BrowseContext {
  // Newest first (products.ts). "Newest" keeps this order
  catalog: ShopListing[];
  categories: ShopCategory[];
  // SKUs by listing id: a card has no SKU, but the search looks in it
  skus: ReadonlyMap<string, string>;
}

// The mock's cursor is the number of cards already shown, in base64url like the API's cursors. The
// prefix tells the mock's own cursors from anything else: a cursor is opaque (pagination.ts), so a
// page must never learn to read or make one, and an edited one must not land on a random offset
const CURSOR = /^mock:([1-9]\d{0,5})$/;

export function encodeCursor(offset: number): string {
  return btoa(`mock:${String(offset)}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// null: not a cursor this mock made (edited by hand, or from an older source)
export function decodeCursor(cursor: string): number | null {
  let text: string;
  try {
    text = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    // atob throws on characters that are not base64 ("%", "!")
    return null;
  }
  const match = CURSOR.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

// The ids of a category and of every category under it, at any depth (decision 16): /c/cosmetics
// shows the face washes of Skin care too. An unknown slug gives no ids, so no cards; the page answers
// 404 before it asks (26d.3), so this only matters to a caller that skipped that
function categoryIds(slug: string, categories: ShopCategory[]): Set<string> {
  const top = categories.find((category) => category.slug === slug);
  const ids = new Set<string>(top === undefined ? [] : [top.id]);
  // Add children until a round adds none. A loop in the data (A under B under A) stops too, because
  // an id already in the set is never added again
  let grew = ids.size > 0;
  while (grew) {
    grew = false;
    for (const category of categories) {
      if (category.parentId !== null && ids.has(category.parentId) && !ids.has(category.id)) {
        ids.add(category.id);
        grew = true;
      }
    }
  }
  return ids;
}

// One form for the text and the words. NFC: a Bangla letter like য় can be typed as one code point
// or as two (য + ়), and both must match. Lower case for English; Bangla has no case, so it is
// unchanged. 'en' fixes the rules, so a server in Turkey would not turn "I" into "ı"
function fold(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('en');
}

// Each category's name with the names of every category above it ("Tea", "Beverages"), by id: a
// search for "beverages" finds the teas. Worked out once per call, not once per card. `seen` stops a
// loop in the data (A under B under A)
function categoryTrails(categories: ShopCategory[]): Map<string, string[]> {
  const byId = new Map(categories.map((category) => [category.id, category]));
  return new Map(
    categories.map((category) => {
      const names: string[] = [];
      const seen = new Set<string>();
      let current: ShopCategory | undefined = category;
      while (current !== undefined && !seen.has(current.id)) {
        seen.add(current.id);
        names.push(current.name);
        current = current.parentId === null ? undefined : byId.get(current.parentId);
      }
      return [category.id, names];
    }),
  );
}

// A search's words, folded. Every word must be found, in any field and any order: "face neem"
// finds "Neem Face Wash". null: no search
function searchWords(q: string | null): string[] | null {
  return q === null
    ? null
    : fold(q)
        .split(/\s+/u)
        .filter((word) => word !== '');
}

function matches(
  listing: ShopListing,
  query: ShopListingQuery,
  words: string[] | null,
  trails: Map<string, string[]>,
  skus: ReadonlyMap<string, string>,
): boolean {
  if (query.inStock && !listing.inStock) return false;
  // On sale: a ribbon, or a struck-out price. Either one is what the shopper sees as an offer
  if (query.offer && listing.discount === null && listing.compareAtPrice === null) return false;
  // compareMoney, never Number or a string compare: a price may have paisa ("339.50")
  if (query.minPrice !== null && compareMoney(listing.price, query.minPrice) < 0) return false;
  if (query.maxPrice !== null && compareMoney(listing.price, query.maxPrice) > 0) return false;
  if (words !== null) {
    // The name, the category trail and the SKU, joined with a line break: no word holds one after
    // the split, so a word never matches across two fields
    const text = fold(
      [listing.name, ...(trails.get(listing.categoryId) ?? []), skus.get(listing.id) ?? ''].join(
        '\n',
      ),
    );
    if (!words.every((word) => text.includes(word))) return false;
  }
  return true;
}

// numeric: "Zero Cal Stevia 30 Sachets" comes before "… 100 Sachets"
const NAME_ORDER = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

// A Record, not a switch: a sort added to SHOP_SORTS without an order here fails the type check.
// Equal prices or names keep the newest first: the matches come in catalog order and
// Array.prototype.sort is stable, so 'newest' needs no work at all
const ORDERS: Record<ShopSort, (a: ShopListing, b: ShopListing) => number> = {
  newest: () => 0,
  price_asc: (a, b) => compareMoney(a.price, b.price),
  price_desc: (a, b) => compareMoney(b.price, a.price),
  name: (a, b) => NAME_ORDER.compare(a.name, b.name),
};

// One page of cards. null: the cursor is not one this mock made, so the page sends the shopper to
// the first page (26d.3). A cursor past the end is a real cursor of a list that got shorter: an
// empty last page, not an error
export function listListings(
  query: ShopListingQuery,
  context: BrowseContext,
): ShopListingPage | null {
  const offset = query.cursor === null ? 0 : decodeCursor(query.cursor);
  if (offset === null) return null;

  const ids = query.category === null ? null : categoryIds(query.category, context.categories);
  const words = searchWords(query.q);
  const trails = categoryTrails(context.categories);
  // filter() makes a new array, so sort() never reorders the catalog itself
  const found = context.catalog
    .filter((listing) => ids === null || ids.has(listing.categoryId))
    .filter((listing) => matches(listing, query, words, trails, context.skus))
    .sort(ORDERS[query.sort]);

  const end = offset + SHOP_PAGE_SIZE;
  return {
    items: found.slice(offset, end),
    nextCursor: end < found.length ? encodeCursor(end) : null,
  };
}
