import type { ShopCategory } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { categoriesMatching, searchWords, subtreeIds } from './categories.js';

function category(id: string, name: string, parentId: string | null = null): ShopCategory {
  return { id, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, parentId };
}

const TREE = [
  category('c1', 'Cosmetics'),
  category('c2', 'Skin care', 'c1'),
  category('c3', 'Face wash', 'c2'),
  category('c4', 'Beverages'),
  category('c5', 'Tea', 'c4'),
  category('c6', 'চা পাতা', 'c4'),
];

describe('subtreeIds', () => {
  it('takes the category and everything under it', () => {
    expect(subtreeIds('cosmetics', TREE).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(subtreeIds('tea', TREE)).toEqual(['c5']);
  });

  it('gives no ids for an unknown slug, and stops on a loop in the data', () => {
    expect(subtreeIds('toys', TREE)).toEqual([]);
    const loop = [category('a', 'A', 'b'), category('b', 'B', 'a')];
    expect(subtreeIds('a', loop).sort()).toEqual(['a', 'b']);
  });
});

describe('search words', () => {
  it('splits, folds and drops empty words', () => {
    expect(searchWords('  Neem   FACE ')).toEqual(['neem', 'face']);
    expect(searchWords(null)).toEqual([]);
  });

  it('finds the categories under a matching name, in English and in Bangla', () => {
    expect(categoriesMatching('beverages', TREE).sort()).toEqual(['c4', 'c5', 'c6']);
    expect(categoriesMatching('চা', TREE)).toEqual(['c6']);
    expect(categoriesMatching('toys', TREE)).toEqual([]);
  });

  it('matches a Bangla word typed in its other form', () => {
    // য় as one code point (U+09DF) in the name, as য + ় (U+09AF U+09BC) in the search
    const tree = [category('d1', 'মিষ্টি দইয়')];
    const [word] = searchWords('দইয়');
    expect(word).toBeDefined();
    expect(categoriesMatching(word ?? '', tree)).toEqual(['d1']);
  });
});
