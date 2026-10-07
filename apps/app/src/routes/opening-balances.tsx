import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  ACCOUNT_TYPES,
  contractErrorMap,
  isPartyAccountPurpose,
  type OpeningBalances,
  openingBalancesInputSchema,
  type PartyRef,
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
  IconButton,
  MoneyInput,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { CustomerPicker } from '../components/customer-picker';
import { LineError, LineField, useIsoDate } from '../components/journal-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { balanceSide, formAmount, linePath, openingAccounts, totalsOf } from '../lib/journal';
import { useCan } from '../lib/permissions';
import { accountsQuery, openingBalancesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

type FormValues = z.input<typeof openingBalancesInputSchema>;
type LineValues = FormValues['lines'][number];

// Name, Debit, Credit — the same template for the header, every row and the totals
const ROW = '@3xl:grid-cols-[minmax(0,1fr)_10rem_10rem] @3xl:items-start';

function fieldNames(count: number): Path<FormValues>[] {
  return [
    'goLiveDate',
    ...Array.from({ length: count }, (_, index) => [
      linePath(index, 'accountId'),
      linePath(index, 'partyId'),
      linePath(index, 'debit'),
      linePath(index, 'credit'),
    ]).flat(),
  ];
}

function emptyLine(accountId: string): LineValues {
  return { accountId, partyId: '', debit: '', credit: '' };
}

// The form's lines: one per account, and on the receivable one per customer (step 15a). A
// receivable with nothing saved starts with one empty customer row, ready to fill.
function linesOf(
  saved: OpeningBalances,
  rows: readonly Account[],
  partyAccounts: ReadonlySet<string>,
): LineValues[] {
  return rows.flatMap((account) => {
    const own = saved.lines.filter((line) => line.accountId === account.id);
    if (!partyAccounts.has(account.id)) {
      const [line] = own;
      return [
        {
          accountId: account.id,
          partyId: '',
          debit: formAmount(line?.debit ?? ''),
          credit: formAmount(line?.credit ?? ''),
        },
      ];
    }
    if (own.length === 0) return [emptyLine(account.id)];
    // A line saved before step 15a has no customer: it stays, with its amount, until the person
    // picks one or splits it
    return own.map((line) => ({
      accountId: account.id,
      partyId: line.party?.id ?? '',
      debit: formAmount(line.debit),
      credit: formAmount(line.credit),
    }));
  });
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
  const partyAccounts = useMemo(
    () =>
      new Set(
        rows.filter((account) => isPartyAccountPurpose(account.purpose)).map((item) => item.id),
      ),
    [rows],
  );
  // The customers saved before, so each box names its customer before any search ran
  const savedParties = useMemo(
    () =>
      new Map<string, PartyRef>(
        saved.lines.flatMap((line) => (line.party ? [[line.party.id, line.party]] : [])),
      ),
    [saved],
  );
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
      lines: linesOf(saved, rows, partyAccounts),
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const goLiveDate = useWatch({ control, name: 'goLiveDate' });
  const totals = totalsOf(lines);
  // Opening balance equity takes the other side of the difference, so the entry balances
  const gap = balanceSide(totals.difference);
  // Where each account's lines are in the form. "Add a customer" appends at the end, so a
  // receivable's rows are not next to each other in the array; the page shows them together.
  const indexesOf = useMemo(() => {
    const map = new Map<string, number[]>();
    lines.forEach((line, index) => {
      map.set(line.accountId, [...(map.get(line.accountId) ?? []), index]);
    });
    return map;
  }, [lines]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      const result = await call(routes.openingBalances.save, { body: values });
      queryClient.setQueryData(openingBalancesQuery(tenantId).queryKey, result);
      await queryClient.invalidateQueries({ queryKey: ['journal', tenantId] });
      // The customers' balances come from these lines too
      await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
      toast(
        result.entry ? t('opening.saved', { number: result.entry.number }) : t('opening.cleared'),
      );
    } catch (error) {
      applyApiError(error, fieldNames(lines.length), setError);
    }
  });

  const money = (value: string) => format.money(value, { decimals: 2 });

  // Debit and credit of one line, with a label that names the row for a screen reader
  const amounts = (index: number, label: string) =>
    (['debit', 'credit'] as const).map((side) => (
      <Controller
        key={side}
        control={control}
        name={linePath(index, side)}
        render={({ field, fieldState }) => (
          <LineField
            id={field.name}
            label={`${t(`opening.${side}`)}, ${label}`}
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
              aria-describedby={fieldState.error ? `${field.name}-error` : undefined}
            />
          </LineField>
        )}
      />
    ));

  const accountName = (account: Account) => (
    <span className="block truncate text-body-sm text-ink">
      <span className="font-mono text-ink-3 tabular-nums">{account.code}</span> {account.name}
    </span>
  );

  // The receivable: a row per customer, each with its picker, and "Add a customer"
  const partyRows = (account: Account) => {
    const indexes = indexesOf.get(account.id) ?? [];
    return (
      <div key={account.id} role="group" aria-label={`${account.code} ${account.name}`}>
        <div className="grid gap-0.5 px-5 pt-2">
          {accountName(account)}
          <span className="text-caption text-ink-3">{t('opening.receivableHint')}</span>
        </div>
        {indexes.map((index, position) => {
          const number = position + 1;
          const label = t('opening.customerLine', { account: account.code, number });
          const start = fields[index];
          // Saved with an amount and no customer: from before customers were kept
          const unassigned =
            start !== undefined &&
            (start.partyId ?? '') === '' &&
            (start.debit !== '' || start.credit !== '') &&
            (lines[index]?.partyId ?? '') === '';
          return (
            <div
              key={start?.id ?? index}
              role="group"
              aria-label={label}
              className={cn('grid grid-cols-2 gap-x-3 gap-y-2 py-2 pr-5 pl-9', ROW)}
            >
              <div className="col-span-2 grid min-w-0 gap-1.5 @3xl:col-span-1">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Controller
                      control={control}
                      name={linePath(index, 'partyId')}
                      render={({ field, fieldState }) => (
                        <LineField
                          id={field.name}
                          label={t('opening.customer')}
                          error={fieldState.error?.message}
                        >
                          <CustomerPicker
                            id={field.name}
                            name={field.name}
                            ref={field.ref}
                            value={field.value ?? ''}
                            saved={savedParties.get(field.value ?? '') ?? null}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            disabled={!canPost}
                            invalid={fieldState.error !== undefined}
                            aria-label={`${t('opening.customer')}, ${label}`}
                            aria-describedby={fieldState.error ? `${field.name}-error` : undefined}
                          />
                        </LineField>
                      )}
                    />
                  </div>
                  {canPost && (
                    <IconButton
                      icon={Delete02Icon}
                      label={t('opening.removeCustomer', { account: account.code, number })}
                      // Level with the box once its label is hidden (wide card)
                      className="mt-[26px] @3xl:mt-0.5"
                      onClick={() => {
                        remove(index);
                      }}
                    />
                  )}
                </div>
                {unassigned && (
                  <span className="text-caption text-ink-3">{t('opening.noCustomerHint')}</span>
                )}
              </div>
              {amounts(index, label)}
            </div>
          );
        })}
        {canPost && (
          <div className="py-2 pr-5 pl-9">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                append(emptyLine(account.id));
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
              {t('opening.addCustomer')}
            </Button>
          </div>
        )}
      </div>
    );
  };

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
              {rows.map((account) => {
                if (account.type !== type) return null;
                if (partyAccounts.has(account.id)) return partyRows(account);
                const index = indexesOf.get(account.id)?.[0];
                if (index === undefined) return null;
                return (
                  <div
                    key={account.id}
                    className={cn('grid grid-cols-2 gap-x-3 gap-y-2 px-5 py-2', ROW)}
                  >
                    <div className="col-span-2 min-w-0 self-center @3xl:col-span-1">
                      {accountName(account)}
                      <LineError
                        id={linePath(index, 'accountId')}
                        error={errors.lines?.[index]?.accountId?.message}
                      />
                    </div>
                    {amounts(index, account.code)}
                  </div>
                );
              })}
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
    const extra = new Set<Account>();
    for (const line of saved.lines) {
      const account = accounts.find((item) => item.id === line.accountId);
      // A Set: the receivable has a line per customer (step 15a), but one row block
      if (account && !list.includes(account)) extra.add(account);
    }
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
