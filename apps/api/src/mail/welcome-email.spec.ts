import { describe, expect, it } from 'vitest';

import { welcomeEmail } from './welcome-email.js';

const input = {
  to: 'farhana@rahmangarments.com',
  fullName: 'Farhana Rahman',
  workspaceName: 'Rahman Garments Ltd.',
  workspaceSlug: 'rahman-garments',
  signInLink: 'http://localhost:5173/login',
} as const;

describe('welcomeEmail', () => {
  it('names the workspace address, which sign-in asks for', () => {
    const mail = welcomeEmail({ ...input, language: 'en' });
    expect(mail.subject).toBe('Welcome to Omnivo, Farhana Rahman');
    expect(mail.text).toContain('rahman-garments.omnivo.app');
    expect(mail.text).toContain('Open Rahman Garments Ltd.: http://localhost:5173/login');
    expect(mail.html).toContain('href="http://localhost:5173/login"');
  });

  it('is written in the owner’s language', () => {
    const mail = welcomeEmail({ ...input, language: 'bn' });
    expect(mail.subject).toBe('Omnivo-তে স্বাগতম, Farhana Rahman');
    expect(mail.html).toContain('<html lang="bn">');
  });

  // The frame (layout.ts) escapes every text, so no template can forget it
  it('escapes a company name that looks like HTML', () => {
    const mail = welcomeEmail({
      ...input,
      workspaceName: '<a href="https://evil.example">Rahman</a>',
      language: 'en',
    });
    expect(mail.html).not.toContain('<a href="https://evil.example">');
    expect(mail.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
  });
});
