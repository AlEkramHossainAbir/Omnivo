import type { LanguageCode } from '@omnivo/contracts';

import { emailHtml, emailText } from './layout.js';
import type { MailMessage } from './mail.service.js';

interface WelcomeEmailInput {
  to: string;
  fullName: string;
  workspaceName: string;
  // Where the sign-in page is: {APP_ORIGIN}/login
  signInLink: string;
  language: LanguageCode;
}

interface Copy {
  subject: string;
  intro: string;
  button: string;
  signIn: string;
  reason: string;
}

// Same shape as invitation-email.ts: both languages side by side, satisfies keeps them equal.
// Step 3b: the last line says how to sign in. A new owner does not know yet that there is no
// workspace address to remember, and one sentence saves a support call.
function copy(input: WelcomeEmailInput): Record<LanguageCode, Copy> {
  const { fullName: name, workspaceName: workspace } = input;
  return {
    en: {
      subject: `Welcome to Omnivo, ${name}`,
      intro: `${workspace} is ready. Pick your business type in the setup wizard, then invite your accountant and managers.`,
      button: `Open ${workspace}`,
      signIn: 'Sign in with this email address and your password.',
      reason: 'You get this email because you created a workspace on Omnivo.',
    },
    bn: {
      subject: `Omnivo-তে স্বাগতম, ${name}`,
      intro: `${workspace} তৈরি। setup wizard-এ ব্যবসার ধরন বাছুন, তারপর আপনার অ্যাকাউন্ট্যান্ট আর ম্যানেজারদের ডাকুন।`,
      button: `${workspace} খুলুন`,
      signIn: 'এই ইমেইল ঠিকানা আর আপনার পাসওয়ার্ড দিয়ে লগইন করুন।',
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
    footer: [text.signIn, text.reason],
  };
  return { to: input.to, subject: text.subject, text: emailText(body), html: emailHtml(body) };
}
