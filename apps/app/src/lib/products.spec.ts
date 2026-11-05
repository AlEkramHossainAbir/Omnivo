import type { ProductCategory } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  categoryOptions,
  categoryPath,
  combinations,
  emptyVariant,
  importTemplate,
  splitValues,
  syncVariants,
} from './products';

function category(id: string, name: string, parentId: string | null = null): ProductCategory {
  return { id, parentId, name, productCount: 0, version: 1, updatedAt: '2026-10-04T00:00:00.000Z' };
}

const categories = [
  category('c2', 'Fabrics'),
  category('c1', 'Finished garments'),
  category('c3', 'T-shirts', 'c1'),
  category('c4', 'Polo shirts', 'c1'),
];

describe('categories', () => {
  it('lists them in tree order, indented, without the one being moved', () => {
    expect(categoryOptions(categories).map((option) => option.label)).toEqual([
      'Fabrics',
      'Finished garments',
      ' Polo shirts',
      ' T-shirts',
    ]);
    expect(categoryOptions(categories, 'c1').map((option) => option.value)).toEqual(['c2']);
  });

  it('writes where a category sits', () => {
    expect(categoryPath(categories, 'c3')).toBe('Finished garments › T-shirts');
    expect(categoryPath(categories, null)).toBe('');
  });
});

describe('options and variants', () => {
  it('reads a values box like the API counts values', () => {
    expect(splitValues(' S, M ,, L, m ,XL ')).toEqual(['S', 'M', 'L', 'XL']);
  });

  it('makes every combination, first option first', () => {
    expect(combinations([{ values: ['S', 'M'] }, { values: ['Navy', 'White'] }])).toEqual([
      ['S', 'Navy'],
      ['S', 'White'],
      ['M', 'Navy'],
      ['M', 'White'],
    ]);
    expect(combinations([])).toEqual([[]]);
  });

  it('keeps what a variant holds when the options change', () => {
    const small = { ...emptyVariant(['S']), id: 'v-s', salePrice: '600' };
    const large = { ...emptyVariant(['L']), id: 'v-l' };
    const next = syncVariants([{ values: ['S', 'M'] }], [small, large]);
    expect(next.map((variant) => [variant.id, variant.optionValues])).toEqual([
      ['v-s', ['S']],
      [null, ['M']],
    ]);
    expect(next[0]?.salePrice).toBe('600');
  });

  it('lets a simple product’s one variant become the first combination', () => {
    const only = { ...emptyVariant(), id: 'v-1', barcode: '8941100500118' };
    const next = syncVariants([{ values: ['M', 'L'] }], [only]);
    expect(next.map((variant) => [variant.id, variant.optionValues, variant.barcode])).toEqual([
      ['v-1', ['M'], '8941100500118'],
      [null, ['L'], ''],
    ]);
  });
});

describe('the import template', () => {
  it('has every column, the active custom fields, and quotes what needs quoting', () => {
    const text = importTemplate([
      {
        id: 'f1',
        entity: 'product',
        key: 'gsm',
        label: 'GSM',
        type: 'number',
        options: [],
        required: false,
        archivedAt: null,
        version: 1,
        updatedAt: '2026-10-04T00:00:00.000Z',
      },
      {
        id: 'f2',
        entity: 'product',
        key: 'season',
        label: 'Season',
        type: 'text',
        options: [],
        required: false,
        archivedAt: '2026-10-04T00:00:00.000Z',
        version: 2,
        updatedAt: '2026-10-04T00:00:00.000Z',
      },
    ]);
    const [header, ...rows] = text.replace('\uFEFF', '').trim().split('\r\n');
    expect(header?.startsWith('code,name,type,category,unit')).toBe(true);
    expect(header?.endsWith(',description,cf_gsm')).toBe(true);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('Finished garments > Polo shirts');
  });
});
