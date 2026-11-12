import { describe, expect, it } from 'vitest';

import { spacedPhone } from './phone';
import {
  codeDigits,
  fillWords,
  isOrderConfirmed,
  problemParts,
  resendSeconds,
  waitText,
} from './verify';

describe('codeDigits', () => {
  it('keeps six ASCII digits from what the shopper typed or pasted', () => {
    expect(codeDigits('123 456', 6)).toBe('123456');
    expect(codeDigits('১২৩৪৫৬', 6)).toBe('123456');
    expect(codeDigits('Your code: 1234567', 6)).toBe('123456');
    expect(codeDigits('abc', 6)).toBe('');
  });
});

describe('waitText', () => {
  it('writes minutes and two-digit seconds', () => {
    expect(waitText(45, 'en-IN')).toBe('0:45');
    expect(waitText(65, 'en-IN')).toBe('1:05');
    expect(waitText(9.2, 'en-IN')).toBe('0:10');
  });

  it('counts in Bangla digits and never below zero', () => {
    expect(waitText(45, 'bn-BD')).toBe('০:৪৫');
    expect(waitText(-3, 'en-IN')).toBe('0:00');
  });
});

describe('fillWords', () => {
  it('fills every placeholder and leaves an unknown one', () => {
    expect(fillWords('{{count}} of {{count}} {{other}}', { count: '2' })).toBe('2 of 2 {{other}}');
  });
});

describe('the answers the verify page reads', () => {
  it('reads a problem’s code and params', () => {
    expect(problemParts({ code: 'shop_code_wrong', params: { triesLeft: 2 } })).toEqual({
      code: 'shop_code_wrong',
      params: { triesLeft: 2 },
    });
    expect(problemParts({ code: 'shop_code_no_order' })).toEqual({
      code: 'shop_code_no_order',
      params: {},
    });
    expect(problemParts('<html>Bad gateway</html>')).toBeNull();
  });

  it('takes a confirmed order only with its number and phone', () => {
    expect(isOrderConfirmed({ orderNo: 'W-000001', phone: '01786120356' })).toBe(true);
    expect(isOrderConfirmed({ orderNo: '', phone: '01786120356' })).toBe(false);
    expect(isOrderConfirmed({ orderNo: 1, phone: '01786120356' })).toBe(false);
  });

  it('reads the wait from a resend answer and from a 429', () => {
    expect(resendSeconds({ resendInSeconds: 45 })).toBe(45);
    expect(resendSeconds({ code: 'shop_code_resend_wait', params: { seconds: 12 } })).toBe(12);
    expect(resendSeconds({ resendInSeconds: -1 })).toBeNull();
    expect(resendSeconds(null)).toBeNull();
  });
});

describe('spacedPhone', () => {
  it('writes a mobile number as 5 + 6 digits', () => {
    expect(spacedPhone('01786120356')).toBe('01786 120356');
    expect(spacedPhone('+8801786')).toBe('+8801786');
  });
});
