import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  ACCOUNT_TYPES,
  contractErrorMap,
  type OpeningBalances,
  openingBalancesInputSchema,
  routes,
  shiftIsoDate,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  DatePicker,
  FormAlert,
  FormField,
  MoneyInput,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { LineError, LineField, useIsoDate } from '../components/journal-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { balanceSide, formAmount, linePath, openingAccounts, totalsOf } from '../lib/journal';
import { useCan } from '../lib/permissions';
import { accountsQuery, openingBalancesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

type FormValues = z.input<typeof openingBalancesInputSchema>;

// Name, Debit, Credit — the same template for the header, every row and the totals
const ROW = '@3xl:grid-cols-[minmax(0,1fr)_10rem_10rem] @3xl:items-start';

function fieldNames(count: number): Path<FormValues>[] {
  return [
    'goLiveDate',
    ...Array.from({ length: count }, (_, index) => [
      linePath(index, 'accountId'),
      linePath(index, 'debit'),
      linePath(index, 'credit'),
    ]).flat(),
  ];
}

function OpeningForm({
  saved,
  rows,
  equity,
}: {
  saved: OpeningBalances;
  // One per account that can take an opening balance, in code order
  rows: Account[];
  equity: Account | undefined;
}) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const showDate = useIsoDate();
  const canPost = useCan()('accounting.journal.post');
  const savedOf = new Map(saved.lines.map((line) => [line.accountId, line]));
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(openingBalancesInputSchema, { error: contractErrorMap }),
    defaultValues: {
      goLiveDate: saved.goLiveDate ?? '',
      replaces: saved.entry?.id ?? null,
      // Every row is in the form, empty or not; the server drops the empty ones
      lines: rows.map((account) => ({
        accountId: account.id,
        debit: formAmount(savedOf.get(account.id)?.debit ?? ''),
        credit: formAmount(savedOf.get(account.id)?.credit ?? ''),
      })),
    },
  });
  const lines = useWatch({ control, name: 'lines' });
  const goLiveDate = useWatch({ control, name: 'goLiveDate' });
  const totals = totalsOf(lines);
  // Opening balance equity takes the other side of the difference, so the entry balances
  const gap = balanceSide(totals.difference);

  const onSubmit = handleSubmit(async (values) => {
    try {
      const result = await call(routes.openingBalances.save, { body: values });
      queryClient.setQueryData(openingBalancesQuery(tenantId).queryKey, result);
      await queryClient.invalidateQueries({ queryKey: ['journal', tenantId] });
      toast(
        result.entry ? t('opening.saved', { number: result.entry.number }) : t('opening.cleared'),
      );
    } catch (error) {
      applyApiError(error, fieldNames(rows.length), setError);
    }
  });

  const money = (value: string) => format.money(value, { decimals: 2 });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid grid-cols-1 gap-5">
      {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
      {!canPost && <p className="text-body-sm text-ink-3">{t('opening.readOnly')}</p>}
      <Card className="grid grid-cols-1 gap-2 p-5 sm:max-w-sm">
        <FormField
          control={control}
          name="goLiveDate"
          label={t('opening.goLive')}
          hint={
            goLiveDate === ''
              ? undefined
              : t('opening.goLiveHint', { date: showDate(shiftIsoDate(goLiveDate, -1)) })
          }
        >
          {(field) => <DatePicker {...field} disabled={!canPost} />}
        </FormField>
        {saved.entry && (
          <Link
            to="/journal/$entryId"
            params={{ entryId: saved.entry.id }}
            className="w-fit text-body-sm font-medium text-brand underline-offset-3 hover:underline"
          >
            {t('opening.postedAs', { number: saved.entry.number })}
          </Link>
        )}
      </Card>

      <Card className="@container grid grid-cols-1 overflow-hidden">
        <div
          aria-hidden="true"
          className={cn(
            'hidden gap-2 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
            ROW,
          )}
        >
          <span>{t('opening.account')}</span>
          <span className="text-right">{t('opening.debit')}</span>
          <span className="text-right">{t('opening.credit')}</span>
        </div>
        {ACCOUNT_TYPES.filter((type) => rows.some((account) => account.type === type)).map(
          (type) => (
            <section key={type} aria-label={t(`accounts.types.${type}`)}>
              <h2 className="border-t border-line px-5 pt-4 pb-1 text-caption font-medium text-ink-3">
                {t(`accounts.types.${type}`)}
              </h2>
              {rows.map((account, index) =>
                account.type !== type ? null : (
                  <div
                    key={account.id}
                    className={cn('grid grid-cols-2 gap-x-3 gap-y-2 px-5 py-2', ROW)}
                  >
                    <div className="col-span-2 min-w-0 self-center @3xl:col-span-1">
                      <span className="block truncate text-body-sm text-ink">
                        <span className="font-mono text-ink-3 tabular-nums">{account.code}</span>{' '}
                        {account.name}
                      </span>
                      <LineError
                        id={linePath(index, 'accountId')}
                        error={errors.lines?.[index]?.accountId?.message}
                      />
                    </div>
                    {(['debit', 'credit'] as const).map((side) => (
                      <Controller
                        key={side}
                        control={control}
                        name={linePath(index, side)}
                        render={({ field, fieldState }) => (
                          <LineField
                            id={field.name}
                            label={`${t(`opening.${side}`)}, ${account.code}`}
                            error={fieldState.error?.message}
                          >
                            <MoneyInput
                              id={field.name}
                              name={field.name}
                              ref={field.ref}
                              value={field.value}
                              onChange={field.onChange}
                              onBlur={field.onBlur}
                              disabled={!canPost}
                              invalid={fieldState.error !== undefined}
                              aria-describedby={
                                fieldState.error ? `${field.name}-error` : undefined
                              }
                            />
                          </LineField>
                        )}
                      />
                    ))}
                  </div>
                ),
              )}
            </section>
          ),
        )}
        {equity && (
          <div
            className={cn('grid grid-cols-2 gap-x-3 gap-y-1 border-t border-line px-5 py-3', ROW)}
          >
            <div className="col-span-2 min-w-0 @3xl:col-span-1">
              <span className="block text-body-sm text-ink">
                <span className="font-mono text-ink-3 tabular-nums">{equity.code}</span>{' '}
                {t('opening.difference')}
              </span>
              <span className="block text-caption text-ink-3">{t('opening.differenceHint')}</span>
            </div>
            {/* A debit gap is closed on the credit side, and the other way round */}
            <span className="text-right text-body-sm tabular-nums">
              {gap.side === 'credit' ? money(gap.amount) : ''}
            </span>
            <span className="text-right text-body-sm tabular-nums">
              {gap.side === 'debit' ? money(gap.amount) : ''}
            </span>
          </div>
        )}
        <div
          className={cn(
            'grid grid-cols-2 gap-x-3 border-t border-line bg-subtle px-5 py-3 text-body-sm font-medium',
            ROW,
          )}
        >
          <span className="col-span-2 @3xl:col-span-1">{t('opening.total')}</span>
          {/* With the equity line both sides are equal: the larger of the two. A debit gap
              (more debits) means the debit total is the larger one. */}
          <span className="text-right tabular-nums">
            {money(gap.side === 'debit' ? totals.debit : totals.credit)}
          </span>
          <span className="text-right tabular-nums">
            {money(gap.side === 'debit' ? totals.debit : totals.credit)}
          </span>
        </div>
      </Card>

      {canPost && (
        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('opening.save')}
          </Button>
        </div>
      )}
    </form>
  );
}

export function OpeningBalancesPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.journal.read');
  const accounts = useQuery({ ...accountsQuery(tenantId), enabled: canRead }).data;
  const { data: saved, isError } = useQuery({
    ...openingBalancesQuery(tenantId),
    enabled: canRead,
  });

  const rows = useMemo(() => {
    if (!accounts || !saved) return undefined;
    const list = openingAccounts(accounts);
    // An account that holds a saved balance but was archived since stays on the page, so its
    // amount never disappears without a word; the server then asks to restore it or clear it
    const extra = saved.lines.flatMap((line) => {
      const account = accounts.find((item) => item.id === line.accountId);
      return account && !list.includes(account) ? [account] : [];
    });
    return [...list, ...extra];
  }, [accounts, saved]);
  const equity = accounts?.find((account) => account.purpose === 'opening_balance_equity');

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader title={t('opening.title')} description={t('opening.description')} />
      {!canRead && (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.journal.read' })}
        </p>
      )}
      {isError && <p className="text-body-sm text-crit">{t('opening.loadFailed')}</p>}
      {saved && rows && (
        // key: after a save the entry changes, and the form starts again from what was posted
        <OpeningForm key={saved.entry?.id ?? 'none'} saved={saved} rows={rows} equity={equity} />
      )}
    </div>
  );
}
