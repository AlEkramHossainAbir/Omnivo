import { describe, expect, it } from 'vitest';

import { compareAsOf, compareRange, presetRange, shiftMonths } from './reports';

describe('shifting by months', () => {
  it('keeps the day, or takes the last day of a shorter month', () => {
    expect(shiftMonths('2026-09-23', -1)).toBe('2026-08-23');
    expect(shiftMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(shiftMonths('2028-03-31', -1)).toBe('2028-02-29');
    expect(shiftMonths('2026-01-15', -12)).toBe('2025-01-15');
    expect(shiftMonths('2026-11-30', 3)).toBe('2027-02-28');
  });
});

describe('period presets', () => {
  // 23 September 2026, a July–June fiscal year
  const today = '2026-09-23';

  it('runs this year, quarter and month up to today', () => {
    expect(presetRange('this_year', today, 7)).toEqual({ from: '2026-07-01', to: today });
    expect(presetRange('this_quarter', today, 7)).toEqual({ from: '2026-07-01', to: today });
    expect(presetRange('this_month', today, 7)).toEqual({ from: '2026-09-01', to: today });
  });

  it('gives whole periods for last year, quarter and month', () => {
    expect(presetRange('last_year', today, 7)).toEqual({ from: '2025-07-01', to: '2026-06-30' });
    expect(presetRange('last_quarter', today, 7)).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    });
    expect(presetRange('last_month', today, 7)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('counts quarters from the first month of the fiscal year', () => {
    // A July year: November is in its second quarter, October–December
    expect(presetRange('this_quarter', '2026-11-05', 7).from).toBe('2026-10-01');
    // A calendar year: the first quarter of 2027 is January–March
    expect(presetRange('last_quarter', '2027-02-10', 1)).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
    });
  });
});

describe('comparison periods', () => {
  it('compares a quarter with the quarter before, month end with month end', () => {
    expect(compareRange({ from: '2026-07-01', to: '2026-09-30' }, 'previous_period')).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    });
    expect(compareRange({ from: '2026-03-01', to: '2026-03-31' }, 'previous_period')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('compares a month so far with the same days of the month before', () => {
    expect(compareRange({ from: '2026-10-01', to: '2026-10-15' }, 'previous_period')).toEqual({
      from: '2026-09-01',
      to: '2026-09-15',
    });
  });

  it('moves any other range back by its own number of days', () => {
    expect(compareRange({ from: '2026-09-10', to: '2026-09-19' }, 'previous_period')).toEqual({
      from: '2026-08-31',
      to: '2026-09-09',
    });
  });

  it('compares with the same days a year earlier, and with nothing', () => {
    expect(compareRange({ from: '2026-07-01', to: '2026-09-23' }, 'previous_year')).toEqual({
      from: '2025-07-01',
      to: '2025-09-23',
    });
    expect(compareRange({ from: '2026-07-01', to: '2026-09-23' }, 'none')).toBeNull();
  });

  it('compares a balance sheet with the last year end, or the same day last year', () => {
    expect(compareAsOf('2026-09-23', 'year_end', 7)).toBe('2026-06-30');
    expect(compareAsOf('2028-02-29', 'previous_year', 7)).toBe('2027-02-28');
    expect(compareAsOf('2026-09-23', 'none', 7)).toBeNull();
  });
});
