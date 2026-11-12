import type { Messages } from './locales/messages.js';

// The words the typed t() knows. An interface, not `typeof en` itself, so that another entry of
// this package can add words by declaration merging: '@omnivo/i18n/shop' (shop.ts) adds `shop`.
// Only a program that imports that entry sees the shop's keys; in the ERP app t('shop.…') stays
// a compile error, because those words are never loaded there (step 26d)
export interface Translation extends Messages {}

// t('nav.overview')-এর key এখন টাইপ-চেকড: ভুল key compile error, আর IDE-তে autocomplete।
// .d.ts না, .ts: tsc src-এর .d.ts ফাইল dist-এ কপি করে না, তখন ui/app এই augmentation দেখত না
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: Translation };
  }
}
