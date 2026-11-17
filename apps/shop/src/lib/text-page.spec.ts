import { formatDate } from '@omnivo/i18n';
import { describe, expect, it } from 'vitest';

import { dayInShop, isTextPageSlug } from './text-page';

describe('isTextPageSlug', () => {
  it('knows the footer pages and nothing else', () => {
    expect(isTextPageSlug('terms')).toBe(true);
    expect(isTextPageSlug('contact')).toBe(true);
    expect(isTextPageSlug('Terms')).toBe(false);
    expect(isTextPageSlug('refunds')).toBe(false);
    expect(isTextPageSlug('')).toBe(false);
    expect(isTextPageSlug(undefined)).toBe(false);
  });
});

describe('dayInShop', () => {
  it("writes the shop's day, not the server's", () => {
    // 00:30 on 1 November in Dhaka is still 31 October in UTC
    expect(formatDate(dayInShop('2026-10-31T18:30:00Z', 'Asia/Dhaka'), 'en')).toBe('1 Nov 2026');
    expect(formatDate(dayInShop('2026-10-31T18:30:00Z', 'UTC'), 'en')).toBe('31 Oct 2026');
  });

  it('writes the day in Bangla too', () => {
    expect(formatDate(dayInShop('2026-11-01T10:00:00+06:00', 'Asia/Dhaka'), 'bn')).toBe(
      formatDate(new Date(2026, 10, 1), 'bn'),
    );
  });
});
