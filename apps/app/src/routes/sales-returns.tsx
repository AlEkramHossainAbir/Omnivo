import { DeliveryReturn01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type SalesReturnSummary,
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

import { CustomerFilter } from '../components/customer-filter';
import { DocumentStatusPill } from '../components/sales-pills';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { salesReturnsQuery } from '../lib/queries';
import { returnReasonKey } from '../lib/returns';

const column = dataTableColumns<SalesReturnSummary>();

// The sales returns (step 15d): what came back, from whom, why and into which warehouse
export function SalesReturnsPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.return.manage');
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const [status, setStatus] = useState<StockDocumentStatus | ''>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    salesReturnsQuery(useTenantId(), { status, customerId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('salesReturns.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('salesReturns.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((salesReturn) => salesReturn.customer.name, {
          id: 'customer',
          header: t('salesReturns.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[18rem]">
              <span className="truncate">{row.original.customer.name}</span>
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.customer.code}
              </span>
            </span>
          ),
        }),
        column.accessor('reason', {
          header: t('salesReturns.columns.reason'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => t(returnReasonKey(getValue())),
        }),
        column.accessor('warehouseId', {
          header: t('salesReturns.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        column.accessor('lineCount', {
          header: t('salesReturns.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => t('salesLines.lineCount', { count: getValue() }),
        }),
        column.accessor('status', {
          header: t('salesReturns.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => (
            <DocumentStatusPill
              status={getValue()}
              label={t(`salesReturns.statuses.${getValue()}`)}
            />
          ),
        }),
      ]),
    [t, isoDate, byId],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/sales-returns/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('salesReturns.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('salesReturns.title')}
        description={t('salesReturns.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerFilter
            id="sales-returns-customer"
            aria-label={t('salesReturns.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('salesReturns.show')}
          value={status}
          options={[
            { value: '', label: t('salesReturns.all') },
            ...STOCK_DOCUMENT_STATUSES.map((value) => ({
              value,
              label: t(`salesReturns.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('salesReturns.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('salesReturns.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/sales-returns/$returnId', params: { returnId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={DeliveryReturn01Icon}
              title={t('salesReturns.emptyTitle')}
              description={t('salesReturns.emptyBody')}
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
