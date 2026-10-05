import { PackageOutOfStockIcon } from '@hugeicons/core-free-icons';
import { isZeroQuantity, type ReorderItem } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, Select } from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  useQuantity,
  useTenantId,
  useWarehouses,
  VariantCell,
  warehouseLabel,
} from '../components/stock-parts';
import { reorderQuery } from '../lib/queries';

const column = dataTableColumns<ReorderItem>();

// The list a purchase officer works from: what fell to its level, where, and how much to order.
// From step 17 a row will turn into a purchase requisition.
export function StockReorderPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const quantity = useQuantity();
  const { active, byId } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    reorderQuery(useTenantId(), warehouseId),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('productName', {
          header: t('reorder.columns.product'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => <VariantCell item={row.original} />,
        }),
        column.accessor('warehouseId', {
          header: t('reorder.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        column.accessor('onHand', {
          header: t('reorder.columns.onHand'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => (
            <span className="font-medium tabular-nums">
              {quantity(row.original.onHand, row.original.baseUnitId)}
            </span>
          ),
        }),
        column.accessor('inTransit', {
          header: t('reorder.columns.inTransit'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) =>
            isZeroQuantity(row.original.inTransit)
              ? '—'
              : quantity(row.original.inTransit, row.original.baseUnitId),
        }),
        column.accessor('minQuantity', {
          header: t('reorder.columns.level'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) => quantity(row.original.minQuantity, row.original.baseUnitId),
        }),
        column.accessor('reorderQuantity', {
          header: t('reorder.columns.order'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) =>
            row.original.reorderQuantity === null
              ? '—'
              : quantity(row.original.reorderQuantity, row.original.baseUnitId),
        }),
      ]),
    [t, quantity, byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('reorder.title')} description={t('reorder.description')} />
      <div className="min-w-0 sm:max-w-sm">
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
      {isError && <p className="text-body-sm text-crit">{t('reorder.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('reorder.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => `${row.variantId}-${row.warehouseId}`}
          onRowClick={(row) =>
            void navigate({ to: '/stock/$variantId', params: { variantId: row.variantId } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={PackageOutOfStockIcon}
              title={t('reorder.emptyTitle')}
              description={t('reorder.emptyBody')}
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
