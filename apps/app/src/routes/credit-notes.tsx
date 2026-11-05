import { Invoice04Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  CREDIT_NOTE_STATUSES,
  type CreditNoteStatus,
  type CreditNoteSummary,
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

import { CustomerFilter } from '../components/customer-filter';
import { DocumentStatusPill } from '../components/sales-pills';
import { useIsoDate, useTenantId } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { creditNotesQuery } from '../lib/queries';

const column = dataTableColumns<CreditNoteSummary>();

// What a credit note still holds as the customer's advance: its total, less what is applied to
// invoices and what refunds paid back
function unappliedOfNote(note: CreditNoteSummary): string {
  return unappliedOf({ amount: note.total, applied: note.applied, refunded: note.refunded });
}

// The credit notes (step 15d): which invoice each takes back, how much, and what is left of it
export function CreditNotesPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.credit_note.manage');
  const isoDate = useIsoDate();
  const [status, setStatus] = useState<CreditNoteStatus | ''>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    creditNotesQuery(useTenantId(), { status, customerId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('creditNotes.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('creditNotes.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((note) => note.customer.name, {
          id: 'customer',
          header: t('creditNotes.columns.customer'),
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
        column.accessor((note) => note.invoice.number, {
          id: 'invoice',
          header: t('creditNotes.columns.invoice'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="font-mono tabular-nums">{getValue()}</span>,
        }),
        column.accessor('total', {
          header: t('creditNotes.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A list shows whole taka; the credit note's page shows paisa
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor((note) => unappliedOfNote(note), {
          id: 'unapplied',
          header: t('creditNotes.columns.unapplied'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A draft holds no money yet
          cell: ({ row, getValue }) =>
            row.original.status === 'draft' ? (
              <span className="text-ink-3">—</span>
            ) : (
              format.money(getValue())
            ),
        }),
        column.accessor('status', {
          header: t('creditNotes.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => (
            <DocumentStatusPill
              status={getValue()}
              label={t(`creditNotes.statuses.${getValue()}`)}
            />
          ),
        }),
      ]),
    [t, format, isoDate],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/credit-notes/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('creditNotes.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('creditNotes.title')}
        description={t('creditNotes.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerFilter
            id="credit-notes-customer"
            aria-label={t('creditNotes.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('creditNotes.show')}
          value={status}
          options={[
            { value: '', label: t('creditNotes.all') },
            ...CREDIT_NOTE_STATUSES.map((value) => ({
              value,
              label: t(`creditNotes.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('creditNotes.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('creditNotes.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/credit-notes/$creditNoteId', params: { creditNoteId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={Invoice04Icon}
              title={t('creditNotes.emptyTitle')}
              description={t('creditNotes.emptyBody')}
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
