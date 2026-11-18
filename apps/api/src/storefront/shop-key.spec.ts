import { describe, expect, it } from 'vitest';

import { shopKeyMatches } from './shop-key.js';

const KEY = 'a-shop-key-of-at-least-thirty-two-chars';

describe('shopKeyMatches', () => {
  it('takes only the exact key', () => {
    expect(shopKeyMatches(KEY, KEY)).toBe(true);
    expect(shopKeyMatches(`${KEY} `, KEY)).toBe(false);
    expect(shopKeyMatches(KEY.slice(0, -1), KEY)).toBe(false);
    expect(shopKeyMatches('', KEY)).toBe(false);
  });

  it('refuses every call when no key was sent, or none is set', () => {
    expect(shopKeyMatches(undefined, KEY)).toBe(false);
    expect(shopKeyMatches(KEY, null)).toBe(false);
  });
});
