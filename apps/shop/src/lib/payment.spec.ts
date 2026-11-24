import { describe, expect, it } from 'vitest';

import { isCodeWait, paymentUrlOf } from './payment';

describe('paymentUrlOf (step 27d)', () => {
  it('believes an http(s) address', () => {
    const page = 'https://sandbox.sslcommerz.com/EasyCheckOut/testcde123';
    expect(paymentUrlOf({ paymentUrl: page })).toBe(page);
    expect(paymentUrlOf({ paymentUrl: 'http://nirvor.localhost:4321/checkout/fake-gateway' })).toBe(
      'http://nirvor.localhost:4321/checkout/fake-gateway',
    );
    expect(paymentUrlOf({ paymentUrl: null })).toBeNull();
  });

  it('refuses anything that could leave the shop for a script or another site', () => {
    expect(paymentUrlOf({ paymentUrl: 'javascript:alert(1)' })).toBeUndefined();
    // A path has no protocol of its own: new URL() refuses it
    expect(paymentUrlOf({ paymentUrl: '/checkout/fake-gateway' })).toBeUndefined();
    expect(paymentUrlOf({ paymentUrl: '//evil.example/pay' })).toBeUndefined();
    expect(paymentUrlOf({ paymentUrl: 'not a url' })).toBeUndefined();
    expect(paymentUrlOf({ paymentUrl: 42 })).toBeUndefined();
    expect(paymentUrlOf({ code: 'internal_error' })).toBeUndefined();
    expect(paymentUrlOf(null)).toBeUndefined();
  });
});

describe('isCodeWait', () => {
  it('knows the verify page’s answer', () => {
    expect(isCodeWait({ next: 'verify', maskedPhone: '+880 17•• ••• 356' })).toBe(true);
    expect(isCodeWait({ next: 'pay' })).toBe(false);
    expect(isCodeWait('verify')).toBe(false);
  });
});
