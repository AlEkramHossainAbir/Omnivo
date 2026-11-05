import { describe, expect, it } from 'vitest';

import { niceTicks } from './ticks.js';

describe('niceTicks', () => {
  it('starts at zero and takes a round step that holds the largest day', () => {
    // ৳2,26,000 in three steps is 75,333 a step: the next round one is 1,00,000
    expect(niceTicks([168_000, 226_000, 121_000])).toEqual([0, 100_000, 200_000, 300_000]);
    expect(niceTicks([40, 95])).toEqual([0, 50, 100]);
  });

  it('goes below zero for a day with more returns than sales', () => {
    expect(niceTicks([-12_000, 30_000])).toEqual([-20_000, 0, 20_000, 40_000]);
  });

  it('draws nothing but zeros on the bottom gridline', () => {
    expect(niceTicks([0, 0, 0])).toEqual([0, 1]);
    expect(niceTicks([])).toEqual([0, 1]);
  });
});
