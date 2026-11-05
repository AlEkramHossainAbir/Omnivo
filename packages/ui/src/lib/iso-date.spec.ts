import { describe, expect, it } from 'vitest';

import { parseIsoDate, toIsoDate } from './iso-date.js';

describe('ISO dates', () => {
  it('reads a date as local midnight, not UTC', () => {
    const date = parseIsoDate('2026-09-23');
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(8);
    expect(date?.getDate()).toBe(23);
    expect(date?.getHours()).toBe(0);
  });

  it('round-trips without shifting a day', () => {
    expect(toIsoDate(new Date(2026, 8, 23))).toBe('2026-09-23');
    expect(toIsoDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    expect(parseIsoDate('')).toBeUndefined();
    expect(parseIsoDate('23/09/2026')).toBeUndefined();
  });
});
