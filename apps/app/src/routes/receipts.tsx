import { MoneyReceive02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  RECEIPT_STATUSES,
  type ReceiptStatus,
  type ReceiptSummary,
  unappliedOf,
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
import { ReceiptStatusPill } from '../components/sales-pills';
import { useIsoDate, useTenantId } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { receiptsQuery } from '../lib/queries';

const column = dataTableColumns<ReceiptSummary>();

export function ReceiptsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.receipt.manage');
  const isoDate = useIsoDate();
  const [status, setStatus] = useState<ReceiptStatus | ''>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    receiptsQuery(useTenantId(), { status, customerId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('receipts.columns.number'),
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
        column.accessor((receipt) => receipt.customer.name, {
          id: 'customer',
          header: t('receipts.columns.customer'),
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
        column.accessor('method', {
          header: t('receipts.columns.method'),
          enableSorting: false,
          meta: { card: 'detail' },
          // The cheque number or the TrxID under the method: what a cashier looks for
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[14rem]">
              <span>{t(`receipts.methods.${row.original.method}`)}</span>
              {row.original.reference !== null && (
                <span className="truncate text-caption text-ink-3">{row.original.reference}</span>
              )}
            </span>
          ),
        }),
        column.accessor('amount', {
          header: t('receipts.columns.amount'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        // Step 15d: less what refunds paid back
        column.accessor((receipt) => unappliedOf(receipt), {
          id: 'unapplied',
          header: t('receipts.columns.unapplied'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A voided receipt holds no money: nothing is waiting to be applied
          cell: ({ row, getValue }) =>
            row.original.status === 'voided' ? (
              <span className="text-ink-3">—</span>
            ) : (
              format.money(getValue())
            ),
        }),
        column.accessor('status', {
          header: t('receipts.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <ReceiptStatusPill status={getValue()} />,
        }),
      ]),
    [t, format, isoDate],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/receipts/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('receipts.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('receipts.title')}
        description={t('receipts.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerPicker
            id="receipts-customer"
            aria-label={t('receipts.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('receipts.show')}
          value={status}
          options={[
            { value: '', label: t('receipts.all') },
            ...RECEIPT_STATUSES.map((value) => ({
              value,
              label: t(`receipts.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('receipts.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('receipts.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/receipts/$receiptId', params: { receiptId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={MoneyReceive02Icon}
              title={t('receipts.emptyTitle')}
              description={t('receipts.emptyBody')}
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
