import type { LanguageCode, ReportScheduleFrequency } from '@omnivo/contracts';

import { emailHtml, emailText } from './layout.js';
import type { MailMessage } from './mail.service.js';

// A scheduled report (step 21c), to one member of the workspace. Omnivo's own email, like the
// invitation: our address and name, the company's name at the top. The file is attached up to
// 5 MB (decision 7); a larger one is a button to the person's Exports page, which needs a sign-in,
// so a forwarded email never hands a big file to someone else either.

interface ScheduledReportEmailInput {
  to: string;
  // The person's own language, like the file
  language: LanguageCode;
  company: string;
  // The report's title and its period, already in the person's language
  title: string;
  period: string;
  frequency: ReportScheduleFrequency;
  fileName: string;
  // null: too large to attach, so the button opens the Exports page instead
  file: { bytes: Uint8Array; contentType: string } | null;
  schedulesUrl: string;
  exportsUrl: string;
}

interface Copy {
  every: Record<ReportScheduleFrequency, string>;
  subject: (title: string, period: string, company: string) => string;
  intro: (title: string, period: string) => string;
  attached: (file: string) => string;
  tooLarge: string;
  download: string;
  manage: string;
  why: (company: string, every: string) => string;
  stop: (link: string) => string;
}

// The words here, not in @omnivo/i18n, for the reason invitation-email.ts gives: that package is for
// the browser. satisfies: a text missing in one language does not compile.
const COPY = {
  en: {
    every: { daily: 'every day', weekly: 'every week', monthly: 'every month' },
    subject: (title, period, company) => `${title}, ${period} · ${company}`,
    intro: (title, period) => `${title} for ${period}.`,
    attached: (file) => `The file is attached: ${file}`,
    tooLarge: 'The file is too large to attach. Sign in to download it from your exports.',
    download: 'Download the file',
    manage: 'Change this email',
    why: (company, every) =>
      `You get this email because ${company} sends this report to you ${every}.`,
    stop: (link) => `To change or stop it: ${link}`,
  },
  bn: {
    every: { daily: 'প্রতিদিন', weekly: 'প্রতি সপ্তাহে', monthly: 'প্রতি মাসে' },
    subject: (title, period, company) => `${title}, ${period} · ${company}`,
    intro: (title, period) => `${title}, ${period}।`,
    attached: (file) => `ফাইলটা সাথে দেওয়া আছে: ${file}`,
    tooLarge: 'ফাইলটা ইমেইলে দেওয়ার জন্য অনেক বড়। সাইন ইন করে আপনার এক্সপোর্ট থেকে ডাউনলোড করুন।',
    download: 'ফাইল ডাউনলোড করুন',
    manage: 'এই ইমেইল বদলান',
    why: (company, every) =>
      `এই ইমেইল আপনি পাচ্ছেন কারণ ${company} এই রিপোর্টটা ${every} আপনাকে পাঠায়।`,
    stop: (link) => `বদলাতে বা বন্ধ করতে: ${link}`,
  },
} satisfies Record<LanguageCode, Copy>;

export function scheduledReportEmail(input: ScheduledReportEmailInput): MailMessage {
  const copy: Copy = COPY[input.language];
  const intro = copy.intro(input.title, input.period);
  const body = {
    language: input.language,
    heading: input.company,
    // The line breaks stay (the frame turns them into <br>)
    intro: input.file === null ? `${intro}\n\n${copy.tooLarge}` : intro,
    button:
      input.file === null
        ? { label: copy.download, href: input.exportsUrl }
        : { label: copy.manage, href: input.schedulesUrl },
    footer: [
      ...(input.file === null ? [] : [copy.attached(input.fileName)]),
      copy.why(input.company, copy.every[input.frequency]),
      // With the file attached, the button already opens the schedules page (decision 9)
      ...(input.file === null ? [copy.stop(input.schedulesUrl)] : []),
    ],
  };
  return {
    to: input.to,
    subject: copy.subject(input.title, input.period, input.company),
    text: emailText(body),
    html: emailHtml(body),
    ...(input.file !== null && {
      attachments: [
        {
          filename: input.fileName,
          content: Buffer.from(input.file.bytes),
          contentType: input.file.contentType,
        },
      ],
    }),
  };
}
