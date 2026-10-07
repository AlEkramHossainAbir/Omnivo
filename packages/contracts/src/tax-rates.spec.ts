import { describe, expect, it } from 'vitest';

import { taxRateInputSchema } from './tax-rates.js';

describe('VAT rate input', () => {
  it('takes a standard rate with up to 2 decimals', () => {
    expect(
      taxRateInputSchema.parse({
        name: 'VAT 7.5%',
        kind: 'reduced',
        rate: '7.5',
        isDefault: false,
      }),
    ).toMatchObject({ rate: '7.5' });
  });

  it('refuses a charged kind at 0%, and a zero-rated or exempt kind with a rate', () => {
    for (const [kind, rate] of [
      ['standard', '0'],
      ['reduced', '0.00'],
      ['zero_rated', '15'],
      ['exempt', '5'],
    ]) {
      const result = taxRateInputSchema.safeParse({ name: 'VAT', kind, rate, isDefault: false });
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ path: ['rate'], message: 'tax_rate_kind_rate' }),
      ]);
    }
  });

  it('refuses 100% and more than 2 decimals', () => {
    for (const rate of ['100', '15.005', '-5', '']) {
      const result = taxRateInputSchema.safeParse({
        name: 'VAT',
        kind: 'standard',
        rate,
        isDefault: false,
      });
      expect(result.error?.issues[0]?.message).toBe('tax_rate_format');
    }
  });
});
