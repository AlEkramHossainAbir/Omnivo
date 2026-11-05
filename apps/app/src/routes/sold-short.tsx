import {
  CheckmarkCircle02Icon,
  PackageRemoveIcon,
  TimeQuarterPassIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { compareQuantity, type SoldShortItem } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, Pill, Select } from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  useIsoDate,
  useQuantity,
  useTenantId,
  useWarehouses,
  warehouseLabel,
} from '../components/stock-parts';
import { soldShortQuery } from '../lib/pos-queries';
import { variantName } from '../lib/stock';
import { useOnline } from '../lib/use-online';

// Step 20a (decision 30): what the counters sold that the warehouse did not have. A POS sale is
// never refused for stock, so its lines go below zero, and each such line is listed here until
// someone counts the shelf and posts an adjustment or receives the goods. Newest first, from the
// server. A row opens its sale.

const column = dataTableColumns<SoldShortItem>();

export function SoldShortPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const online = useOnline();
  const tenantId = useTenantId();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const warehouses = useWarehouses();
  // '' = every warehouse
  const [warehouseId, setWarehouseId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...soldShortQuery(tenantId, warehouseId),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor((item) => variantName(item), {
          id: 'item',
          header: t('soldShort.columns.item'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[20rem]">
              <span className="truncate font-medium">{variantName(row.original)}</span>
              <span className="truncate font-mono text-caption text-ink-3">{row.original.sku}</span>
              {/* Serial numbers the scanner read that were not in this warehouse (decision 15) */}
              {row.original.serialNumbers.length > 0 && (
                <span className="truncate text-caption text-ink-3">
                  {t('soldShort.serials', { serials: row.original.serialNumbers.join(', ') })}
                </span>
              )}
            </span>
          ),
        }),
        column.accessor('saleNumber', {
          header: t('soldShort.columns.sale'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono tabular-nums">{row.original.saleNumber}</span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)} ·{' '}
                {warehouseLabel(warehouses.byId.get(row.original.warehouseId))}
              </span>
            </span>
          ),
        }),
        column.accessor('shortQuantity', {
          header: t('soldShort.columns.short'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row, getValue }) => (
            <span className="font-medium">{quantity(getValue(), row.original.baseUnitId)}</span>
          ),
        }),
        column.accessor('lotNumber', {
          header: t('soldShort.columns.batch'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const lot = getValue();
            return lot === null ? (
              <span className="text-ink-3">{t('soldShort.noBatch')}</span>
            ) : (
              <span className="font-mono">{lot}</span>
            );
          },
        }),
        column.accessor('onHandNow', {
          header: t('soldShort.columns.onHand'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row, getValue }) => quantity(getValue(), row.original.baseUnitId),
        }),
        // warn while the variant is below zero there, good once it is back at zero or above
        column.accessor((item) => compareQuantity(item.onHandNow, '0') < 0, {
          id: 'status',
          header: t('soldShort.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) =>
            getValue() ? (
              <Pill tone="warn" icon={TimeQuarterPassIcon}>
                {t('soldShort.statuses.open')}
              </Pill>
            ) : (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('soldShort.statuses.fixed')}
              </Pill>
            ),
        }),
      ]),
    [t, isoDate, quantity, warehouses.byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('soldShort.title')} description={t('soldShort.description')} />
      <div className="max-w-72">
        <Select
          aria-label={t('soldShort.warehouse')}
          value={warehouseId}
          onChange={(event) => {
            setWarehouseId(event.target.value);
          }}
          options={[
            { value: '', label: t('soldShort.allWarehouses') },
            ...(warehouses.active ?? []).map((warehouse) => ({
              value: warehouse.id,
              label: warehouseLabel(warehouse),
            })),
          ]}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('soldShort.loadFailed')}</p>}
      {!online && (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('soldShort.needsConnection')}
        />
      )}
      {online && rows && (
        <DataTable
          label={t('soldShort.title')}
          data={rows}
          columns={columns}
          // One sale may have several short lines: the key is the line, not the sale
          getRowId={(row) => row.lineId}
          onRowClick={(row) =>
            void navigate({ to: '/pos/sales/$saleId', params: { saleId: row.saleId } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={PackageRemoveIcon}
              title={t('soldShort.emptyTitle')}
              description={t('soldShort.emptyBody')}
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
