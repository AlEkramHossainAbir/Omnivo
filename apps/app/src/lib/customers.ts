import { absMoney, isNegativeMoney, isZeroMoney, type PartyRef } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { useMemo } from 'react';

// "C-00042 · Rahman Traders": how a line's customer reads (the journal, the picker's choice). Here,
// not in customer-picker.tsx: the entry view shows it without loading the picker.
export function partyLabel(party: PartyRef): string {
  return `${party.code} · ${party.name}`;
}

// "RT" for Rahman Traders: the avatar tile of the list's first column (CLAUDE.md → Table). The
// first letter of the first two words; Array.from splits by code point, so a Bangla name gives
// whole letters, not halves of a surrogate pair.
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();
}

// How a customer's terms, limit and balance read: the list and the customer's page say them the
// same way. `decimals`: the list shows whole taka, the page's KPIs too (CLAUDE.md → Money).
export function useCustomerText() {
  const { t, format } = useLocale();
  return useMemo(
    () => ({
      // 0 days = due on receipt
      terms: (days: number) =>
        days === 0 ? t('customers.onReceipt') : t('customers.termsDays', { count: days }),
      // null = no limit; "0.0000" = a real limit of nothing, i.e. cash only
      creditLimit: (limit: string | null) =>
        limit === null
          ? t('customers.noLimit')
          : isZeroMoney(limit)
            ? t('customers.cashOnly')
            : format.money(limit),
      // Debit balance = the customer owes; credit = they paid ahead (an advance, an overpayment)
      balance: (balance: string) =>
        isZeroMoney(balance)
          ? t('customers.settled')
          : isNegativeMoney(balance)
            ? t('customers.inAdvance', { amount: format.money(absMoney(balance)) })
            : t('customers.owes', { amount: format.money(balance) }),
    }),
    [t, format],
  );
}
