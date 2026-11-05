import { HourglassIcon } from '@hugeicons/core-free-icons';
import type { BatchStock } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SegmentedControl,
  Select,
} from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  ExpiryPill,
  useQuantity,
  useTenantId,
  useToday,
  useWarehouses,
  VariantCell,
  warehouseLabel,
} from '../components/stock-parts';
import { batchStockQuery } from '../lib/queries';

const column = dataTableColumns<BatchStock>();

// The windows a pharma depot works with: what to sell or return to the principal first
const WINDOWS = { all: null, d30: 30, d60: 60, d90: 90 } as const;
type ExpiryWindow = keyof typeof WINDOWS;
const WINDOW_KEYS = ['all', 'd30', 'd60', 'd90'] as const satisfies readonly ExpiryWindow[];

export function StockBatchesPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const quantity = useQuantity();
  const today = useToday();
  const { active, byId } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [within, setWithin] = useState<ExpiryWindow>('d90');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    batchStockQuery(useTenantId(), { warehouseId, expiresWithin: WINDOWS[within] }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('productName', {
          header: t('expiry.columns.product'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => <VariantCell item={row.original} />,
        }),
        column.accessor('lotNumber', {
          header: t('expiry.columns.lot'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="font-mono">{getValue()}</span>,
        }),
        column.accessor('warehouseId', {
          header: t('expiry.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => byId.get(getValue())?.code ?? '—',
        }),
        column.accessor('expiresOn', {
          header: t('expiry.columns.expires'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <ExpiryPill expiresOn={getValue()} today={today} />,
        }),
        column.accessor('quantity', {
          header: t('expiry.columns.quantity'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => (
            <span className="tabular-nums">
              {quantity(row.original.quantity, row.original.baseUnitId)}
            </span>
          ),
        }),
      ]),
    [t, quantity, today, byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('expiry.title')} description={t('expiry.description')} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-64">
          <Select
            aria-label={t('stock.warehouse')}
            options={[
              { value: '', label: t('stock.allWarehouses') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            value={warehouseId}
            onChange={(event) => {
              setWarehouseId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('expiry.within')}
          value={within}
          options={WINDOW_KEYS.map((value) => ({ value, label: t(`expiry.windows.${value}`) }))}
          onChange={setWithin}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('expiry.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('expiry.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => `${row.batchId}-${row.warehouseId}`}
          onRowClick={(row) =>
            void navigate({ to: '/stock/$variantId', params: { variantId: row.variantId } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={HourglassIcon}
              title={t('expiry.emptyTitle')}
              description={t('expiry.emptyBody')}
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
