import { describe, expect, it } from 'vitest';

import { cancelledSms, codeSms, confirmedSms, returnedSms } from './shop-sms.js';

describe('the shop SMS', () => {
  it('puts the code first, in ASCII digits in both languages', () => {
    expect(codeSms('en', 'Nirvor', '042317')).toBe(
      '042317 is your Nirvor order code. It works for 10 minutes. Do not share it.',
    );
    expect(codeSms('bn', 'নির্ভর', '042317')).toMatch(
      /^042317 আপনার নির্ভর অর্ডারের কোড। ১০ মিনিট/,
    );
  });

  it('carries the number and the link after the right code', () => {
    const link = 'https://nirvor.omnivo.shop/t/AbCdEfGhIjKlMnOpQrStUv';
    expect(confirmedSms('en', 'Nirvor', 'W-000123', link)).toBe(
      `Nirvor: order W-000123 is confirmed. Track it here: ${link}`,
    );
    expect(confirmedSms('bn', 'Nirvor', 'W-000123', link)).toContain(link);
  });

  it('says the order was cancelled and where to ask, never why', () => {
    expect(cancelledSms('en', 'Nirvor', 'W-000123', '09610-123456')).toBe(
      'Nirvor: order W-000123 was cancelled. Questions? Call 09610-123456.',
    );
    expect(cancelledSms('bn', 'নির্ভর', 'W-000123', '09610-123456')).toBe(
      'নির্ভর: অর্ডার W-000123 বাতিল করা হয়েছে। কিছু জানতে কল করুন 09610-123456।',
    );
  });

  // Step 28b: Receive the return, like the cancel: the hotline, never the staff's reason
  it('says the order came back and where to ask', () => {
    expect(returnedSms('en', 'Nirvor', 'W-000123', '09610-123456')).toBe(
      'Nirvor: order W-000123 came back to us and is closed. Questions? Call 09610-123456.',
    );
    expect(returnedSms('bn', 'নির্ভর', 'W-000123', '09610-123456')).toBe(
      'নির্ভর: অর্ডার W-000123 ফেরত এসেছে, অর্ডারটি বন্ধ করা হলো। কিছু জানতে কল করুন 09610-123456।',
    );
  });
});
