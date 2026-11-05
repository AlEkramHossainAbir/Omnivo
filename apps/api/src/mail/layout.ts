import type { LanguageCode } from '@omnivo/contracts';

// HTML-এ বসানোর আগে: কোম্পানির নাম আর মানুষের নাম ইউজারের লেখা — "<a href=…>" নামে কোম্পানি খুললে
// escape ছাড়া সেটা ইমেইলে সত্যিকারের লিংক হয়ে যেত (phishing-এর সহজ পথ)
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface EmailBody {
  language: LanguageCode;
  // The name at the top. Omnivo's own emails leave it out; a document email (step 16) is the
  // company's, so it carries the company's name.
  heading?: string;
  // Line breaks are kept (a document email's message is typed by a person). '' = no paragraph.
  intro: string;
  // null: no button (a document email: the PDF is attached, there is nothing to click)
  button: { label: string; href: string } | null;
  // Small grey lines under the button (how long the link works, why you got this)
  footer: string[];
}

// One frame for every email, so they all look the same. Inline styles only: most mail apps drop
// <style> blocks. Every text passes through escapeHtml here, so a template cannot forget it.
export function emailHtml(body: EmailBody): string {
  const footer = body.footer.map(escapeHtml).join('<br>');
  // Escaped first, then the line breaks: a <br> the escaping cannot touch, and nothing else
  const intro =
    body.intro === ''
      ? ''
      : `<p style="margin:0 0 24px;font-size:15px;line-height:1.5">${escapeHtml(body.intro).replaceAll('\n', '<br>')}</p>`;
  const button =
    body.button === null
      ? ''
      : `<a href="${escapeHtml(body.button.href)}" style="display:inline-block;padding:11px 16px;background:#1F47B5;color:#FFFFFF;border-radius:10px;font-weight:500;text-decoration:none">${escapeHtml(body.button.label)}</a>
      `;
  return `<!doctype html>
<html lang="${body.language}">
  <body style="margin:0;padding:32px 16px;background:#F6F7F9;font-family:'Segoe UI',system-ui,sans-serif;color:#0F1728">
    <div style="max-width:480px;margin:0 auto;padding:32px;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:14px">
      <p style="margin:0 0 24px;font-size:17px;font-weight:600">${escapeHtml(body.heading ?? 'Omnivo')}</p>
      ${intro}
      ${button}<p style="margin:24px 0 0;font-size:13px;line-height:1.45;color:#475467">${footer}</p>
    </div>
  </body>
</html>
`;
}

// The plain-text part, for mail apps (and spam filters) that do not show HTML
export function emailText(body: EmailBody): string {
  const parts = [
    body.intro,
    body.button === null ? '' : `${body.button.label}: ${body.button.href}`,
    body.footer.join('\n'),
  ];
  return `${parts.filter((part) => part !== '').join('\n\n')}\n`;
}
