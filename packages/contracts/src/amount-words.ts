import type { LanguageCode } from './preferences.js';
import type { Currency } from './settings.js';

// An amount written out in words, as a Bangladeshi invoice, money receipt or cheque says it under
// the total: "Eighteen lakh forty-two thousand six hundred taka and fifty paisa only" /
// "আঠারো লক্ষ বিয়াল্লিশ হাজার ছয়শত টাকা পঞ্চাশ পয়সা মাত্র" (step 16). Here in contracts, so the
// worker's PDF and the browser's print show the same words.

// Lakh and crore, not million: 18,42,600 is "eighteen lakh ...", never "one million eight hundred ..."
const CRORE = 10_000_000n;
const LAKH = 100_000n;
const THOUSAND = 1_000n;
const HUNDRED = 100n;

const EN_ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;

const EN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const;

// Bangla has its own word for every number below 100 (৪২ is "বিয়াল্লিশ", not "চল্লিশ দুই"), so
// there is no tens-and-ones rule to follow: the words are a list, read by index.
const BN_UNDER_100 = [
  'শূন্য',
  'এক',
  'দুই',
  'তিন',
  'চার',
  'পাঁচ',
  'ছয়',
  'সাত',
  'আট',
  'নয়',
  'দশ',
  'এগারো',
  'বারো',
  'তেরো',
  'চৌদ্দ',
  'পনেরো',
  'ষোলো',
  'সতেরো',
  'আঠারো',
  'উনিশ',
  'বিশ',
  'একুশ',
  'বাইশ',
  'তেইশ',
  'চব্বিশ',
  'পঁচিশ',
  'ছাব্বিশ',
  'সাতাশ',
  'আটাশ',
  'ঊনত্রিশ',
  'ত্রিশ',
  'একত্রিশ',
  'বত্রিশ',
  'তেত্রিশ',
  'চৌত্রিশ',
  'পঁয়ত্রিশ',
  'ছত্রিশ',
  'সাঁইত্রিশ',
  'আটত্রিশ',
  'ঊনচল্লিশ',
  'চল্লিশ',
  'একচল্লিশ',
  'বিয়াল্লিশ',
  'তেতাল্লিশ',
  'চুয়াল্লিশ',
  'পঁয়তাল্লিশ',
  'ছেচল্লিশ',
  'সাতচল্লিশ',
  'আটচল্লিশ',
  'ঊনপঞ্চাশ',
  'পঞ্চাশ',
  'একান্ন',
  'বাহান্ন',
  'তিপ্পান্ন',
  'চুয়ান্ন',
  'পঞ্চান্ন',
  'ছাপ্পান্ন',
  'সাতান্ন',
  'আটান্ন',
  'ঊনষাট',
  'ষাট',
  'একষট্টি',
  'বাষট্টি',
  'তেষট্টি',
  'চৌষট্টি',
  'পঁয়ষট্টি',
  'ছেষট্টি',
  'সাতষট্টি',
  'আটষট্টি',
  'ঊনসত্তর',
  'সত্তর',
  'একাত্তর',
  'বাহাত্তর',
  'তিয়াত্তর',
  'চুয়াত্তর',
  'পঁচাত্তর',
  'ছিয়াত্তর',
  'সাতাত্তর',
  'আটাত্তর',
  'ঊনআশি',
  'আশি',
  'একাশি',
  'বিরাশি',
  'তিরাশি',
  'চুরাশি',
  'পঁচাশি',
  'ছিয়াশি',
  'সাতাশি',
  'অষ্টাশি',
  'ঊননব্বই',
  'নব্বই',
  'একানব্বই',
  'বিরানব্বই',
  'তিরানব্বই',
  'চুরানব্বই',
  'পঁচানব্বই',
  'ছিয়ানব্বই',
  'সাতানব্বই',
  'আটানব্বই',
  'নিরানব্বই',
] as const;

interface Scale {
  under100: (n: number) => string;
  // "six hundred" / "ছয়শত": Bangla writes the hundred as one word with its digit
  hundreds: (digit: number) => string;
  thousand: string;
  lakh: string;
  crore: string;
}

// Every index below is 0–99 (or 1–9 for the hundreds) by the arithmetic that makes it, so the
// lookups cannot miss; the `?? ''` only satisfies noUncheckedIndexedAccess.
const SCALES = {
  en: {
    under100: (n) => {
      if (n < 20) return EN_ONES[n] ?? '';
      const ones = n % 10;
      const tens = EN_TENS[Math.floor(n / 10)] ?? '';
      return ones === 0 ? tens : `${tens}-${EN_ONES[ones] ?? ''}`;
    },
    hundreds: (digit) => `${EN_ONES[digit] ?? ''} hundred`,
    thousand: 'thousand',
    lakh: 'lakh',
    crore: 'crore',
  },
  bn: {
    under100: (n) => BN_UNDER_100[n] ?? '',
    hundreds: (digit) => `${BN_UNDER_100[digit] ?? ''}শত`,
    thousand: 'হাজার',
    lakh: 'লক্ষ',
    crore: 'কোটি',
  },
} satisfies Record<LanguageCode, Scale>;

// A whole number in words, Indian grouping: crore, lakh, thousand, hundred, then the rest. Above
// 99 crore the crores are themselves a number in words ("one hundred twenty crore"), the way a
// bank writes it. No "and" inside the number: the one "and" in the sentence is before the paisa.
function wholeInWords(n: bigint, scale: Scale): string {
  if (n === 0n) return scale.under100(0);
  const parts: string[] = [];
  const crores = n / CRORE;
  if (crores > 0n) parts.push(`${wholeInWords(crores, scale)} ${scale.crore}`);
  const lakhs = Number((n % CRORE) / LAKH);
  if (lakhs > 0) parts.push(`${scale.under100(lakhs)} ${scale.lakh}`);
  const thousands = Number((n % LAKH) / THOUSAND);
  if (thousands > 0) parts.push(`${scale.under100(thousands)} ${scale.thousand}`);
  const hundreds = Number((n % THOUSAND) / HUNDRED);
  if (hundreds > 0) parts.push(scale.hundreds(hundreds));
  const rest = Number(n % HUNDRED);
  if (rest > 0) parts.push(scale.under100(rest));
  return parts.join(' ');
}

// The money's two names in each language. English counts them (one dollar, two dollars); taka and
// paisa are the same for one and many, and Bangla never changes a noun for a number.
interface Units {
  major: readonly [one: string, many: string];
  minor: readonly [one: string, many: string];
}

const UNITS = {
  en: {
    BDT: { major: ['taka', 'taka'], minor: ['paisa', 'paisa'] },
    USD: { major: ['dollar', 'dollars'], minor: ['cent', 'cents'] },
    EUR: { major: ['euro', 'euros'], minor: ['cent', 'cents'] },
    GBP: { major: ['pound', 'pounds'], minor: ['penny', 'pence'] },
    INR: { major: ['rupee', 'rupees'], minor: ['paisa', 'paise'] },
  },
  bn: {
    BDT: { major: ['টাকা', 'টাকা'], minor: ['পয়সা', 'পয়সা'] },
    USD: { major: ['ডলার', 'ডলার'], minor: ['সেন্ট', 'সেন্ট'] },
    EUR: { major: ['ইউরো', 'ইউরো'], minor: ['সেন্ট', 'সেন্ট'] },
    GBP: { major: ['পাউন্ড', 'পাউন্ড'], minor: ['পেনি', 'পেন্স'] },
    INR: { major: ['রুপি', 'রুপি'], minor: ['পয়সা', 'পয়সা'] },
  },
} satisfies Record<LanguageCode, Record<Currency, Units>>;

function unit(names: readonly [string, string], count: bigint): string {
  return count === 1n ? names[0] : names[1];
}

// A decimal string with any number of decimals (the database sends NUMERIC(19,4) as "18450.5000").
// No minus sign: every amount a document prints in words (a total, a receipt) is zero or more,
// so a negative one is a bug to see, not a sentence to write.
const AMOUNT = /^(\d+)(?:\.(\d+))?$/;

// The amount in paisa, rounded half up at the second decimal like every printed amount
// ("10.005" → 1001 paisa). BigInt, never a JavaScript number: 15 digits of taka do not fit a double
// exactly.
function toPaisa(amount: string): bigint {
  const match = AMOUNT.exec(amount.trim());
  const whole = match?.[1];
  if (match === null || whole === undefined) {
    throw new Error(`Not a non-negative amount: "${amount}"`);
  }
  const fraction = match[2] ?? '';
  const paisa = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  // The third decimal decides the rounding; the ones after it cannot change a half-up result
  return Number(fraction.charAt(2) || '0') >= 5 ? paisa + 1n : paisa;
}

export function amountInWords(amount: string, language: LanguageCode, currency: Currency): string {
  const paisa = toPaisa(amount);
  const whole = paisa / 100n;
  const cents = paisa % 100n;
  const scale = SCALES[language];
  const names = UNITS[language][currency];
  const major = `${wholeInWords(whole, scale)} ${unit(names.major, whole)}`;
  const minor = `${wholeInWords(cents, scale)} ${unit(names.minor, cents)}`;
  if (language === 'bn') {
    // "পঞ্চাশ পয়সা মাত্র" when there is no whole taka; "শূন্য টাকা মাত্র" for nothing at all
    const words = whole === 0n && cents > 0n ? minor : cents === 0n ? major : `${major} ${minor}`;
    return `${words} মাত্র`;
  }
  const words = whole === 0n && cents > 0n ? minor : cents === 0n ? major : `${major} and ${minor}`;
  // Sentence case (CLAUDE.md → Copy): only the first letter is a capital
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} only`;
}
