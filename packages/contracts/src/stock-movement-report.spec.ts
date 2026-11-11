import { describe, expect, it } from 'vitest';

import {
  isStockValueSort,
  STOCK_MOVEMENT_COLUMN_OF,
  stockMovementFilterSchema,
} from './stock-movement-report.js';
import { MOVEMENT_KINDS } from './stock.js';

describe('the stock movement report', () => {
  it('puts a return in the column of what it undoes', () => {
    expect(STOCK_MOVEMENT_COLUMN_OF.sales_return).toBe('sold');
    expect(STOCK_MOVEMENT_COLUMN_OF.pos_return).toBe('sold');
    expect(STOCK_MOVEMENT_COLUMN_OF.purchase_return).toBe('purchased');
  });

  it('leaves only the revaluation out of the quantity columns', () => {
    expect(MOVEMENT_KINDS.filter((kind) => STOCK_MOVEMENT_COLUMN_OF[kind] === null)).toEqual([
      'revaluation',
    ]);
  });

  it('starts with what moved, sorted by name', () => {
    expect(stockMovementFilterSchema.parse({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      show: 'moved',
      sort: 'name',
    });
  });

  it('refuses a period that ends before it starts', () => {
    expect(
      stockMovementFilterSchema.safeParse({ from: '2026-10-31', to: '2026-10-01' }).error?.issues[0]
        ?.message,
    ).toBe('report_range_invalid');
  });

  it('knows which sorts read the value', () => {
    expect(isStockValueSort('-closingValue')).toBe(true);
    expect(isStockValueSort('closing')).toBe(false);
  });
});
