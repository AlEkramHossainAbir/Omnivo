import { describe, expect, it } from 'vitest';

import {
  costColumns,
  isCostSort,
  purchaseReportFilterSchema,
  purchaseReportQuerySchema,
  salesReportQuerySchema,
  salesReportSchema,
} from './trade-reports.js';

describe('the sales report query', () => {
  it('starts by customer, the largest net first, 50 rows a page', () => {
    expect(salesReportQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      groupBy: 'customer',
      sort: '-net',
      limit: 50,
    });
  });

  it('refuses a period that ends before it starts, under To', () => {
    const result = salesReportQuerySchema.safeParse({ from: '2026-10-31', to: '2026-10-01' });
    expect(result.error?.issues[0]).toMatchObject({
      path: ['to'],
      message: 'report_range_invalid',
    });
  });

  it('sorts by quantity only by product', () => {
    const byCustomer = salesReportQuerySchema.safeParse({
      from: '2026-10-01',
      to: '2026-10-31',
      sort: '-quantity',
    });
    expect(byCustomer.error?.issues[0]).toMatchObject({
      path: ['sort'],
      message: 'report_sort_invalid',
    });
    expect(
      salesReportQuerySchema.safeParse({
        from: '2026-10-01',
        to: '2026-10-31',
        groupBy: 'product',
        sort: '-quantity',
      }).success,
    ).toBe(true);
  });

  it('knows the sorts that read the cost', () => {
    expect(isCostSort('-marginPercent')).toBe(true);
    expect(isCostSort('cost')).toBe(true);
    expect(isCostSort('-net')).toBe(false);
  });
});

describe('the purchase report query', () => {
  it('starts by supplier, and keeps the same checks with or without the page', () => {
    expect(purchaseReportQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31' })).toMatchObject(
      { groupBy: 'supplier', sort: '-net' },
    );
    const result = purchaseReportFilterSchema.safeParse({
      from: '2026-10-01',
      to: '2026-10-31',
      groupBy: 'account',
      sort: 'quantity',
    });
    expect(result.error?.issues[0]?.message).toBe('report_sort_invalid');
  });

  it('leaves the page out of an export', () => {
    const filter = purchaseReportFilterSchema.parse({
      from: '2026-10-01',
      to: '2026-10-31',
      limit: 20,
      cursor: 'abc',
    });
    expect(filter).not.toHaveProperty('limit');
    expect(filter).not.toHaveProperty('cursor');
  });
});

describe('costColumns', () => {
  it('works out the margin and its percent from the net and the cost', () => {
    // Napa 500 mg in October: ৳1,20,000 sold, ৳93,000 cost
    expect(costColumns('120000.0000', '93000.0000')).toEqual({
      cost: '93000.0000',
      margin: '27000.0000',
      marginPercent: '22.5',
    });
  });

  it('has a margin but no percent when the net is zero, and nothing without the cost', () => {
    // Sold and all of it came back, after the cost of a broken strip was written off
    expect(costColumns('0.0000', '150.0000')).toEqual({
      cost: '150.0000',
      margin: '-150.0000',
      marginPercent: null,
    });
    expect(costColumns('120000.0000', null)).toEqual({
      cost: null,
      margin: null,
      marginPercent: null,
    });
  });
});

describe('salesReportSchema', () => {
  const row = {
    key: 'walk_in',
    kind: 'walk_in',
    id: null,
    code: null,
    name: null,
    month: null,
    quantity: null,
    baseUnit: null,
    gross: '52650.5000',
    returns: '368.0000',
    net: '52282.5000',
    cost: null,
    margin: null,
    marginPercent: null,
  };
  const totals = {
    gross: '52650.5000',
    returns: '368.0000',
    net: '52282.5000',
    cost: null,
    margin: null,
    marginPercent: null,
  };

  it('reads a page with the walk-in row and no cost', () => {
    expect(
      salesReportSchema.safeParse({
        items: [row],
        nextCursor: null,
        totals,
        withCost: false,
        books: '52282.5000',
      }).success,
    ).toBe(true);
  });

  it('refuses a month that is not a year and a month', () => {
    const result = salesReportSchema.safeParse({
      items: [{ ...row, key: '2026-10-01', kind: 'item', month: '2026-10-01' }],
      nextCursor: null,
      totals,
      withCost: false,
      books: null,
    });
    expect(result.error?.issues[0]?.path).toEqual(['items', 0, 'month']);
  });
});
