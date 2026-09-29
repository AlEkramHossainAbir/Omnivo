import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatMonth,
  formatMonthName,
  formatNumber,
  type MoneyFormatOptions,
} from './format.js';
import { isLanguage, type Language } from './i18n.js';
import { en } from './locales/en.js';

type ErrorKey = keyof typeof en.errors;

// en.errors-এর key আর contracts-এর ErrorCode একই তালিকা (en.ts-এর satisfies সেটা নিশ্চিত করে),
// তাই runtime-এ contracts import না করেই চেনা যায় কোনটা error code
function isErrorKey(value: string): value is ErrorKey {
  return Object.hasOwn(en.errors, value);
}

// component-এ ভাষা + ভাষা-অনুযায়ী formatter একসাথে। useTranslation ভাষা বদলের event-এ
// subscribe করে, তাই ভাষা বদলালে এই hook-ওয়ালা সব component নিজে থেকেই আবার render হয়
export function useLocale() {
  const { t, i18n } = useTranslation();
  const language: Language = isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : 'en';

  // language না বদলালে একই object — এটা dependency হিসেবে দিলে অকারণে effect চলে না
  const format = useMemo(
    () => ({
      money: (value: number | string, options?: MoneyFormatOptions) =>
        formatMoney(value, language, options),
      number: (value: number | string, decimals?: number) =>
        formatNumber(value, language, decimals),
      date: (date: Date) => formatDate(date, language),
      month: (date: Date) => formatMonth(date, language),
      dateTime: (date: Date, timeZone: string) => formatDateTime(date, language, timeZone),
      monthName: (month: number) => formatMonthName(month, language),
    }),
    [language],
  );

  // ফর্মের error-এ থাকে একটা code ('slug_taken') — সেটা বর্তমান ভাষায়। code না হলে (যেমন
  // kitchen sink-এর নিজের ইংরেজি মেসেজ) যেমন আছে তেমন, যাতে পুরনো ফর্ম না ভাঙে
  const errorText = useCallback(
    (message: string, params?: Record<string, string | number>): string =>
      isErrorKey(message) ? t(`errors.${message}`, { ...params }) : message,
    [t],
  );

  return { t, language, format, errorText };
}
