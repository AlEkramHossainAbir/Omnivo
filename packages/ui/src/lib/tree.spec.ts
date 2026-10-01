import { describe, expect, it } from 'vitest';

import { buildTree, filterTree, flattenTree } from './tree.js';

interface Row {
  id: string;
  parentId: string | null;
  code: string;
}

const keys = {
  id: (row: Row) => row.id,
  parentId: (row: Row) => row.parentId,
  compare: (a: Row, b: Row) => a.code.localeCompare(b.code),
};

// Out of order on purpose: children before parents, siblings unsorted
const rows: Row[] = [
  { id: 'bank', parentId: 'current', code: '1120' },
  { id: 'cash', parentId: 'current', code: '1110' },
  { id: 'current', parentId: 'assets', code: '1100' },
  { id: 'assets', parentId: null, code: '1000' },
  { id: 'lost', parentId: 'missing', code: '9000' },
];

function codes(nodes: ReturnType<typeof buildTree<Row>>): string[] {
  return flattenTree(nodes).map(({ node, depth }) => `${'-'.repeat(depth)}${node.item.code}`);
}

describe('buildTree', () => {
  it('nests by parent and sorts siblings, whatever the input order', () => {
    expect(codes(buildTree(rows, keys))).toEqual(['1000', '-1100', '--1110', '--1120', '9000']);
  });

  it('puts a node whose parent is not in the list at the top, not nowhere', () => {
    expect(buildTree(rows, keys).map((node) => node.id)).toContain('lost');
  });
});

describe('filterTree', () => {
  it('keeps a match together with the groups above it, and drops its siblings', () => {
    const tree = buildTree(rows, keys);
    expect(codes(filterTree(tree, (row) => row.code === '1120'))).toEqual([
      '1000',
      '-1100',
      '--1120',
    ]);
  });
});
