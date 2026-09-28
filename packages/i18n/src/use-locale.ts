import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  formatDate,
  formatMoney,
  formatMonth,
  formatNumber,
  type MoneyFormatOptions,
} from './format.js';
import { isLanguage, type Language } from './i18n.js';

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
    }),
    [language],
  );

  return { t, language, format };
}
