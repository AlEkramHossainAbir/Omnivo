import type { TaxRate } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import type { SelectOption } from '@omnivo/ui';
import { useCallback } from 'react';

// "7.50" → "7.5", "15.00" → "15": a rate as people write it. Postgres sends NUMERIC(5,2) with both
// decimals; only a number with a point loses its trailing zeros ("10" must stay "10").
export function plainRate(rate: string): string {
  return rate.includes('.') ? rate.replace(/\.?0+$/, '') : rate;
}

// "7.5%", with Bangla digits in Bangla
export function useRateText(): (rate: string) => string {
  const { t, format } = useLocale();
  return useCallback(
    (rate: string) => {
      const plain = plainRate(rate);
      const decimals = plain.split('.')[1]?.length ?? 0;
      return t('taxRates.percent', { rate: format.number(plain, decimals) });
    },
    [t, format],
  );
}

// The rates a product can pick: the active ones, plus its own if it was archived since (the select
// would otherwise silently show another rate; the server keeps an unchanged archived rate)
export function taxRateOptions(
  rates: readonly TaxRate[],
  rateText: (rate: string) => string,
  keep: string | null,
): SelectOption[] {
  return rates
    .filter((rate) => rate.archivedAt === null || rate.id === keep)
    .map((rate) => ({ value: rate.id, label: `${rate.name} · ${rateText(rate.rate)}` }));
}
