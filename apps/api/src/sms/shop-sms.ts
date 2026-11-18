import { type LanguageCode, SHOP_CODE_VALID_MINUTES } from '@omnivo/contracts';

// Step 27a: the shop's two SMS, in the shop's language (storefront_settings.language). Written
// here, side by side, like the emails' words (mail/invitation-email.ts): @omnivo/i18n is the
// browser's. satisfies makes a third language a compile error until it has its words.
//
// Short on purpose. A Bangla SMS part holds 70 characters, an English one 160, and each part costs
// the shop money. The code comes first in its message: Android and iOS offer the first number of
// an SMS as "fill in the code", and the shopper may see only the first line on the lock screen.

function bnDigits(value: number): string {
  return new Intl.NumberFormat('bn-BD').format(value);
}

// The code stays in ASCII digits in Bangla too: it is typed into a box that takes either, and the
// phone's "fill in the code" reads ASCII digits only
export function codeSms(language: LanguageCode, shopName: string, code: string): string {
  const words = {
    en: `${code} is your ${shopName} order code. It works for ${String(SHOP_CODE_VALID_MINUTES)} minutes. Do not share it.`,
    bn: `${code} আপনার ${shopName} অর্ডারের কোড। ${bnDigits(SHOP_CODE_VALID_MINUTES)} মিনিট কাজ করবে। কাউকে বলবেন না।`,
  } satisfies Record<LanguageCode, string>;
  return words[language];
}

// After the right code: the number and the tracking link (27a's decision 9). The link is the only
// copy of its token: the database keeps its hash
export function confirmedSms(
  language: LanguageCode,
  shopName: string,
  orderNo: string,
  link: string,
): string {
  const words = {
    en: `${shopName}: order ${orderNo} is confirmed. Track it here: ${link}`,
    bn: `${shopName}: অর্ডার ${orderNo} নিশ্চিত হয়েছে। এখানে দেখুন: ${link}`,
  } satisfies Record<LanguageCode, string>;
  return words[language];
}
