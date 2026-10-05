import { describe, expect, it } from 'vitest';

import {
  addQuantity,
  compareQuantity,
  fitsDecimals,
  isQuantity,
  levelSchema,
  negateQuantity,
  plainQuantity,
  receivedQuantitySchema,
  subtractQuantity,
  sumQuantity,
  toBaseQuantity,
  wholeCount,
} from './quantities.js';

describe('quantities', () => {
  it('accepts positive quantities with up to 4 decimals', () => {
    expect(['1', '0.5', '1.2500', '9999999999999.9999'].every(isQuantity)).toBe(true);
    expect(['0', '0.0000', '-1', '1.23456', '1e3', '', ' 1'].some(isQuantity)).toBe(false);
  });

  it('adds and subtracts exactly, in Postgres’s 4-decimal shape', () => {
    // 0.1 + 0.2 kg: exactly 0.3, not 0.30000000000000004
    expect(addQuantity('0.1', '0.2')).toBe('0.3000');
    expect(subtractQuantity('10', '12.5')).toBe('-2.5000');
    expect(sumQuantity(['72.0000', '-2', '-4'])).toBe('66.0000');
    expect(negateQuantity('0')).toBe('0.0000');
    expect(compareQuantity('10.0000', '12')).toBe(-1);
    expect(compareQuantity('12', '12.0000')).toBe(0);
  });

  it('turns a pack into base units, rounded to the base unit’s decimals', () => {
    // 3 cases of 24 pieces
    expect(toBaseQuantity('3', '24.000000', 0)).toBe('72.0000');
    // 3 yards in metres (2 decimals): 2.7432 → 2.74
    expect(toBaseQuantity('3', '0.914400', 2)).toBe('2.7400');
    // Half up: 1 yard = 0.9144 → 0.91; 5 yards = 4.572 → 4.57; 0.5 yard = 0.4572 → 0.46
    expect(toBaseQuantity('0.5', '0.914400', 2)).toBe('0.4600');
    // A kilo bag in kg with 3 decimals stays exact
    expect(toBaseQuantity('1.25', '50', 3)).toBe('62.5000');
  });

  it('knows when a quantity has more decimals than its unit allows', () => {
    expect(fitsDecimals('1.50', 1)).toBe(true);
    expect(fitsDecimals('1.25', 1)).toBe(false);
    expect(fitsDecimals('3.0000', 0)).toBe(true);
    expect(fitsDecimals('1.5', 0)).toBe(false);
  });

  it('counts whole items and writes a quantity plainly', () => {
    expect(wholeCount('3.0000')).toBe(3);
    expect(plainQuantity('24.0000')).toBe('24');
    expect(plainQuantity('2.7400')).toBe('2.74');
    expect(plainQuantity('-5.0000')).toBe('-5');
    expect(plainQuantity('0.0000')).toBe('0');
  });

  it('reads levels and received quantities, where zero is a real answer', () => {
    expect(levelSchema.parse('')).toBeNull();
    expect(levelSchema.parse('0')).toBe('0');
    expect(receivedQuantitySchema.safeParse('0').success).toBe(true);
    expect(receivedQuantitySchema.safeParse('').success).toBe(false);
  });
});
