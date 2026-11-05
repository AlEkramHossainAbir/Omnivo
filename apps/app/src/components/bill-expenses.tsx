import { Alert02Icon, Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type Account, type BillExpenseFormValues, MAX_BILL_EXPENSES } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, cn, IconButton, Input, MoneyInput, Select } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { draftExpenseAmounts } from '../lib/bills';
import { taxRatesQuery } from '../lib/queries';
import { taxRateOptions, useRateText } from '../lib/tax-rates';
import { LineError } from './journal-parts';
import { useTenantId } from './stock-parts';

// A supplier bill's expenses (step 17c, decision 6): costs with no product, like rent, electricity
// or a repair. Each is an account, a description, one amount and a VAT rate. A card of its own under
// the item lines, and a lazy chunk of its own like the line editor: it brings the money box
// (decimal.js). Like the line editor, it changes one controlled array value (a Controller on
// "expenses").

export type BillExpensesErrors = FieldErrors<{ expenses: BillExpenseFormValues[] }>['expenses'];

// One template for the header and every row on a wide card; below it each box shows its label
const COLUMNS =
  '@3xl:grid-cols-[14rem_minmax(0,1fr)_8.5rem_9.5rem_7.5rem_2.25rem] @3xl:items-start @3xl:gap-2';

export function BillExpensesEditor({
  expenses,
  onChange,
  accounts,
  pricesIncludeVat,
  errors,
}: {
  expenses: BillExpenseFormValues[];
  onChange: (expenses: BillExpenseFormValues[]) => void;
  // The accounts an expense may post to (costAccounts, decision 40)
  accounts: readonly Account[];
  pricesIncludeVat: boolean;
  errors: BillExpensesErrors;
}) {
  const { t, format, errorText } = useLocale();
  const rateText = useRateText();
  const rates = useQuery(taxRatesQuery(useTenantId())).data ?? [];
  // React's keys, at the same index as the expenses: an expense keeps its key when one above it is
  // removed, so the boxes below keep what is typed in them
  const [keys, setKeys] = useState<string[]>(() =>
    expenses.map((_, index) => `saved-${String(index)}`),
  );
  const listError = errors?.root?.message ?? errors?.message;
  const full = expenses.length >= MAX_BILL_EXPENSES;

  const update = (index: number, patch: Partial<BillExpenseFormValues>) => {
    onChange(expenses.map((expense, at) => (at === index ? { ...expense, ...patch } : expense)));
  };
  const remove = (index: number) => {
    setKeys((before) => before.filter((_, at) => at !== index));
    onChange(expenses.filter((_, at) => at !== index));
  };
  // A new expense starts at the workspace's default rate, like a product without its own rate
  const add = () => {
    setKeys((before) => [...before, `new-${crypto.randomUUID()}`]);
    onChange([
      ...expenses,
      {
        accountId: '',
        description: '',
        amount: '',
        taxRateId: rates.find((rate) => rate.isDefault && rate.archivedAt === null)?.id ?? '',
      },
    ]);
  };

  return (
    <Card
      className="@container grid grid-cols-1 overflow-hidden"
      aria-label={t('bills.expensesTitle')}
    >
      <CardHeader title={t('bills.expensesTitle')} subtitle={t('bills.expensesSubtitle')} />
      {expenses.length === 0 ? (
        <p className="px-5 pt-3 pb-5 text-body-sm text-ink-2">
          {accounts.length === 0 ? t('bills.noCostAccounts') : t('bills.noExpenses')}
        </p>
      ) : (
        <div
          aria-hidden="true"
          className={cn(
            'mt-4 hidden bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
            COLUMNS,
          )}
        >
          <span>{t('bills.expenseAccount')}</span>
          <span>{t('bills.expenseDescription')}</span>
          <span className="text-right">{t('bills.expenseAmount')}</span>
          <span>{t('bills.expenseVat')}</span>
          <span className="text-right">{t('salesLines.amount')}</span>
        </div>
      )}
      {expenses.map((expense, index) => {
        const number = index + 1;
        const rowErrors = errors?.[index];
        const id = (field: string) => `expenses.${String(index)}.${field}`;
        const rate = rates.find((each) => each.id === expense.taxRateId)?.rate ?? null;
        const amounts = draftExpenseAmounts(expense, rate, pricesIncludeVat);
        const removeButton = (
          <IconButton
            icon={Delete02Icon}
            label={t('bills.removeExpense', { number })}
            onClick={() => {
              remove(index);
            }}
          />
        );
        return (
          <div
            key={keys[index] ?? `row-${String(index)}`}
            role="group"
            aria-label={t('bills.expense', { number })}
            className={cn('grid grid-cols-2 gap-3 border-t border-line px-5 py-4', COLUMNS)}
          >
            <Field
              id={id('accountId')}
              label={t('bills.expenseAccount')}
              error={rowErrors?.accountId?.message}
            >
              <Select
                id={id('accountId')}
                value={expense.accountId}
                invalid={rowErrors?.accountId !== undefined}
                options={[
                  { value: '', label: t('bills.accountPlaceholder') },
                  ...accounts.map((account) => ({
                    value: account.id,
                    label: `${account.code} · ${account.name}`,
                  })),
                ]}
                onChange={(event) => {
                  update(index, { accountId: event.target.value });
                }}
              />
            </Field>
            <Field
              id={id('description')}
              label={t('bills.expenseDescription')}
              error={rowErrors?.description?.message}
            >
              <Input
                id={id('description')}
                autoComplete="off"
                placeholder={t('bills.expenseDescriptionPlaceholder')}
                value={expense.description}
                invalid={rowErrors?.description !== undefined}
                onChange={(event) => {
                  update(index, { description: event.target.value });
                }}
              />
            </Field>
            <Field
              id={id('amount')}
              label={t('bills.expenseAmount')}
              error={rowErrors?.amount?.message}
            >
              <MoneyInput
                id={id('amount')}
                value={expense.amount}
                invalid={rowErrors?.amount !== undefined}
                aria-describedby={rowErrors?.amount ? `${id('amount')}-error` : undefined}
                onChange={(value) => {
                  update(index, { amount: value });
                }}
              />
            </Field>
            <Field
              id={id('taxRateId')}
              label={t('bills.expenseVat')}
              error={rowErrors?.taxRateId?.message}
            >
              <Select
                id={id('taxRateId')}
                value={expense.taxRateId}
                invalid={rowErrors?.taxRateId !== undefined}
                options={[
                  { value: '', label: t('salesLines.vatRate') },
                  ...taxRateOptions(rates, rateText, expense.taxRateId),
                ]}
                onChange={(event) => {
                  update(index, { taxRateId: event.target.value });
                }}
              />
            </Field>
            <div className="grid content-start gap-1.5">
              <span className="text-label font-medium text-ink @3xl:sr-only">
                {t('salesLines.amount')}
              </span>
              {/* In the price's own terms, like an item line: with VAT when prices include it */}
              <span className="py-2.5 text-right text-body-sm font-medium tabular-nums">
                {amounts
                  ? format.money(pricesIncludeVat ? amounts.total : amounts.net, { decimals: 2 })
                  : '—'}
              </span>
            </div>
            <div className="flex justify-end @3xl:pt-1">{removeButton}</div>
          </div>
        );
      })}
      {listError && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {errorText(listError)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={full || accounts.length === 0}
          onClick={add}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
          {t('bills.addExpense')}
        </Button>
        {full && (
          <span className="text-label text-ink-3">
            {t('bills.tooManyExpenses', { max: MAX_BILL_EXPENSES })}
          </span>
        )}
      </div>
    </Card>
  );
}

// A box with its label, hidden on a wide card where the header names the column
function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="col-span-2 grid grid-cols-1 content-start gap-1.5 @3xl:col-span-1">
      <label htmlFor={id} className="text-label font-medium text-ink @3xl:sr-only">
        {label}
      </label>
      {children}
      <LineError id={id} error={error} />
    </div>
  );
}
