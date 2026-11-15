import type { ShopCategory } from '@omnivo/contracts';

// Step 26f: the two things the listing search needs from the shop's category tree. A shop has tens
// of categories, not thousands, so the API reads them all once per request and works these out
// here, the same way the shop's mock does (apps/shop/src/data/mock/browse.ts). The database then
// gets plain id lists, and no recursive query.

// The ids of the category with this slug and of every category under it, at any depth: /c/cosmetics
// shows the face washes of "Skin care" too. An unknown slug gives an empty list, so no cards. A loop
// in the data (A under B under A) cannot hang it: an id already in the set is never added again
export function subtreeIds(slug: string, categories: readonly ShopCategory[]): string[] {
  const top = categories.find((category) => category.slug === slug);
  if (top === undefined) return [];
  const ids = new Set([top.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const category of categories) {
      if (category.parentId !== null && ids.has(category.parentId) && !ids.has(category.id)) {
        ids.add(category.id);
        grew = true;
      }
    }
  }
  return [...ids];
}

// One form for the search's words and the names they are looked for in. NFC: a Bangla letter like
// য় can be typed as one code point or two (য + ়), and both must match. Lower case for English,
// with fixed rules ('en'), so a server set to Turkish would not turn "I" into "ı". Bangla has no
// case. The SQL side compares with lower(name); the shop writes names in NFC (step 26g)
export function fold(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('en');
}

// A search's words: every one must be found, in any field and in any order. Empty: no search
export function searchWords(q: string | null): string[] {
  return q === null
    ? []
    : fold(q)
        .split(/\s+/u)
        .filter((word) => word !== '');
}

// The categories a word finds: those whose name, or the name of a category above them, has the
// word in it. A search for "beverages" then finds the teas under "Beverages > Tea". `seen` stops a
// loop in the data
export function categoriesMatching(word: string, categories: readonly ShopCategory[]): string[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  return categories
    .filter((category) => {
      const seen = new Set<string>();
      let current: ShopCategory | undefined = category;
      while (current !== undefined && !seen.has(current.id)) {
        if (fold(current.name).includes(word)) return true;
        seen.add(current.id);
        current = current.parentId === null ? undefined : byId.get(current.parentId);
      }
      return false;
    })
    .map((category) => category.id);
}
