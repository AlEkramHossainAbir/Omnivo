import { i18n, setLanguage, type Language } from './i18n.js';
import { shopEn } from './locales/shop/en.js';
import type { ShopMessages } from './locales/shop/messages.js';

// Step 26d: the public shop's words, out of the ERP app's first load. The ERP imports only the
// main entry ('@omnivo/i18n'); the shop imports this one as well, which adds the `shop` words to
// the same i18next instance and the same `translation` namespace. So the keys stay `shop.*`, and
// errors.*, common words and the formatters work in the shop as before.

// What makes t('shop.cart.title') type-check, in the shop only: a program sees this merge only
// when it imports this file (types.ts explains the interface)
declare module './types.js' {
  interface Translation {
    shop: ShopMessages;
  }
}

// Bangla is a chunk of its own, like the main words (i18n.ts). satisfies: a new language does not
// compile until the shop has its words
const LOADERS = {
  bn: async () => (await import('./locales/shop/bn.js')).shopBn,
} satisfies Record<Exclude<Language, 'en'>, () => Promise<ShopMessages>>;

const added = new Set<Language>();

// deep = true merges `shop` into the language's words instead of replacing them. Once per
// language: a server process answers many pages, and the words never change while it runs
function addShopWords(language: Language, words: ShopMessages): void {
  if (added.has(language)) return;
  i18n.addResourceBundle(language, 'translation', { shop: words }, true, true);
  added.add(language);
}

// English at once: it is the fallback for a Bangla word that is missing, as in the ERP
addShopWords('en', shopEn);

// The shop's replacement for setLanguage(). The order matters: setLanguage() loads a language's
// main words only when that language has none yet (i18n.ts, loadLanguage), so adding the shop's
// Bangla words first would leave the shop without Bangla errors.* and common words.
// remember: false: a shop speaks its own language (PublicShop.language) and never stores a choice
export async function setShopLanguage(language: Language): Promise<void> {
  await setLanguage(language, { remember: false });
  if (language !== 'en') addShopWords(language, await LOADERS[language]());
}

export type { ShopMessages };
