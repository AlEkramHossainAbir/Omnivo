import { describe, expect, it } from 'vitest';

import {
  absMoney,
  addMoney,
  amountSchema,
  isNegativeMoney,
  isZeroMoney,
  subtractMoney,
  sumMoney,
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
});
