import type { LanguageCode } from '@omnivo/contracts';

// Numbers and dates inside an exported file, in the language of the person who asked for it.
// The same rules as the app's @omnivo/i18n (format.ts), written again here: that package is for
// the browser (React, i18next), and the server must not load it (the same reason as the emails,
// mail/invitation-email.ts).

// en-IN = lakh/crore grouping (18,42,600.50); bn-BD = the same grouping in Bangla digits
const MONEY = {
  en: new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'negative',
  }),
  bn: new Intl.NumberFormat('bn-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'negative',
  }),
} satisfies Record<LanguageCode, Intl.NumberFormat>;

const DECIMAL = /^-?\d+(\.\d+)?$/;

// Intl formats a decimal string exactly (no trip through a JavaScript number), but its type asks
// for `${number}`, not any string: this guard says which strings are decimals
function isDecimal(value: string): value is `${number}` {
  return DECIMAL.test(value);
}

// "1842600.5000" → "18,42,600.50". No ৳ in every cell: the heading says the currency once.
export function formatAmount(value: string, language: LanguageCode): string {
  return isDecimal(value) ? MONEY[language].format(value) : value;
}

const DAY = {
  en: new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }),
  bn: new Intl.DateTimeFormat('bn-BD', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }),
} satisfies Record<LanguageCode, Intl.DateTimeFormat>;

// "2026-09-23" → "23 Sep 2026" / "২৩ সেপ, ২০২৬". Read as a UTC day and written in UTC, so the
// server's own time zone can never move it.
export function formatIsoDate(iso: string, language: LanguageCode): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (language === 'bn') return DAY.bn.format(date);
  const parts = DAY.en.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}

// When the file was made, on the company's clock: "1 Oct 2026, 14:05"
export function formatMoment(moment: Date, language: LanguageCode, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(language === 'bn' ? 'bn-BD' : 'en-US', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(moment);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  const day =
    language === 'bn' ? `${part('day')} ${part('month')},` : `${part('day')} ${part('month')}`;
  return `${day} ${part('year')}, ${part('hour')}:${part('minute')}`;
}
