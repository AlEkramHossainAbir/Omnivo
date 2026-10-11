import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { compareMoney, isMoneyAmount, subtractMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, MoneyInput } from '@omnivo/ui';
import type { FieldErrors } from 'react-hook-form';

import { type AllocationRow, appliedOf, suggestAllocations } from '../lib/invoices';
import { useIsoDate } from './stock-parts';

// Where a money receipt's money goes (step 15c): one row per invoice the customer still owes on,
// the oldest due date first, with a box for what this receipt puts on it. Used by the receipt form
// and by "Apply money" on a saved receipt.

interface Allocation {
  invoiceId: string;
  amount: string;
}
export type AllocationErrors = FieldErrors<{ allocations: Allocation[] }>['allocations'];

export function AllocationTable({
  rows,
  value,
  onChange,
  amount,
  errors,
  empty,
}: {
  rows: readonly AllocationRow[];
  // Only the invoices that get something: the contract refuses an empty or ৳0 amount, so a box
  // left empty is not in the list at all
  value: readonly Allocation[];
  onChange: (value: Allocation[]) => void;
  // The receipt's amount: what "Apply oldest first" spreads, and what the line below adds up to
  amount: string;
  errors: AllocationErrors;
  // What to say when there is no row (no customer yet, or nothing owed)
  empty: string;
}) {
  const { t, format, errorText } = useLocale();
  const isoDate = useIsoDate();
  const money = (text: string) => format.money(text, { decimals: 2 });
  const applied = appliedOf(value);
  const left = isMoneyAmount(amount.trim()) ? subtractMoney(amount.trim(), applied) : null;
  const over = left !== null && compareMoney(left, '0') < 0;
  const listError = errors?.root?.message ?? errors?.message;

  // A box changed: the row's amount replaces the old one, or the row leaves the list when emptied
  const change = (invoiceId: string, next: string) => {
    const rest = value.filter((allocation) => allocation.invoiceId !== invoiceId);
    if (next.trim() === '') {
      onChange(rest);
      return;
    }
    // In the rows' order, so the server's "allocations.3" points at the row it means
    const order = new Map(rows.map((row, index) => [row.invoiceId, index]));
    onChange(
      [...rest, { invoiceId, amount: next }].toSorted(
        (a, b) => (order.get(a.invoiceId) ?? 0) - (order.get(b.invoiceId) ?? 0),
      ),
    );
  };

  if (rows.length === 0) return <p className="px-5 py-4 text-body-sm text-ink-2">{empty}</p>;

  return (
    <div className="grid grid-cols-1">
      <div className="flex flex-wrap gap-2 px-5 py-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={!isMoneyAmount(amount.trim())}
          onClick={() => {
            onChange(suggestAllocations(amount, rows));
          }}
        >
          {t('receipts.applyOldest')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={value.length === 0}
          onClick={() => {
            onChange([]);
          }}
        >
          {t('receipts.clearAll')}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] border-collapse text-body-sm">
          <caption className="sr-only">{t('receipts.applyTitle')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('receipts.allocationColumns.invoice')}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                {t('receipts.allocationColumns.total')}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                {t('receipts.allocationColumns.due')}
              </th>
              <th scope="col" className="w-40 px-5 py-2.5 text-right">
                {t('receipts.allocationColumns.amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const index = value.findIndex((allocation) => allocation.invoiceId === row.invoiceId);
              const rowErrors = index === -1 ? undefined : errors?.[index];
              const error = rowErrors?.amount?.message ?? rowErrors?.invoiceId?.message;
              const id = `allocation-${row.invoiceId}`;
              return (
                <tr key={row.invoiceId} className="border-t border-line align-top">
                  <td className="px-5 py-3">
                    <span className="block font-mono font-medium tabular-nums">{row.number}</span>
                    <span className="block text-caption text-ink-3 tabular-nums">
                      {t('invoices.dueOn', { date: isoDate(row.dueDate) })}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                    {money(row.total)}
                  </td>
                  <td className="px-3 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                    {money(row.due)}
                  </td>
                  <td className="px-5 py-2">
                    <MoneyInput
                      id={id}
                      aria-label={t('receipts.applyTo', { number: row.number })}
                      value={index === -1 ? '' : (value[index]?.amount ?? '')}
                      invalid={error !== undefined}
                      aria-describedby={error ? `${id}-error` : undefined}
                      onChange={(next) => {
                        change(row.invoiceId, next);
                      }}
                    />
                    {error && (
                      <span id={`${id}-error`} className="mt-1 block text-label text-crit">
                        {errorText(error)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 border-t border-line bg-subtle px-5 py-3 text-body-sm tabular-nums">
        <span>
          <span className="text-ink-2">{t('receipts.applied')}</span>{' '}
          <span className="font-medium">{money(applied)}</span>
        </span>
        {left !== null &&
          (over ? (
            // More applied than received: the one state that needs attention, with an icon
            <span className="flex items-center gap-1.5 font-medium text-crit">
              <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} />
              {t('receipts.overBy', { amount: money(subtractMoney('0', left)) })}
            </span>
          ) : (
            <span>
              <span className="text-ink-2">{t('receipts.unapplied')}</span>{' '}
              <span className="font-medium">{money(left)}</span>
            </span>
          ))}
      </div>
      {listError && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {errorText(listError)}
        </p>
      )}
    </div>
  );
}
