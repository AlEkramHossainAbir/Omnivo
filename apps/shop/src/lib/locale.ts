import { i18n, type Language } from '@omnivo/i18n';
import { setShopLanguage } from '@omnivo/i18n/shop';

import { shopMoney } from './money';

// Step 26a: the words and number format of one page, worked out once in the page and handed to
// every component. The shop speaks its own language (PublicShop.language), not the shopper's last
// choice in the ERP, so the stored preference is neither read nor written here.
export async function shopLocale(language: Language) {
  // Loads the language's words (Bangla is a chunk of its own). It also makes it the current
  // language, which step 26b's React islands render with on the server. Step 26d: the shop's own
  // words come from '@omnivo/i18n/shop', which also never writes a stored preference
  await setShopLanguage(language);
  // A t() fixed to this language: the components never depend on which language is current
  const t = i18n.getFixedT(language);
  return {
    t,
    language,
    money: (value: string) => shopMoney(value, language),
  };
}

export type ShopLocale = Awaited<ReturnType<typeof shopLocale>>;
