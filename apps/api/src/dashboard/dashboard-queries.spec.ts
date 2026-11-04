import { DASHBOARD_TREND_DAYS, dashboardPeriods } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { type DaySold, marginCard, salesCard, soldFrom } from './dashboard-queries.js';

// The rows soldByDay() reads, as a map by day: what the cards add up. No database here: the sums
// over the days are plain TypeScript, so every edge of the periods is cheap to try.
function days(entries: Record<string, [sales: string, cost: string]>): Map<string, DaySold> {
  return new Map(Object.entries(entries).map(([day, [sales, cost]]) => [day, { sales, cost }]));
}

describe('soldFrom', () => {
  it('is the 1st of last month when the chart starts later', () => {
    expect(soldFrom(dashboardPeriods('2026-11-02'))).toBe('2026-10-01');
  });

  it("is the chart's first day when that is earlier: 1 March starts on 31 January", () => {
    expect(soldFrom(dashboardPeriods('2027-03-01'))).toBe('2027-01-31');
  });
});

describe('salesCard', () => {
  const periods = dashboardPeriods('2026-11-02');
  const sold = days({
    '2026-11-02': ['1500.0000', '900.0000'],
    '2026-11-01': ['800.0000', '500.0000'],
    // A day of returns only: below zero, and it still counts
    '2026-10-31': ['-200.0000', '-120.0000'],
    '2026-10-02': ['300.0000', '180.0000'],
    // Last month, but after the 2nd: not in "the same days of last month"
    '2026-10-03': ['4000.0000', '2400.0000'],
    '2026-10-01': ['700.0000', '420.0000'],
  });

  it('adds up today, yesterday, this month so far and the same days of last month', () => {
    const card = salesCard(sold, periods);
    expect(card).toMatchObject({
      today: '1500.0000',
      yesterday: '800.0000',
      monthToDate: '2300.0000',
      lastMonthToDate: '1000.0000',
    });
  });

  it('has a point for every day of the chart, with zero on a day nothing was sold', () => {
    const chart = salesCard(sold, periods).days;
    expect(chart).toHaveLength(DASHBOARD_TREND_DAYS);
    expect(chart[0]).toEqual({ date: '2026-10-04', amount: '0.0000' });
    expect(chart.at(-1)).toEqual({ date: '2026-11-02', amount: '1500.0000' });
    expect(chart.find((day) => day.date === '2026-10-31')?.amount).toBe('-200.0000');
    // 1–3 October are before the chart's first day: in the month's sums, not on the chart
    expect(chart.map((day) => day.date)).not.toContain('2026-10-03');
  });

  it('is zeros with no rows at all', () => {
    const card = salesCard(new Map(), periods);
    expect(card).toMatchObject({
      today: '0.0000',
      yesterday: '0.0000',
      monthToDate: '0.0000',
      lastMonthToDate: '0.0000',
    });
    expect(card.days.every((day) => day.amount === '0.0000')).toBe(true);
  });

  it('compares the 31st with the whole of last month, never a day of this month', () => {
    const march = dashboardPeriods('2027-03-31');
    const card = salesCard(
      days({
        '2027-02-28': ['600.0000', '0.0000'],
        '2027-02-01': ['400.0000', '0.0000'],
        '2027-03-01': ['900.0000', '0.0000'],
      }),
      march,
    );
    expect(card.lastMonthToDate).toBe('1000.0000');
    expect(card.monthToDate).toBe('900.0000');
  });
});

describe('marginCard', () => {
  it('pairs the sales with the cost of the same days', () => {
    const card = marginCard(
      days({
        '2026-11-02': ['1500.0000', '900.0000'],
        '2026-11-01': ['800.0000', '500.0000'],
        '2026-10-02': ['300.0000', '180.0000'],
        '2026-10-03': ['4000.0000', '2400.0000'],
      }),
      dashboardPeriods('2026-11-02'),
    );
    expect(card).toEqual({
      monthToDate: { sales: '2300.0000', cost: '1400.0000' },
      lastMonthToDate: { sales: '300.0000', cost: '180.0000' },
    });
  });
});
