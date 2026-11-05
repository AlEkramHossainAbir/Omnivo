import type { Account, DocumentTotals, TaxRateRef } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, CardHeader } from '@omnivo/ui';
import type { ReactNode } from 'react';

import { useRateText } from '../lib/tax-rates';
import { SalesTotals } from './sales-parts';

// An expense as the page shows it: a bill's (17c) or a debit note's (17d), both of which carry the
// bill expense's account, description and VAT rate
interface ShownExpense {
  id: string;
  accountId: string;
  description: string;
  taxRate: TaxRateRef;
  net: string;
  total: string;
}

export const accountLabel = (account: Account | undefined) =>
  account ? `${account.code} · ${account.name}` : '—';

// The expenses, read only, with the document's totals under them: they count the item lines too.
// The bill's page had it in 17c (bill-view.tsx); step 17d moved it here for the debit note's page,
// a file of its own so that page does not load the bill's.
export function ExpensesTable<E extends ShownExpense>({
  title,
  subtitle,
  expenses,
  totals,
  pricesIncludeVat,
  accountOf,
  detail,
}: {
  title: string;
  subtitle: string;
  expenses: readonly E[];
  totals: DocumentTotals;
  pricesIncludeVat: boolean;
  accountOf: (id: string) => Account | undefined;
  // Words under an expense's description (what debit notes took off it)
  detail?: (expense: E) => ReactNode;
}) {
  const { t, format } = useLocale();
  const rateText = useRateText();
  const money = (value: string) => format.money(value, { decimals: 2 });
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} subtitle={subtitle} />
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-body-sm">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('bills.expenseDescription')}
              </th>
              <th scope="col" className="px-5 py-2.5">
                {t('bills.expenseAccount')}
              </th>
              <th scope="col" className="px-5 py-2.5">
                {t('bills.expenseVat')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((expense) => (
              <tr key={expense.id} className="border-t border-line align-top">
                <td className="px-5 py-3 font-medium text-ink">
                  {expense.description}
                  {detail?.(expense)}
                </td>
                <td className="px-5 py-3">{accountLabel(accountOf(expense.accountId))}</td>
                <td className="px-5 py-3 whitespace-nowrap">
                  {expense.taxRate.name}
                  <span className="block text-caption text-ink-3 tabular-nums">
                    {rateText(expense.taxRate.rate)}
                  </span>
                </td>
                <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                  {money(pricesIncludeVat ? expense.total : expense.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />
    </Card>
  );
}
