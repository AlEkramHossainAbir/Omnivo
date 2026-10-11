import { Invoice03Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { INVOICE_PAYMENT_FILTERS, type InvoiceSummary } from '@omnivo/contracts';
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
import { InvoicePills } from '../components/sales-parts';
import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
import { amountDue } from '../lib/invoices';
import { useCan } from '../lib/permissions';
import { type InvoiceListFilter, invoicesQuery } from '../lib/queries';

const column = dataTableColumns<InvoiceSummary>();

// One control for what the person asks: drafts, or posted invoices by what is paid. A draft has
// nothing paid yet, so the two filters of the API never need to be set together.
const SHOW = ['', 'draft', ...INVOICE_PAYMENT_FILTERS] as const;
type Show = (typeof SHOW)[number];

function filterOf(show: Show, customerId: string): InvoiceListFilter {
  if (show === 'draft') return { status: 'draft', payment: '', customerId };
  return { status: '', payment: show, customerId };
}

export function InvoicesPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.invoice.manage');
  const isoDate = useIsoDate();
  const today = useToday();
  const [show, setShow] = useState<Show>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    invoicesQuery(useTenantId(), filterOf(show, customerId)),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('invoices.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('invoices.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((invoice) => invoice.customer.name, {
          id: 'customer',
          header: t('invoices.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[18rem]">
              <span className="truncate">{row.original.customer.name}</span>
              {/* The buyer's own number, the one they ask about */}
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.customerReference ?? row.original.customer.code}
              </span>
            </span>
          ),
        }),
        column.accessor('dueDate', {
          header: t('invoices.columns.dueDate'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="tabular-nums">{isoDate(getValue())}</span>,
        }),
        column.accessor('total', {
          header: t('invoices.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A list shows whole taka; the invoice's page shows paisa
          cell: ({ getValue }) => format.money(getValue()),
        }),
        column.accessor((invoice) => amountDue(invoice), {
          id: 'due',
          header: t('invoices.columns.due'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A draft asks for nothing yet
          cell: ({ row, getValue }) =>
            row.original.status === 'draft' ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="font-medium">{format.money(getValue())}</span>
            ),
        }),
        column.display({
          id: 'status',
          header: t('invoices.columns.status'),
          meta: { card: 'trailing' },
          cell: ({ row }) => <InvoicePills invoice={row.original} today={today} />,
        }),
      ]),
    [t, format, isoDate, today],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/invoices/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('invoices.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('invoices.title')}
        description={t('invoices.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerPicker
            id="invoices-customer"
            aria-label={t('invoices.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('invoices.show')}
          value={show}
          options={SHOW.map((value) => ({
            value,
            label:
              value === ''
                ? t('invoices.all')
                : value === 'draft'
                  ? t('invoices.statuses.draft')
                  : t(`invoices.paymentFilters.${value}`),
          }))}
          onChange={setShow}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('invoices.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('invoices.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/invoices/$invoiceId', params: { invoiceId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={Invoice03Icon}
              title={t('invoices.emptyTitle')}
              description={t('invoices.emptyBody')}
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
