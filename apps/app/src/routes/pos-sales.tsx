import { ReceiptDollarIcon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import type { PosSaleSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, Select } from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { PosSalePills } from '../components/pos-sale-parts';
import { useIsoDate, useTenantId } from '../components/stock-parts';
import { posRegistersQuery, posSalesQuery } from '../lib/pos-queries';
import { useOnline } from '../lib/use-online';

// Step 20a: what the counters sold, as it reached the books, newest first. For the managers: the
// cashier sees their own sales on the POS screen and its receipts. Read from the server (the sales
// are not on the devices), so offline it says it needs a connection, like the orders list.

const column = dataTableColumns<PosSaleSummary>();

export function PosSalesPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const online = useOnline();
  const tenantId = useTenantId();
  const isoDate = useIsoDate();
  // '' = every register
  const [registerId, setRegisterId] = useState('');
  const registers = useQuery(posRegistersQuery(tenantId, 'active')).data;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...posSalesQuery(tenantId, registerId),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('posSales.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">{row.original.number}</span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((sale) => sale.register.code, {
          id: 'register',
          header: t('posSales.columns.register'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[14rem]">
              <span className="font-mono">{row.original.register.code}</span>
              <span className="truncate text-caption text-ink-3">{row.original.register.name}</span>
            </span>
          ),
        }),
        // null = walk-in (decision 5)
        column.accessor((sale) => sale.customer?.name ?? '', {
          id: 'customer',
          header: t('posSales.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) =>
            row.original.customer ? (
              <span className="block max-w-[16rem] truncate">{row.original.customer.name}</span>
            ) : (
              <span className="text-ink-3">{t('posSales.walkIn')}</span>
            ),
        }),
        column.accessor((sale) => sale.cashier.fullName, {
          id: 'cashier',
          header: t('posSales.columns.cashier'),
          enableSorting: false,
          meta: { card: 'detail' },
        }),
        column.accessor('total', {
          header: t('posSales.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor('soldShort', {
          header: t('posSales.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <PosSalePills soldShort={getValue()} />,
        }),
      ]),
    [t, format, isoDate],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('posSales.title')} description={t('posSales.description')} />
      <div className="max-w-72">
        <Select
          aria-label={t('posSales.register')}
          value={registerId}
          onChange={(event) => {
            setRegisterId(event.target.value);
          }}
          options={[
            { value: '', label: t('posSales.allRegisters') },
            ...(registers ?? []).map((register) => ({
              value: register.id,
              label: `${register.code} · ${register.name}`,
            })),
          ]}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('posSales.loadFailed')}</p>}
      {!online && (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('posSales.needsConnection')}
        />
      )}
      {online && rows && (
        <DataTable
          label={t('posSales.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/pos/sales/$saleId', params: { saleId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={ReceiptDollarIcon}
              title={t('posSales.emptyTitle')}
              description={t('posSales.emptyBody')}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </div>
  );
}
