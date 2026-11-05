import { MoneyReceiveCircleIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  SUPPLIER_REFUND_STATUSES,
  type SupplierRefundStatus,
  type SupplierRefundSummary,
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
import { useIsoDate, useTenantId } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { supplierRefundsQuery } from '../lib/queries';

const column = dataTableColumns<SupplierRefundSummary>();

// The supplier refunds (step 17d): money suppliers paid back, and what it was owed on, like the
// customer refunds of 15d
export function SupplierRefundsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.refund.manage');
  const isoDate = useIsoDate();
  const [status, setStatus] = useState<SupplierRefundStatus | ''>('');
  const [supplierId, setSupplierId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    supplierRefundsQuery(useTenantId(), { status, supplierId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('supplierRefunds.columns.number'),
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
        column.accessor((refund) => refund.supplier.name, {
          id: 'supplier',
          header: t('supplierRefunds.columns.supplier'),
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
        column.accessor('source', {
          header: t('supplierRefunds.columns.source'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => (
            <span className="grid">
              <span className="font-mono tabular-nums">{getValue().number}</span>
              <span className="text-caption text-ink-3">
                {t(`supplierRefunds.sources.${getValue().type}`)}
              </span>
            </span>
          ),
        }),
        column.accessor('method', {
          header: t('supplierRefunds.columns.method'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row, getValue }) => (
            <span className="grid min-w-0 max-w-[14rem]">
              <span>{t(`receipts.methods.${getValue()}`)}</span>
              {row.original.reference !== null && (
                <span className="truncate text-caption text-ink-3">{row.original.reference}</span>
              )}
            </span>
          ),
        }),
        column.accessor('amount', {
          header: t('supplierRefunds.columns.amount'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor('status', {
          header: t('supplierRefunds.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => (
            <DocumentStatusPill
              status={getValue()}
              label={t(`supplierRefunds.statuses.${getValue()}`)}
            />
          ),
        }),
      ]),
    [t, format, isoDate],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/supplier-refunds/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('supplierRefunds.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('supplierRefunds.title')}
        description={t('supplierRefunds.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <SupplierFilter
            id="supplier-refunds-supplier"
            aria-label={t('supplierRefunds.supplier')}
            value={supplierId}
            saved={null}
            onChange={setSupplierId}
            allLabel={t('suppliers.allSuppliers')}
          />
        </div>
        <SegmentedControl
          label={t('supplierRefunds.show')}
          value={status}
          options={[
            { value: '', label: t('supplierRefunds.all') },
            ...SUPPLIER_REFUND_STATUSES.map((value) => ({
              value,
              label: t(`supplierRefunds.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('supplierRefunds.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('supplierRefunds.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/supplier-refunds/$refundId', params: { refundId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={MoneyReceiveCircleIcon}
              title={t('supplierRefunds.emptyTitle')}
              description={t('supplierRefunds.emptyBody')}
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
