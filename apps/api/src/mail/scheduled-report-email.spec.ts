import { describe, expect, it } from 'vitest';

import { scheduledReportEmail } from './scheduled-report-email.js';

const input = {
  to: 'mitu@karnaphulipharma.com',
  language: 'en',
  company: 'Karnaphuli Pharma Distributors',
  title: 'VAT report',
  period: '1 Oct 2026 – 31 Oct 2026',
  frequency: 'monthly',
  fileName: 'vat-2026-10-01-to-2026-10-31.pdf',
  file: { bytes: new TextEncoder().encode('%PDF-1.3'), contentType: 'application/pdf' },
  schedulesUrl: 'https://app.omnivo.app/reports/schedules',
  exportsUrl: 'https://app.omnivo.app/reports/exports',
} as const;

describe('scheduledReportEmail', () => {
  it('attaches the file, and its button opens the schedules page', () => {
    const mail = scheduledReportEmail(input);
    expect(mail).toMatchObject({
      to: 'mitu@karnaphulipharma.com',
      subject: 'VAT report, 1 Oct 2026 – 31 Oct 2026 · Karnaphuli Pharma Distributors',
    });
    expect(mail.attachments).toEqual([
      {
        filename: 'vat-2026-10-01-to-2026-10-31.pdf',
        content: Buffer.from('%PDF-1.3'),
        contentType: 'application/pdf',
      },
    ]);
    // Our own email (no "via"): the person is a member, not a customer
    expect(mail).not.toHaveProperty('fromName');
    expect(mail.text).toBe(
      'VAT report for 1 Oct 2026 – 31 Oct 2026.\n\n' +
        'Change this email: https://app.omnivo.app/reports/schedules\n\n' +
        'The file is attached: vat-2026-10-01-to-2026-10-31.pdf\n' +
        'You get this email because Karnaphuli Pharma Distributors sends this report to you every month.\n',
    );
    expect(mail.html).toContain('href="https://app.omnivo.app/reports/schedules"');
  });

  it('links to the exports page when the file is too large, and still says how to stop it', () => {
    const mail = scheduledReportEmail({ ...input, file: null });
    expect(mail).not.toHaveProperty('attachments');
    expect(mail.text).toBe(
      'VAT report for 1 Oct 2026 – 31 Oct 2026.\n\n' +
        'The file is too large to attach. Sign in to download it from your exports.\n\n' +
        'Download the file: https://app.omnivo.app/reports/exports\n\n' +
        'You get this email because Karnaphuli Pharma Distributors sends this report to you every month.\n' +
        'To change or stop it: https://app.omnivo.app/reports/schedules\n',
    );
  });

  it("speaks the person's language, with the frequency in words", () => {
    const mail = scheduledReportEmail({
      ...input,
      language: 'bn',
      title: 'VAT রিপোর্ট',
      period: '১ অক্টো, ২০২৬ – ৩১ অক্টো, ২০২৬',
      frequency: 'weekly',
    });
    expect(mail.subject).toBe(
      'VAT রিপোর্ট, ১ অক্টো, ২০২৬ – ৩১ অক্টো, ২০২৬ · Karnaphuli Pharma Distributors',
    );
    expect(mail.text).toContain('এই ইমেইল বদলান: https://app.omnivo.app/reports/schedules');
    expect(mail.text).toContain('প্রতি সপ্তাহে আপনাকে পাঠায়');
    expect(mail.html).toContain('lang="bn"');
  });
});
