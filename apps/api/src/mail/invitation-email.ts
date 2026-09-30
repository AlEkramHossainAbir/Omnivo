import { INVITATION_TTL_DAYS, type LanguageCode } from '@omnivo/contracts';

import { emailHtml, emailText } from './layout.js';
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

export function invitationEmail(input: InvitationEmailInput): MailMessage {
  const text = copy(input)[input.language];
  const body = {
    language: input.language,
    intro: text.intro,
    button: { label: text.button, href: input.link },
    footer: [text.expiry, text.ignore],
  };
  return { to: input.to, subject: text.subject, text: emailText(body), html: emailHtml(body) };
}
