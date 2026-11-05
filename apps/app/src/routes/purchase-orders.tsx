import { PlusSignIcon, ShoppingBasket01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  PURCHASE_ORDER_BILL_FILTERS,
  PURCHASE_ORDER_RECEIPT_FILTERS,
  PURCHASE_ORDER_STATUSES,
  type PurchaseOrderBillFilter,
  type PurchaseOrderReceiptFilter,
  type PurchaseOrderStatus,
  type PurchaseOrderSummary,
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
import { PurchaseOrderStatusPills } from '../components/purchase-pills';
import {
  useIsoDate,
  useTenantId,
  useToday,
  useWarehouses,
  warehouseLabel,
} from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { purchaseOrdersQuery } from '../lib/queries';

const column = dataTableColumns<PurchaseOrderSummary>();

// "To receive" sits with the statuses, like the requisitions' "To order": it is the store keeper's
// queue (approved, with goods still to come). Step 17c: "Services to bill", the accountant's.
type Show = PurchaseOrderStatus | PurchaseOrderReceiptFilter | PurchaseOrderBillFilter | 'all';

function isReceiptFilter(show: Show): show is PurchaseOrderReceiptFilter {
  return PURCHASE_ORDER_RECEIPT_FILTERS.some((filter) => filter === show);
}

function isBillFilter(show: Show): show is PurchaseOrderBillFilter {
  return PURCHASE_ORDER_BILL_FILTERS.some((filter) => filter === show);
}

// The purchase orders (step 17b), newest date first. Everyone reads them (a store keeper checks
// what is coming to the gate); writing them needs purchase.order.manage.
export function PurchaseOrdersPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.order.manage');
  const isoDate = useIsoDate();
  const today = useToday();
  const { active, byId } = useWarehouses();
  const [show, setShow] = useState<Show>('all');
  const [warehouseId, setWarehouseId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    purchaseOrdersQuery(useTenantId(), {
      status: show === 'all' || isReceiptFilter(show) || isBillFilter(show) ? '' : show,
      warehouseId,
      supplierId,
      receipt: isReceiptFilter(show) ? show : '',
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
          header: t('purchaseOrders.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              {/* A draft nobody submitted has no number yet (decision 13) */}
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('purchaseOrders.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((row) => row.supplier.name, {
          id: 'supplier',
          header: t('purchaseOrders.columns.supplier'),
          enableSorting: false,
          meta: { card: 'subtitle' },
        }),
        column.accessor('expectedDate', {
          header: t('purchaseOrders.columns.expectedDate'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const date = getValue();
            return date === null ? '—' : <span className="tabular-nums">{isoDate(date)}</span>;
          },
        }),
        column.accessor('warehouseId', {
          header: t('purchaseOrders.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        // Whole taka, like every list (CLAUDE.md → Money); the page shows the paisa
        column.accessor('total', {
          header: t('purchaseOrders.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor('status', {
          header: t('purchaseOrders.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) => <PurchaseOrderStatusPills order={row.original} today={today} />,
        }),
      ]),
    [t, format, isoDate, byId, today],
  );

  const newButton = canWrite && (
    <Button onClick={() => void navigate({ to: '/purchase-orders/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('purchaseOrders.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('purchaseOrders.title')}
        description={t('purchaseOrders.description')}
        actions={newButton}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <SupplierFilter
            id="purchase-orders-supplier"
            aria-label={t('purchaseOrders.supplier')}
            value={supplierId}
            saved={null}
            onChange={setSupplierId}
            allLabel={t('suppliers.allSuppliers')}
          />
        </div>
        <div className="min-w-0 basis-64">
          <Select
            aria-label={t('purchaseOrders.warehouse')}
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
          label={t('purchaseOrders.show')}
          value={show}
          options={[
            { value: 'all', label: t('purchaseOrders.all') },
            ...PURCHASE_ORDER_STATUSES.map((value) => ({
              value,
              label: t(`purchaseOrders.statuses.${value}`),
            })),
            ...PURCHASE_ORDER_RECEIPT_FILTERS.map((value) => ({
              value,
              label: t(`purchaseOrders.receiptFilters.${value}`),
            })),
            ...PURCHASE_ORDER_BILL_FILTERS.map((value) => ({
              value,
              label: t(`purchaseOrders.billFilters.${value}`),
            })),
          ]}
          onChange={setShow}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('purchaseOrders.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('purchaseOrders.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/purchase-orders/$orderId', params: { orderId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={ShoppingBasket01Icon}
              title={t('purchaseOrders.emptyTitle')}
              description={t('purchaseOrders.emptyBody')}
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
