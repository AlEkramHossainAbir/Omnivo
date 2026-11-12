import type { ShopCategory } from '@omnivo/contracts';

// Step 26d.4: the shop's categories as a tree, for the category drawer. The source answers a flat
// list (each category names its parent); the drawer draws nested lists, so it needs each one's
// children in hand. A plain function with no imports but a type, so the tests need no source.

export interface CategoryNode {
  category: ShopCategory;
  children: CategoryNode[];
}

// Top categories first, each with the ones under it, at any depth (a real shop may have Beverages →
// Tea → Green tea). The list's own order is kept at every level: it is the shop's order.
// A category whose parent is not in the list is left out: the source answers only categories the
// shop shows, so its parent was hidden, and a hidden parent hides what is under it.
// The tree is built from the top down, so a loop in the data (A under B, B under A) can never be
// reached from a top category and cannot make this run forever
export function categoryTree(categories: ShopCategory[]): CategoryNode[] {
  const byParent = new Map<string | null, ShopCategory[]>();
  for (const category of categories) {
    const siblings = byParent.get(category.parentId);
    if (siblings) siblings.push(category);
    else byParent.set(category.parentId, [category]);
  }

  const build = (parentId: string | null): CategoryNode[] =>
    (byParent.get(parentId) ?? []).map((category) => ({
      category,
      children: build(category.id),
    }));

  return build(null);
}

// The ids of the categories above the one with this slug, top first, and its own id last. The
// drawer opens these groups, so the list on screen is in view when the drawer opens. Empty when no
// category has the slug (/c/all, /search, a page that is not a list)
export function categoryPath(categories: ShopCategory[], slug: string | null): string[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const path: string[] = [];
  let category = categories.find((candidate) => candidate.slug === slug);
  // A path is never longer than the list: in a loop in the data, the walk ends there instead of
  // spinning
  while (category && path.length < categories.length) {
    path.unshift(category.id);
    category = category.parentId === null ? undefined : byId.get(category.parentId);
  }
  return path;
}
