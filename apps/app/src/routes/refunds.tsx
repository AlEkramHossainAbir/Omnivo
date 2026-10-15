import { MoneySend02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { REFUND_STATUSES, type RefundStatus, type RefundSummary } from '@omnivo/contracts';
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
import { useIsoDate, useTenantId } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { refundsQuery } from '../lib/queries';

const column = dataTableColumns<RefundSummary>();

// The refunds (step 15d): money paid back to customers, and where it was paid back from
export function RefundsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.refund.manage');
  const isoDate = useIsoDate();
  const [status, setStatus] = useState<RefundStatus | ''>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    refundsQuery(useTenantId(), { status, customerId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('refunds.columns.number'),
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
        column.accessor((refund) => refund.customer.name, {
          id: 'customer',
          header: t('refunds.columns.customer'),
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
        column.accessor('source', {
          header: t('refunds.columns.source'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => (
            <span className="grid">
              <span className="font-mono tabular-nums">{getValue().number}</span>
              <span className="text-caption text-ink-3">
                {t(`refunds.sources.${getValue().type}`)}
              </span>
            </span>
          ),
        }),
        column.accessor('method', {
          header: t('refunds.columns.method'),
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
          header: t('refunds.columns.amount'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor('status', {
          header: t('refunds.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => (
            <DocumentStatusPill status={getValue()} label={t(`refunds.statuses.${getValue()}`)} />
          ),
        }),
      ]),
    [t, format, isoDate],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/refunds/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('refunds.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('refunds.title')}
        description={t('refunds.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerFilter
            id="refunds-customer"
            aria-label={t('refunds.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('refunds.show')}
          value={status}
          options={[
            { value: '', label: t('refunds.all') },
            ...REFUND_STATUSES.map((value) => ({
              value,
              label: t(`refunds.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('refunds.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('refunds.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/refunds/$refundId', params: { refundId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={MoneySend02Icon}
              title={t('refunds.emptyTitle')}
              description={t('refunds.emptyBody')}
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
