import { Note01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { QUOTATION_STATUSES, type QuotationStatus, type QuotationSummary } from '@omnivo/contracts';
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
import { QuotationStatusPill } from '../components/sales-parts';
import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { quotationsQuery } from '../lib/queries';

const column = dataTableColumns<QuotationSummary>();

export function QuotationsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.quotation.manage');
  const isoDate = useIsoDate();
  const today = useToday();
  const [status, setStatus] = useState<QuotationStatus | ''>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    quotationsQuery(useTenantId(), { status, customerId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('quotations.columns.number'),
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
        column.accessor((quotation) => quotation.customer.name, {
          id: 'customer',
          header: t('quotations.columns.customer'),
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
        column.accessor('validUntil', {
          header: t('quotations.columns.validUntil'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const until = getValue();
            return until === null ? t('quotations.noEndDate') : isoDate(until);
          },
        }),
        column.accessor('total', {
          header: t('quotations.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A list shows whole taka (CLAUDE.md → Money); the quotation's page shows paisa
          cell: ({ getValue }) => format.money(getValue()),
        }),
        column.accessor('status', {
          header: t('quotations.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) => <QuotationStatusPill quotation={row.original} today={today} />,
        }),
      ]),
    [t, format, isoDate, today],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/quotations/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('quotations.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('quotations.title')}
        description={t('quotations.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerPicker
            id="quotations-customer"
            aria-label={t('quotations.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('quotations.show')}
          value={status}
          options={[
            { value: '', label: t('quotations.all') },
            ...QUOTATION_STATUSES.map((value) => ({
              value,
              label: t(`quotations.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('quotations.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('quotations.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/quotations/$quotationId', params: { quotationId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={Note01Icon}
              title={t('quotations.emptyTitle')}
              description={t('quotations.emptyBody')}
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
