import { UserTime01Icon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import { POS_SHIFT_STATUSES, type PosShiftStatus, type PosShiftSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, Select } from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { counterMoney, differenceWords, PosShiftPill } from '../components/pos-shift-parts';
import { useTenantId, useTimeZone } from '../components/stock-parts';
import { posRegistersQuery, posShiftsQuery } from '../lib/pos-queries';
import { useOnline } from '../lib/use-online';

// Step 20b: every register's shifts, newest first, for the people with pos.shift.manage (decision
// 26: a shift shows how short a cashier's drawer was). Read from the server, like the POS sales:
// offline it says it needs a connection. A row opens the shift's page.

const column = dataTableColumns<PosShiftSummary>();

function isShiftStatus(value: string): value is PosShiftStatus {
  return POS_SHIFT_STATUSES.some((status) => status === value);
}

export function PosShiftsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const online = useOnline();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  // '' = every register; undefined = every status
  const [registerId, setRegisterId] = useState('');
  const [status, setStatus] = useState<PosShiftStatus | undefined>(undefined);
  const registers = useQuery(posRegistersQuery(tenantId, 'active')).data;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...posShiftsQuery(tenantId, registerId, status),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        // The number, and when it opened by the device's clock in the workspace's time zone
        column.accessor('number', {
          header: t('posShifts.columns.shift'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">{row.original.number}</span>
              <span className="text-caption text-ink-3 tabular-nums">
                {format.dateTime(new Date(row.original.openedAt), timeZone)}
              </span>
            </span>
          ),
        }),
        column.accessor((shift) => shift.register.code, {
          id: 'register',
          header: t('posShifts.columns.register'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[14rem]">
              <span className="font-mono">{row.original.register.code}</span>
              <span className="truncate text-caption text-ink-3">{row.original.register.name}</span>
            </span>
          ),
        }),
        // One person on one device (step 20 decision 4): the device under the name
        column.accessor((shift) => shift.cashier.fullName, {
          id: 'cashier',
          header: t('posShifts.columns.cashier'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[14rem]">
              <span className="truncate">{row.original.cashier.fullName}</span>
              <span className="truncate text-caption text-ink-3">{row.original.device.name}</span>
            </span>
          ),
        }),
        // So far while open, at the close once closed (the API's number, decision 60)
        column.accessor('expectedCash', {
          header: t('posShifts.columns.expected'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => counterMoney(format, getValue()),
        }),
        column.accessor('countedCash', {
          header: t('posShifts.columns.counted'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => {
            const counted = getValue();
            return counted === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="font-medium">{counterMoney(format, counted)}</span>
            );
          },
        }),
        // In words, not a sign (decision 66): "৳50 short" reads the same in both languages
        column.accessor('difference', {
          header: t('posShifts.columns.difference'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => {
            const difference = getValue();
            return difference === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              differenceWords(t, format, difference)
            );
          },
        }),
        column.accessor('status', {
          header: t('posShifts.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <PosShiftPill status={getValue()} />,
        }),
      ]),
    [t, format, timeZone],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('posShifts.title')} description={t('posShifts.description')} />
      <div className="flex flex-wrap gap-3">
        <div className="w-full sm:w-72">
          <Select
            aria-label={t('posShifts.register')}
            value={registerId}
            onChange={(event) => {
              setRegisterId(event.target.value);
            }}
            options={[
              { value: '', label: t('posShifts.allRegisters') },
              ...(registers ?? []).map((register) => ({
                value: register.id,
                label: `${register.code} · ${register.name}`,
              })),
            ]}
          />
        </div>
        {/* A select, not a segmented control: "All shifts" is a choice too, and the manager most
            often looks for the open ones (a stuck shift) */}
        <div className="w-full sm:w-56">
          <Select
            aria-label={t('posShifts.show')}
            value={status ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              setStatus(isShiftStatus(value) ? value : undefined);
            }}
            options={[
              { value: '', label: t('posShifts.allStatuses') },
              ...POS_SHIFT_STATUSES.map((value) => ({
                value,
                label: t(`posShifts.statuses.${value}`),
              })),
            ]}
          />
        </div>
      </div>
      {isError && <p className="text-body-sm text-crit">{t('posShifts.loadFailed')}</p>}
      {!online && (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('posShifts.needsConnection')}
        />
      )}
      {online && rows && (
        <DataTable
          label={t('posShifts.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/pos/shifts/$shiftId', params: { shiftId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={UserTime01Icon}
              title={t('posShifts.emptyTitle')}
              description={t('posShifts.emptyBody')}
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
