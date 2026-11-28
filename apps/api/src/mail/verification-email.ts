import { EMAIL_VERIFICATION_TTL_HOURS, type LanguageCode } from '@omnivo/contracts';

import { emailHtml, emailText } from './layout.js';
import type { MailMessage } from './mail.service.js';

interface VerificationEmailInput {
  to: string;
  fullName: string;
  workspaceName: string;
  // {APP_ORIGIN}/verify-email#<token> (verifyEmailLink in @omnivo/contracts)
  link: string;
  language: LanguageCode;
}

interface Copy {
  subject: string;
  intro: string;
  button: string;
  expiry: string;
  reason: string;
}

// Same shape as welcome-email.ts: both languages side by side, satisfies keeps them equal. The
// person may not have picked a language yet (users.language is NULL at sign-up), so English is the
// handler's fallback, as for the welcome email.
function copy(input: VerificationEmailInput): Record<LanguageCode, Copy> {
  const { fullName: name, workspaceName: workspace } = input;
  const hours = EMAIL_VERIFICATION_TTL_HOURS;
  return {
    en: {
      subject: 'Confirm your email for Omnivo',
      intro: `Hi ${name}, confirm that this is your email address to open ${workspace}.`,
      button: 'Confirm email',
      expiry: `The link works for ${String(hours)} hours, once. If it has ended, sign in with your email and password, and we send a new one.`,
      reason:
        'You get this email because someone created a workspace on Omnivo with this address. If it was not you, ignore it.',
    },
    bn: {
      subject: 'Omnivo-র জন্য আপনার ইমেইল নিশ্চিত করুন',
      intro: `${name}, ${workspace} খুলতে নিশ্চিত করুন যে এটা আপনার ইমেইল ঠিকানা।`,
      button: 'ইমেইল নিশ্চিত করুন',
      expiry: `লিংকটা ${String(hours)} ঘণ্টা কাজ করে, একবারই। মেয়াদ শেষ হলে ইমেইল আর পাসওয়ার্ড দিয়ে সাইন ইন করুন, আমরা নতুন লিংক পাঠাব।`,
      reason:
        'এই ঠিকানা দিয়ে কেউ Omnivo-তে workspace তৈরি করেছে বলে এই ইমেইল পেয়েছেন। আপনি না হলে এটা উপেক্ষা করুন।',
    },
  } satisfies Record<LanguageCode, Copy>;
}

export function verificationEmail(input: VerificationEmailInput): MailMessage {
  const text = copy(input)[input.language];
  const body = {
    language: input.language,
    intro: text.intro,
    button: { label: text.button, href: input.link },
    footer: [text.expiry, text.reason],
  };
  return { to: input.to, subject: text.subject, text: emailText(body), html: emailHtml(body) };
}
