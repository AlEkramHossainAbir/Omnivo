import type { en } from './locales/en.js';

// t('nav.overview')-এর key এখন টাইপ-চেকড: ভুল key compile error, আর IDE-তে autocomplete।
// .d.ts না, .ts: tsc src-এর .d.ts ফাইল dist-এ কপি করে না, তখন ui/app এই augmentation দেখত না
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
