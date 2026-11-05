// A flat list with parent ids → a tree, for TreeList. Pure functions, so they are tested alone
// (tree.spec.ts) and any app list with a parent (accounts now, product categories in step 12) can
// use them.
export interface TreeNode<T> {
  id: string;
  item: T;
  children: TreeNode<T>[];
}

interface TreeKeys<T> {
  id: (item: T) => string;
  parentId: (item: T) => string | null;
  // The order of siblings
  compare: (a: T, b: T) => number;
}

export function buildTree<T>(items: readonly T[], keys: TreeKeys<T>): TreeNode<T>[] {
  // Map<…, TreeNode<T>>: the type makes `children: []` a list of nodes — no cast needed
  const nodes = new Map<string, TreeNode<T>>(
    items.map((item) => [keys.id(item), { id: keys.id(item), item, children: [] }]),
  );
  const roots: TreeNode<T>[] = [];
  for (const node of nodes.values()) {
    const parentId = keys.parentId(node.item);
    const parent = parentId === null ? undefined : nodes.get(parentId);
    // A parent that is not in the list (filtered out) makes the node a root: nothing the caller
    // passed in ever disappears silently
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: TreeNode<T>[]): TreeNode<T>[] => {
    list.sort((a, b) => keys.compare(a.item, b.item));
    for (const node of list) sort(node.children);
    return list;
  };
  return sort(roots);
}

// Keeps a node when it matches or when something under it does — a search result stays inside
// its groups, so you still see where it sits. A kept group keeps only its kept children.
export function filterTree<T>(
  nodes: readonly TreeNode<T>[],
  keep: (item: T) => boolean,
): TreeNode<T>[] {
  return nodes.flatMap((node) => {
    const children = filterTree(node.children, keep);
    return keep(node.item) || children.length > 0 ? [{ ...node, children }] : [];
  });
}

// Every node, parents before their children — the order the tree shows them in
export function flattenTree<T>(
  nodes: readonly TreeNode<T>[],
  depth = 0,
): { node: TreeNode<T>; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children, depth + 1)]);
}
