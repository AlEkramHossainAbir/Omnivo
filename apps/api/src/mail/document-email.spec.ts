import { describe, expect, it } from 'vitest';

import { documentEmail } from './document-email.js';

const input = {
  to: ['orders@bhairabbazar.com'],
  cc: [],
  subject: 'Invoice INV-2026-27-0001 from Meghna Distributors Ltd.',
  message: 'Dear Bhairab Bazar Traders,\n\nPlease find the invoice attached.',
  language: 'en',
  company: 'Meghna Distributors Ltd.',
  sender: 'Shafiq Ahmed',
  replyTo: 'accounts@meghnadistributors.com',
  file: { name: 'INV-2026-27-0001.pdf', bytes: new TextEncoder().encode('%PDF-1.3') },
} as const;

describe('documentEmail', () => {
  it("is the company's, sent from our address, with replies to the company", () => {
    const mail = documentEmail(input);
    expect(mail).toMatchObject({
      to: ['orders@bhairabbazar.com'],
      fromName: 'Meghna Distributors Ltd. via Omnivo',
      replyTo: 'accounts@meghnadistributors.com',
      subject: input.subject,
    });
    expect(mail.attachments).toEqual([
      {
        filename: 'INV-2026-27-0001.pdf',
        content: Buffer.from('%PDF-1.3'),
        contentType: 'application/pdf',
      },
    ]);
    // The company at the top, where our own emails say "Omnivo", and no button
    expect(mail.html).toContain('font-weight:600">Meghna Distributors Ltd.</p>');
    expect(mail.html).not.toContain('<a href=');
  });

  it("puts the person's message first, then lines they cannot change", () => {
    expect(documentEmail(input).text).toBe(
      'Dear Bhairab Bazar Traders,\n\nPlease find the invoice attached.\n\n' +
        'Attached: INV-2026-27-0001.pdf\n' +
        'Shafiq Ahmed sent this from Meghna Distributors Ltd. using Omnivo.\n' +
        'To reach Meghna Distributors Ltd., reply to this email.\n',
    );
  });

  it('says nothing about replying when the company has no email', () => {
    const mail = documentEmail({ ...input, replyTo: null });
    expect(mail).not.toHaveProperty('replyTo');
    expect(mail.text).not.toContain('reply');
  });

  it('keeps the line breaks of the message, and shows HTML in it as text', () => {
    const mail = documentEmail({ ...input, message: 'Dear Rafiq,\n<script>alert(1)</script>' });
    expect(mail.html).toContain('Dear Rafiq,<br>&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).not.toContain('<script>');
  });

  it('writes its own lines in the language of the document', () => {
    const mail = documentEmail({ ...input, language: 'bn' });
    expect(mail.text).toContain('সংযুক্ত: INV-2026-27-0001.pdf');
    expect(mail.html).toContain('<html lang="bn">');
  });
});
