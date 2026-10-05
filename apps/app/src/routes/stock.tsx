import {
  Alert02Icon,
  Archive02Icon,
  ArrowDataTransferHorizontalIcon,
  Layers01Icon,
  PackageOutOfStockIcon,
  PlusSignIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  compareQuantity,
  isZeroQuantity,
  STOCK_FILTERS,
  type StockFilter,
  type StockItem,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  Input,
  PageHeader,
  Pill,
  SegmentedControl,
  Select,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  useQuantity,
  useTenantId,
  useWarehouses,
  VariantCell,
  warehouseLabel,
} from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { categoryOptions } from '../lib/products';
import { productCategoriesQuery, stockListQuery } from '../lib/queries';
import { useDebounced } from '../lib/use-debounced';

const column = dataTableColumns<StockItem>();

// Why a row needs a look: below zero (crit), at its reorder level (warn: "Out of stock" when
// nothing is left), or archived and still holding some (neutral). Each with its icon and word,
// never colour alone. Zero alone is no warning: a garments factory has thousands of styles it
// does not keep — only a variant with a reorder level is expected to be in stock.
function StockStatus({ item }: { item: StockItem }) {
  const { t } = useLocale();
  return (
    <span className="inline-flex flex-wrap justify-end gap-1.5">
      {compareQuantity(item.onHand, '0') < 0 && (
        <Pill tone="crit" icon={Alert02Icon}>
          {t('stock.statuses.negative')}
        </Pill>
      )}
      {item.low && isZeroQuantity(item.onHand) && (
        <Pill tone="warn" icon={PackageOutOfStockIcon}>
          {t('stock.statuses.out')}
        </Pill>
      )}
      {item.low && compareQuantity(item.onHand, '0') > 0 && (
        <Pill tone="warn" icon={PackageOutOfStockIcon}>
          {t('stock.statuses.low')}
        </Pill>
      )}
      {item.archived && (
        <Pill tone="neutral" icon={Archive02Icon}>
          {t('stock.statuses.archived')}
        </Pill>
      )}
    </span>
  );
}

export function StockPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const can = useCan();
  const quantity = useQuantity();
  const { active } = useWarehouses();
  const [search, setSearch] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [filter, setFilter] = useState<StockFilter>('all');
  const settled = useDebounced(search.trim());
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    stockListQuery(tenantId, { search: settled, warehouseId, categoryId, filter }),
  );
  const categories = useQuery(productCategoriesQuery(tenantId)).data;
  const items = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('productName', {
          header: t('stock.columns.product'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => <VariantCell item={row.original} />,
        }),
        column.accessor('onHand', {
          header: t('stock.columns.onHand'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => (
            <span className="font-medium tabular-nums">
              {quantity(row.original.onHand, row.original.baseUnitId)}
            </span>
          ),
        }),
        column.accessor('inTransit', {
          header: t('stock.columns.inTransit'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) =>
            isZeroQuantity(row.original.inTransit) ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="tabular-nums">
                {quantity(row.original.inTransit, row.original.baseUnitId)}
              </span>
            ),
        }),
        column.display({
          id: 'status',
          header: t('stock.columns.status'),
          meta: { align: 'end', card: 'subtitle' },
          cell: ({ row }) => <StockStatus item={row.original} />,
        }),
      ]),
    [t, quantity],
  );

  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('stock.noMatchTitle', { query: settled })}
        description={t('stock.noMatchBody')}
      />
    ) : filter === 'low' ? (
      <EmptyState
        icon={PackageOutOfStockIcon}
        title={t('stock.lowEmptyTitle')}
        description={t('stock.lowEmptyBody')}
      />
    ) : (
      <EmptyState
        icon={Layers01Icon}
        title={t('stock.emptyTitle')}
        description={t('stock.emptyBody')}
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('stock.title')}
        description={t('stock.description')}
        actions={
          <>
            {can('inventory.stock.transfer') && (
              <Button
                variant="secondary"
                onClick={() => void navigate({ to: '/stock/transfers/new' })}
              >
                <HugeiconsIcon icon={ArrowDataTransferHorizontalIcon} size={17} strokeWidth={1.5} />
                {t('stock.newTransfer')}
              </Button>
            )}
            {can('inventory.stock.adjust') && (
              <Button onClick={() => void navigate({ to: '/stock/adjustments/new' })}>
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('stock.newAdjustment')}
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('stock.searchLabel')}
            placeholder={t('stock.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 basis-56">
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
        <div className="min-w-0 basis-56">
          <Select
            aria-label={t('stock.category')}
            options={[
              { value: '', label: t('stock.allCategories') },
              ...categoryOptions(categories ?? []),
            ]}
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('stock.show')}
          value={filter}
          options={STOCK_FILTERS.map((value) => ({ value, label: t(`stock.filters.${value}`) }))}
          onChange={setFilter}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('stock.loadFailed')}</p>}
      {items && (
        <DataTable
          label={t('stock.title')}
          data={items}
          columns={columns}
          getRowId={(item) => item.variantId}
          onRowClick={(item) =>
            void navigate({ to: '/stock/$variantId', params: { variantId: item.variantId } })
          }
          onEndReached={loadMore}
          maxHeight={640}
          empty={empty}
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
