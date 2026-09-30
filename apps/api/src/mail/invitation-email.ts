import { INVITATION_TTL_DAYS, type LanguageCode } from '@omnivo/contracts';

import type { MailMessage } from './mail.service.js';

interface InvitationEmailInput {
  to: string;
  workspaceName: string;
  inviterName: string;
  link: string;
  // যিনি ডাকছেন তাঁর ভাষা — একই কোম্পানির লোক সাধারণত একই ভাষায় কাজ করে। তিনি না বাছলে ইংরেজি
  language: LanguageCode;
}

interface Copy {
  subject: string;
  intro: string;
  button: string;
  expiry: string;
  ignore: string;
}

// ইমেইলের লেখা সার্ভারে, i18n-এ না: @omnivo/i18n ব্রাউজারের জন্য (React hook, i18next) — API-তে সেটা
// টানলে সার্ভারে React আসত। দুই ভাষার লেখা এখানে পাশাপাশি; satisfies দুটোকেই একই আকারে বাঁধে
function copy(input: InvitationEmailInput): Record<LanguageCode, Copy> {
  const { workspaceName: workspace, inviterName: inviter } = input;
  return {
    en: {
      subject: `${inviter} invited you to ${workspace} on Omnivo`,
      intro: `${inviter} invited you to join ${workspace} on Omnivo.`,
      button: `Join ${workspace}`,
      expiry: `The link works for ${String(INVITATION_TTL_DAYS)} days and only once.`,
      ignore: "If you weren't expecting this, you can ignore this email.",
    },
    bn: {
      subject: `${inviter} আপনাকে Omnivo-তে ${workspace}-এ যোগ দিতে ডেকেছেন`,
      intro: `${inviter} আপনাকে Omnivo-তে ${workspace}-এ যোগ দিতে ডেকেছেন।`,
      button: `${workspace}-এ যোগ দিন`,
      expiry: `লিংকটা ${new Intl.NumberFormat('bn-BD').format(INVITATION_TTL_DAYS)} দিন কাজ করবে, একবারই।`,
      ignore: 'এই ইমেইল আশা না করে থাকলে এটা এড়িয়ে যান।',
    },
  } satisfies Record<LanguageCode, Copy>;
}

// HTML-এ বসানোর আগে: কোম্পানির নাম আর মানুষের নাম ইউজারের লেখা — "<a href=…>" নামে কোম্পানি খুললে
// escape ছাড়া সেটা ইমেইলে সত্যিকারের লিংক হয়ে যেত (phishing-এর সহজ পথ)
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function invitationEmail(input: InvitationEmailInput): MailMessage {
  const text = copy(input)[input.language];
  const html = `<!doctype html>
<html lang="${input.language}">
  <body style="margin:0;padding:32px 16px;background:#F6F7F9;font-family:'Segoe UI',system-ui,sans-serif;color:#0F1728">
    <div style="max-width:480px;margin:0 auto;padding:32px;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:14px">
      <p style="margin:0 0 24px;font-size:17px;font-weight:600">Omnivo</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.5">${escapeHtml(text.intro)}</p>
      <a href="${escapeHtml(input.link)}" style="display:inline-block;padding:11px 16px;background:#1F47B5;color:#FFFFFF;border-radius:10px;font-weight:500;text-decoration:none">${escapeHtml(text.button)}</a>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.45;color:#475467">${escapeHtml(text.expiry)}<br>${escapeHtml(text.ignore)}</p>
    </div>
  </body>
</html>
`;
  return {
    to: input.to,
    subject: text.subject,
    text: `${text.intro}\n\n${text.button}: ${input.link}\n\n${text.expiry}\n${text.ignore}\n`,
    html,
  };
}
