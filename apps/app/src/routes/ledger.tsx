import { Book02Icon, Notebook02Icon } from '@hugeicons/core-free-icons';
import { DEFAULT_SETTINGS, type LedgerLine, todayIn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Card,
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  Field,
  PageHeader,
  SelectField,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { useIsoDate } from '../components/journal-parts';
import { balanceSide, fiscalYearStart, ledgerOptions } from '../lib/journal';
import { useCan } from '../lib/permissions';
import { accountsQuery, ledgerQuery, settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<LedgerLine>();

// "৳12,500.00 Dr" — a balance with its side; zero has none
function useBalanceText(): (value: string) => string {
  const { t, format } = useLocale();
  return useCallback(
    (value: string) => {
      const { amount, side } = balanceSide(value);
      const money = format.money(amount, { decimals: 2 });
      if (side === null) return money;
      return t(side === 'debit' ? 'ledger.debitBalance' : 'ledger.creditBalance', {
        amount: money,
      });
    },
    [t, format],
  );
}

export function LedgerPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const { account: accountId = '' } = useSearch({ strict: false });
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.journal.read');
  const showDate = useIsoDate();
  const balanceText = useBalanceText();
  const accounts = useQuery({ ...accountsQuery(tenantId), enabled: canRead }).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  // Until the person picks dates: from the start of this fiscal year to today, in the company's
  // time zone. null = "not picked", so the default follows the settings once they arrive.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const today = todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone);
  const { from, to } = range ?? {
    from: fiscalYearStart(
      today,
      settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
    ),
    to: today,
  };
  const account = accounts?.find((item) => item.id === accountId);

  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...ledgerQuery(tenantId, accountId, from, to),
    enabled: canRead && account !== undefined,
  });
  const lines = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const first = data?.pages[0];

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const options = useMemo(
    () => [{ value: '', label: t('ledger.accountPlaceholder') }, ...ledgerOptions(accounts ?? [])],
    [accounts, t],
  );

  const columns = useMemo(() => {
    const amount = (value: string) =>
      value === '0.0000' ? '' : format.money(value, { decimals: 2 });
    return column.columns([
      column.accessor('number', {
        header: t('ledger.columns.entry'),
        // The server's order (date, then the order the lines were written) is the ledger
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-mono font-medium tabular-nums">{row.original.number}</span>
            <span className="text-caption text-ink-3 tabular-nums">
              {showDate(row.original.date)}
            </span>
          </span>
        ),
      }),
      column.accessor((line) => line.description ?? line.narration ?? '', {
        id: 'narration',
        header: t('journal.columns.narration'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => <span className="block truncate">{getValue() || '—'}</span>,
      }),
      column.accessor('debit', {
        header: t('ledger.columns.debit'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => amount(getValue()),
      }),
      column.accessor('credit', {
        header: t('ledger.columns.credit'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => amount(getValue()),
      }),
      column.accessor('balance', {
        header: t('ledger.columns.balance'),
        enableSorting: false,
        meta: { align: 'end', card: 'trailing' },
        cell: ({ getValue }) => <span className="font-medium">{balanceText(getValue())}</span>,
      }),
    ]);
  }, [t, format, showDate, balanceText]);

  if (!canRead) {
    return (
      <div className="grid max-w-5xl grid-cols-1 gap-5">
        <PageHeader title={t('ledger.title')} description={t('ledger.description')} />
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.journal.read' })}
        </p>
      </div>
    );
  }

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader title={t('ledger.title')} description={t('ledger.description')} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <SelectField
          label={t('ledger.account')}
          options={options}
          value={account ? accountId : ''}
          onChange={(event) => {
            const next = event.target.value;
            // In the address: the link from an entry's line lands here, and Back works
            void navigate({ to: '/ledger', search: next === '' ? {} : { account: next } });
          }}
        />
        <Field id="ledger-from" label={t('ledger.from')}>
          <DatePicker
            id="ledger-from"
            value={from}
            onChange={(value) => {
              setRange({ from: value, to });
            }}
          />
        </Field>
        <Field id="ledger-to" label={t('ledger.to')}>
          <DatePicker
            id="ledger-to"
            value={to}
            onChange={(value) => {
              setRange({ from, to: value });
            }}
          />
        </Field>
      </div>
      {!account ? (
        <EmptyState
          icon={Book02Icon}
          title={t('ledger.pickTitle')}
          description={t('ledger.pickBody')}
        />
      ) : (
        <>
          {/* One card split by a rule, like the KPI strip */}
          <Card className="grid grid-cols-2 divide-x divide-line">
            {[
              { label: t('ledger.opening'), value: first?.openingBalance },
              { label: t('ledger.closing'), value: first?.closingBalance },
            ].map((cell) => (
              <div key={cell.label} className="grid gap-1 px-5 py-4">
                <span className="text-caption text-ink-3">{cell.label}</span>
                <span className="text-h3 tabular-nums">
                  {cell.value === undefined ? '—' : balanceText(cell.value)}
                </span>
              </div>
            ))}
          </Card>
          {isError && <p className="text-body-sm text-crit">{t('ledger.loadFailed')}</p>}
          {lines && (
            <DataTable
              label={t('ledger.title')}
              data={lines}
              columns={columns}
              getRowId={(line) => line.lineId}
              onRowClick={(line) =>
                void navigate({ to: '/journal/$entryId', params: { entryId: line.entryId } })
              }
              onEndReached={loadMore}
              empty={
                <EmptyState
                  icon={Notebook02Icon}
                  title={t('ledger.emptyTitle')}
                  description={t('ledger.emptyBody')}
                />
              }
              footer={
                isFetchingNextPage && (
                  <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                )
              }
            />
          )}
        </>
      )}
    </div>
  );
}
