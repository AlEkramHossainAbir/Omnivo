import { describe, expect, it } from 'vitest';

import {
  changePercent,
  type Dashboard,
  DASHBOARD_TREND_DAYS,
  dashboardCardsFor,
  dashboardPeriods,
  dashboardSchema,
  everyDay,
  marginPercent,
} from './dashboard.js';

describe('dashboard periods', () => {
  it('compares 1–2 Nov with 1–2 Oct, and charts the 30 days up to today', () => {
    expect(dashboardPeriods('2026-11-02')).toEqual({
      today: '2026-11-02',
      yesterday: '2026-11-01',
      monthStart: '2026-11-01',
      lastMonthStart: '2026-10-01',
      lastMonthEnd: '2026-10-02',
      trendStart: '2026-10-04',
    });
  });

  it('compares 31 March with the whole of February, never with days of March', () => {
    expect(dashboardPeriods('2027-03-31')).toMatchObject({
      lastMonthStart: '2027-02-01',
      lastMonthEnd: '2027-02-28',
    });
    // 2028 is a leap year
    expect(dashboardPeriods('2028-03-30')).toMatchObject({ lastMonthEnd: '2028-02-29' });
  });

  it('goes back into last year on 1 January', () => {
    expect(dashboardPeriods('2027-01-01')).toEqual({
      today: '2027-01-01',
      yesterday: '2026-12-31',
      monthStart: '2027-01-01',
      lastMonthStart: '2026-12-01',
      lastMonthEnd: '2026-12-01',
      trendStart: '2026-12-03',
    });
  });
});

describe('everyDay', () => {
  it('gives every day a point, zero when nothing was sold', () => {
    const days = everyDay(
      '2026-10-04',
      DASHBOARD_TREND_DAYS,
      new Map([
        ['2026-10-04', '18400.0000'],
        ['2026-11-02', '52650.5000'],
      ]),
    );
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({ date: '2026-10-04', amount: '18400.0000' });
    // Across the end of October
    expect(days[27]).toEqual({ date: '2026-10-31', amount: '0.0000' });
    expect(days[28]).toEqual({ date: '2026-11-01', amount: '0.0000' });
    expect(days[29]).toEqual({ date: '2026-11-02', amount: '52650.5000' });
  });
});

describe('change and margin', () => {
  it('says how much today moved against yesterday', () => {
    expect(changePercent('52650.5', '46800')).toBe('12.5');
    expect(changePercent('0', '46800')).toBe('-100.0');
  });

  it('has no percent when there is nothing to compare with', () => {
    expect(changePercent('52650.5', '0.0000')).toBeNull();
  });

  it('works out the margin, and has none without sales', () => {
    expect(marginPercent({ sales: '840000', cost: '651000' })).toBe('22.5');
    // Sold below cost
    expect(marginPercent({ sales: '1000', cost: '1200' })).toBe('-20.0');
    expect(marginPercent({ sales: '0.0000', cost: '350' })).toBeNull();
  });
});

describe('dashboardCardsFor', () => {
  it('gives an owner every card, in the screen order', () => {
    expect(
      dashboardCardsFor([
        'sales.report.read',
        'inventory.stock.value',
        'accounting.report.read',
        'sales.customer.balance',
        'purchase.supplier.balance',
        'inventory.report.read',
      ]),
    ).toEqual(['sales', 'margin', 'cash', 'topProducts', 'receivables', 'payables', 'lowStock']);
  });

  it('shows no margin to a storekeeper who sees stock values but not sales', () => {
    expect(dashboardCardsFor(['inventory.stock.value', 'inventory.report.read'])).toEqual([
      'lowStock',
    ]);
  });

  it('gives a cashier nothing, and ignores keys it does not know', () => {
    expect(dashboardCardsFor(['pos.sale.create', 'pos.something.new'])).toEqual([]);
  });
});

describe('dashboardSchema', () => {
  const empty: Dashboard = {
    today: '2026-11-02',
    generatedAt: '2026-11-02T04:42:00.000Z',
    branchId: null,
    sales: null,
    margin: null,
    cash: null,
    topProducts: null,
    receivables: null,
    payables: null,
    lowStock: null,
  };

  it('reads an answer with no card at all', () => {
    expect(dashboardSchema.parse(empty)).toEqual(empty);
  });

  it('refuses a sales chart that is not 30 days', () => {
    const days = everyDay('2026-10-05', 29, new Map());
    const result = dashboardSchema.safeParse({
      ...empty,
      sales: {
        today: '0.0000',
        yesterday: '0.0000',
        monthToDate: '0.0000',
        lastMonthToDate: '0.0000',
        days,
      },
    });
    expect(result.success).toBe(false);
  });
});
