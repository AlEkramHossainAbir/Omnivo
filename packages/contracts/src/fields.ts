import { z } from 'zod';

// optimistic locking: ক্লায়েন্ট যে version দেখে ফর্ম খুলেছিল সেটাই ফেরত পাঠায়। সার্ভারে তার মধ্যে কেউ
// বদলালে version বেড়ে গেছে — তখন 409 version_conflict, চুপচাপ অন্যের বদল মুছে দেওয়া না
export const versionSchema = z.number().int().min(1);

// ঐচ্ছিক লেখা: ফর্মের ফাঁকা ঘর '' পাঠায়, API-র বাইরের ক্লায়েন্ট null। দুটোকেই null বানানো —
// নাহলে DB-তে "নেই" দুই রকম ('' আর NULL) থাকত, আর "BIN নেই এমন কোম্পানি" খুঁজতে দুটোই মেলাতে হতো
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable();
}
