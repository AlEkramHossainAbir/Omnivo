import { absMoney, isNegativeMoney, isZeroMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { useMemo } from 'react';

// How a supplier's terms and balance read: the list and the supplier's page say them the same way
// (lib/customers.ts is the customer's twin).
export function useSupplierText() {
  const { t, format } = useLocale();
  return useMemo(
    () => ({
      // 0 days = due on receipt
      terms: (days: number) =>
        days === 0 ? t('suppliers.onReceipt') : t('suppliers.termsDays', { count: days }),
      // The API sends debit minus credit, like every balance. On the payable a credit balance is
      // what the company owes, so a negative number reads "You owe"; a debit balance is money
      // paid ahead (an advance to a mill before it ships the yarn).
      balance: (balance: string) =>
        isZeroMoney(balance)
          ? t('suppliers.settled')
          : isNegativeMoney(balance)
            ? t('suppliers.owe', { amount: format.money(absMoney(balance)) })
            : t('suppliers.inAdvance', { amount: format.money(balance) }),
    }),
    [t, format],
  );
}
