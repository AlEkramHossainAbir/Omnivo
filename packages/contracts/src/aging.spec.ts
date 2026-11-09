import { describe, expect, it } from 'vitest';

import {
  agingAmountsOf,
  agingBucketOf,
  arAgingFilterSchema,
  arAgingQuerySchema,
  daysBetween,
  daysOverdue,
} from './aging.js';

describe('days and buckets', () => {
  it('counts days across a month, a leap day and a year', () => {
    expect(daysBetween('2026-10-31', '2026-11-01')).toBe(1);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-11-05', '2026-11-01')).toBe(-4);
  });

  it('is current on its due date, and overdue from the day after', () => {
    expect(daysOverdue('2026-11-05', '2026-11-05')).toBe(0);
    expect(daysOverdue('2026-11-20', '2026-11-05')).toBe(0);
    expect(agingBucketOf('2026-11-05', '2026-11-05')).toBe('current');
    expect(daysOverdue('2026-11-04', '2026-11-05')).toBe(1);
    expect(agingBucketOf('2026-11-04', '2026-11-05')).toBe('days1To30');
  });

  it('puts each edge day in the lower bucket', () => {
    // As of 5 Nov 2026: due 6 Oct is 30 days late, 5 Oct is 31
    expect(agingBucketOf('2026-10-06', '2026-11-05')).toBe('days1To30');
    expect(agingBucketOf('2026-10-05', '2026-11-05')).toBe('days31To60');
    expect(agingBucketOf('2026-09-06', '2026-11-05')).toBe('days31To60');
    expect(agingBucketOf('2026-09-05', '2026-11-05')).toBe('days61To90');
    expect(agingBucketOf('2026-08-07', '2026-11-05')).toBe('days61To90');
    expect(agingBucketOf('2026-08-06', '2026-11-05')).toBe('over90');
  });
});

describe('agingAmountsOf', () => {
  it('adds the open amounts into their buckets and takes the advances off the balance', () => {
    // Sylhet Pharmacy on 5 Nov 2026: three invoices open, one receipt not applied yet
    expect(
      agingAmountsOf(
        [
          { dueDate: '2026-11-15', open: '42000.0000' },
          { dueDate: '2026-10-20', open: '18500.5000' },
          { dueDate: '2026-07-01', open: '9000.0000' },
        ],
        ['5000.0000'],
        '2026-11-05',
      ),
    ).toEqual({
      current: '42000.0000',
      days1To30: '18500.5000',
      days31To60: '0.0000',
      days61To90: '0.0000',
      over90: '9000.0000',
      due: '69500.5000',
      advances: '5000.0000',
      balance: '64500.5000',
    });
  });

  it('has a negative balance when only an advance is left', () => {
    expect(agingAmountsOf([], ['20000.0000', '1500.0000'], '2026-11-05')).toMatchObject({
      due: '0.0000',
      advances: '21500.0000',
      balance: '-21500.0000',
    });
  });
});

describe('the aging query', () => {
  it('shows everyone, the largest balance first', () => {
    expect(arAgingQuerySchema.parse({ asOf: '2026-11-05' })).toEqual({
      asOf: '2026-11-05',
      show: 'all',
      sort: '-balance',
      limit: 50,
    });
  });

  it('takes "overdue only" as a word, not a boolean a query string would turn into true', () => {
    expect(arAgingFilterSchema.safeParse({ asOf: '2026-11-05', show: 'false' }).success).toBe(
      false,
    );
    expect(arAgingFilterSchema.parse({ asOf: '2026-11-05', show: 'overdue' }).show).toBe('overdue');
  });
});
