import { NoteRemoveIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  DEBIT_NOTE_STATUSES,
  type DebitNoteStatus,
  type DebitNoteSummary,
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

import { SupplierFilter } from '../components/purchase-parts';
import { DocumentStatusPill } from '../components/sales-pills';
import { useIsoDate, useTenantId } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { debitNotesQuery } from '../lib/queries';

const column = dataTableColumns<DebitNoteSummary>();

// What the supplier still owes back on a debit note: its total, less what is applied to bills and
// what supplier refunds paid back
function unappliedOfNote(note: DebitNoteSummary): string {
  return unappliedOf({ amount: note.total, applied: note.applied, refunded: note.refunded });
}

// The debit notes (step 17d): which bill each takes money off, how much, and what is left of it,
// like the credit notes of 15d
export function DebitNotesPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.debit_note.manage');
  const isoDate = useIsoDate();
  const [status, setStatus] = useState<DebitNoteStatus | ''>('');
  const [supplierId, setSupplierId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    debitNotesQuery(useTenantId(), { status, supplierId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('debitNotes.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('debitNotes.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((note) => note.supplier.name, {
          id: 'supplier',
          header: t('debitNotes.columns.supplier'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[18rem]">
              <span className="truncate">{row.original.supplier.name}</span>
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.supplier.code}
              </span>
            </span>
          ),
        }),
        column.accessor((note) => note.bill?.number ?? null, {
          id: 'bill',
          header: t('debitNotes.columns.bill'),
          enableSorting: false,
          meta: { card: 'detail' },
          // Decision 9: a debit note without a bill says so, not an empty cell
          cell: ({ getValue }) => {
            const number = getValue();
            return number === null ? (
              <span className="text-ink-3">{t('debitNotes.noBillColumn')}</span>
            ) : (
              <span className="font-mono tabular-nums">{number}</span>
            );
          },
        }),
        column.accessor('total', {
          header: t('debitNotes.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A list shows whole taka; the debit note's page shows paisa
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor((note) => unappliedOfNote(note), {
          id: 'unapplied',
          header: t('debitNotes.columns.unapplied'),
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
          header: t('debitNotes.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => (
            <DocumentStatusPill
              status={getValue()}
              label={t(`debitNotes.statuses.${getValue()}`)}
            />
          ),
        }),
      ]),
    [t, format, isoDate],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/debit-notes/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('debitNotes.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('debitNotes.title')}
        description={t('debitNotes.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <SupplierFilter
            id="debit-notes-supplier"
            aria-label={t('debitNotes.supplier')}
            value={supplierId}
            saved={null}
            onChange={setSupplierId}
            allLabel={t('suppliers.allSuppliers')}
          />
        </div>
        <SegmentedControl
          label={t('debitNotes.show')}
          value={status}
          options={[
            { value: '', label: t('debitNotes.all') },
            ...DEBIT_NOTE_STATUSES.map((value) => ({
              value,
              label: t(`debitNotes.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('debitNotes.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('debitNotes.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/debit-notes/$debitNoteId', params: { debitNoteId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={NoteRemoveIcon}
              title={t('debitNotes.emptyTitle')}
              description={t('debitNotes.emptyBody')}
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
