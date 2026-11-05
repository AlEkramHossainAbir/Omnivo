import { Notebook02Icon } from '@hugeicons/core-free-icons';
import { DEFAULT_SETTINGS, type LedgerLine, type PartyRole, todayIn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Card,
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  Field,
  SectionHeader,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { fiscalYearStart } from '../lib/journal';
import { useCan } from '../lib/permissions';
import { partyStatementQuery, settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useBalanceText, useIsoDate } from './journal-parts';

const column = dataTableColumns<LedgerLine>();

// Where each side's words are: the customer's page says "customers.statementTitle", the supplier's
// "suppliers.statementTitle" (the same keys in each section)
const SECTION = { customer: 'customers', supplier: 'suppliers' } as const satisfies Record<
  PartyRole,
  string
>;

// A party's receivable lines (a customer, step 15a) or payable lines (a supplier, step 17a) with a
// running balance: the ledger of one account, cut down to one party. Moved here from the customer's
// page in step 17a, so both pages show the same table. Dates as on the ledger: this fiscal year to
// today until the person picks.
export function PartyStatement({ role, partyId }: { role: PartyRole; partyId: string }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canReadJournal = useCan()('accounting.journal.read');
  const showDate = useIsoDate();
  const balanceText = useBalanceText();
  const section = SECTION[role];
  const settings = useQuery(settingsQuery(tenantId)).data;
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const today = todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone);
  const { from, to } = range ?? {
    from: fiscalYearStart(
      today,
      settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
    ),
    to: today,
  };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    partyStatementQuery(tenantId, role, partyId, from, to),
  );
  const lines = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const first = data?.pages[0];

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(() => {
    const amount = (value: string) =>
      value === '0.0000' ? '' : format.money(value, { decimals: 2 });
    return column.columns([
      column.accessor('number', {
        header: t('ledger.columns.entry'),
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

  return (
    <section className="grid grid-cols-1 gap-4" aria-label={t(`${section}.statementTitle`)}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeader
          title={t(`${section}.statementTitle`)}
          subtitle={t(`${section}.statementSubtitle`)}
        />
        <div className="grid w-full grid-cols-2 gap-4 sm:w-auto sm:grid-cols-[12rem_12rem]">
          <Field id="statement-from" label={t('ledger.from')}>
            <DatePicker
              id="statement-from"
              value={from}
              onChange={(value) => {
                setRange({ from: value, to });
              }}
            />
          </Field>
          <Field id="statement-to" label={t('ledger.to')}>
            <DatePicker
              id="statement-to"
              value={to}
              onChange={(value) => {
                setRange({ from, to: value });
              }}
            />
          </Field>
        </div>
      </div>
      {/* One card split by a rule, like the ledger's */}
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
      {isError && <p className="text-body-sm text-crit">{t(`${section}.statementLoadFailed`)}</p>}
      {lines && (
        <DataTable
          label={t(`${section}.statementTitle`)}
          data={lines}
          columns={columns}
          getRowId={(line) => line.lineId}
          // The entry behind a line, for those who may read the journal
          onRowClick={
            canReadJournal
              ? (line) =>
                  void navigate({ to: '/journal/$entryId', params: { entryId: line.entryId } })
              : undefined
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={Notebook02Icon}
              title={t(`${section}.statementEmptyTitle`)}
              description={t(`${section}.statementEmptyBody`)}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </section>
  );
}
