import { describe, expect, it } from 'vitest';

import { verificationEmail } from './verification-email.js';

const input = {
  to: 'farhana@rahmangarments.com',
  fullName: 'Farhana Rahman',
  workspaceName: 'Rahman Garments Ltd.',
  link: 'http://localhost:5173/verify-email#abc',
} as const;

describe('verificationEmail', () => {
  it('has the link as its button, and says how long it works', () => {
    const mail = verificationEmail({ ...input, language: 'en' });
    expect(mail.subject).toBe('Confirm your email for Omnivo');
    expect(mail.text).toContain('Confirm email: http://localhost:5173/verify-email#abc');
    expect(mail.html).toContain('href="http://localhost:5173/verify-email#abc"');
    expect(mail.text).toContain('The link works for 24 hours, once.');
    expect(mail.text).toContain('to open Rahman Garments Ltd.');
  });

  it('is written in the owner’s language', () => {
    const mail = verificationEmail({ ...input, language: 'bn' });
    expect(mail.subject).toBe('Omnivo-র জন্য আপনার ইমেইল নিশ্চিত করুন');
    expect(mail.html).toContain('<html lang="bn">');
  });

  it('escapes a company name that looks like HTML', () => {
    const mail = verificationEmail({
      ...input,
      workspaceName: '<a href="https://evil.example">Rahman</a>',
      language: 'en',
    });
    expect(mail.html).not.toContain('<a href="https://evil.example">');
  });
});
