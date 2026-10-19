import { Payment02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  SUPPLIER_PAYMENT_STATUSES,
  type SupplierPaymentStatus,
  type SupplierPaymentSummary,
  unappliedPaymentOf,
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
import { SupplierPaymentStatusPill } from '../components/purchase-pills';
import { useIsoDate, useTenantId } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { supplierPaymentsQuery } from '../lib/queries';

const column = dataTableColumns<SupplierPaymentSummary>();

// The supplier payments (step 17c), newest date first, like the money receipts. Everyone reads
// them; paying needs purchase.payment.manage.
export function SupplierPaymentsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.payment.manage');
  const isoDate = useIsoDate();
  const [status, setStatus] = useState<SupplierPaymentStatus | ''>('');
  const [supplierId, setSupplierId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    supplierPaymentsQuery(useTenantId(), { status, supplierId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('supplierPayments.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('supplierPayments.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((payment) => payment.supplier.name, {
          id: 'supplier',
          header: t('supplierPayments.columns.supplier'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid max-w-[18rem] min-w-0">
              <span className="truncate">{row.original.supplier.name}</span>
              {/* The cheque or the transfer, the way the bank statement shows it */}
              <span className="truncate text-caption text-ink-3">
                {row.original.reference ?? row.original.supplier.code}
              </span>
            </span>
          ),
        }),
        column.accessor('method', {
          header: t('supplierPayments.columns.method'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => t(`receipts.methods.${getValue()}`),
        }),
        column.accessor('amount', {
          header: t('supplierPayments.columns.amount'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor((payment) => unappliedPaymentOf(payment), {
          id: 'unapplied',
          header: t('supplierPayments.columns.unapplied'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // An advance only counts once the money left: a draft's plan holds nothing, and a
          // voided or cancelled payment paid nothing
          cell: ({ row, getValue }) =>
            row.original.status === 'posted' ? (
              format.money(getValue())
            ) : (
              <span className="text-ink-3">—</span>
            ),
        }),
        column.accessor('status', {
          header: t('supplierPayments.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <SupplierPaymentStatusPill status={getValue()} />,
        }),
      ]),
    [t, format, isoDate],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/supplier-payments/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('supplierPayments.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('supplierPayments.title')}
        description={t('supplierPayments.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <SupplierFilter
            id="supplier-payments-supplier"
            aria-label={t('supplierPayments.supplier')}
            value={supplierId}
            saved={null}
            onChange={setSupplierId}
            allLabel={t('suppliers.allSuppliers')}
          />
        </div>
        <SegmentedControl
          label={t('supplierPayments.show')}
          value={status}
          options={[
            { value: '', label: t('supplierPayments.all') },
            ...SUPPLIER_PAYMENT_STATUSES.map((value) => ({
              value,
              label: t(`supplierPayments.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('supplierPayments.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('supplierPayments.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({
              to: '/supplier-payments/$paymentId',
              params: { paymentId: row.id },
            })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={Payment02Icon}
              title={t('supplierPayments.emptyTitle')}
              description={t('supplierPayments.emptyBody')}
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
