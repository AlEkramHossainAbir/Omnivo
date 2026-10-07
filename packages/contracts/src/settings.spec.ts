import { describe, expect, it } from 'vitest';

import { createUploadInputSchema } from './attachments.js';
import { branchInputSchema } from './branches.js';
import { isTimeZone, updateSettingsInputSchema } from './settings.js';

const valid = {
  version: 1,
  companyName: 'Rahman Garments Ltd.',
  legalName: '',
  bin: '',
  phone: '',
  email: '',
  address: '',
  baseCurrency: 'BDT',
  fiscalYearStartMonth: 7,
  timezone: 'Asia/Dhaka',
  allowNegativeStock: false,
  pricesIncludeVat: false,
} as const;

describe('settings input', () => {
  it('stores empty optional fields as null, not as empty strings', () => {
    const parsed = updateSettingsInputSchema.parse(valid);
    expect(parsed).toMatchObject({ legalName: null, bin: null, phone: null, email: null });
  });

  it('keeps only the digits of a BIN written with a hyphen', () => {
    const parsed = updateSettingsInputSchema.parse({ ...valid, bin: '000123456-0101' });
    expect(parsed.bin).toBe('0001234560101');
  });

  it('refuses a BIN that is not 13 digits, with a field code', () => {
    const result = updateSettingsInputSchema.safeParse({ ...valid, bin: '12345' });
    expect(result.error?.issues[0]).toMatchObject({ path: ['bin'], message: 'bin_format' });
  });

  it('checks the time zone against Intl', () => {
    expect(isTimeZone('Asia/Dhaka')).toBe(true);
    expect(isTimeZone('Asia/Gazipur')).toBe(false);
  });
});

describe('branch input', () => {
  it('upper-cases the code so gzp and GZP are the same branch', () => {
    const parsed = branchInputSchema.parse({
      code: 'gzp',
      name: 'Gazipur factory',
      phone: '',
      address: '',
    });
    expect(parsed.code).toBe('GZP');
  });
});

describe('upload input', () => {
  it('refuses an SVG logo and an oversized one, on the right fields', () => {
    const result = createUploadInputSchema.safeParse({
      purpose: 'company_logo',
      fileName: 'logo.svg',
      contentType: 'image/svg+xml',
      sizeBytes: 3 * 1024 * 1024,
    });
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['contentType', 'file_type_not_allowed'],
      ['sizeBytes', 'file_too_large'],
    ]);
  });
});
