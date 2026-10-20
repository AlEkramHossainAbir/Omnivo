import { PackageReceiveIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type GoodsReceiptSummary,
  GRN_BILL_FILTERS,
  type GrnBillFilter,
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
import {
  GoodsReceiptBillPill,
  GoodsReceiptReturnPill,
  GoodsReceiptStatusPill,
} from '../components/purchase-pills';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { goodsReceiptsQuery } from '../lib/queries';

const column = dataTableColumns<GoodsReceiptSummary>();

// Step 17c: "To bill" and "Billed" sit with the statuses, like the orders' "To receive": "To bill"
// is the accountant's queue (posted, with a line no posted bill bills yet)
type Show = StockDocumentStatus | GrnBillFilter | '';

function isBillFilter(show: Show): show is GrnBillFilter {
  return GRN_BILL_FILTERS.some((filter) => filter === show);
}

// The goods receipts (step 17b), newest date first. Everyone reads them, like every stock
// document; writing and posting them needs purchase.receipt.manage (the store keeper at the gate).
export function GoodsReceiptsPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.receipt.manage');
  const isoDate = useIsoDate();
  const { active, byId } = useWarehouses();
  const [show, setShow] = useState<Show>('');
  const [warehouseId, setWarehouseId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    goodsReceiptsQuery(useTenantId(), {
      status: isBillFilter(show) ? '' : show,
      warehouseId,
      supplierId,
      bill: isBillFilter(show) ? show : '',
    }),
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
          // An order a receipt is made from was approved, so it has its number. Step 17c: a
          // receipt a bill made has none (decision 21), and names the bill instead.
          cell: ({ row }) =>
            row.original.order !== null ? (
              <span className="font-mono tabular-nums">{row.original.order.number}</span>
            ) : (
              <span className="text-ink-3">
                {row.original.bill === null
                  ? t('goodsReceipts.noOrder')
                  : t('goodsReceipts.fromBill', { number: row.original.bill.number ?? '' })}
              </span>
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
          // Step 17c: a posted receipt also says how much of it is billed
          cell: ({ row }) => (
            <span className="inline-flex flex-wrap gap-1.5">
              <GoodsReceiptStatusPill status={row.original.status} />
              {row.original.status === 'posted' && (
                <>
                  <GoodsReceiptBillPill state={row.original.billState} />
                  {/* Step 17d: nothing went back shows nothing, like a challan's */}
                  <GoodsReceiptReturnPill state={row.original.returnState} />
                </>
              )}
            </span>
          ),
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
          value={show}
          options={[
            { value: '', label: t('goodsReceipts.all') },
            ...STOCK_DOCUMENT_STATUSES.map((value) => ({
              value,
              label: t(`goodsReceipts.statuses.${value}`),
            })),
            ...GRN_BILL_FILTERS.map((value) => ({
              value,
              label: t(`goodsReceipts.billFilters.${value}`),
            })),
          ]}
          onChange={setShow}
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
