import { describe, expect, it } from 'vitest';

import { codeSms, confirmedSms } from './shop-sms.js';

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
});
