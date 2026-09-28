import { describe, expect, it } from 'vitest';

import { isMoneyDraft, normalizeMoneyInput, toCanonicalMoney } from './money.js';

describe('normalizeMoneyInput', () => {
  it('turns Bangla digits into ASCII digits', () => {
    expect(normalizeMoneyInput('১৮৪২৬০০.৫০')).toBe('1842600.50');
  });

  it('removes grouping commas and spaces from pasted amounts', () => {
    expect(normalizeMoneyInput('18,42,600')).toBe('1842600');
    expect(normalizeMoneyInput(' 1 200 ')).toBe('1200');
  });
});

describe('isMoneyDraft', () => {
  it('accepts every half-typed state', () => {
    for (const draft of ['', '12', '12.', '12.5', '12.50', '.5']) {
      expect(isMoneyDraft(draft, 2)).toBe(true);
    }
  });

  it('rejects letters, a second point and too many decimals', () => {
    for (const draft of ['12a', '1.2.3', '12.505', '-12']) {
      expect(isMoneyDraft(draft, 2)).toBe(false);
    }
  });

  it('allows no point at all when the scale is 0', () => {
    expect(isMoneyDraft('12', 0)).toBe(true);
    expect(isMoneyDraft('12.', 0)).toBe(false);
  });
});

describe('toCanonicalMoney', () => {
  it('pads to the scale', () => {
    expect(toCanonicalMoney('1842600.5', 2)).toBe('1842600.50');
    expect(toCanonicalMoney('12.', 2)).toBe('12.00');
  });

  it('rounds half up without binary float errors', () => {
    // (1.005).toFixed(2) === '1.00' in JavaScript
    expect(toCanonicalMoney('1.005', 2)).toBe('1.01');
  });

  it('keeps every digit of amounts beyond Number.MAX_SAFE_INTEGER', () => {
    expect(toCanonicalMoney('9007199254740993', 2)).toBe('9007199254740993.00');
  });

  it('maps an empty draft to an empty value', () => {
    expect(toCanonicalMoney('', 2)).toBe('');
    expect(toCanonicalMoney('.', 2)).toBe('');
  });
});
