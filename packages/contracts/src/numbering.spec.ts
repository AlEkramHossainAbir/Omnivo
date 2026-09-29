import { describe, expect, it } from 'vitest';

import {
  formatDocumentNumber,
  periodOf,
  todayIn,
  updateNumberSeriesInputSchema,
} from './numbering.js';

describe('periodOf', () => {
  it('splits a July–June fiscal year at the start month', () => {
    expect(periodOf('2026-06-30', 'fiscal', 7)).toBe('2025-26');
    expect(periodOf('2026-07-01', 'fiscal', 7)).toBe('2026-27');
    expect(periodOf('2027-03-15', 'fiscal', 7)).toBe('2026-27');
  });

  it('uses the plain year for calendar years and January fiscal years', () => {
    expect(periodOf('2026-09-23', 'calendar', 7)).toBe('2026');
    expect(periodOf('2026-09-23', 'fiscal', 1)).toBe('2026');
  });

  it('never resets when the year is left out', () => {
    expect(periodOf('2026-09-23', 'none', 7)).toBe('');
  });

  it('writes the century boundary as two digits', () => {
    expect(periodOf('2099-12-01', 'fiscal', 7)).toBe('2099-00');
  });
});

describe('formatDocumentNumber', () => {
  it('joins prefix, period and the padded sequence with hyphens', () => {
    const format = { prefix: 'INV', yearStyle: 'fiscal', padding: 4 } as const;
    expect(formatDocumentNumber(format, '2026-27', 42)).toBe('INV-2026-27-0042');
    expect(formatDocumentNumber({ ...format, yearStyle: 'none' }, '', 7)).toBe('INV-0007');
  });

  it('lets the sequence grow past the padding instead of cutting it', () => {
    expect(formatDocumentNumber({ prefix: 'JV', yearStyle: 'none', padding: 3 }, '', 12345)).toBe(
      'JV-12345',
    );
  });
});

describe('todayIn', () => {
  it("gives the tenant's date, not the server's", () => {
    // 23 Sep 19:30 UTC = 24 Sep 01:30 in Dhaka (UTC+6)
    const instant = new Date('2026-09-23T19:30:00Z');
    expect(todayIn('Asia/Dhaka', instant)).toBe('2026-09-24');
    expect(todayIn('UTC', instant)).toBe('2026-09-23');
  });
});

describe('number series input', () => {
  it('upper-cases the prefix and refuses hyphens inside it', () => {
    const base = { yearStyle: 'fiscal', padding: 4, version: 0 } as const;
    expect(updateNumberSeriesInputSchema.parse({ ...base, prefix: ' inv ' }).prefix).toBe('INV');
    const result = updateNumberSeriesInputSchema.safeParse({ ...base, prefix: 'IN-V' });
    expect(result.error?.issues[0]?.message).toBe('prefix_format');
  });
});
