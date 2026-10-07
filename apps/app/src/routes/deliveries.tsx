import { DeliveryTruck01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type DeliverySummary,
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

import { CustomerPicker } from '../components/customer-picker';
import { DeliveryStatusPill } from '../components/sales-parts';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { deliveriesQuery } from '../lib/queries';

const column = dataTableColumns<DeliverySummary>();

export function DeliveriesPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.delivery.manage');
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const [status, setStatus] = useState<StockDocumentStatus | ''>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    deliveriesQuery(useTenantId(), { status, customerId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('deliveries.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('deliveries.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((delivery) => delivery.customer.name, {
          id: 'customer',
          header: t('deliveries.columns.customer'),
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
        column.accessor('order', {
          header: t('deliveries.columns.order'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const order = getValue();
            // A delivery without an order; or one whose order is a draft again (no number)
            return order === null ? (
              <span className="text-ink-3">{t('deliveries.noOrder')}</span>
            ) : (
              <span className="font-mono tabular-nums">
                {order.number ?? t('salesOrders.statuses.draft')}
              </span>
            );
          },
        }),
        column.accessor('warehouseId', {
          header: t('deliveries.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        column.accessor('lineCount', {
          header: t('deliveries.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => t('salesLines.lineCount', { count: getValue() }),
        }),
        column.accessor('status', {
          header: t('deliveries.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <DeliveryStatusPill status={getValue()} />,
        }),
      ]),
    [t, isoDate, byId],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/deliveries/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('deliveries.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('deliveries.title')}
        description={t('deliveries.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerPicker
            id="deliveries-customer"
            aria-label={t('deliveries.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('deliveries.show')}
          value={status}
          options={[
            { value: '', label: t('deliveries.all') },
            ...STOCK_DOCUMENT_STATUSES.map((value) => ({
              value,
              label: t(`deliveries.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('deliveries.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('deliveries.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/deliveries/$deliveryId', params: { deliveryId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={DeliveryTruck01Icon}
              title={t('deliveries.emptyTitle')}
              description={t('deliveries.emptyBody')}
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
