import { describe, expect, it } from 'vitest';

import {
  absMoney,
  addMoney,
  amountSchema,
  compareMoney,
  isNegativeMoney,
  isZeroMoney,
  multiplyMoney,
  negateMoney,
  prorateMoney,
  splitMoney,
  subtractMoney,
  sumMoney,
  unitCostOf,
} from './money.js';

describe('money', () => {
  it('sums exactly, where JavaScript numbers drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMoney(['0.1', '0.2'])).toBe('0.3000');
    // More digits than a double holds exactly: 2^53 + 1
    expect(sumMoney(['9007199254740993', '0.0001'])).toBe('9007199254740993.0001');
  });

  it('counts an empty box as zero, so a half-filled form adds up', () => {
    expect(sumMoney(['', '1250.5', ''])).toBe('1250.5000');
    expect(subtractMoney('100', '250.25')).toBe('-150.2500');
    expect(isZeroMoney('')).toBe(true);
    expect(isZeroMoney('0.0000')).toBe(true);
    expect(isZeroMoney('0.0001')).toBe(false);
    expect(isZeroMoney('-0.0000')).toBe(true);
    expect(isZeroMoney('100')).toBe(false);
  });

  it('keeps the sign right around zero, and never writes "-0"', () => {
    expect(subtractMoney('0', '0')).toBe('0.0000');
    expect(subtractMoney('0.05', '0.1')).toBe('-0.0500');
    expect(addMoney('-0.0500', '0.05')).toBe('0.0000');
    expect(isNegativeMoney('-0.0000')).toBe(false);
    expect(isNegativeMoney('-0.0001')).toBe(true);
    expect(absMoney('-1200.5')).toBe('1200.5000');
  });

  it('takes up to 15 digits and 4 decimals, and stores an empty box as 0', () => {
    expect(amountSchema.parse(' 18500.25 ')).toBe('18500.25');
    expect(amountSchema.parse('')).toBe('0');
    for (const bad of ['-5', '1,200', '12.34567', '1'.repeat(16), 'abc', '1e5']) {
      expect(amountSchema.safeParse(bad).error?.issues[0]?.message, bad).toBe('money_format');
    }
  });

  it('multiplies a quantity by a price, rounded once to the paisa', () => {
    expect(multiplyMoney('3', '1200.5')).toBe('3601.5000');
    // 2.74 m at ৳123.4567 = 338.271358 → 338.27
    expect(multiplyMoney('2.74', '123.4567')).toBe('338.2700');
    // Half a paisa rounds away from zero, on both sides of it
    expect(multiplyMoney('1', '0.005')).toBe('0.0100');
    expect(multiplyMoney('1', '-0.005')).toBe('-0.0100');
    expect(multiplyMoney('0.0001', '0.0001')).toBe('0.0000');
  });

  it('shares a value over part of a quantity, and the whole takes all of it', () => {
    // 30 of 40 pieces worth ৳1,000
    expect(prorateMoney('1000', '30', '40')).toBe('750.0000');
    // 1 of 3 pieces worth ৳100: 33.33, never 33.3333 (the books keep paisa)
    expect(prorateMoney('100', '1', '3')).toBe('33.3300');
    expect(prorateMoney('100', '3', '3')).toBe('100.0000');
    expect(prorateMoney('-100', '2', '3')).toBe('-66.6700');
    expect(() => prorateMoney('100', '1', '0')).toThrow();
  });

  it('splits a value into pieces that add up to it exactly', () => {
    expect(splitMoney('100', 3)).toEqual(['33.3300', '33.3300', '33.3400']);
    expect(splitMoney('-0.05', 2)).toEqual(['-0.0300', '-0.0200']);
    expect(sumMoney(splitMoney('1234.57', 7))).toBe('1234.5700');
    expect(splitMoney('5', 1)).toEqual(['5.0000']);
  });

  it('works out a unit cost to 4 decimals', () => {
    expect(unitCostOf('1000', '3')).toBe('333.3333');
    expect(unitCostOf('8.512', '10')).toBe('0.8512');
    expect(() => unitCostOf('10', '0')).toThrow();
  });

  it('compares and negates', () => {
    expect(compareMoney('10', '10.0000')).toBe(0);
    expect(compareMoney('-1', '0')).toBe(-1);
    expect(negateMoney('12.5')).toBe('-12.5000');
    expect(negateMoney('0')).toBe('0.0000');
  });
});
