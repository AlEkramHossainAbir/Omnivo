import { describe, expect, it } from 'vitest';

import { barWidth, cashChange, madeToday, nothingSold, salesChange } from './dashboard';

describe('salesChange', () => {
  it('says more or less with the percent without its sign', () => {
    expect(salesChange('184250.0000', '163900.0000')).toEqual({ kind: 'more', percent: '12.4' });
    expect(salesChange('163900.0000', '184250.0000')).toEqual({ kind: 'less', percent: '11.0' });
  });

  it('gives no percent when there is nothing to compare with', () => {
    expect(salesChange('5000.0000', '0.0000')).toEqual({ kind: 'none' });
  });

  it('calls a change that rounds to 0.0% the same', () => {
    expect(salesChange('100000.0000', '100000.0000')).toEqual({ kind: 'same' });
    // −0.01% rounds to "-0.0"
    expect(salesChange('99990.0000', '100000.0000')).toEqual({ kind: 'same' });
  });
});

describe('cashChange', () => {
  it('compares with the end of yesterday', () => {
    expect(cashChange({ accounts: [], total: '1462580.0000', yesterday: '1366180.0000' })).toEqual({
      kind: 'up',
      amount: '96400.0000',
    });
    expect(cashChange({ accounts: [], total: '100.0000', yesterday: '350.0000' })).toEqual({
      kind: 'down',
      amount: '250.0000',
    });
    expect(cashChange({ accounts: [], total: '100.0000', yesterday: '100.0000' })).toEqual({
      kind: 'same',
    });
  });
});

describe('barWidth', () => {
  it('is the share of the largest amount, and never below zero', () => {
    expect(barWidth('362560.0000', '362560.0000')).toBe('100.0%');
    expect(barWidth('122400.0000', '362560.0000')).toBe('33.8%');
    expect(barWidth('-10.0000', '362560.0000')).toBe('0%');
    expect(barWidth('0.0000', '0.0000')).toBe('0%');
  });
});

describe('nothingSold', () => {
  it('is true only when every day is zero', () => {
    expect(nothingSold([{ amount: '0.0000' }, { amount: '0.0000' }])).toBe(true);
    expect(nothingSold([{ amount: '0.0000' }, { amount: '-20.0000' }])).toBe(false);
  });
});

describe('madeToday', () => {
  it("compares the days in the workspace's time zone", () => {
    const now = new Date('2026-11-04T05:00:00Z');
    // 4 Nov, 10:42 in Dhaka
    expect(madeToday('2026-11-04T04:42:00.000Z', 'Asia/Dhaka', now)).toBe(true);
    // 3 Nov, 23:30 in Dhaka: yesterday in the workspace
    expect(madeToday('2026-11-03T17:30:00.000Z', 'Asia/Dhaka', now)).toBe(false);
    // 4 Nov 00:30 in Dhaka is 3 Nov in UTC: still today in the workspace
    expect(madeToday('2026-11-03T18:30:00.000Z', 'Asia/Dhaka', now)).toBe(true);
  });
});
