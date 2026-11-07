import { formatMoney, i18n, setLanguage, type Language } from '@omnivo/i18n';

// Step 26a: the words and number format of one page, worked out once in the page and handed to
// every component. The shop speaks its own language (PublicShop.language), not the shopper's last
// choice in the ERP, so the stored preference is neither read nor written here.
export async function shopLocale(language: Language) {
  // Loads the language's words (Bangla is a chunk of its own). It also makes it the current
  // language, which step 26b's React islands render with on the server. remember: false, so the
  // build never writes a preference
  await setLanguage(language, { remember: false });
  // A t() fixed to this language: the components never depend on which language is current
  const t = i18n.getFixedT(language);
  return {
    t,
    language,
    money: (value: string) => shopMoney(value, language),
  };
}

export type ShopLocale = Awaited<ReturnType<typeof shopLocale>>;

// A shop price is a unit price: whole taka when it is whole ("৳1,199"), paisa only when it has
// them ("৳49.50"). CLAUDE.md → Money keeps decimals for unit prices only; this keeps a shelf of
// whole prices from showing ".00" on every card.
export function shopMoney(value: string, language: Language): string {
  const hasPaisa = /\.\d*[1-9]/.test(value);
  return formatMoney(value, language, { decimals: hasPaisa ? 2 : 0 });
}
