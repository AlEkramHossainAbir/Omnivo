import { describe, expect, it } from 'vitest';

import { amountInWords } from './amount-words.js';

describe('amountInWords (English)', () => {
  it('uses lakh and crore, not million', () => {
    expect(amountInWords('1842600.5000', 'en', 'BDT')).toBe(
      'Eighteen lakh forty-two thousand six hundred taka and fifty paisa only',
    );
    expect(amountInWords('25000000', 'en', 'BDT')).toBe('Two crore fifty lakh taka only');
  });

  it('writes the crores as a number of their own above 99 crore', () => {
    expect(amountInWords('1200000000', 'en', 'BDT')).toBe('One hundred twenty crore taka only');
  });

  it('skips the empty groups', () => {
    expect(amountInWords('100005', 'en', 'BDT')).toBe('One lakh five taka only');
    expect(amountInWords('62100.00', 'en', 'BDT')).toBe('Sixty-two thousand one hundred taka only');
  });

  it('says only the paisa when there is no whole taka, and zero for nothing', () => {
    expect(amountInWords('0.75', 'en', 'BDT')).toBe('Seventy-five paisa only');
    expect(amountInWords('0.0000', 'en', 'BDT')).toBe('Zero taka only');
  });

  it('rounds half up at the paisa', () => {
    expect(amountInWords('10.005', 'en', 'BDT')).toBe('Ten taka and one paisa only');
    expect(amountInWords('10.0049', 'en', 'BDT')).toBe('Ten taka only');
    expect(amountInWords('99.995', 'en', 'BDT')).toBe('One hundred taka only');
  });

  it('counts the units of other currencies', () => {
    expect(amountInWords('1.01', 'en', 'USD')).toBe('One dollar and one cent only');
    expect(amountInWords('2.50', 'en', 'GBP')).toBe('Two pounds and fifty pence only');
  });
});

describe('amountInWords (Bangla)', () => {
  it('uses the Bangla word of every number below 100', () => {
    expect(amountInWords('1842600.50', 'bn', 'BDT')).toBe(
      'আঠারো লক্ষ বিয়াল্লিশ হাজার ছয়শত টাকা পঞ্চাশ পয়সা মাত্র',
    );
    expect(amountInWords('99', 'bn', 'BDT')).toBe('নিরানব্বই টাকা মাত্র');
  });

  it('writes the crores and the zero amount', () => {
    expect(amountInWords('1200000000', 'bn', 'BDT')).toBe('একশত বিশ কোটি টাকা মাত্র');
    expect(amountInWords('0', 'bn', 'BDT')).toBe('শূন্য টাকা মাত্র');
    expect(amountInWords('0.25', 'bn', 'BDT')).toBe('পঁচিশ পয়সা মাত্র');
  });
});

describe('amountInWords (bad input)', () => {
  it('refuses a negative or broken amount instead of writing wrong words', () => {
    expect(() => amountInWords('-5', 'en', 'BDT')).toThrow();
    expect(() => amountInWords('1,000', 'en', 'BDT')).toThrow();
    expect(() => amountInWords('', 'en', 'BDT')).toThrow();
  });
});
