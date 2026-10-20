import { PlusSignIcon, TruckReturnIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type PurchaseReturnSummary,
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
} from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { SupplierFilter } from '../components/purchase-parts';
import { DocumentStatusPill } from '../components/sales-pills';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { purchaseReturnsQuery } from '../lib/queries';
import { purchaseReturnReasonKey } from '../lib/returns';

const column = dataTableColumns<PurchaseReturnSummary>();

// The purchase returns (step 17d): what went back, to whom, why and from which warehouse, like the
// sales returns of 15d
export function PurchaseReturnsPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.return.manage');
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const [status, setStatus] = useState<StockDocumentStatus | ''>('');
  const [supplierId, setSupplierId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    purchaseReturnsQuery(useTenantId(), { status, supplierId, warehouseId: '' }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('purchaseReturns.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('purchaseReturns.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((purchaseReturn) => purchaseReturn.supplier.name, {
          id: 'supplier',
          header: t('purchaseReturns.columns.supplier'),
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
        column.accessor('reason', {
          header: t('purchaseReturns.columns.reason'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => t(purchaseReturnReasonKey(getValue())),
        }),
        column.accessor('warehouseId', {
          header: t('purchaseReturns.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        column.accessor('lineCount', {
          header: t('purchaseReturns.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => t('salesLines.lineCount', { count: getValue() }),
        }),
        column.accessor('status', {
          header: t('purchaseReturns.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => (
            <DocumentStatusPill
              status={getValue()}
              label={t(`purchaseReturns.statuses.${getValue()}`)}
            />
          ),
        }),
      ]),
    [t, isoDate, byId],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/purchase-returns/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('purchaseReturns.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('purchaseReturns.title')}
        description={t('purchaseReturns.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <SupplierFilter
            id="purchase-returns-supplier"
            aria-label={t('purchaseReturns.supplier')}
            value={supplierId}
            saved={null}
            onChange={setSupplierId}
            allLabel={t('suppliers.allSuppliers')}
          />
        </div>
        <SegmentedControl
          label={t('purchaseReturns.show')}
          value={status}
          options={[
            { value: '', label: t('purchaseReturns.all') },
            ...STOCK_DOCUMENT_STATUSES.map((value) => ({
              value,
              label: t(`purchaseReturns.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('purchaseReturns.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('purchaseReturns.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/purchase-returns/$returnId', params: { returnId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={TruckReturnIcon}
              title={t('purchaseReturns.emptyTitle')}
              description={t('purchaseReturns.emptyBody')}
              action={write}
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
