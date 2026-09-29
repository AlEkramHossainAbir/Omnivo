import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatMonth,
  formatMonthName,
  formatNumber,
} from './format.js';

describe('formatMoney', () => {
  it('uses lakh/crore grouping with a leading taka sign', () => {
    expect(formatMoney(1842600, 'en')).toBe('৳18,42,600');
  });

  it('writes Bangla digits but keeps the taka sign in front', () => {
    expect(formatMoney(1842600, 'bn')).toBe('৳১৮,৪২,৬০০');
  });

  it('puts the minus before the taka sign and never shows -0', () => {
    expect(formatMoney(-1200, 'en')).toBe('-৳1,200');
    expect(formatMoney(-0.4, 'en')).toBe('৳0');
  });

  it('formats NUMERIC strings exactly, without going through a float', () => {
    // number হিসেবে 9007199254740993 হয়ে যেত 9007199254740992
    expect(formatMoney('9007199254740993.25', 'en', { decimals: 2 })).toBe(
      '৳9,00,71,99,25,47,40,993.25',
    );
  });

  it('returns a non-numeric string unchanged instead of printing NaN', () => {
    expect(formatMoney('abc', 'en')).toBe('abc');
  });
});

describe('formatNumber', () => {
  it('groups counts the same way', () => {
    expect(formatNumber(4800, 'en')).toBe('4,800');
    expect(formatNumber(4800, 'bn')).toBe('৪,৮০০');
  });
});

describe('dates', () => {
  const date = new Date(2026, 8, 23);

  it('writes "23 Sep 2026" in English (not the ICU "Sept")', () => {
    expect(formatDate(date, 'en')).toBe('23 Sep 2026');
  });

  it('writes Bangla dates with Bangla digits', () => {
    expect(formatDate(date, 'bn')).toBe('২৩ সেপ, ২০২৬');
  });

  it('writes periods as month and year', () => {
    expect(formatMonth(date, 'en')).toBe('September 2026');
    expect(formatMonth(date, 'bn')).toBe('সেপ্টেম্বর ২০২৬');
  });
});

describe('formatDateTime', () => {
  it("shows the moment in the workspace's time zone, not the browser's", () => {
    const moment = new Date('2026-09-23T10:05:00Z');
    expect(formatDateTime(moment, 'en', 'Asia/Dhaka')).toBe('23 Sep 2026, 16:05');
    expect(formatDateTime(moment, 'en', 'UTC')).toBe('23 Sep 2026, 10:05');
    expect(formatDateTime(moment, 'bn', 'Asia/Dhaka')).toBe('২৩ সেপ, ২০২৬, ১৬:০৫');
  });
});

describe('formatMonthName', () => {
  it('names the month in both languages', () => {
    expect(formatMonthName(7, 'en')).toBe('July');
    expect(formatMonthName(7, 'bn')).toBe('জুলাই');
  });
});
