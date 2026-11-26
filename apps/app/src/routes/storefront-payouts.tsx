import { BankIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { PAYOUT_STATUSES, type PayoutStatus, type PayoutSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SegmentedControl,
  SelectField,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

import { useIsoDate } from '../components/stock-parts';
import { PayoutStatusPill, usePayoutAccountName } from '../components/storefront-payout-parts';
import { StorefrontOffline } from '../components/storefront-parts';
import { storefrontPayoutSetupQuery, storefrontPayoutsQuery } from '../lib/storefront-payouts';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 28c: Storefront → Shop payouts (decision 13, approved with the mockup),
// storefront.payout.manage. A data table, newest date first and paged by the server, filtered by
// the courier account and the status, both in the address. A voided payout stays with its pill
// (P2). Whole taka, as a list shows money; the payout's page has the paisa. Online only, like the
// whole Storefront menu.

const column = dataTableColumns<PayoutSummary>();

export function StorefrontPayoutsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const online = useOnline();
  const isoDate = useIsoDate();
  const accountName = usePayoutAccountName();
  const { status = '', account = '' } = useSearch({ from: '/app/storefront/payouts' });
  const filtered = status !== '' || account !== '';

  const { data: setup } = useQuery({ ...storefrontPayoutSetupQuery(tenantId), enabled: online });
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...storefrontPayoutsQuery(tenantId, { status, accountId: account }),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // The address keeps the filters: Back from a payout lands on the same list. replace: a filter is
  // not a page of its own in the history
  const setFilter = (next: { status?: PayoutStatus | ''; account?: string }) => {
    const nextStatus = next.status ?? status;
    const nextAccount = next.account ?? account;
    void navigate({
      to: '/storefront/payouts',
      search: {
        ...(nextStatus !== '' && { status: nextStatus }),
        ...(nextAccount !== '' && { account: nextAccount }),
      },
      replace: true,
    });
  };

  const money = useCallback((value: string) => format.money(value, { decimals: 0 }), [format]);
  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('storefront.payouts.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ getValue }) => (
            <span className="font-mono font-medium tabular-nums">{getValue()}</span>
          ),
        }),
        column.accessor('date', {
          header: t('storefront.payouts.columns.date'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            // On a phone the card's sub-line says the account too: the column is hidden there
            <span className="tabular-nums">
              {isoDate(row.original.date)}
              <span className="min-[860px]:hidden"> · {row.original.account.name}</span>
            </span>
          ),
        }),
        column.accessor((payout) => payout.account.name, {
          id: 'account',
          header: t('storefront.payouts.columns.account'),
          enableSorting: false,
        }),
        column.accessor('reference', {
          header: t('storefront.payouts.columns.reference'),
          enableSorting: false,
          cell: ({ getValue }) => {
            const reference = getValue();
            return reference === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="font-mono text-label">{reference}</span>
            );
          },
        }),
        column.accessor('parcels', {
          header: t('storefront.payouts.columns.parcels'),
          enableSorting: false,
          meta: { align: 'end' },
          cell: ({ getValue }) => format.number(getValue()),
        }),
        column.accessor('collected', {
          header: t('storefront.payouts.columns.collected'),
          enableSorting: false,
          meta: { align: 'end' },
          cell: ({ getValue }) => money(getValue()),
        }),
        column.accessor('charges', {
          header: t('storefront.payouts.columns.charges'),
          enableSorting: false,
          meta: { align: 'end' },
          cell: ({ getValue }) => money(getValue()),
        }),
        // What reached the bank: the figure a person matches against the statement, so it is the
        // one at 500 and the card's right-hand number on a phone
        column.accessor('net', {
          header: t('storefront.payouts.columns.net'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => <span className="font-medium">{money(getValue())}</span>,
        }),
        column.accessor('status', {
          header: t('storefront.payouts.columns.status'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <PayoutStatusPill status={getValue()} />,
        }),
      ]),
    [t, format, isoDate, money],
  );

  const write = (
    <Button
      onClick={() =>
        void navigate({
          to: '/storefront/payouts/new',
          search: account === '' ? {} : { account },
        })
      }
    >
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('storefront.payouts.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.payouts.title')}
        description={t('storefront.payouts.description')}
        actions={online && write}
      />
      {!online ? (
        <StorefrontOffline />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <div className="w-full min-w-0 sm:w-80">
              <SelectField
                label={t('storefront.payouts.account')}
                value={account}
                onChange={(event) => {
                  setFilter({ account: event.target.value });
                }}
                options={[
                  { value: '', label: t('storefront.payouts.allAccounts') },
                  ...(setup?.accounts ?? []).map((choice) => ({
                    value: choice.id,
                    label: accountName(choice),
                  })),
                ]}
              />
            </div>
            <SegmentedControl
              label={t('storefront.payouts.view')}
              value={status}
              options={[
                { value: '', label: t('storefront.payouts.views.all') },
                ...PAYOUT_STATUSES.map((value) => ({
                  value,
                  label: t(`storefront.payouts.views.${value}`),
                })),
              ]}
              onChange={(next) => {
                setFilter({ status: next });
              }}
            />
          </div>
          {isError && (
            <p className="text-body-sm text-crit">{t('storefront.payouts.loadFailed')}</p>
          )}
          {rows && (
            <DataTable
              label={t('storefront.payouts.title')}
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              onRowClick={(row) =>
                void navigate({
                  to: '/storefront/payouts/$payoutId',
                  params: { payoutId: row.id },
                })
              }
              onEndReached={loadMore}
              empty={
                filtered ? (
                  <EmptyState
                    icon={BankIcon}
                    title={t('storefront.payouts.filteredEmptyTitle')}
                    description={t('storefront.payouts.filteredEmptyBody')}
                    action={
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setFilter({ status: '', account: '' });
                        }}
                      >
                        {t('storefront.payouts.showAll')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={BankIcon}
                    title={t('storefront.payouts.emptyTitle')}
                    description={t('storefront.payouts.emptyBody')}
                    action={write}
                  />
                )
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
