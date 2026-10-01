import { describe, expect, it } from 'vitest';

import {
  fiscalYearLabel,
  fiscalYearOf,
  naturalAmount,
  profitAndLossQuerySchema,
  type ReportAccount,
  reportExportInputSchema,
  reportSection,
  trialBalanceQuerySchema,
} from './reports.js';

describe('fiscal years', () => {
  it('finds the July–June year of a date on either side of the new year', () => {
    expect(fiscalYearOf('2026-09-23', 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
    expect(fiscalYearOf('2027-06-30', 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
    expect(fiscalYearOf('2026-07-01', 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
  });

  it('ends a calendar year on 31 December, and a March year on the last day of February', () => {
    expect(fiscalYearOf('2026-05-10', 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    // 2028 is a leap year
    expect(fiscalYearOf('2027-04-01', 3)).toEqual({ start: '2027-03-01', end: '2028-02-29' });
  });

  it('labels a year the way the journal numbers do', () => {
    expect(fiscalYearLabel('2025-07-01', 7)).toBe('2025-26');
    expect(fiscalYearLabel('2026-01-01', 1)).toBe('2026');
  });
});

describe('report queries', () => {
  it('refuses a range that ends before it starts, under To', () => {
    const result = trialBalanceQuerySchema.safeParse({ from: '2026-09-30', to: '2026-09-01' });
    expect(result.error?.issues[0]).toMatchObject({
      path: ['to'],
      message: 'report_range_invalid',
    });
  });

  it('needs both comparison dates or neither', () => {
    const half = profitAndLossQuerySchema.safeParse({
      from: '2026-07-01',
      to: '2026-09-30',
      compareFrom: '2025-07-01',
    });
    expect(half.error?.issues[0]?.message).toBe('report_compare_incomplete');
    expect(
      profitAndLossQuerySchema.safeParse({
        from: '2026-07-01',
        to: '2026-09-30',
        compareFrom: '2025-07-01',
        compareTo: '2025-09-30',
      }).success,
    ).toBe(true);
  });

  it('checks an export query with the schema of its own report', () => {
    const result = reportExportInputSchema.safeParse({
      report: 'balance_sheet',
      format: 'pdf',
      query: { from: '2026-07-01', to: '2026-09-30' },
    });
    expect(result.error?.issues[0]?.path).toEqual(['query', 'asOf']);
  });
});

describe('a report section', () => {
  const id = (n: number) => `01939d1c-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const accounts: ReportAccount[] = [
    { id: id(1), parentId: null, code: '4000', name: 'Income', type: 'income', isGroup: true },
    { id: id(2), parentId: id(1), code: '4100', name: 'Revenue', type: 'income', isGroup: true },
    {
      id: id(3),
      parentId: id(2),
      code: '4120',
      name: 'Local sales',
      type: 'income',
      isGroup: false,
    },
    {
      id: id(4),
      parentId: id(2),
      code: '4110',
      name: 'Export sales',
      type: 'income',
      isGroup: false,
    },
    {
      id: id(5),
      parentId: id(1),
      code: '4200',
      name: 'Other income',
      type: 'income',
      isGroup: true,
    },
    { id: id(6), parentId: id(5), code: '4210', name: 'Interest', type: 'income', isGroup: false },
    { id: id(7), parentId: null, code: '5000', name: 'Expenses', type: 'expense', isGroup: true },
  ];

  it('orders rows as a tree by code, sums groups, and leaves out what never moved', () => {
    const section = reportSection(
      'income',
      accounts,
      new Map([
        [id(3), '250000'],
        [id(4), '1200000.5'],
      ]),
      null,
    );
    expect(section.rows.map((row) => [row.code, row.depth, row.amount])).toEqual([
      ['4100', 0, '1450000.5000'],
      ['4110', 1, '1200000.5000'],
      ['4120', 1, '250000.0000'],
    ]);
    expect(section.total).toBe('1450000.5000');
    expect(section.compareTotal).toBeNull();
  });

  it('keeps a group that nets to zero, and a row that only moved in the comparison', () => {
    const section = reportSection(
      'income',
      accounts,
      new Map([
        [id(3), '100'],
        [id(4), '-100'],
      ]),
      new Map([[id(6), '75']]),
    );
    expect(section.rows.map((row) => [row.code, row.amount, row.compareAmount])).toEqual([
      ['4100', '0.0000', '0.0000'],
      ['4110', '-100.0000', '0.0000'],
      ['4120', '100.0000', '0.0000'],
      ['4200', '0.0000', '75.0000'],
      ['4210', '0.0000', '75.0000'],
    ]);
    expect(section.compareTotal).toBe('75.0000');
  });

  it('is empty with zero totals when nothing moved', () => {
    expect(reportSection('expense', accounts, new Map(), new Map())).toEqual({
      type: 'expense',
      rows: [],
      total: '0.0000',
      compareTotal: '0.0000',
    });
  });

  it('turns a signed balance into the natural sign of the type', () => {
    expect(naturalAmount('income', '-1200.0000')).toBe('1200.0000');
    expect(naturalAmount('expense', '300.0000')).toBe('300.0000');
    expect(naturalAmount('liability', '50.0000')).toBe('-50.0000');
  });
});
