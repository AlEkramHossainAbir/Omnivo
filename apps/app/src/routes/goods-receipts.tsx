import { PackageReceiveIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type GoodsReceiptSummary,
  STOCK_DOCUMENT_STATUSES,
  type StockDocumentStatus,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
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

import { SupplierFilter } from '../components/purchase-parts';
import { GoodsReceiptStatusPill } from '../components/purchase-pills';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { goodsReceiptsQuery } from '../lib/queries';

const column = dataTableColumns<GoodsReceiptSummary>();

// The goods receipts (step 17b), newest date first. Everyone reads them, like every stock
// document; writing and posting them needs purchase.receipt.manage (the store keeper at the gate).
export function GoodsReceiptsPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.receipt.manage');
  const isoDate = useIsoDate();
  const { active, byId } = useWarehouses();
  const [status, setStatus] = useState<StockDocumentStatus | ''>('');
  const [warehouseId, setWarehouseId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    goodsReceiptsQuery(useTenantId(), { status, warehouseId, supplierId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('goodsReceipts.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              {/* A draft has its number when it is posted */}
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('goodsReceipts.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((receipt) => receipt.supplier.name, {
          id: 'supplier',
          header: t('goodsReceipts.columns.supplier'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[18rem]">
              <span className="truncate">{row.original.supplier.name}</span>
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.supplier.code}
              </span>
            </span>
          ),
        }),
        column.accessor('order', {
          header: t('goodsReceipts.columns.order'),
          enableSorting: false,
          meta: { card: 'detail' },
          // An order a receipt is made from was approved, so it has its number
          cell: ({ getValue }) => (
            <span className="font-mono tabular-nums">{getValue().number}</span>
          ),
        }),
        column.accessor('warehouseId', {
          header: t('goodsReceipts.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        column.accessor('lineCount', {
          header: t('goodsReceipts.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => t('purchaseLines.lineCount', { count: getValue() }),
        }),
        column.accessor('status', {
          header: t('goodsReceipts.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <GoodsReceiptStatusPill status={getValue()} />,
        }),
      ]),
    [t, isoDate, byId],
  );

  const newButton = canWrite && (
    <Button onClick={() => void navigate({ to: '/goods-receipts/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('goodsReceipts.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('goodsReceipts.title')}
        description={t('goodsReceipts.description')}
        actions={newButton}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <SupplierFilter
            id="goods-receipts-supplier"
            aria-label={t('goodsReceipts.supplier')}
            value={supplierId}
            saved={null}
            onChange={setSupplierId}
            allLabel={t('suppliers.allSuppliers')}
          />
        </div>
        <div className="min-w-0 basis-64">
          <Select
            aria-label={t('goodsReceipts.warehouse')}
            options={[
              { value: '', label: t('purchaseOrders.allWarehouses') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            value={warehouseId}
            onChange={(event) => {
              setWarehouseId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('goodsReceipts.show')}
          value={status}
          options={[
            { value: '', label: t('goodsReceipts.all') },
            ...STOCK_DOCUMENT_STATUSES.map((value) => ({
              value,
              label: t(`goodsReceipts.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('goodsReceipts.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('goodsReceipts.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/goods-receipts/$receiptId', params: { receiptId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={PackageReceiveIcon}
              title={t('goodsReceipts.emptyTitle')}
              description={t('goodsReceipts.emptyBody')}
              action={newButton}
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
