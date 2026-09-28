import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import { bn } from './locales/bn.js';
import { en } from './locales/en.js';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'bn', label: 'বাংলা' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];

const STORAGE_KEY = 'omnivo.language';

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.code === value);
}

// localStorage প্রাইভেট মোডে throw করতে পারে, আর Node-এ (টেস্ট) নেই — দুই ক্ষেত্রেই ইংরেজি
function storedLanguage(): Language {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLanguage(value) ? value : 'en';
  } catch {
    return 'en';
  }
}

// global singleton-এর বদলে নিজস্ব instance: অন্য কোনো লাইব্রেরি i18next-এর default instance
// init করলেও আমাদের অনুবাদে হাত পড়বে না
export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, bn: { translation: bn } },
  lng: storedLanguage(),
  fallbackLng: 'en',
  supportedLngs: LANGUAGES.map((language) => language.code),
  // resource bundle-এর ভেতরেই আছে, তাই init sync — প্রথম render-এই অনুবাদ তৈরি
  initAsync: false,
  // React নিজেই escape করে; i18next আবার করলে "&amp;" দেখা যেত
  interpolation: { escapeValue: false },
});

// স্ক্রিন রিডার আর ব্রাউজারের hyphenation/ফন্ট নির্বাচন <html lang> দেখে
function syncDocumentLanguage(language: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}
syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', syncDocumentLanguage);

export async function setLanguage(language: Language): Promise<void> {
  await i18n.changeLanguage(language);
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // সেভ না হলে শুধু এই সেশনে ভাষা বদলাবে — ক্ষতি নেই
  }
}
