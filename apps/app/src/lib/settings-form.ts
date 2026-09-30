import type { Settings, updateSettingsInputSchema } from '@omnivo/contracts';
import type { z } from 'zod';

// Shared by the settings page and the onboarding wizard's company step (moved from
// routes/settings.tsx in step 8)
// ফর্মে যা থাকে: parse-এর আগের মান (z.input) — ফাঁকা ঘর '' (null না, <input>-এ null বসানো যায় না)
export type SettingsFormValues = z.input<typeof updateSettingsInputSchema>;

// version ফর্মের লুকানো মান: ফর্ম যে version দেখে খোলা হয়েছিল, সেভে সেটাই যায়। সেভের মুহূর্তে ক্যাশ
// থেকে সর্বশেষ version নিলে optimistic locking-এর মানেই থাকত না — ব্যাকগ্রাউন্ডে refetch হয়ে নতুন
// version এলে অন্যের বদল চুপচাপ মুছে যেত
export function settingsToForm(settings: Settings): SettingsFormValues {
  return {
    version: settings.version,
    companyName: settings.companyName,
    legalName: settings.legalName ?? '',
    bin: settings.bin ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    address: settings.address ?? '',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
  };
}
