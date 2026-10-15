import { describe, expect, it } from 'vitest';

import {
  type DocumentEmailFormValues,
  documentEmailInputSchema,
  whatsAppNumber,
  whatsAppUrl,
} from './document-output.js';

describe('whatsAppNumber', () => {
  it('adds the country code to a Bangladeshi mobile number as people write it', () => {
    expect(whatsAppNumber('01711-000000')).toBe('8801711000000');
    expect(whatsAppNumber('01711 000 000')).toBe('8801711000000');
    expect(whatsAppNumber('8801711000000')).toBe('8801711000000');
  });

  it('keeps an international number written with + or 00', () => {
    expect(whatsAppNumber('+880 1711-000000')).toBe('8801711000000');
    expect(whatsAppNumber('+44 20 7946 0958')).toBe('442079460958');
    expect(whatsAppNumber('0044 20 7946 0958')).toBe('442079460958');
  });

  it('gives up on a land line, an extension or no phone', () => {
    expect(whatsAppNumber('02-9887766')).toBeNull();
    expect(whatsAppNumber('+12')).toBeNull();
    expect(whatsAppNumber(null)).toBeNull();
  });
});

describe('whatsAppUrl', () => {
  it('encodes the message, with or without a number', () => {
    expect(whatsAppUrl('01711-000000', 'Invoice INV-1: ৳100')).toBe(
      'https://wa.me/8801711000000?text=Invoice%20INV-1%3A%20%E0%A7%B3100',
    );
    expect(whatsAppUrl(null, 'Hi')).toBe('https://wa.me/?text=Hi');
  });
});

function email(extra: Partial<DocumentEmailFormValues> = {}): DocumentEmailFormValues {
  return {
    to: 'accounts@rahman-traders.com',
    cc: '',
    subject: 'Invoice INV-2026-27-0042 from Karim Garments',
    message: '',
    language: 'en',
    ...extra,
  };
}

describe('document email input', () => {
  it('reads a list of addresses as people paste them, without duplicates', () => {
    const parsed = documentEmailInputSchema.parse(
      email({ to: 'A@x.com, b@y.com;a@x.com', cc: ' c@z.com ' }),
    );
    expect(parsed.to).toEqual(['a@x.com', 'b@y.com']);
    expect(parsed.cc).toEqual(['c@z.com']);
  });

  it('puts one error on the box, not on an address inside it', () => {
    const result = documentEmailInputSchema.safeParse(email({ to: 'a@x.com, not-an-email' }));
    expect(result.error?.issues).toMatchObject([{ path: ['to'], message: 'email_invalid' }]);
  });

  it('needs someone to send to, and at most five in a box', () => {
    expect(documentEmailInputSchema.safeParse(email({ to: ' ' })).error?.issues[0]?.message).toBe(
      'email_to_required',
    );
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `${name}@x.com`).join(',');
    expect(documentEmailInputSchema.safeParse(email({ cc: six })).error?.issues[0]).toMatchObject({
      path: ['cc'],
      message: 'email_too_many',
    });
  });

  it('needs a subject', () => {
    expect(
      documentEmailInputSchema.safeParse(email({ subject: '  ' })).error?.issues[0]?.message,
    ).toBe('email_subject_required');
  });
});
