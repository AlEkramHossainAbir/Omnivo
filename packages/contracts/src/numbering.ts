import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';

// যেসব ডকুমেন্ট নম্বর পায়। এখনো কোনোটা তৈরি হয়নি (ইনভয়েস ধাপ ১৫, journal ধাপ ১০) — কিন্তু
// নম্বরের ছাঁচ আগে থেকে ঠিক করে রাখা যায়। নতুন ডকুমেন্ট = এখানে এক লাইন + i18n-এ তার নাম
export const DOCUMENT_TYPES = [
  'sales.invoice',
  'sales.order',
  'purchase.order',
  'purchase.bill',
  'inventory.receipt',
  'accounting.journal',
  'inventory.product',
  'inventory.adjustment',
  'inventory.transfer',
  'inventory.revaluation',
  'sales.customer',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

// none: INV-0001 · calendar: INV-2026-0001 · fiscal: INV-2026-27-0001 (অর্থবছর জুলাই থেকে)
export const YEAR_STYLES = ['none', 'calendar', 'fiscal'] as const;
export type YearStyle = (typeof YEAR_STYLES)[number];

export interface NumberFormat {
  prefix: string;
  yearStyle: YearStyle;
  padding: number;
}

const DEFAULT_PREFIXES = {
  'sales.invoice': 'INV',
  'sales.order': 'SO',
  'purchase.order': 'PO',
  'purchase.bill': 'BILL',
  'inventory.receipt': 'GRN',
  'accounting.journal': 'JV',
  'inventory.product': 'P',
  'inventory.adjustment': 'ADJ',
  'inventory.transfer': 'TRF',
  'inventory.revaluation': 'REV',
  'sales.customer': 'C',
} satisfies Record<DocumentType, string>;

// টেন্যান্ট কিছু না বদলালে এই ছাঁচ — DB-তে রো লেখা হয় শুধু প্রথম বদলের সময়।
// A product code is not a yearly document: P-00042 stays P-00042 for the product's whole life, so
// its series never restarts (no year) and has room for 99,999 products before it grows a digit.
// A customer code (step 15a) is the same kind of code: C-00042 for good.
export function defaultNumberFormat(documentType: DocumentType): NumberFormat {
  if (documentType === 'inventory.product' || documentType === 'sales.customer') {
    return { prefix: DEFAULT_PREFIXES[documentType], yearStyle: 'none', padding: 5 };
  }
  return { prefix: DEFAULT_PREFIXES[documentType], yearStyle: 'fiscal', padding: 4 };
}

// ডকুমেন্টের তারিখ কোন সময়কালে পড়ে: '' (কখনো রিসেট না), '2026', বা '2026-27'।
// তারিখ ISO string ('2026-09-23') — ব্যবসার তারিখ, সময় বা টাইমজোন নেই (system-design §১০)।
// Date না নেওয়ার কারণ: new Date('2026-07-01') UTC মধ্যরাত, ঢাকায় সেটা ১ জুলাই সকাল ৬টা, কিন্তু
// UTC-র পশ্চিমের কোনো মেশিনে getMonth() ৩০ জুন দিত — অর্থবছরের ভুল দিকে
export function periodOf(isoDate: string, yearStyle: YearStyle, fiscalYearStartMonth: number) {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  if (yearStyle === 'none') return '';
  if (yearStyle === 'calendar' || fiscalYearStartMonth === 1) return String(year);
  // জুলাই–জুন: সেপ্টেম্বর ২০২৬ → 2026-27, মার্চ ২০২৭ → 2026-27 (শুরুর বছর আগে)
  const startYear = month >= fiscalYearStartMonth ? year : year - 1;
  return `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// INV + 2026-27 + 42 → INV-2026-27-0042। সার্ভার নম্বর দেওয়ার সময় আর UI প্রিভিউয়ে একই ফাংশন —
// দুই জায়গায় আলাদা লিখলে প্রিভিউ আর আসল নম্বর একদিন আলাদা হয়ে যেত
export function formatDocumentNumber(format: NumberFormat, period: string, sequence: number) {
  const number = String(sequence).padStart(format.padding, '0');
  return [format.prefix, period, number].filter((part) => part !== '').join('-');
}

// "আজ" টেন্যান্টের টাইমজোনে: ঢাকায় রাত ১টা মানে UTC-তে এখনো আগের দিন।
// en-CA-র তারিখের ছাঁদ হুবহু ISO: 2026-09-23
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export const numberSeriesSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  prefix: z.string(),
  yearStyle: z.enum(YEAR_STYLES),
  padding: z.number().int(),
  // 0 = টেন্যান্ট কখনো বদলায়নি (ডিফল্ট ছাঁচ, DB-তে রো নেই)
  version: z.number().int().min(0),
  // আজ একটা ডকুমেন্ট হলে কোন নম্বর পেত — কিন্তু নম্বরটা খরচ হয় না (শুধু দেখা)
  nextNumber: z.string(),
});
export type NumberSeries = z.infer<typeof numberSeriesSchema>;

export const numberSeriesListSchema = z.object({ items: z.array(numberSeriesSchema) });

// বড় হাতের অক্ষর দিয়ে শুরু, ৮ অক্ষর পর্যন্ত — হাইফেন নেই, কারণ হাইফেন অংশগুলোর বিভাজক
export const updateNumberSeriesInputSchema = z.object({
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{0,7}$/, errorCode('prefix_format')),
  yearStyle: z.enum(YEAR_STYLES),
  padding: z.number().int().min(3).max(8),
  version: z.number().int().min(0),
});
export type UpdateNumberSeriesInput = z.infer<typeof updateNumberSeriesInputSchema>;

export const numberSeriesRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/number-series',
    summary: 'The numbering format of every document type, with the next number',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    response: numberSeriesListSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/number-series/:documentType',
    summary: "Change a document type's numbering format",
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: z.object({ documentType: z.enum(DOCUMENT_TYPES) }),
    body: updateNumberSeriesInputSchema,
    response: numberSeriesSchema,
  }),
};
