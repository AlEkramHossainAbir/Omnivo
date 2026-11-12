import { describe, expect, it } from 'vitest';

import { countdownText } from './countdown';

const DAY_12_10_32 = (((1 * 24 + 12) * 60 + 10) * 60 + 32) * 1000;

describe('countdownText', () => {
  it('writes Figma’s countdown', () => {
    expect(countdownText(DAY_12_10_32, 'en-IN')).toBe('01 : 12 : 10 : 32');
  });

  // The page asks a few hundred milliseconds into a second; the clock shows the whole seconds left
  it('drops the part of a second', () => {
    expect(countdownText(DAY_12_10_32 + 999, 'en-IN')).toBe('01 : 12 : 10 : 32');
  });

  it('counts in Bangla digits in a Bangla shop', () => {
    expect(countdownText(DAY_12_10_32, 'bn-BD')).toBe('০১ : ১২ : ১০ : ৩২');
  });

  it('shows zeros once the sale is over, never a minus', () => {
    expect(countdownText(-5000, 'en-IN')).toBe('00 : 00 : 00 : 00');
  });

  it('keeps every digit of a long sale', () => {
    expect(countdownText(120 * 24 * 3600 * 1000, 'en-IN')).toBe('120 : 00 : 00 : 00');
  });
});
