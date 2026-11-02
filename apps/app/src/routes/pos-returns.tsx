import { ReturnRequestIcon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import type { PosReturnSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, Select } from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { PosReturnPills } from '../components/pos-sale-parts';
import { useIsoDate, useTenantId } from '../components/stock-parts';
import { posRegistersQuery, posReturnsQuery } from '../lib/pos-queries';
import { useOnline } from '../lib/use-online';

// Step 20c: what the counters took back, as it reached the books, newest first. The POS sales
// list's twin (decision 30: everyone reads it, like the sales): the same register filter, the
// same "needs a connection" offline. A shift's page opens it with ?shiftId=, for that shift's
// returns only; the register filter makes no sense then, so a line names the shift instead.

const column = dataTableColumns<PosReturnSummary>();

export function PosReturnsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const online = useOnline();
  const tenantId = useTenantId();
  const isoDate = useIsoDate();
  const { shiftId = '' } = useSearch({ strict: false });
  // '' = every register
  const [registerId, setRegisterId] = useState('');
  const registers = useQuery(posRegistersQuery(tenantId, 'active')).data;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...posReturnsQuery(tenantId, shiftId === '' ? registerId : '', shiftId),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  // Every row of a shift's list has the shift's number; a shift with no returns has no link to
  // this list (its page shows none), so an empty list needs no number
  const shiftNumber = shiftId === '' ? null : (rows?.[0]?.shift.number ?? null);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('posReturns.columns.number'),
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
        // The receipt it came from. Plain text: the row opens the return, whose page links it.
        column.accessor((item) => item.sale.number, {
          id: 'sale',
          header: t('posReturns.columns.sale'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="font-mono tabular-nums">{getValue()}</span>,
        }),
        column.accessor((item) => item.register.code, {
          id: 'register',
          header: t('posReturns.columns.register'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[14rem]">
              <span className="font-mono">{row.original.register.code}</span>
              <span className="truncate text-caption text-ink-3">{row.original.register.name}</span>
            </span>
          ),
        }),
        // The sale's customer; null = walk-in
        column.accessor((item) => item.customer?.name ?? '', {
          id: 'customer',
          header: t('posReturns.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) =>
            row.original.customer ? (
              <span className="block max-w-[16rem] truncate">{row.original.customer.name}</span>
            ) : (
              <span className="text-ink-3">{t('posReturns.walkIn')}</span>
            ),
        }),
        column.accessor((item) => item.cashier.fullName, {
          id: 'cashier',
          header: t('posReturns.columns.cashier'),
          enableSorting: false,
          meta: { card: 'detail' },
        }),
        column.accessor('total', {
          header: t('posReturns.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.display({
          id: 'status',
          header: t('posReturns.columns.status'),
          meta: { card: 'trailing' },
          cell: ({ row }) => <PosReturnPills item={row.original} />,
        }),
      ]),
    [t, format, isoDate],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('posReturns.title')} description={t('posReturns.description')} />
      {shiftId === '' ? (
        <div className="max-w-72">
          <Select
            aria-label={t('posReturns.register')}
            value={registerId}
            onChange={(event) => {
              setRegisterId(event.target.value);
            }}
            options={[
              { value: '', label: t('posReturns.allRegisters') },
              ...(registers ?? []).map((register) => ({
                value: register.id,
                label: `${register.code} · ${register.name}`,
              })),
            ]}
          />
        </div>
      ) : (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-ink-2">
          {shiftNumber !== null && (
            <span className="tabular-nums">{t('posReturns.ofShift', { number: shiftNumber })}</span>
          )}
          <Link
            to="/pos/returns"
            className="font-medium text-brand underline-offset-3 hover:underline"
          >
            {t('posReturns.showAll')}
          </Link>
        </p>
      )}
      {isError && <p className="text-body-sm text-crit">{t('posReturns.loadFailed')}</p>}
      {!online && (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('posReturns.needsConnection')}
        />
      )}
      {online && rows && (
        <DataTable
          label={t('posReturns.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/pos/returns/$returnId', params: { returnId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={ReturnRequestIcon}
              title={t('posReturns.emptyTitle')}
              description={t('posReturns.emptyBody')}
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
