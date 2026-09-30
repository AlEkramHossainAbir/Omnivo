import type { LanguageCode } from '@omnivo/contracts';

import { emailHtml, emailText } from './layout.js';
import type { MailMessage } from './mail.service.js';

interface WelcomeEmailInput {
  to: string;
  fullName: string;
  workspaceName: string;
  workspaceSlug: string;
  // Where the sign-in page is: {APP_ORIGIN}/login
  signInLink: string;
  language: LanguageCode;
}

interface Copy {
  subject: string;
  intro: string;
  button: string;
  address: string;
  reason: string;
}

// Same shape as invitation-email.ts: both languages side by side, satisfies keeps them equal.
// The address line matters: people forget their workspace address, and sign-in asks for it.
function copy(input: WelcomeEmailInput): Record<LanguageCode, Copy> {
  const { fullName: name, workspaceName: workspace } = input;
  const address = `${input.workspaceSlug}.omnivo.app`;
  return {
    en: {
      subject: `Welcome to Omnivo, ${name}`,
      intro: `${workspace} is ready. Pick your business type in the setup wizard, then invite your accountant and managers.`,
      button: `Open ${workspace}`,
      address: `Your workspace address is ${address}. You need it to sign in.`,
      reason: 'You get this email because you created a workspace on Omnivo.',
    },
    bn: {
      subject: `Omnivo-তে স্বাগতম, ${name}`,
      intro: `${workspace} তৈরি। setup wizard-এ ব্যবসার ধরন বাছুন, তারপর আপনার অ্যাকাউন্ট্যান্ট আর ম্যানেজারদের ডাকুন।`,
      button: `${workspace} খুলুন`,
      address: `আপনার workspace-এর ঠিকানা ${address}। লগইন করতে এটা লাগবে।`,
      reason: 'Omnivo-তে workspace তৈরি করেছেন বলে এই ইমেইল পেয়েছেন।',
    },
  } satisfies Record<LanguageCode, Copy>;
}

export function welcomeEmail(input: WelcomeEmailInput): MailMessage {
  const text = copy(input)[input.language];
  const body = {
    language: input.language,
    intro: text.intro,
    button: { label: text.button, href: input.signInLink },
    footer: [text.address, text.reason],
  };
  return { to: input.to, subject: text.subject, text: emailText(body), html: emailHtml(body) };
}
