import { type LanguageCode, SHOP_CODE_VALID_MINUTES, type ShopCourier } from '@omnivo/contracts';

// Step 27a: the shop's two SMS (27b adds a third, 28a a fourth, 28b a fifth), in the shop's language (storefront_settings.language). Written
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

// Step 27b: the shop cancelled the order (decision 8). The hotline, so the shopper can ask why: the
// reason the staff typed is theirs (decision 19), and never goes in a message
export function cancelledSms(
  language: LanguageCode,
  shopName: string,
  orderNo: string,
  hotline: string,
): string {
  const words = {
    en: `${shopName}: order ${orderNo} was cancelled. Questions? Call ${hotline}.`,
    bn: `${shopName}: অর্ডার ${orderNo} বাতিল করা হয়েছে। কিছু জানতে কল করুন ${hotline}।`,
  } satisfies Record<LanguageCode, string>;
  return words[language];
}

// The couriers' own names: brand names, the same in every language (as the tracking page's
// shop.track.couriers words)
const COURIER_NAMES = {
  pathao: 'Pathao',
  steadfast: 'Steadfast',
  redx: 'RedX',
  ecourier: 'eCourier',
  paperfly: 'Paperfly',
} satisfies Record<ShopCourier, string>;

// Step 28a (decision 11): the courier picked the parcel up, and the order is Shipped. The courier
// and its code, which its call centre asks for; the tracking link went with the confirmation and
// cannot be sent again (only its hash is kept)
export function pickedUpSms(
  language: LanguageCode,
  shopName: string,
  orderNo: string,
  courier: ShopCourier,
  trackingCode: string,
): string {
  const words = {
    en: `${shopName}: order ${orderNo} is on its way with ${COURIER_NAMES[courier]}, code ${trackingCode}.`,
    bn: `${shopName}: অর্ডার ${orderNo} ${COURIER_NAMES[courier]} দিয়ে রওনা হয়েছে, কোড ${trackingCode}।`,
  } satisfies Record<LanguageCode, string>;
  return words[language];
}

// Step 28b (decision 7): Receive the return, the parcel is back in the shop. Like the cancel's: the
// hotline, never the staff's reason. Sent only once a member has the goods, so it never says
// "returned" for a parcel that is still on its way back
export function returnedSms(
  language: LanguageCode,
  shopName: string,
  orderNo: string,
  hotline: string,
): string {
  const words = {
    en: `${shopName}: order ${orderNo} came back to us and is closed. Questions? Call ${hotline}.`,
    bn: `${shopName}: অর্ডার ${orderNo} ফেরত এসেছে, অর্ডারটি বন্ধ করা হলো। কিছু জানতে কল করুন ${hotline}।`,
  } satisfies Record<LanguageCode, string>;
  return words[language];
}
