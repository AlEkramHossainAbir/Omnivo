import { Invoice01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { BILL_PAYMENT_FILTERS, billAmountDueOf, type BillSummary } from '@omnivo/contracts';
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
import { BillPills } from '../components/purchase-pills';
import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { type BillListFilter, billsQuery } from '../lib/queries';

const column = dataTableColumns<BillSummary>();

// One control for what the person asks: the bills before they are posted by their status, and the
// posted ones by what is paid, like the invoice list. A bill not posted has nothing paid yet, so
// the two filters of the API never need to be set together.
const SHOW = ['', 'draft', 'pending', ...BILL_PAYMENT_FILTERS, 'cancelled'] as const;
type Show = (typeof SHOW)[number];

function filterOf(show: Show, supplierId: string): BillListFilter {
  if (show === 'draft' || show === 'pending' || show === 'cancelled') {
    return { status: show, payment: '', supplierId };
  }
  return { status: '', payment: show, supplierId };
}

// The supplier bills (step 17c), newest date first; "Not paid" and "Overdue" list the oldest due
// date first, the order they get paid in. Everyone reads them, like every purchase document;
// entering them needs purchase.bill.manage (the accountant).
export function BillsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.bill.manage');
  const isoDate = useIsoDate();
  const today = useToday();
  const [show, setShow] = useState<Show>('');
  const [supplierId, setSupplierId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    billsQuery(useTenantId(), filterOf(show, supplierId)),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('bills.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              {/* A draft gets its number when it is first submitted (decision 13) */}
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('bills.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((bill) => bill.supplier.name, {
          id: 'supplier',
          header: t('bills.columns.supplier'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid max-w-[18rem] min-w-0">
              <span className="truncate">{row.original.supplier.name}</span>
              {/* The supplier's own number, the one their accountant asks about */}
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.supplierBillNumber}
              </span>
            </span>
          ),
        }),
        column.accessor('dueDate', {
          header: t('bills.columns.dueDate'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="tabular-nums">{isoDate(getValue())}</span>,
        }),
        column.accessor('total', {
          header: t('bills.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A list shows whole taka; the bill's page shows paisa
          cell: ({ getValue }) => format.money(getValue()),
        }),
        column.accessor((bill) => billAmountDueOf(bill), {
          id: 'due',
          header: t('bills.columns.due'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // Nothing is owed before it is posted, nor on a cancelled bill
          cell: ({ row, getValue }) =>
            row.original.status === 'posted' ? (
              <span className="font-medium">{format.money(getValue())}</span>
            ) : (
              <span className="text-ink-3">—</span>
            ),
        }),
        column.display({
          id: 'status',
          header: t('bills.columns.status'),
          meta: { card: 'trailing' },
          cell: ({ row }) => <BillPills bill={row.original} today={today} />,
        }),
      ]),
    [t, format, isoDate, today],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/bills/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('bills.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('bills.title')} description={t('bills.description')} actions={write} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <SupplierFilter
            id="bills-supplier"
            aria-label={t('bills.supplier')}
            value={supplierId}
            saved={null}
            onChange={setSupplierId}
            allLabel={t('suppliers.allSuppliers')}
          />
        </div>
        <SegmentedControl
          label={t('bills.show')}
          value={show}
          options={SHOW.map((value) => ({
            value,
            label:
              value === ''
                ? t('bills.all')
                : value === 'draft' || value === 'pending' || value === 'cancelled'
                  ? t(`bills.statuses.${value}`)
                  : t(`bills.paymentFilters.${value}`),
          }))}
          onChange={setShow}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('bills.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('bills.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) => void navigate({ to: '/bills/$billId', params: { billId: row.id } })}
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={Invoice01Icon}
              title={t('bills.emptyTitle')}
              description={t('bills.emptyBody')}
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
