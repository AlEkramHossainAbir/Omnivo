import type { Language } from './i18n.js';

// en-IN = লাখ/কোটি গ্রুপিং (18,42,600); bn-BD = একই গ্রুপিং, বাংলা অঙ্কে (১৮,৪২,৬০০)
const NUMBER_LOCALE = { en: 'en-IN', bn: 'bn-BD' } satisfies Record<Language, string>;

const DECIMAL = /^-?\d+(\.\d+)?$/;

// Intl string পেলে পুরো নির্ভুলতায় format করে (number-এ রূপান্তর করে না), কিন্তু টাইপ চায়
// `${number}` — সাধারণ string না। DB-র NUMERIC মান string হয়ে আসে, তাই এই guard
export function isDecimalString(value: string): value is `${number}` {
  return DECIMAL.test(value);
}

type Numeric = number | string;

const numberFormats = new Map<string, Intl.NumberFormat>();

// Intl.NumberFormat তৈরি ব্যয়বহুল; ১০,০০০ রো-র টেবিলে প্রতি cell-এ নতুন বানানো উচিত না
function numberFormat(language: Language, decimals: number): Intl.NumberFormat {
  const key = `${language}:${String(decimals)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(NUMBER_LOCALE[language], {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      // 'negative': -0.4 শূন্যে গোল হলে "-0" না দেখিয়ে "0"
      signDisplay: 'negative',
    });
    numberFormats.set(key, format);
  }
  return format;
}

export interface MoneyFormatOptions {
  // CLAUDE.md: দশমিক শুধু unit price-এ; বাকি সব টাকার অঙ্ক পূর্ণ সংখ্যায়
  decimals?: number;
}

export function formatNumber(value: Numeric, language: Language, decimals = 0): string {
  if (typeof value === 'string' && !isDecimalString(value)) return value;
  return numberFormat(language, decimals).format(value);
}

// ৳ সবসময় সংখ্যার আগে, মাইনাস তারও আগে: -৳1,200। bn-BD-র currency style ৳ পরে বসায়
// (১,২০০৳), তাই currency style না নিয়ে নিজেরা জোড়া
export function formatMoney(
  value: Numeric,
  language: Language,
  { decimals = 0 }: MoneyFormatOptions = {},
): string {
  if (typeof value === 'string' && !isDecimalString(value)) return value;
  const parts = numberFormat(language, decimals).formatToParts(value);
  const sign = parts.find((part) => part.type === 'minusSign')?.value ?? '';
  const digits = parts
    .filter((part) => part.type !== 'minusSign')
    .map((part) => part.value)
    .join('');
  return `${sign}৳${digits}`;
}

// en-GB নতুন ICU-তে "Sept" লেখে, তাই en-US-এর অংশ নিয়ে নিজেরা সাজানো: "23 Sep 2026"
const EN_DATE = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const BN_DATE = new Intl.DateTimeFormat('bn-BD', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function formatDate(date: Date, language: Language): string {
  if (language === 'bn') return BN_DATE.format(date);
  const parts = EN_DATE.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}

// পিরিয়ড (মাস): "September 2026" / "সেপ্টেম্বর ২০২৬"
const MONTH = {
  en: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }),
  bn: new Intl.DateTimeFormat('bn-BD', { month: 'long', year: 'numeric' }),
} satisfies Record<Language, Intl.DateTimeFormat>;

export function formatMonth(date: Date, language: Language): string {
  return MONTH[language].format(date);
}
