import type { LanguageCode } from '@omnivo/contracts';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import { en } from './locales/en.js';
import type { Messages } from './locales/messages.js';

// satisfies: সার্ভারে সেভ হওয়া ভাষা (contracts-এর LANGUAGE_CODES) আর এই তালিকা একই — চুক্তিতে নেই এমন
// ভাষা এখানে যোগ করলে compile error। import type: runtime-এ contracts লাগে না
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'bn', label: 'বাংলা' },
] as const satisfies readonly { code: LanguageCode; label: string }[];

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

// Step 13: English is in the first page load (it is also the fallback for a missing key); every
// other language is a chunk of its own, fetched the first time someone uses it. Both languages
// together had grown to 45 KB gz of the 200 KB first-load budget, and most readers use one.
// satisfies: a new language in LANGUAGES does not compile until it has a loader here.
const LOADERS = {
  bn: async () => (await import('./locales/bn.js')).bn,
} satisfies Record<Exclude<Language, 'en'>, () => Promise<Messages>>;

// global singleton-এর বদলে নিজস্ব instance: অন্য কোনো লাইব্রেরি i18next-এর default instance
// init করলেও আমাদের অনুবাদে হাত পড়বে না
export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  // English until the stored language has arrived (languageReady below)
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: LANGUAGES.map((language) => language.code),
  // The other languages are added later with addResourceBundle
  partialBundledLanguages: true,
  // English is in the bundle, so init is sync: the first render already has its texts
  initAsync: false,
  // React নিজেই escape করে; i18next আবার করলে "&amp;" দেখা যেত
  interpolation: { escapeValue: false },
});

// A language's texts, fetched once. English is always there.
async function loadLanguage(language: Language): Promise<void> {
  if (language === 'en' || i18n.hasResourceBundle(language, 'translation')) return;
  i18n.addResourceBundle(language, 'translation', await LOADERS[language]());
}

// স্ক্রিন রিডার আর ব্রাউজারের hyphenation/ফন্ট নির্বাচন <html lang> দেখে
function syncDocumentLanguage(language: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}
syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', syncDocumentLanguage);

export async function setLanguage(language: Language): Promise<void> {
  await loadLanguage(language);
  await i18n.changeLanguage(language);
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // সেভ না হলে শুধু এই সেশনে ভাষা বদলাবে — ক্ষতি নেই
  }
}

// The language this device used last, ready to use. main.tsx waits for it before the first render,
// so a Bangla reader never sees a flash of English; for English it resolves at once. A failed fetch
// (offline on the very first visit) leaves the app in English instead of not starting at all.
export const languageReady: Promise<void> = setLanguage(storedLanguage()).catch(() => undefined);
