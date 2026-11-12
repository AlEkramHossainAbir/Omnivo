import type { ShopCategory } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { categoryPath, categoryTree, type CategoryNode } from './category-tree';

function category(id: string, parentId: string | null = null): ShopCategory {
  return { id, slug: id, name: id, parentId };
}

// The tree as nested ids, so a failure shows its shape at a glance
type Shape = [string, Shape[]];
function shape(nodes: CategoryNode[]): Shape[] {
  return nodes.map((node) => [node.category.id, shape(node.children)]);
}

describe('categoryTree', () => {
  it('puts each category under its parent, in the list order', () => {
    const tree = categoryTree([
      category('food'),
      category('tea', 'drinks'),
      category('drinks'),
      category('green-tea', 'tea'),
      category('coffee', 'drinks'),
    ]);
    expect(shape(tree)).toEqual([
      ['food', []],
      [
        'drinks',
        [
          ['tea', [['green-tea', []]]],
          ['coffee', []],
        ],
      ],
    ]);
  });

  it('leaves out a category whose parent is not in the list', () => {
    expect(shape(categoryTree([category('food'), category('tea', 'drinks')]))).toEqual([
      ['food', []],
    ]);
  });

  it('ends on a loop in the data', () => {
    const tree = categoryTree([category('food'), category('a', 'b'), category('b', 'a')]);
    expect(shape(tree)).toEqual([['food', []]]);
  });

  it('answers an empty tree for no categories', () => {
    expect(categoryTree([])).toEqual([]);
  });
});

describe('categoryPath', () => {
  const categories = [
    category('drinks'),
    category('tea', 'drinks'),
    category('green-tea', 'tea'),
    category('food'),
  ];

  it('lists the categories above one, top first, and the one itself last', () => {
    expect(categoryPath(categories, 'green-tea')).toEqual(['drinks', 'tea', 'green-tea']);
  });

  it('is the category alone for a top category', () => {
    expect(categoryPath(categories, 'food')).toEqual(['food']);
  });

  it('is empty for no slug or one no category has', () => {
    expect(categoryPath(categories, null)).toEqual([]);
    expect(categoryPath(categories, 'all')).toEqual([]);
  });

  it('ends on a loop in the data', () => {
    expect(categoryPath([category('a', 'b'), category('b', 'a')], 'a')).toEqual(['b', 'a']);
  });
});
