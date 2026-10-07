import { z } from 'zod';

import { companyNameSchema } from './auth.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// base currency — হিসাবের বই কোন মুদ্রায়। বাংলাদেশের কোম্পানির জন্য আইনত BDT; বাকিগুলো পরে বিদেশি
// টেন্যান্টের জন্য খোলা। ধাপ ১০-এ প্রথম journal পোস্ট হলে এটা আর বদলানো যাবে না
export const CURRENCIES = ['BDT', 'USD', 'EUR', 'GBP', 'INR'] as const;
export type Currency = (typeof CURRENCIES)[number];

// নতুন workspace-এর শুরুর মান: বাংলাদেশের অর্থবছর জুলাই–জুন (CLAUDE.md → Dates)
export const DEFAULT_SETTINGS = {
  baseCurrency: 'BDT',
  fiscalYearStartMonth: 7,
  timezone: 'Asia/Dhaka',
} as const satisfies {
  baseCurrency: Currency;
  fiscalYearStartMonth: number;
  timezone: string;
};

// IANA নাম ('Asia/Dhaka') সত্যিই আছে কি না — Intl নিজেই জানে, আলাদা তালিকা রাখতে হয় না।
// ব্রাউজার আর Node দুজনেরই Intl আছে, তাই ফর্ম আর সার্ভার একই যাচাই চালায়
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// BIN (NBR-এর VAT নিবন্ধন নম্বর) ১৩ অঙ্কের, প্রায়ই "000123456-0101" লেখা হয়। হাইফেন আর স্পেস
// ফেলে শুধু অঙ্ক রাখা — তাহলে একই BIN দুই রকম লেখায় দুবার ঢোকে না, আর Mushak 6.3-এ একই ছাঁদে ছাপা হয়
export const binSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine((value) => value === '' || /^\d{13}$/.test(value), errorCode('bin_format'))
  .transform((value) => (value === '' ? null : value))
  .nullable();

// ফাঁকা চলে; লিখলে ঠিক ইমেইল হতে হবে
export const optionalEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => value === '' || z.email().safeParse(value).success, errorCode('email_invalid'))
  .transform((value) => (value === '' ? null : value))
  .nullable();

export const settingsSchema = z.object({
  companyName: z.string(),
  legalName: z.string().nullable(),
  bin: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  baseCurrency: z.enum(CURRENCIES),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  timezone: z.string(),
  // url: কিছুক্ষণের জন্য সই করা (presigned) ঠিকানা — <img src>-এ সরাসরি বসে
  logo: z.object({ attachmentId: z.uuid(), url: z.url() }).nullable(),
  // Off (the default): stock never goes below zero — a sale or an adjustment that takes more than
  // is there is refused. On: an untracked product may go negative (the shelf had it, the books
  // did not yet). Batches and serial numbers never go negative: a batch or an IMEI either is in
  // the warehouse or is not.
  allowNegativeStock: z.boolean(),
  // Whether the prices the workspace types (a product's sale price, a price list) already hold the
  // VAT. On for a shop that sells at the printed MRP; off (the default) for a distributor that
  // quotes before VAT. Sales lines (step 15b) work the VAT out from here.
  pricesIncludeVat: z.boolean(),
  version: z.number().int(),
});
export type Settings = z.infer<typeof settingsSchema>;

// PUT: পুরো ফর্ম একসাথে। version = ফর্ম খোলার সময়ের version (optimistic locking)
export const updateSettingsInputSchema = z.object({
  version: versionSchema,
  companyName: companyNameSchema,
  legalName: optionalText(160),
  bin: binSchema,
  phone: optionalText(30),
  email: optionalEmailSchema,
  address: optionalText(300),
  baseCurrency: z.enum(CURRENCIES),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  timezone: z.string().refine(isTimeZone, errorCode('timezone_invalid')),
  allowNegativeStock: z.boolean(),
  pricesIncludeVat: z.boolean(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;

// null = লোগো সরানো
export const setLogoInputSchema = z.object({ attachmentId: z.uuid().nullable() });

export const settingsRoutes = {
  get: defineRoute({
    method: 'GET',
    path: '/settings',
    summary: "The active workspace's company profile and regional settings",
    auth: 'bearer',
    status: 200,
    response: settingsSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/settings',
    summary: 'Save the company profile and regional settings',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    body: updateSettingsInputSchema,
    response: settingsSchema,
  }),
  setLogo: defineRoute({
    method: 'PUT',
    path: '/settings/logo',
    summary: 'Set or remove the company logo (an uploaded attachment)',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    body: setLogoInputSchema,
    response: settingsSchema,
  }),
};
